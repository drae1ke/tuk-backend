const User = require('../models/User');
const Ride = require('../models/Ride');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const { reverseGeocode } = require('../config/ors');

// Get user profile
exports.getUserProfile = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id);
  
  res.status(200).json({
    status: 'success',
    data: { user }
  });
});

// Update user profile
exports.updateUserProfile = catchAsync(async (req, res, next) => {
  const allowedFields = ['name', 'phone', 'profilePhoto'];
  const filteredBody = {};
  
  Object.keys(req.body).forEach(key => {
    if (allowedFields.includes(key)) {
      filteredBody[key] = req.body[key];
    }
  });
  
  const user = await User.findByIdAndUpdate(
    req.user.id,
    filteredBody,
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { user }
  });
});

// Add saved address
exports.addSavedAddress = catchAsync(async (req, res, next) => {
  const { name, address, latitude, longitude } = req.body;
  
  const user = await User.findById(req.user.id);
  
  user.savedAddresses.push({
    name,
    address,
    location: {
      type: 'Point',
      coordinates: [longitude, latitude]
    }
  });
  
  await user.save();
  
  res.status(201).json({
    status: 'success',
    data: { savedAddresses: user.savedAddresses }
  });
});

// Update saved address
exports.updateSavedAddress = catchAsync(async (req, res, next) => {
  const { addressId } = req.params;
  const { name, address, latitude, longitude } = req.body;
  
  const user = await User.findById(req.user.id);
  
  const addressIndex = user.savedAddresses.findIndex(
    addr => addr._id.toString() === addressId
  );
  
  if (addressIndex === -1) {
    return next(new AppError('Address not found', 404));
  }
  
  if (name) user.savedAddresses[addressIndex].name = name;
  if (address) user.savedAddresses[addressIndex].address = address;
  if (latitude && longitude) {
    user.savedAddresses[addressIndex].location.coordinates = [longitude, latitude];
  }
  
  await user.save();
  
  res.status(200).json({
    status: 'success',
    data: { savedAddresses: user.savedAddresses }
  });
});

// Delete saved address
exports.deleteSavedAddress = catchAsync(async (req, res, next) => {
  const { addressId } = req.params;
  
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $pull: { savedAddresses: { _id: addressId } } },
    { new: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { savedAddresses: user.savedAddresses }
  });
});

// Add payment method
exports.addPaymentMethod = catchAsync(async (req, res, next) => {
  const { type, last4, isDefault } = req.body;
  
  const user = await User.findById(req.user.id);
  
  user.paymentMethods.push({
    type,
    last4,
    isDefault: isDefault || false
  });
  
  // If this is default, unset others
  if (isDefault) {
    user.paymentMethods.forEach(method => {
      if (method._id.toString() !== user.paymentMethods[user.paymentMethods.length - 1]._id.toString()) {
        method.isDefault = false;
      }
    });
  }
  
  await user.save();
  
  res.status(201).json({
    status: 'success',
    data: { paymentMethods: user.paymentMethods }
  });
});

// Delete payment method
exports.deletePaymentMethod = catchAsync(async (req, res, next) => {
  const { methodId } = req.params;
  
  const user = await User.findById(req.user.id);
  
  user.paymentMethods = user.paymentMethods.filter(
    method => method._id.toString() !== methodId
  );
  
  await user.save();
  
  res.status(200).json({
    status: 'success',
    data: { paymentMethods: user.paymentMethods }
  });
});

// Get user stats
exports.getUserStats = catchAsync(async (req, res, next) => {
  const totalRides = await Ride.countDocuments({
    userId: req.user.id,
    status: 'completed'
  });
  
  const totalSpent = await Ride.aggregate([
    { $match: { userId: req.user._id, status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$fare' } } }
  ]);
  
  const averageRating = await Ride.aggregate([
    { $match: { userId: req.user._id, userRating: { $exists: true } } },
    { $group: { _id: null, avg: { $avg: '$userRating' } } }
  ]);
  
  res.status(200).json({
    status: 'success',
    data: {
      totalRides,
      totalSpent: totalSpent[0]?.total || 0,
      averageRating: averageRating[0]?.avg || 0,
      memberSince: req.user.createdAt
    }
  });
});

// Get recent rides
exports.getRecentRides = catchAsync(async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 5;
  
  const rides = await Ride.find({
    userId: req.user.id,
    status: 'completed'
  })
    .sort('-completedAt')
    .limit(limit)
    .populate('driverId', 'name vehicle rating');
  
  res.status(200).json({
    status: 'success',
    data: { rides }
  });
});

// Get favorite drivers
exports.getFavoriteDrivers = catchAsync(async (req, res, next) => {
  // Get drivers with highest ratings and most rides with this user
  const rides = await Ride.aggregate([
    { $match: { userId: req.user._id, status: 'completed', driverId: { $exists: true } } },
    { $group: {
        _id: '$driverId',
        rideCount: { $sum: 1 },
        averageRating: { $avg: '$driverRating' }
      }
    },
    { $sort: { rideCount: -1, averageRating: -1 } },
    { $limit: 10 }
  ]);
  
  const driverIds = rides.map(r => r._id);
  const drivers = await Driver.find({ _id: { $in: driverIds } })
    .select('name vehicle rating profilePhoto');
  
  const favoriteDrivers = drivers.map(driver => ({
    ...driver.toObject(),
    rideCount: rides.find(r => r._id.toString() === driver._id.toString())?.rideCount,
    averageRating: rides.find(r => r._id.toString() === driver._id.toString())?.averageRating
  }));
  
  res.status(200).json({
    status: 'success',
    data: { favoriteDrivers }
  });
});

// Get promo codes (if any)
exports.getPromoCodes = catchAsync(async (req, res, next) => {
  // Implement promo code logic
  res.status(200).json({
    status: 'success',
    data: { promoCodes: [] }
  });
});

// Apply promo code
exports.applyPromoCode = catchAsync(async (req, res, next) => {
  const { code, rideId } = req.body;
  
  // Implement promo code validation
  res.status(200).json({
    status: 'success',
    data: { discount: 0, message: 'Invalid promo code' }
  });
});