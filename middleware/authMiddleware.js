const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Session = require('../models/Session');

const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'You are not logged in. Please log in to access this resource.'
      });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists
    let user;
    if (decoded.userType === 'driver') {
      user = await Driver.findById(decoded.id).select('-password');
    } else {
      user = await User.findById(decoded.id).select('-password');
    }
    
    if (!user) {
      return res.status(401).json({
        status: 'fail',
        message: 'The user belonging to this token no longer exists.'
      });
    }
    
    req.user = user;
    req.userType = decoded.userType;
    req.sessionId = req.headers['x-session-id'] || null;

    if (req.sessionId) {
      await Session.findOneAndUpdate(
        { sessionId: req.sessionId, accountId: decoded.id, accountType: decoded.userType, isActive: true },
        { lastSeenAt: new Date(), userAgent: req.headers['user-agent'], ipAddress: req.ip },
        { new: true }
      );
    }
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid token. Please log in again.'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'fail',
        message: 'Your token has expired. Please log in again.'
      });
    }
    next(error);
  }
};

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        message: 'You do not have permission to perform this action.'
      });
    }
    next();
  };
};

const restrictUserType = (...types) => {
  return (req, res, next) => {
    if (!types.includes(req.userType)) {
      return res.status(403).json({
        status: 'fail',
        message: `Access denied. This endpoint is for ${types.join(' or ')} only.`
      });
    }
    next();
  };
};

module.exports = { protect, restrictTo, restrictUserType };
