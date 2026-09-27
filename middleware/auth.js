const jwt = require('jsonwebtoken');
const User = require('../models/User');

function readBearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;

  const [scheme, token, extra] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || extra) return null;
  return token;
}

async function authenticate(req, res, next) {
  // Routers mounted at /api can traverse this middleware more than once.
  // Reuse only this request's verified account, never a cross-request cache.
  if (req.auth) return next();
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: process.env.JWT_ISSUER || 'ispeak-api',
      audience: process.env.JWT_AUDIENCE || 'ispeak-clients',
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Authentication session expired' });
    }
    if (['JsonWebTokenError', 'NotBeforeError'].includes(error.name) && process.env.JWT_SECRET) {
      return res.status(401).json({ message: 'Invalid authentication token' });
    }
    return res.status(500).json({ message: 'Authentication service is unavailable' });
  }
  if (typeof payload.userId !== 'string' || !payload.userId) {
    return res.status(401).json({ message: 'Invalid authentication token' });
  }
  try {
    const user = await User.findById(payload.userId).select(
      '_id firstName lastName username email role status isArchived'
    );

    if (!user) {
      return res.status(401).json({ message: 'Authentication session is no longer valid' });
    }
    if (user.status !== 'Active' || user.isArchived) {
      return res.status(403).json({ message: 'This account is not active' });
    }

    req.auth = {
      userId: user._id.toString(),
      role: user.role,
      user,
    };
    return next();
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(401).json({ message: 'Invalid authentication token' });
    }
    console.error('Authentication account lookup failed:', error.name);
    return res.status(503).json({ message: 'Account verification is temporarily unavailable. Please try again.' });
  }
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ message: 'You are not authorized to perform this action' });
    }
    return next();
  };
}

function requireSelfOrRoles({ param = 'userId', body, roles = [] } = {}) {
  return (req, res, next) => {
    const requestedUserId = body ? req.body?.[body] : req.params?.[param];
    if (!requestedUserId) {
      return res.status(400).json({ message: 'User ID is required' });
    }
    if (req.auth.userId === requestedUserId || roles.includes(req.auth.role)) {
      return next();
    }
    return res.status(403).json({ message: 'You cannot access another user\'s data' });
  };
}

module.exports = {
  authenticate,
  authorizeRoles,
  readBearerToken,
  requireSelfOrRoles,
};
