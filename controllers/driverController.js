const Driver = require('../models/Driver');
const Ride = require('../models/Ride');
const { getIsochrones, reverseGeocode } = require('../config/ors');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const { calculateDistance } = require('../utils/geoUtils');
const { getDriverCommissionSnapshot } = require('../services/commissionService');

// Get driver profile
exports.getDriverProfile = catchAsync(async (req, res, next) => {
  const driver = await Driver.findById(req.user.id)
    .populate('currentRide', 'status pickupLocation destination');
  const completedToday = await Ride.countDocuments({
    driverId: req.user.id,
    status: 'completed',
    completedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
  });
  
  res.status(200).json({
    status: 'success',
    data: {
      driver,
      summary: {
        completedToday,
        totalEarnings: driver.totalEarnings,
        totalRides: driver.totalRides,
        rating: driver.rating
      }
    }
  });
});

// Update driver profile
exports.updateDriverProfile = catchAsync(async (req, res, next) => {
  const allowedFields = ['name', 'phone', 'profilePhoto', 'bio', 'mpesaNumber', 'operatingCity', 'serviceAreas', 'emergencyContact'];
  const filteredBody = {};
  
  Object.keys(req.body).forEach(key => {
    if (allowedFields.includes(key)) {
      filteredBody[key] = req.body[key];
    }
  });
  
  const driver = await Driver.findByIdAndUpdate(
    req.user.id,
    filteredBody,
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { driver }
  });
});

// Update driver location
exports.updateLocation = catchAsync(async (req, res, next) => {
  const { latitude, longitude, heading, speed, accuracy } = req.body;
  
  const driver = await Driver.findByIdAndUpdate(
    req.user.id,
    {
      'currentLocation.coordinates': [longitude, latitude],
      lastLocationUpdate: new Date(),
      heading,
      speed,
      accuracy
    },
    { new: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { location: driver.currentLocation }
  });
});

// Update online status
exports.updateOnlineStatus = catchAsync(async (req, res, next) => {
  const { online } = req.body;
  const driver = await Driver.findById(req.user.id);

  if (!driver) {
    return next(new AppError('Driver not found', 404));
  }

  const canReceiveRequests = driver.status === 'active' && driver.commissionAccountStatus === 'active';
  
  const updatedDriver = await Driver.findByIdAndUpdate(
    req.user.id,
    { 
      online,
      available: online && canReceiveRequests && !driver.currentRide,
      lastActive: new Date()
    },
    { new: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: {
      online: updatedDriver.online,
      available: updatedDriver.available,
      commissionAccountStatus: updatedDriver.commissionAccountStatus
    }
  });
});

// Update vehicle details
exports.updateVehicle = catchAsync(async (req, res, next) => {
  const allowedFields = ['make', 'model', 'year', 'color', 'plateNumber', 'type', 'capacity'];
  const vehicleUpdates = {};
  
  Object.keys(req.body).forEach(key => {
    if (allowedFields.includes(key)) {
      vehicleUpdates[`vehicle.${key}`] = req.body[key];
    }
  });
  
  const driver = await Driver.findByIdAndUpdate(
    req.user.id,
    vehicleUpdates,
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { vehicle: driver.vehicle }
  });
});

// Get driver earnings
exports.getEarnings = catchAsync(async (req, res, next) => {
  const { period = 'week' } = req.query;
  
  let startDate;
  const now = new Date();
  
  switch (period) {
    case 'day':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case 'week':
      startDate = new Date(now.setDate(now.getDate() - now.getDay()));
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default:
      startDate = new Date(now.setDate(now.getDate() - 7));
  }
  
  const rides = await Ride.find({
    driverId: req.user.id,
    status: 'completed',
    completedAt: { $gte: startDate }
  });
  
  const totalEarnings = rides.reduce((sum, ride) => sum + ride.fare, 0);
  const totalRides = rides.length;
  const averageFare = totalRides > 0 ? totalEarnings / totalRides : 0;
  
  // Daily breakdown
  const dailyEarnings = {};
  rides.forEach(ride => {
    const date = ride.completedAt.toISOString().split('T')[0];
    dailyEarnings[date] = (dailyEarnings[date] || 0) + ride.fare;
  });
  
  res.status(200).json({
    status: 'success',
    data: {
      period,
      totalEarnings,
      totalRides,
      averageFare,
      dailyBreakdown: dailyEarnings,
      rides
    }
  });
});

// Get driver stats
exports.getStats = catchAsync(async (req, res, next) => {
  const driver = await Driver.findById(req.user.id);
  
  const totalRides = await Ride.countDocuments({
    driverId: req.user.id,
    status: 'completed'
  });
  
  const avgRating = driver.rating;
  const acceptanceRate = await calculateAcceptanceRate(req.user.id);
  const cancellationRate = await calculateCancellationRate(req.user.id);
  
  res.status(200).json({
    status: 'success',
    data: {
      totalRides,
      totalEarnings: driver.totalEarnings,
      weeklyCommissionBalance: driver.weeklyCommissionBalance,
      outstandingCommissionBalance: driver.outstandingCommissionBalance,
      rating: avgRating,
      acceptanceRate,
      cancellationRate,
      onlineStatus: driver.online,
      availability: driver.available
    }
  });
});

// Helper functions
const calculateAcceptanceRate = async (driverId) => {
  const totalRequests = await Ride.countDocuments({
    driverId,
    status: { $in: ['accepted', 'cancelled'] }
  });
  
  const accepted = await Ride.countDocuments({
    driverId,
    status: 'accepted'
  });
  
  return totalRequests > 0 ? (accepted / totalRequests) * 100 : 0;
};

const calculateCancellationRate = async (driverId) => {
  const total = await Ride.countDocuments({
    driverId,
    status: { $in: ['completed', 'cancelled'] }
  });
  
  const cancelled = await Ride.countDocuments({
    driverId,
    status: 'cancelled',
    cancelledBy: 'driver'
  });
  
  return total > 0 ? (cancelled / total) * 100 : 0;
};

// Get nearby drivers
exports.getNearbyDrivers = catchAsync(async (req, res, next) => {
  const { latitude, longitude, radius = 3 } = req.query;
  
  const drivers = await Driver.find({
    online: true,
    available: true,
    status: 'active',
    commissionAccountStatus: 'active',
    'currentLocation.coordinates': {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [parseFloat(longitude), parseFloat(latitude)]
        },
        $maxDistance: radius * 1000 // Convert km to meters
      }
    }
  }).limit(20).select('name phone rating vehicle currentLocation lastLocationUpdate operatingCity');

  res.status(200).json({
    status: 'success',
    data: {
      drivers: drivers.map((driver) => {
        const [lng, lat] = driver.currentLocation.coordinates;
        const distanceKm = calculateDistance(parseFloat(latitude), parseFloat(longitude), lat, lng);
        return {
          id: driver._id,
          name: driver.name,
          phone: driver.phone,
          rating: driver.rating,
          vehicle: driver.vehicle,
          operatingCity: driver.operatingCity,
          distanceKm: Number(distanceKm.toFixed(2)),
          currentLocation: driver.currentLocation,
          lastLocationUpdate: driver.lastLocationUpdate
        };
      }),
      count: drivers.length
    }
  });
});

// Get driver availability zones (isochrones)
exports.getAvailabilityZones = catchAsync(async (req, res, next) => {
  const { latitude, longitude, range = 15 } = req.query;
  
  const isochrones = await getIsochrones(
    [parseFloat(longitude), parseFloat(latitude)],
    parseInt(range),
    'time'
  );
  
  res.status(200).json({
    status: 'success',
    data: { isochrones }
  });
});

// Update documents
exports.updateDocuments = catchAsync(async (req, res, next) => {
  const { nationalId, drivingLicense, insurance, inspection } = req.body;
  
  const driver = await Driver.findById(req.user.id);
  
  if (nationalId) driver.documents.nationalId = nationalId;
  if (drivingLicense) driver.documents.drivingLicense = drivingLicense;
  if (insurance) driver.documents.insurance = insurance;
  if (inspection) driver.documents.inspection = inspection;
  
  await driver.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Documents updated successfully',
    data: { documents: driver.documents }
  });
});

// Update bank details
exports.updateBankDetails = catchAsync(async (req, res, next) => {
  const { bankName, accountNumber, accountName } = req.body;
  
  const driver = await Driver.findByIdAndUpdate(
    req.user.id,
    {
      bankDetails: { bankName, accountNumber, accountName }
    },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { bankDetails: driver.bankDetails }
  });
});

// Update M-Pesa number
exports.updateMpesaNumber = catchAsync(async (req, res, next) => {
  const { mpesaNumber } = req.body;
  
  const driver = await Driver.findByIdAndUpdate(
    req.user.id,
    { mpesaNumber },
    { new: true }
  );
  
  res.status(200).json({
    status: 'success',
    data: { mpesaNumber: driver.mpesaNumber }
  });
});

exports.getCommissionSummary = catchAsync(async (req, res) => {
  const summary = await getDriverCommissionSnapshot(req.user.id);

  res.status(200).json({
    status: 'success',
    data: summary
  });
});

exports.getDriverStatus = catchAsync(async (req, res) => {
  const summary = await getDriverCommissionSnapshot(req.user.id);

  res.status(200).json({
    status: 'success',
    data: {
      onboardingStatus: summary.onboardingStatus,
      accountStatus: summary.accountStatus,
      canReceiveRideRequests: summary.canReceiveRideRequests,
      outstandingBalance: summary.outstanding.totalDue,
      graceEndsAt: summary.outstanding.graceEndsAt,
      lastPaymentDate: summary.lastPaymentDate
    }
  });
});
