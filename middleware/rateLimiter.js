const rateLimit = require('express-rate-limit');

// General limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    status: 'error',
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for ride requests
const rideLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: {
    status: 'error',
    message: 'Too many ride requests, please wait a moment.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Export a function that returns the appropriate limiter based on the route
const rateLimiterMiddleware = (req, res, next) => {
  if (req.path.startsWith('/api/auth')) {
    return authLimiter(req, res, next);
  }
  if (req.path.startsWith('/api/rides/request')) {
    return rideLimiter(req, res, next);
  }
  return generalLimiter(req, res, next);
};

module.exports = rateLimiterMiddleware;