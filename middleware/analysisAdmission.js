const { createRateLimiter } = require('./rateLimit');

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function createAnalysisAdmission() {
  const activeUsers = new Set();
  const rateLimit = createRateLimiter({
    windowMs: 60_000,
    max: positiveInteger(process.env.ANALYSIS_RATE_LIMIT_MAX, 10),
    message: 'Too many analysis submissions. Please wait a minute and try again.',
    keyForRequest: (req) => req.auth.userId,
  });
  return (req, res, next) => {
    const userId = req.auth.userId;
    if (activeUsers.has(userId)) {
      res.set('Retry-After', '5');
      return res.status(429).json({ message: 'Your previous recording is still being analyzed. Please wait for it to finish.' });
    }
    return rateLimit(req, res, () => {
      activeUsers.add(userId);
      let released = false;
      req.releaseAnalysis = () => {
        if (!released) activeUsers.delete(userId);
        released = true;
      };
      // A disconnected client does not release a running analysis. The
      // controller owns that slot until its upstream request/save completes.
      res.once('finish', req.releaseAnalysis);
      res.once('close', () => {
        if (!req.analysisStarted) req.releaseAnalysis();
      });
      next();
    });
  };
}

module.exports = { createAnalysisAdmission };
