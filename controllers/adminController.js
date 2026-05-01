const User = require('../models/User');
const Driver = require('../models/Driver');
const Ride = require('../models/Ride');
const PricingConfig = require('../models/PricingConfig');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const {
  DEFAULT_PRICING,
  getPricingConfig,
  invalidatePricingCache,
  normalizePricingConfig,
} = require('../utils/pricing');
const { runWeeklySettlement } = require('../services/commissionService');

exports.getDrivers = catchAsync(async (req, res) => {
  const drivers = await Driver.find().select('-password');

  res.status(200).json({
    status: 'success',
    data: { drivers, count: drivers.length }
  });
});

exports.getClients = catchAsync(async (req, res) => {
  const clients = await User.find({ role: 'user' }).select('-password');

  res.status(200).json({
    status: 'success',
    data: { clients, count: clients.length }
  });
});

exports.updateDriverStatus = catchAsync(async (req, res, next) => {
  const { status } = req.body;
  const validStatuses = ['active', 'pending', 'suspended', 'rejected'];
  if (!validStatuses.includes(status)) {
    return next(new AppError('Invalid driver status', 400));
  }

  const driver = await Driver.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  ).select('-password');

  if (!driver) {
    return next(new AppError('Driver not found', 404));
  }

  res.status(200).json({ status: 'success', data: { driver } });
});

exports.deleteDriver = catchAsync(async (req, res, next) => {
  const driver = await Driver.findByIdAndDelete(req.params.id);

  if (!driver) {
    return next(new AppError('Driver not found', 404));
  }

  res.status(200).json({ status: 'success', message: 'Driver deleted' });
});

exports.updateClientStatus = catchAsync(async (req, res, next) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return next(new AppError('Invalid client status value', 400));
  }

  const client = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'user' },
    { isActive },
    { new: true, runValidators: true }
  ).select('-password');

  if (!client) {
    return next(new AppError('Client not found', 404));
  }

  res.status(200).json({ status: 'success', data: { client } });
});

exports.deleteClient = catchAsync(async (req, res, next) => {
  const client = await User.findOneAndDelete({ _id: req.params.id, role: 'user' });

  if (!client) {
    return next(new AppError('Client not found', 404));
  }

  res.status(200).json({ status: 'success', message: 'Client deleted' });
});

exports.getDashboardStats = catchAsync(async (req, res) => {
  const [drivers, clients, rides, completedRevenueAgg, pendingRides, onlineDrivers] = await Promise.all([
    Driver.countDocuments(),
    User.countDocuments({ role: 'user' }),
    Ride.countDocuments(),
    Ride.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$fare' } } }
    ]),
    Ride.countDocuments({ status: { $in: ['pending', 'accepted', 'arrived', 'started'] } }),
    Driver.countDocuments({ online: true, status: 'active', commissionAccountStatus: 'active' })
  ]);

  const recentRides = await Ride.find()
    .sort('-createdAt')
    .limit(8)
    .populate('userId', 'name')
    .populate('driverId', 'name vehicle');

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalDrivers: drivers,
        totalClients: clients,
        totalRides: rides,
        revenue: completedRevenueAgg[0]?.total || 0,
        pendingRides,
        onlineDrivers
      },
      recentRides
    }
  });
});

exports.getPricing = catchAsync(async (req, res) => {
  const pricing = await getPricingConfig();

  res.status(200).json({
    status: 'success',
    data: { pricing }
  });
});

exports.updatePricing = catchAsync(async (req, res) => {
  let pricing = await PricingConfig.findOne().sort('-updatedAt');
  if (!pricing) {
    pricing = await PricingConfig.create(DEFAULT_PRICING);
  }

  const allowedFields = ['baseFare', 'bookingFee', 'perKm', 'perMinute', 'minimumFare', 'cancellationFee', 'nightSurcharge', 'cbdSurcharge', 'trafficMultiplier', 'demandMultiplier'];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      pricing[field] = req.body[field];
    }
  });

  Object.assign(pricing, normalizePricingConfig(pricing.toObject()));
  await pricing.save();
  invalidatePricingCache();
  const normalizedPricing = await getPricingConfig();

  res.status(200).json({
    status: 'success',
    data: { pricing: normalizedPricing }
  });
});

exports.runWeeklySettlement = catchAsync(async (req, res) => {
  const result = await runWeeklySettlement({
    referenceDate: new Date(),
    targetWeekStart: req.body?.weekStart || null,
    triggeredBy: 'admin'
  });

  res.status(200).json({
    status: 'success',
    data: result
  });
});
