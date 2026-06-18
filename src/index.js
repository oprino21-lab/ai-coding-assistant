require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const path = require('path');
const logger = require('./utils/logger');

const authRoutes   = require('./routes/auth');
const repoRoutes   = require('./routes/repo');
const aiRoutes     = require('./routes/ai');
const changesRoutes = require('./routes/changes');

const app  = express();
const PORT = process.env.PORT || 5000;

/* ── Middleware ─────────────────────────────────────────────── */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'codelite-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());
require('./services/githubAuth')(passport);

/* ── Routes ─────────────────────────────────────────────────── */
app.use('/auth',        authRoutes);
app.use('/api/repo',    repoRoutes);
app.use('/api/ai',      aiRoutes);
app.use('/api/changes', changesRoutes);

/* ── Status endpoint ────────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    name:    'CodeLite AI Backend',
    version: '1.0.0',
    status:  'running',
    authenticated: req.isAuthenticated?.() ?? false,
    user: req.user ? { username: req.user.username, avatar: req.user.avatarUrl } : null,
    deployedAt: process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`,
    endpoints: {
      login:    'GET  /auth/github',
      me:       'GET  /auth/me',
      logout:   'POST /auth/logout',
      repos:    'GET  /api/repo/list',
      connect:  'POST /api/repo/connect      { repoFullName }',
      analyze:  'POST /api/repo/analyze      { repoFullName }',
      instruct: 'POST /api/ai/instruct       { repoFullName, instruction }',
      task:     'GET  /api/ai/task/:taskId',
      explain:  'POST /api/ai/explain        { repoFullName, filePath }',
      changes:  'GET  /api/changes',
      diff:     'GET  /api/changes/:taskId',
      approve:  'POST /api/changes/:taskId/approve',
      reject:   'POST /api/changes/:taskId/reject'
    }
  });
});

/* Root → HTML dashboard */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* ── Global error handler ───────────────────────────────────── */
app.use((err, req, res, next) => {
  logger.error('Unhandled error: ' + err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ── Server startup with port-conflict recovery ─────────────── */
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`CodeLite backend running → http://0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is in use — exiting so the process manager can restart cleanly.`);
  } else {
    logger.error('Server error: ' + err.message);
  }
  process.exit(1);
});

/* Clean shutdown on SIGTERM / SIGINT (Render + Replit) */
const shutdown = (sig) => {
  logger.info(`Received ${sig} — shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
