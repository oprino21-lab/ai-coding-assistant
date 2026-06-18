const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getTask, updateTask, getUserTasks } = require('../services/taskEngine');
const githubService = require('../services/githubService');
const { connectedRepos } = require('./repo');
const { analyzeRepo } = require('../services/repoAnalyzer');
const diff = require('diff');
const logger = require('../utils/logger');

router.get('/', requireAuth, (req, res) => {
  const tasks = getUserTasks(req.user.id);
  res.json({ tasks });
});

router.get('/:taskId', requireAuth, async (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  let diffPreview = null;

  if (task.changes?.changes) {
    const conn = connectedRepos.get(`${req.user.id}:${task.repoFullName}`);
    if (conn) {
      diffPreview = await Promise.all(
        task.changes.changes.map(async (change) => {
          let originalContent = '';
          if (change.action === 'modify') {
            try {
              originalContent = await githubService.readFile(conn.localPath, change.path);
            } catch (_) {}
          }
          const patch = diff.createPatch(
            change.path,
            originalContent,
            change.content,
            'original',
            'proposed'
          );
          return {
            path: change.path,
            action: change.action,
            description: change.description,
            diff: patch,
            linesAdded: (change.content.match(/\n/g) || []).length,
            linesRemoved: (originalContent.match(/\n/g) || []).length
          };
        })
      );
    }
  }

  res.json({
    task: {
      ...task,
      diffPreview
    }
  });
});

router.post('/:taskId/approve', requireAuth, async (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (task.status !== 'awaiting_approval') {
    return res.status(400).json({ error: `Task is not awaiting approval. Current status: ${task.status}` });
  }

  const conn = connectedRepos.get(`${req.user.id}:${task.repoFullName}`);
  if (!conn) {
    return res.status(400).json({ error: 'Repository not connected. Please reconnect.' });
  }

  updateTask(task.id, { status: 'applying' });

  try {
    const changedFiles = [];

    for (const change of task.changes.changes) {
      await githubService.writeFile(conn.localPath, change.path, change.content);
      changedFiles.push(change.path);
      logger.info(`Applied change to: ${change.path}`);
    }

    const commitMessage = task.changes.commitMessage || `feat: ${task.instruction.substring(0, 72)}`;

    const pushResult = await githubService.commitAndPush(
      conn.localPath,
      req.user.accessToken,
      req.user.username,
      task.repoFullName,
      commitMessage,
      changedFiles
    );

    conn.analysis = null;

    updateTask(task.id, {
      status: 'completed',
      appliedChanges: {
        filesChanged: changedFiles,
        commitMessage,
        branch: pushResult.branch,
        appliedAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      message: `✅ Changes applied and pushed to GitHub successfully`,
      filesChanged: changedFiles,
      commitMessage,
      branch: pushResult.branch,
      repoUrl: `https://github.com/${task.repoFullName}`
    });
  } catch (err) {
    logger.error(`Error applying task ${task.id}:`, err);
    updateTask(task.id, { status: 'failed', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/:taskId/reject', requireAuth, (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  updateTask(task.id, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectionReason: req.body.reason || 'User rejected changes'
  });

  res.json({ success: true, message: 'Changes rejected. No modifications were made.' });
});

module.exports = router;
