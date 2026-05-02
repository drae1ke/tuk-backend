const Ride = require('../models/Ride');
const User = require('../models/User');
const Driver = require('../models/Driver');
const { getDirections } = require('../config/ors');
const { getPricingConfig, calculateRidePricing } = require('../utils/pricing');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const { recordRideCommission, refreshDriverCommissionState } = require('../services/commissionService');

const mapRideSummary = (ride) => ({
  id: ride._id,
  fare: ride.fare,
  distance: ride.distance,
  duration: ride.duration,
  status: ride.status,
  createdAt: ride.createdAt,
  pickupLocation: ride.pickupLocation,
  destination: ride.destination,
  paymentMethod: ride.paymentMethod,
  paymentStatus: ride.paymentStatus,
  vehicleType: ride.vehicleType,
  pricingBreakdown: ride.pricingBreakdown,
  driverId: ride.driverId,
  userId: ride.userId
});
// Estimate fare before requesting a ride
exports.estimateRide = catchAsync(async (req, res, next) => {
  const { pickup, destination, vehicleType } = req.body;

  try {
    const start = [pickup.longitude, pickup.latitude];
    const end = [destination.longitude, destination.latitude];

    const route = await getDirections(start, end);
    const distance = route.distance / 1000;
    const duration = route.duration / 60;
    const pricing = await calculateRidePricing({
      distanceKm: distance,
      durationMinutes: duration,
      pickupAddress: pickup.address,
      destinationAddress: destination.address
    });
    const nearbyDrivers = await Driver.find({
      online: true,
      available: true,
      status: 'active',
      commissionAccountStatus: 'active',
      currentLocation: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [pickup.longitude, pickup.latitude]
          },
          $maxDistance: 4000
        }
      }
    }).limit(6).select('name rating vehicle currentLocation lastLocationUpdate');

    res.status(200).json({
      status: 'success',
      data: {
        estimate: {
          fare: pricing.fare,
          distance,
          duration,
          currency: pricing.breakdown.currency,
          vehicleType: vehicleType || 'standard',
          pricingBreakdown: pricing.breakdown,
          pickup: {
            latitude: pickup.latitude,
            longitude: pickup.longitude,
            address: pickup.address || 'Pickup Location'
          },
          destination: {
            latitude: destination.latitude,
            longitude: destination.longitude,
            address: destination.address || 'Destination'
          },
          nearbyDrivers: nearbyDrivers.map((driver) => ({
            id: driver._id,
            name: driver.name,
            rating: driver.rating,
            vehicle: driver.vehicle,
            currentLocation: driver.currentLocation,
            lastLocationUpdate: driver.lastLocationUpdate
          }))
        }
      }
    });
  } catch (error) {
    return next(new AppError(`Failed to estimate ride: ${error.message}`, 500));
  }
});

// Request a ride
exports.requestRide = catchAsync(async (req, res, next) => {
  const { pickup, destination, vehicleType } = req.body;
  
  console.log('📝 Ride request received:', { pickup, destination });
  
  try {
    const start = [pickup.longitude, pickup.latitude];
    const end = [destination.longitude, destination.latitude];
    
    const route = await getDirections(start, end);
    
    const distance = route.distance / 1000;
    const duration = route.duration / 60;
    const pricing = await calculateRidePricing({
      distanceKm: distance,
      durationMinutes: duration,
      pickupAddress: pickup.address,
      destinationAddress: destination.address
    });
    
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
      fare: pricing.fare,
      pricingBreakdown: pricing.breakdown,
      vehicleType: vehicleType || 'standard',
      status: 'pending',
      timeline: [{ status: 'pending', note: 'Ride requested' }]
    });
    
    res.status(201).json({
      status: 'success',
      data: {
        ride: {
          id: ride._id,
          fare: ride.fare,
          distance: ride.distance,
          duration: ride.duration,
          status: ride.status,
          vehicleType: ride.vehicleType,
          paymentMethod: ride.paymentMethod,
          pricingBreakdown: ride.pricingBreakdown
        }
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
  
  await refreshDriverCommissionState(req.user.id);
  const driver = await Driver.findById(req.user.id);
  if (!driver) {
    return next(new AppError('Driver not found', 404));
  }
  if (!driver.online || !driver.available) {
    return next(new AppError('You are not available for rides', 400));
  }

  if (driver.status !== 'active' || driver.commissionAccountStatus !== 'active') {
    return next(new AppError('Your account is restricted from receiving new rides', 403));
  }
  
  ride.driverId = driver._id;
  ride.status = 'accepted';
  ride.acceptedAt = new Date();
  ride.timeline.push({ status: 'accepted', note: 'Ride accepted by driver' });
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
  ride.timeline.push({ status: 'cancelled', note: reason || 'Ride cancelled' });
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

// Get pricing config for riders
exports.getPricingConfig = catchAsync(async (req, res) => {
  const pricing = await getPricingConfig();

  res.status(200).json({
    status: 'success',
    data: { pricing }
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
      path: ride.path?.slice(-50) || [],
      pricingBreakdown: ride.pricingBreakdown
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
      rides: rides.map(mapRideSummary), 
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
      rides: rides.map(mapRideSummary), 
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
  await refreshDriverCommissionState(req.user.id);
  const driver = await Driver.findById(req.user.id);
  if (!driver) {
    return next(new AppError('Driver not found', 404));
  }
  
  if (!driver.online || !driver.available) {
    return next(new AppError('You must be online and available to see rides', 400));
  }

  if (driver.status !== 'active' || driver.commissionAccountStatus !== 'active') {
    return next(new AppError('Your account is restricted from receiving new ride requests', 403));
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
  ride.timeline.push({ status: 'arrived', note: 'Driver arrived at pickup' });
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
  ride.timeline.push({ status: 'started', note: 'Ride started' });
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
  ride.paymentStatus = 'pending';
  ride.timeline.push({ status: 'completed', note: 'Ride completed' });
  
  await ride.save();
  
  const driver = await Driver.findById(req.user.id);
  driver.available = true;
  driver.currentRide = null;
  driver.totalRides += 1;
  driver.totalEarnings += ride.fare;
  await driver.save();

  await User.findByIdAndUpdate(ride.userId, {
    $inc: { totalRides: 1, totalSpent: ride.fare }
  });
  // Record commission - this updates the weekly balance
  
  try {
    await recordRideCommission(ride);
  } catch (error) {
    console.error('❌ Commission accrual failed after ride completion:', {
      rideId: ride._id,
      driverId: ride.driverId,
      errorMessage: error.message,
      errorStack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
  
  res.status(200).json({
    status: 'success',
    data: { ride }
  });
});

exports.completeRideByBody = catchAsync(async (req, res, next) => {
  req.params.rideId = req.body.rideId;
  return exports.completeRide(req, res, next);
});

exports.getNearbyDriverPreview = catchAsync(async (req, res, next) => {
  const { latitude, longitude, radius = 4 } = req.query;

  const drivers = await Driver.find({
    online: true,
    available: true,
    status: 'active',
    commissionAccountStatus: 'active',
    currentLocation: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [parseFloat(longitude), parseFloat(latitude)]
        },
        $maxDistance: parseFloat(radius) * 1000
      }
    }
  }).limit(8).select('name rating vehicle currentLocation lastLocationUpdate');

  res.status(200).json({
    status: 'success',
    data: {
      drivers,
      count: drivers.length
    }
  });
});

exports.getRideMessages = catchAsync(async (req, res, next) => {
  const ride = await Ride.findById(req.params.rideId).select('userId driverId messages');
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }

  const isParticipant =
    ride.userId.toString() === req.user.id ||
    ride.driverId?.toString() === req.user.id;

  if (!isParticipant && req.user.role !== 'admin') {
    return next(new AppError('Not authorized to view ride messages', 403));
  }

  res.status(200).json({
    status: 'success',
    data: { messages: ride.messages || [] }
  });
});

exports.sendRideMessage = catchAsync(async (req, res, next) => {
  const { text } = req.body;
  const ride = await Ride.findById(req.params.rideId).select('userId driverId status messages');
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }

  const isParticipant =
    ride.userId.toString() === req.user.id ||
    ride.driverId?.toString() === req.user.id;

  if (!isParticipant && req.user.role !== 'admin') {
    return next(new AppError('Not authorized to message on this ride', 403));
  }

  const message = {
    senderType: req.user.role === 'admin' ? 'admin' : req.userType,
    senderId: req.user._id,
    text
  };

  ride.messages.push(message);
  await ride.save();

  res.status(201).json({
    status: 'success',
    data: { message: ride.messages[ride.messages.length - 1] }
  });
});
