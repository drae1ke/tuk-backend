const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Driver = require('../models/Driver');
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
const createSendToken = (user, statusCode, res, userType = 'user') => {
  const token = signToken(user._id, userType);
  
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

// Register new user
exports.register = catchAsync(async (req, res, next) => {
  const { name, email, phone, password } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone);
  const normalizedEmail = email.toLowerCase();
  
  // Check if user exists
  const existingUser = await User.findOne({ $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] });
  if (existingUser) {
    return next(new AppError('User already exists with this email or phone', 400));
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
  
  createSendToken(user, 201, res);
});

// Login user
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();
  
  // Check if user exists
  const user = await User.findOne({ email: normalizedEmail }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('Invalid email or password', 401));
  }
  
  // Update last login
  await user.updateLastLogin();
  
  createSendToken(user, 200, res);
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
    return next(new AppError('Driver already registered with this information', 400));
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
  
  createSendToken(driver, 201, res, 'driver');
});

// Driver login
exports.driverLogin = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();
  
  const driver = await Driver.findOne({ email: normalizedEmail }).select('+password');
  if (!driver || !(await driver.comparePassword(password))) {
    return next(new AppError('Invalid email or password', 401));
  }
  
  if (driver.status !== 'active') {
    return next(new AppError(`Your account is ${driver.status}. Please contact support.`, 403));
  }
  
  driver.lastActive = new Date();
  await driver.save();
  
  createSendToken(driver, 200, res, 'driver');
});

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
      return next(new AppError('User not found', 404));
    }
    
    const newToken = signToken(user._id, decoded.userType);
    
    res.status(200).json({
      status: 'success',
      token: newToken
    });
  } catch (error) {
    return next(new AppError('Invalid refresh token', 401));
  }
});

// Logout
exports.logout = catchAsync(async (req, res, next) => {
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
    return next(new AppError('Current password is incorrect', 401));
  }
  
  user.password = newPassword;
  await user.save();
  
  createSendToken(user, 200, res, req.userType);
});

// Forgot password
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  
  const user = await User.findOne({ email });
  if (!user) {
    return next(new AppError('No user found with that email', 404));
  }
  
  const resetToken = crypto.randomBytes(32).toString('hex');
  user.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
  user.resetPasswordExpire = Date.now() + 3600000; // 1 hour
  
  await user.save({ validateBeforeSave: false });
  
  try {
    await sendPasswordResetEmail(email, resetToken);
    
    res.status(200).json({
      status: 'success',
      message: 'Password reset email sent'
    });
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save({ validateBeforeSave: false });
    
    return next(new AppError('Error sending email. Please try again later.', 500));
  }
});

// Reset password
exports.resetPassword = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');
  
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpire: { $gt: Date.now() }
  });
  
  if (!user) {
    return next(new AppError('Invalid or expired token', 400));
  }
  
  user.password = req.body.password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();
  
  createSendToken(user, 200, res);
});

// Verify email
exports.verifyEmail = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  
  const user = await User.findOne({ emailVerificationToken: token });
  if (!user) {
    return next(new AppError('Invalid or expired verification token', 400));
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
    return next(new AppError('Phone number already in use', 400));
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
    return next(new AppError('Invalid OTP', 400));
  }
});