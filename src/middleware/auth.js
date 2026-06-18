const logger = require('../utils/logger');

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  logger.warn(`Unauthenticated request to ${req.path}`);
  return res.status(401).json({ error: 'Authentication required. Please login via /auth/github' });
}

module.exports = { requireAuth };
