const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs-extra');
const { requireAuth } = require('../middleware/auth');
const githubService   = require('../services/githubService');
const { analyzeRepo } = require('../services/repoAnalyzer');
const logger          = require('../utils/logger');

const connectedRepos = new Map();
const STATE_FILE     = path.join(process.cwd(), 'repos', '.state.json');

/* ── Persistence helpers ────────────────────────────────────────── */

async function saveState() {
  try {
    const state = {};
    for (const [key, val] of connectedRepos.entries()) {
      state[key] = {
        localPath:    val.localPath,
        repoFullName: val.repoFullName,
        connectedAt:  val.connectedAt
      };
    }
    await fs.ensureDir(path.dirname(STATE_FILE));
    await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  } catch (err) {
    logger.warn(`Could not save repo state: ${err.message}`);
  }
}

async function restoreState() {
  try {
    if (!await fs.pathExists(STATE_FILE)) return 0;
    const state = await fs.readJson(STATE_FILE);
    let count = 0;
    for (const [key, val] of Object.entries(state)) {
      if (val.localPath && await fs.pathExists(path.join(val.localPath, '.git'))) {
        connectedRepos.set(key, val);
        count++;
      }
    }
    if (count > 0) logger.info(`Restored ${count} connected repo(s) from disk`);
    return count;
  } catch (err) {
    logger.warn(`Could not restore repo state: ${err.message}`);
    return 0;
  }
}

/* ── Routes ─────────────────────────────────────────────────────── */

router.get('/list', requireAuth, async (req, res) => {
  try {
    const repos = await githubService.listUserRepos(req.user.accessToken);
    res.json({ repos });
  } catch (err) {
    logger.error('Error listing repos:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/connect', requireAuth, async (req, res) => {
  const { repoFullName } = req.body;
  if (!repoFullName) return res.status(400).json({ error: 'repoFullName is required' });

  try {
    logger.info(`Cloning/updating repo: ${repoFullName}`);
    const localPath = await githubService.cloneOrUpdateRepo(
      req.user.accessToken,
      req.user.username,
      repoFullName
    );

    const key  = `${req.user.id}:${repoFullName}`;
    const conn = { localPath, repoFullName, connectedAt: new Date().toISOString() };
    connectedRepos.set(key, conn);
    await saveState();

    res.json({
      success: true,
      message: `Repository "${repoFullName}" connected successfully`,
      repoFullName,
      localPath
    });
  } catch (err) {
    logger.error(`Error connecting repo ${repoFullName}:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/analyze', requireAuth, async (req, res) => {
  const { repoFullName } = req.body;
  if (!repoFullName) return res.status(400).json({ error: 'repoFullName is required' });

  const key = `${req.user.id}:${repoFullName}`;
  let conn  = connectedRepos.get(key);

  if (!conn) {
    try {
      const localPath = await githubService.cloneOrUpdateRepo(
        req.user.accessToken,
        req.user.username,
        repoFullName
      );
      conn = { localPath, repoFullName, connectedAt: new Date().toISOString() };
      connectedRepos.set(key, conn);
      await saveState();
    } catch (err) {
      return res.status(500).json({ error: `Could not clone repo: ${err.message}` });
    }
  }

  try {
    const analysis = await analyzeRepo(conn.localPath);
    connectedRepos.set(key, { ...conn, analysis });

    res.json({
      success: true,
      repoFullName,
      analysis: {
        totalFiles:  analysis.totalFiles,
        techStack:   analysis.techStack,
        keyFiles:    analysis.keyFiles,
        fileTree:    analysis.fileTree.slice(0, 100),
        analyzedAt:  analysis.analyzedAt
      }
    });
  } catch (err) {
    logger.error(`Error analyzing repo ${repoFullName}:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/connected', requireAuth, (req, res) => {
  const userRepos = [];
  for (const [key, val] of connectedRepos.entries()) {
    if (key.startsWith(`${req.user.id}:`)) {
      userRepos.push({
        repoFullName: val.repoFullName,
        connectedAt:  val.connectedAt,
        hasAnalysis:  !!val.analysis,
        techStack:    val.analysis?.techStack?.detected || []
      });
    }
  }
  res.json({ repos: userRepos });
});

module.exports        = router;
module.exports.connectedRepos = connectedRepos;
module.exports.restoreState   = restoreState;
