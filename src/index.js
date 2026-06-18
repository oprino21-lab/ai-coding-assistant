require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const repoRoutes = require('./routes/repo');
const aiRoutes = require('./routes/ai');
const changesRoutes = require('./routes/changes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'codelite-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

require('./services/githubAuth')(passport);

app.use('/auth', authRoutes);
app.use('/api/repo', repoRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/changes', changesRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'CodeLite AI Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/auth/github → GitHub OAuth login',
      callback: '/auth/github/callback → OAuth callback',
      me: '/auth/me → current user',
      logout: '/auth/logout → logout',
      repos: '/api/repo/list → list connected repos',
      connect: 'POST /api/repo/connect → connect a repo',
      analyze: 'POST /api/repo/analyze → analyze repo structure',
      instruct: 'POST /api/ai/instruct → send AI instruction',
      changes: 'GET /api/changes/:taskId → get proposed changes',
      approve: 'POST /api/changes/:taskId/approve → approve & apply changes',
      reject: 'POST /api/changes/:taskId/reject → reject changes'
    }
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`CodeLite backend running on port ${PORT}`);
});

module.exports = app;
