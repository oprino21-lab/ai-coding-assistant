const GitHubStrategy = require('passport-github2').Strategy;
const logger = require('../utils/logger');

module.exports = (passport) => {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL,
    scope: ['user:email', 'repo']
  }, (accessToken, refreshToken, profile, done) => {
    const user = {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      email: profile.emails?.[0]?.value,
      avatarUrl: profile.photos?.[0]?.value,
      accessToken
    };
    logger.info(`GitHub OAuth success for user: ${user.username}`);
    return done(null, user);
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
};
