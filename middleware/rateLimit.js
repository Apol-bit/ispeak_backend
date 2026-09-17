function createRateLimiter({ windowMs, max, message }) {
  const clients = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of clients.entries()) {
      if (value.resetAt <= now) clients.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let state = clients.get(key);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      clients.set(key, state);
    }

    state.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - state.count)));
    res.set('RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > max) {
      return res.status(429).json({ message });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
