const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Session = require('../models/Session');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const { normalizeKenyanPhone } = require('../utils/phone');

// Generate JWT Token
const signToken = (id, userType) => {
  return jwt.sign(
    { id, userType },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

// Create and send token
const registerSession = async (req, user, userType) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return null;

  return Session.findOneAndUpdate(
    { sessionId },
    {
      sessionId,
      accountId: user._id,
      accountType: userType,
      isActive: true,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      lastSeenAt: new Date()
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const createSendToken = async (req, user, statusCode, res, userType = 'user') => {
  const token = signToken(user._id, userType);
  await registerSession(req, user, userType);
  
  // Remove password from output
  user.password = undefined;
  
  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
      userType
    }
  });
};

const findAccountByEmail = async (email, { includePassword = false } = {}) => {
  let userQuery = User.findOne({ email });
  if (includePassword) userQuery = userQuery.select('+password');

  const user = await userQuery;
  if (user) {
    return { account: user, userType: 'user' };
  }

  let driverQuery = Driver.findOne({ email });
  if (includePassword) driverQuery = driverQuery.select('+password');

  const driver = await driverQuery;
  if (driver) {
    return { account: driver, userType: 'driver' };
  }

  return { account: null, userType: null };
};

const findAccountByResetToken = async (hashedToken) => {
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (user) {
    return { account: user, userType: 'user' };
  }

  const driver = await Driver.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (driver) {
    return { account: driver, userType: 'driver' };
  }

  return { account: null, userType: null };
};

// Register new user
exports.register = catchAsync(async (req, res, next) => {
  const { name, email, phone, password } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone);
  const normalizedEmail = email.toLowerCase();
  
  // Check if user exists
  const existingUser = await User.findOne({ $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] });
  if (existingUser) {
    throw new AppError('User already exists with this email or phone', 400);
  }
  
  // Create email verification token
  const emailVerificationToken = crypto.randomBytes(32).toString('hex');
  
  // Create user
  const user = await User.create({
    name,
    email: normalizedEmail,
    phone: normalizedPhone,
    password,
    emailVerificationToken,
    emailVerified: false
  });
  
  // Send verification email
  await sendVerificationEmail(email, emailVerificationToken);
  
  await createSendToken(req, user, 201, res);
});

const findAccountForLogin = async (email) => findAccountByEmail(email, { includePassword: true });

// Unified login for client, driver, and admin
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();
  
  const { account, userType } = await findAccountForLogin(normalizedEmail);
  if (!account || !(await account.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }

  if (userType === 'driver' && account.status !== 'active') {
    throw new AppError(`Your account is ${account.status}. Please contact support.`, 403);
  }
  
  if (userType === 'driver') {
    account.lastActive = new Date();
    await account.save();
  } else if (typeof account.updateLastLogin === 'function') {
    await account.updateLastLogin();
  }
  
  await createSendToken(req, account, 200, res, userType);
});

// Register driver
exports.registerDriver = catchAsync(async (req, res, next) => {
  const {
    name, email, phone, password, idNumber, licenseNumber,
    vehicle: { make, model, year, color, plateNumber, type, capacity }
  } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone);
  const normalizedEmail = email.toLowerCase();
  
  // Check if driver exists
  const existingDriver = await Driver.findOne({ $or: [{ email: normalizedEmail }, { phone: normalizedPhone }, { idNumber }, { licenseNumber }, { 'vehicle.plateNumber': plateNumber }] });
  if (existingDriver) {
    throw new AppError('Driver already registered with this information', 400);
  }
  
  // Create driver (pending approval)
  const driver = await Driver.create({
    name,
    email: normalizedEmail,
    phone: normalizedPhone,
    password,
    idNumber,
    licenseNumber,
    vehicle: { make, model, year, color, plateNumber, type, capacity },
    status: 'pending',
    documents: {
      isVerified: false
    }
  });
  
  // Send notification to admin (implement later)
  
  await createSendToken(req, driver, 201, res, 'driver');
});

exports.driverLogin = exports.login;

// Refresh token
exports.refreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    let user;
    
    if (decoded.userType === 'driver') {
      user = await Driver.findById(decoded.id);
    } else {
      user = await User.findById(decoded.id);
    }
    
    if (!user) {
      throw new AppError('User not found', 404);
    }
    
    const newToken = signToken(user._id, decoded.userType);
    
    res.status(200).json({
      status: 'success',
      token: newToken
    });
  } catch (error) {
    throw new AppError('Invalid refresh token', 401);
  }
});

// Logout
exports.logout = catchAsync(async (req, res, next) => {
  if (req.sessionId) {
    await Session.findOneAndUpdate({ sessionId: req.sessionId }, { isActive: false, lastSeenAt: new Date() });
  }
  // Invalidate token on client side
  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully'
  });
});

// Get current user
exports.getMe = catchAsync(async (req, res, next) => {
  res.status(200).json({
    status: 'success',
    data: { user: req.user, userType: req.userType }
  });
});

// Update password
exports.updatePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  
  let user;
  if (req.userType === 'driver') {
    user = await Driver.findById(req.user.id).select('+password');
  } else {
    user = await User.findById(req.user.id).select('+password');
  }
  
  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('Current password is incorrect', 401);
  }
  
  user.password = newPassword;
  await user.save();
  
  await createSendToken(req, user, 200, res, req.userType);
});

// Forgot password
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const normalizedEmail = req.body.email.toLowerCase().trim();

  const { account } = await findAccountByEmail(normalizedEmail);
  if (!account) {
    return res.status(200).json({
      status: 'success',
      message: 'If an account exists for that email, a password reset link has been sent.'
    });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  account.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
  account.resetPasswordExpire = Date.now() + 3600000; // 1 hour

  await account.save({ validateBeforeSave: false });

  let emailSent = false;
  try {
    await sendPasswordResetEmail(normalizedEmail, resetToken);
    emailSent = true;
  } catch (error) {
    console.error('Password reset email failed:', error.message);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Reset link: ${process.env.FRONTEND_URL}/reset-password/${resetToken}`);
    }
  }

  res.status(200).json({
    status: 'success',
    message: 'If an account exists for that email, a password reset link has been sent.',
    ...(process.env.NODE_ENV !== 'production' && !emailSent
      ? { devNote: 'Email not configured. Check server logs for the reset link.' }
      : {})
  });
});

// Reset password
exports.resetPassword = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const { account } = await findAccountByResetToken(hashedToken);

  if (!account) {
    throw new AppError('Invalid or expired token', 400);
  }

  account.password = req.body.password;
  account.resetPasswordToken = undefined;
  account.resetPasswordExpire = undefined;
  await account.save();

  res.status(200).json({
    status: 'success',
    message: 'Password reset successful. You can now sign in with your new password.'
  });
});

// Verify email
exports.verifyEmail = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  
  const user = await User.findOne({ emailVerificationToken: token });
  if (!user) {
    throw new AppError('Invalid or expired verification token', 400);
  }
  
  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  await user.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Email verified successfully'
  });
});

// Change phone number
exports.changePhone = catchAsync(async (req, res, next) => {
  const { phone } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone);
  
  const existingUser = await User.findOne({ phone: normalizedPhone });
  if (existingUser && existingUser._id.toString() !== req.user.id) {
    throw new AppError('Phone number already in use', 400);
  }
  
  req.user.phone = normalizedPhone;
  await req.user.save();
  
  res.status(200).json({
    status: 'success',
    data: { user: req.user }
  });
});

// Verify phone with OTP
exports.verifyPhone = catchAsync(async (req, res, next) => {
  const { otp } = req.body;
  
  // In production, verify OTP from SMS
  // For now, assume any 6-digit OTP works
  if (otp && otp.length === 6) {
    req.user.phoneVerified = true;
    await req.user.save();
    
    res.status(200).json({
      status: 'success',
      message: 'Phone verified successfully'
    });
  } else {
    throw new AppError('Invalid OTP', 400);
  }
});

exports.getSessions = catchAsync(async (req, res, next) => {
  const sessions = await Session.find({
    accountId: req.user.id,
    accountType: req.userType,
    isActive: true
  }).sort('-lastSeenAt');

  res.status(200).json({
    status: 'success',
    data: { sessions }
  });
});

exports.logoutSession = catchAsync(async (req, res, next) => {
  const { sessionId } = req.params;
  const session = await Session.findOneAndUpdate(
    { sessionId, accountId: req.user.id, accountType: req.userType },
    { isActive: false, lastSeenAt: new Date() },
    { new: true }
  );

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  res.status(200).json({
    status: 'success',
    message: 'Session closed successfully'
  });
});
