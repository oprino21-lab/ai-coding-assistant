const express = require('express');
const passport = require('passport');
const router = express.Router();
const logger = require('../utils/logger');

router.get('/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));

router.get('/github/callback',
  passport.authenticate('github', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    logger.info(`User authenticated: ${req.user.username}`);
    res.redirect('/?auth=success');
  }
);

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ authenticated: false, message: 'Not logged in' });
  }
  const { accessToken, ...safeUser } = req.user;
  res.json({ authenticated: true, user: safeUser });
});

router.post('/logout', (req, res) => {
  const username = req.user?.username;
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    logger.info(`User logged out: ${username}`);
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

module.exports = router;
