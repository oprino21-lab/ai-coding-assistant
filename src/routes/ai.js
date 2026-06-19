const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { thinkAndPlan, generateCodeChanges, explainCode } = require('../services/aiService');
const { analyzeRepo } = require('../services/repoAnalyzer');
const { createTask, updateTask, getTask } = require('../services/taskEngine');
const githubService = require('../services/githubService');
const { connectedRepos } = require('./repo');
const logger = require('../utils/logger');

/**
 * Normalize repoFullName to "owner/repo" format.
 * Handles full GitHub URLs, URLs with .git suffix, and plain owner/repo strings.
 */
function normalizeRepoName(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();

  // Strip full GitHub URLs: https://github.com/owner/repo or git@github.com:owner/repo
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/^git@github\.com:/i, '');
  // Strip trailing .git
  s = s.replace(/\.git$/i, '');
  // Strip trailing slashes
  s = s.replace(/\/+$/, '');

  // Must now be exactly "owner/repo"
  const parts = s.split('/').filter(Boolean);
  if (parts.length !== 2) return null;

  return `${parts[0]}/${parts[1]}`;
}

/**
 * Ensure the repo is cloned locally and analyzed.
 * Returns the connection object { localPath, repoFullName, analysis }.
 * Throws a descriptive error on failure.
 */
async function getOrConnectRepo(userId, username, accessToken, repoFullName) {
  const key = `${userId}:${repoFullName}`;
  let conn = connectedRepos.get(key);

  if (!conn) {
    logger.info(`Repo not connected — cloning now: ${repoFullName}`);
    try {
      const localPath = await githubService.cloneOrUpdateRepo(accessToken, username, repoFullName);
      conn = { localPath, repoFullName, connectedAt: new Date().toISOString() };
      connectedRepos.set(key, conn);
    } catch (cloneErr) {
      throw new Error(
        `Could not clone repository "${repoFullName}". ` +
        `Make sure it exists and your GitHub account has access. ` +
        `Details: ${cloneErr.message}`
      );
    }
  }

  if (!conn.analysis) {
    logger.info(`Running repo analysis for: ${repoFullName}`);
    try {
      conn.analysis = await analyzeRepo(conn.localPath);
      connectedRepos.set(key, conn);
    } catch (analyzeErr) {
      throw new Error(`Repo cloned but analysis failed: ${analyzeErr.message}`);
    }
  }

  return conn;
}

/* ── POST /api/ai/instruct ────────────────────────────────────────── */
router.post('/instruct', requireAuth, async (req, res) => {
  let { repoFullName, instruction } = req.body;

  // 1. Validate and normalize repoFullName
  if (!repoFullName) {
    return res.status(400).json({
      error: 'repoFullName is required',
      hint: 'Provide it as "owner/repository" e.g. "john/my-app"'
    });
  }

  const normalized = normalizeRepoName(repoFullName);
  if (!normalized) {
    return res.status(400).json({
      error: 'Invalid repoFullName format',
      received: repoFullName,
      hint: 'Use "owner/repository" format — not a full URL. Example: "john/my-app"'
    });
  }
  repoFullName = normalized;

  // 2. Validate instruction
  if (!instruction || typeof instruction !== 'string' || instruction.trim().length < 3) {
    return res.status(400).json({
      error: 'instruction is required and must be at least 3 characters',
      hint: 'Example: "Add JWT authentication" or "Fix the login bug"'
    });
  }
  instruction = instruction.trim();

  // 3. Check OpenRouter API key is configured
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is not configured on the server',
      hint: 'Add the OPENROUTER_API_KEY environment variable to your deployment'
    });
  }

  // 4. Create task and respond immediately with taskId
  const task = createTask(req.user.id, repoFullName, instruction);

  res.json({
    success: true,
    taskId: task.id,
    repoFullName,
    message: 'Task created. AI is now thinking and planning — poll /api/ai/task/:taskId for updates.',
    statusUrl: `/api/ai/task/${task.id}`
  });

  // 5. Run AI pipeline in background
  setImmediate(async () => {
    try {
      // Step A: clone / connect repo
      updateTask(task.id, { status: 'thinking' });
      const conn = await getOrConnectRepo(
        req.user.id, req.user.username, req.user.accessToken, repoFullName
      );

      // Step B: AI thinks and plans
      updateTask(task.id, { status: 'planning' });
      const plan = await thinkAndPlan(instruction, conn.analysis);
      updateTask(task.id, { status: 'planning', plan });

      // Step C: Read existing file contents for impacted files
      const filesToRead = [...(plan.impactedFiles || [])].filter(Boolean);
      const existingContents = filesToRead.length > 0
        ? await githubService.getFilesContent(conn.localPath, filesToRead)
        : {};

      // Step D: Generate code changes
      updateTask(task.id, { status: 'generating' });
      const codeChanges = await generateCodeChanges(instruction, plan, conn.analysis, existingContents);

      // Step E: Await user approval
      updateTask(task.id, {
        status: 'awaiting_approval',
        plan,
        changes: codeChanges
      });

      logger.info(`Task ${task.id} ready for approval — ${codeChanges.changes?.length ?? 0} change(s) proposed`);
    } catch (err) {
      logger.error(`Task ${task.id} failed: ${err.message}`);
      updateTask(task.id, { status: 'failed', error: err.message });
    }
  });
});

/* ── GET /api/ai/task/:taskId ────────────────────────────────────── */
router.get('/task/:taskId', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found', taskId: req.params.taskId });
  if (task.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json({ task });
});

/* ── POST /api/ai/explain ────────────────────────────────────────── */
router.post('/explain', requireAuth, async (req, res) => {
  let { repoFullName, filePath } = req.body;

  if (!repoFullName) {
    return res.status(400).json({ error: 'repoFullName is required' });
  }
  const normalized = normalizeRepoName(repoFullName);
  if (!normalized) {
    return res.status(400).json({ error: 'Invalid repoFullName format', hint: 'Use "owner/repo"' });
  }
  repoFullName = normalized;

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath is required' });
  }

  try {
    const conn = await getOrConnectRepo(
      req.user.id, req.user.username, req.user.accessToken, repoFullName
    );
    const code = await githubService.readFile(conn.localPath, filePath);
    const explanation = await explainCode(code, filePath);
    res.json({ success: true, filePath, explanation });
  } catch (err) {
    logger.error(`Explain error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
