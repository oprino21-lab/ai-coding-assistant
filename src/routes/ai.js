const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { thinkAndPlan, generateCodeChanges, explainCode } = require('../services/aiService');
const { analyzeRepo } = require('../services/repoAnalyzer');
const { createTask, updateTask, getTask } = require('../services/taskEngine');
const githubService = require('../services/githubService');
const { connectedRepos } = require('./repo');
const logger = require('../utils/logger');

async function getOrConnectRepo(userId, username, accessToken, repoFullName) {
  const key = `${userId}:${repoFullName}`;
  let conn = connectedRepos.get(key);

  if (!conn) {
    const localPath = await githubService.cloneOrUpdateRepo(accessToken, username, repoFullName);
    conn = { localPath, repoFullName, connectedAt: new Date().toISOString() };
    connectedRepos.set(key, conn);
  }

  if (!conn.analysis) {
    conn.analysis = await analyzeRepo(conn.localPath);
    connectedRepos.set(key, conn);
  }

  return conn;
}

router.post('/instruct', requireAuth, async (req, res) => {
  const { repoFullName, instruction } = req.body;

  if (!repoFullName) return res.status(400).json({ error: 'repoFullName is required' });
  if (!instruction || instruction.trim().length < 3) {
    return res.status(400).json({ error: 'instruction is required (minimum 3 characters)' });
  }

  const task = createTask(req.user.id, repoFullName, instruction);

  res.json({
    success: true,
    taskId: task.id,
    message: 'Task created. AI is now thinking and planning...',
    status: 'processing'
  });

  setImmediate(async () => {
    try {
      updateTask(task.id, { status: 'thinking' });

      const conn = await getOrConnectRepo(
        req.user.id, req.user.username, req.user.accessToken, repoFullName
      );

      const plan = await thinkAndPlan(instruction, conn.analysis);
      updateTask(task.id, { status: 'planning', plan });

      const allFilesToRead = [...(plan.impactedFiles || []), ...(plan.newFiles || [])];
      const existingContents = allFilesToRead.length > 0
        ? await githubService.getFilesContent(conn.localPath, plan.impactedFiles || [])
        : {};

      updateTask(task.id, { status: 'generating' });
      const codeChanges = await generateCodeChanges(instruction, plan, conn.analysis, existingContents);

      updateTask(task.id, {
        status: 'awaiting_approval',
        plan,
        changes: codeChanges
      });

      logger.info(`Task ${task.id} ready for approval: ${codeChanges.changes?.length} change(s)`);
    } catch (err) {
      logger.error(`Task ${task.id} failed:`, err);
      updateTask(task.id, { status: 'failed', error: err.message });
    }
  });
});

router.get('/task/:taskId', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json({ task });
});

router.post('/explain', requireAuth, async (req, res) => {
  const { repoFullName, filePath } = req.body;
  if (!repoFullName || !filePath) {
    return res.status(400).json({ error: 'repoFullName and filePath are required' });
  }

  try {
    const conn = await getOrConnectRepo(
      req.user.id, req.user.username, req.user.accessToken, repoFullName
    );
    const code = await githubService.readFile(conn.localPath, filePath);
    const explanation = await explainCode(code, filePath);
    res.json({ success: true, filePath, explanation });
  } catch (err) {
    logger.error('Explain error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
