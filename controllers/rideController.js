const Ride = require('../models/Ride');
const User = require('../models/User');
const Driver = require('../models/Driver');
const { getDirections, calculateFare } = require('../config/ors');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');

// Request a ride
exports.requestRide = catchAsync(async (req, res, next) => {
  const { pickup, destination, vehicleType, paymentMethod } = req.body;
  
  console.log('📝 Ride request received:', { pickup, destination });
  
  try {
    const start = [pickup.longitude, pickup.latitude];
    const end = [destination.longitude, destination.latitude];
    
    const route = await getDirections(start, end);
    
    const distance = route.distance / 1000;
    const duration = route.duration / 60;
    const fare = calculateFare(distance);
    
    const ride = await Ride.create({
      userId: req.user.id,
      pickupLocation: {
        type: 'Point',
        coordinates: [pickup.longitude, pickup.latitude],
        address: pickup.address || 'Pickup Location'
      },
      destination: {
        type: 'Point',
        coordinates: [destination.longitude, destination.latitude],
        address: destination.address || 'Destination'
      },
      distance,
      duration,
      fare,
      vehicleType: vehicleType || 'standard',
      paymentMethod: paymentMethod || 'cash',
      status: 'pending'
    });
    
    res.status(201).json({
      status: 'success',
      data: {
        rideId: ride._id,
        fare: ride.fare,
        distance: ride.distance,
        duration: ride.duration,
        status: ride.status
      }
    });
  } catch (error) {
    console.error('❌ Ride request failed:', error);
    return next(new AppError('Failed to calculate route: ' + error.message, 500));
  }
});

// Accept ride (driver)
exports.acceptRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId);
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.status !== 'pending') {
    return next(new AppError('Ride is no longer available', 400));
  }
  
  const driver = await Driver.findById(req.user.id);
  if (!driver.online || !driver.available) {
    return next(new AppError('You are not available for rides', 400));
  }
  
  ride.driverId = driver._id;
  ride.status = 'accepted';
  ride.acceptedAt = new Date();
  await ride.save();
  
  driver.available = false;
  driver.currentRide = ride._id;
  await driver.save();
  
  res.status(200).json({
    status: 'success',
    data: { ride }
  });
});

// Get ride details
exports.getRideDetails = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId)
    .populate('userId', 'name phone rating')
    .populate('driverId', 'name phone rating vehicle profilePhoto');
  
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.userId._id.toString() !== req.user.id && 
      ride.driverId?._id.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }
  
  res.status(200).json({
    status: 'success',
    data: { ride }
  });
});

// Cancel ride
exports.cancelRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  const { reason } = req.body;
  
  const ride = await Ride.findById(rideId);
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (!['pending', 'accepted'].includes(ride.status)) {
    return next(new AppError('Cannot cancel ride at this stage', 400));
  }
  
  ride.status = 'cancelled';
  ride.cancelledAt = new Date();
  ride.cancellationReason = reason;
  ride.cancelledBy = req.userType;
  await ride.save();
  
  if (ride.driverId) {
    await Driver.findByIdAndUpdate(ride.driverId, {
      available: true,
      currentRide: null
    });
  }
  
  res.status(200).json({
    status: 'success',
    message: 'Ride cancelled successfully'
  });
});

// Rate ride
exports.rateRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  const { rating, feedback } = req.body;
  
  const ride = await Ride.findById(rideId);
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.status !== 'completed') {
    return next(new AppError('Can only rate completed rides', 400));
  }
  
  if (req.userType === 'user') {
    if (ride.userRating) {
      return next(new AppError('You have already rated this ride', 400));
    }
    ride.userRating = rating;
    ride.userFeedback = feedback;
    
    const driver = await Driver.findById(ride.driverId);
    if (driver) {
      driver.rating = (driver.rating * driver.ratingCount + rating) / (driver.ratingCount + 1);
      driver.ratingCount += 1;
      await driver.save();
    }
  } else {
    if (ride.driverRating) {
      return next(new AppError('You have already rated this ride', 400));
    }
    ride.driverRating = rating;
    ride.driverFeedback = feedback;
  }
  
  await ride.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Rating submitted successfully'
  });
});

// Track ride
exports.trackRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId)
    .populate('driverId', 'currentLocation vehicle');
  
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.userId.toString() !== req.user.id && 
      ride.driverId?._id.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }
  
  res.status(200).json({
    status: 'success',
    data: {
      status: ride.status,
      driverLocation: ride.driverId?.currentLocation,
      pickupLocation: ride.pickupLocation,
      destination: ride.destination,
      path: ride.path?.slice(-50) || []
    }
  });
});

// Get user ride history
exports.getUserRideHistory = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  
  const rides = await Ride.find({ userId: req.user.id })
    .sort('-createdAt')
    .skip(skip)
    .limit(limit)
    .populate('driverId', 'name vehicle rating');
  
  const total = await Ride.countDocuments({ userId: req.user.id });
  
  res.status(200).json({
    status: 'success',
    data: { 
      rides, 
      pagination: { 
        page, 
        limit, 
        total, 
        pages: Math.ceil(total / limit) 
      } 
    }
  });
});

// Get driver ride history
exports.getDriverRideHistory = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  
  const rides = await Ride.find({ driverId: req.user.id })
    .sort('-createdAt')
    .skip(skip)
    .limit(limit)
    .populate('userId', 'name phone rating');
  
  const total = await Ride.countDocuments({ driverId: req.user.id });
  
  res.status(200).json({
    status: 'success',
    data: { 
      rides, 
      pagination: { 
        page, 
        limit, 
        total, 
        pages: Math.ceil(total / limit) 
      } 
    }
  });
});

// Get current user ride
exports.getCurrentUserRide = catchAsync(async (req, res, next) => {
  const ride = await Ride.findOne({
    userId: req.user.id,
    status: { $in: ['pending', 'accepted', 'arrived', 'started'] }
  }).populate('driverId', 'name phone rating vehicle currentLocation');
  
  res.status(200).json({
    status: 'success',
    data: { ride: ride || null }
  });
});

// Get current driver ride
exports.getCurrentDriverRide = catchAsync(async (req, res, next) => {
  const ride = await Ride.findOne({
    driverId: req.user.id,
    status: { $in: ['accepted', 'arrived', 'started'] }
  }).populate('userId', 'name phone rating');
  
  res.status(200).json({
    status: 'success',
    data: { ride: ride || null }
  });
});

// Get available rides for driver
exports.getAvailableRides = catchAsync(async (req, res, next) => {
  const driver = await Driver.findById(req.user.id);
  
  if (!driver.online || !driver.available) {
    return next(new AppError('You must be online and available to see rides', 400));
  }
  
  const rides = await Ride.find({
    status: 'pending',
    'pickupLocation.coordinates': {
      $near: {
        $geometry: driver.currentLocation,
        $maxDistance: 5000
      }
    }
  }).limit(20);
  
  res.status(200).json({
    status: 'success',
    data: { rides }
  });
});

// Arrive at pickup
exports.arriveAtPickup = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId);
  if (!ride || ride.driverId.toString() !== req.user.id) {
    return next(new AppError('Ride not found or not assigned to you', 404));
  }
  
  if (ride.status !== 'accepted') {
    return next(new AppError('Cannot arrive at pickup now', 400));
  }
  
  ride.status = 'arrived';
  ride.arrivedAt = new Date();
  await ride.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Arrived at pickup location'
  });
});

// Start ride
exports.startRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId);
  if (!ride || ride.driverId.toString() !== req.user.id) {
    return next(new AppError('Ride not found or not assigned to you', 404));
  }
  
  if (ride.status !== 'arrived') {
    return next(new AppError('Cannot start ride now', 400));
  }
  
  ride.status = 'started';
  ride.startedAt = new Date();
  await ride.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Ride started'
  });
});

// Complete ride
exports.completeRide = catchAsync(async (req, res, next) => {
  const { rideId } = req.params;
  
  const ride = await Ride.findById(rideId);
  if (!ride || ride.driverId.toString() !== req.user.id) {
    return next(new AppError('Ride not found or not assigned to you', 404));
  }
  
  if (ride.status !== 'started') {
    return next(new AppError('Cannot complete ride now', 400));
  }
  
  ride.status = 'completed';
  ride.completedAt = new Date();
  await ride.save();
  
  const driver = await Driver.findById(req.user.id);
  driver.available = true;
  driver.currentRide = null;
  driver.totalRides += 1;
  driver.totalEarnings += ride.fare;
  await driver.save();
  
  res.status(200).json({
    status: 'success',
    data: { ride }
  });
});