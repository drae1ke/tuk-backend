/**
 * controllers/paymentController.js
 *
 * Handles:
 *   POST /payments/stkpush          — driver initiates commission payment
 *   POST /payments/callback         — M-Pesa Daraja callback (public)
 *   POST /payments/mpesa-callback   — alias kept for backwards compat
 *   GET  /payments/commission/history
 *   POST /payments/mpesa            — ride payment (user → rider)
 *   POST /payments/cash             — cash ride payment confirmation
 *   GET  /payments/history          — user payment history
 *   GET  /payments/:paymentId       — single payment detail
 *   POST /payments/refund           — refund request
 */

'use strict';

const Payment = require('../models/Payment');
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const PaymentTransaction = require('../models/PaymentTransaction');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const {
  getDriverCommissionSnapshot,
  handleCommissionPaymentCallback,
  initiateCommissionPayment,
} = require('../services/commissionService');
const {
  isCallbackAuthorized,
  parseStkPushCallback,
} = require('../services/mpesaService');

// ── Commission payment (driver) ───────────────────────────────────────────────

exports.initiateCommissionStkPush = catchAsync(async (req, res, next) => {
  if (req.userType !== 'driver') {
    return next(new AppError('Only drivers can pay commission via this endpoint', 403));
  }

  const idempotencyKey = req.headers['x-idempotency-key'] || null;

  const { transaction, reused } = await initiateCommissionPayment({
    driverId: req.user.id,
    requestSource: 'driver',
    idempotencyKey,
  });

  const snapshot = await getDriverCommissionSnapshot(req.user.id);

  return res.status(200).json({
    status: 'success',
    message: reused
      ? 'A commission payment is already pending — check your phone for the M-Pesa prompt.'
      : 'STK Push sent. Enter your M-Pesa PIN to complete payment.',
    data: { transaction, commission: snapshot },
  });
});

exports.getCommissionPaymentHistory = catchAsync(async (req, res, next) => {
  if (req.userType !== 'driver') {
    return next(new AppError('Only drivers can access this endpoint', 403));
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);

  const [transactions, total] = await Promise.all([
    PaymentTransaction.find({ driverId: req.user.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PaymentTransaction.countDocuments({ driverId: req.user.id }),
  ]);

  return res.status(200).json({
    status: 'success',
    data: {
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
});

// ── M-Pesa callbacks (public — no auth) ──────────────────────────────────────

/**
 * Commission payment callback from Daraja.
 * Daraja requires a 200 response with ResultCode: 0 even on our internal errors.
 */
exports.commissionCallback = async (req, res) => {
  if (!isCallbackAuthorized(req)) {
    return res.status(200).json({ ResultCode: 1, ResultDesc: 'Unauthorized' });
  }

  try {
    const callback = parseStkPushCallback(req.body);
    await handleCommissionPaymentCallback(callback);
  } catch (err) {
    // Log but always return 200 so Daraja doesn't retry indefinitely
    console.error('Commission callback error:', err.message);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

/**
 * Generic M-Pesa STK Push callback (ride payments).
 * Kept for ride payment flows triggered outside the commission path.
 */
exports.mpesaCallback = catchAsync(async (req, res) => {
  if (!isCallbackAuthorized(req)) {
    return res.status(200).json({ ResultCode: 1, ResultDesc: 'Unauthorized' });
  }

  const { Body: { stkCallback } = {} } = req.body || {};
  if (!stkCallback) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Ignored — no stkCallback' });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

  const payment = await Payment.findOne({ mpesaCheckoutRequestID: CheckoutRequestID });
  if (!payment) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment not found' });
  }

  if (Number(ResultCode) === 0) {
    const meta = {};
    (CallbackMetadata?.Item || []).forEach((item) => {
      meta[item.Name] = item.Value;
    });
    payment.status = 'completed';
    payment.completedAt = new Date();
    payment.mpesaReceiptNumber = meta.MpesaReceiptNumber;
    payment.metadata = meta;
    await payment.save();

    await Ride.findByIdAndUpdate(payment.rideId, {
      paymentMethod: 'mpesa',
      paymentStatus: 'paid',
      paymentId: payment._id,
    });
  } else {
    payment.status = 'failed';
    payment.failureReason = ResultDesc;
    await payment.save();
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ── Ride payment (user) ───────────────────────────────────────────────────────

exports.initiateMpesaPayment = catchAsync(async (req, res, next) => {
  const { rideId, phoneNumber } = req.body;

  const ride = await Ride.findById(rideId);
  if (!ride) return next(new AppError('Ride not found', 404));
  if (ride.userId.toString() !== req.user.id)
    return next(new AppError('Not authorized', 403));
  if (ride.paymentStatus === 'paid')
    return next(new AppError('Ride is already paid', 400));

  const payment = await Payment.create({
    rideId: ride._id,
    userId: req.user.id,
    driverId: ride.driverId,
    amount: ride.fare,
    method: 'mpesa',
    status: 'processing',
  });

  // In sandbox/dev we return a mock; in production this calls real Daraja
  const checkoutRequestId = `CHECKOUT-${Date.now()}`;
  const merchantRequestId = `MERCH-${Date.now()}`;

  payment.mpesaCheckoutRequestID = checkoutRequestId;
  payment.mpesaMerchantRequestID = merchantRequestId;
  await payment.save();

  return res.status(200).json({
    status: 'success',
    message: 'M-Pesa STK Push sent. Enter your PIN to complete payment.',
    data: { paymentId: payment._id, checkoutRequestId },
  });
});

exports.processCashPayment = catchAsync(async (req, res, next) => {
  const { rideId } = req.body;

  const ride = await Ride.findById(rideId);
  if (!ride) return next(new AppError('Ride not found', 404));
  if (ride.userId.toString() !== req.user.id)
    return next(new AppError('Not authorized', 403));
  if (ride.paymentStatus === 'paid')
    return next(new AppError('Ride is already paid', 400));

  const payment = await Payment.create({
    rideId: ride._id,
    userId: req.user.id,
    driverId: ride.driverId,
    amount: ride.fare,
    method: 'cash',
    status: 'completed',
    completedAt: new Date(),
  });

  await Ride.findByIdAndUpdate(rideId, {
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paymentId: payment._id,
  });

  return res.status(200).json({ status: 'success', data: { payment } });
});

exports.getPaymentHistory = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);

  const [payments, total] = await Promise.all([
    Payment.find({ userId: req.user.id })
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('rideId', 'pickupLocation destination distance duration'),
    Payment.countDocuments({ userId: req.user.id }),
  ]);

  return res.status(200).json({
    status: 'success',
    data: { payments, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

exports.getPaymentDetails = catchAsync(async (req, res, next) => {
  const payment = await Payment.findById(req.params.paymentId)
    .populate('rideId', 'pickupLocation destination distance duration status')
    .populate('driverId', 'name vehicle');

  if (!payment) return next(new AppError('Payment not found', 404));
  if (payment.userId.toString() !== req.user.id && req.user.role !== 'admin') {
    return next(new AppError('Not authorized', 403));
  }

  return res.status(200).json({ status: 'success', data: { payment } });
});

exports.requestRefund = catchAsync(async (req, res, next) => {
  const { paymentId, reason } = req.body;

  const payment = await Payment.findById(paymentId);
  if (!payment) return next(new AppError('Payment not found', 404));
  if (payment.userId.toString() !== req.user.id)
    return next(new AppError('Not authorized', 403));
  if (payment.status !== 'completed')
    return next(new AppError('Only completed payments can be refunded', 400));
  if (payment.refundedAt)
    return next(new AppError('Payment has already been refunded', 400));

  payment.status = 'refunded';
  payment.refundAmount = payment.amount;
  payment.refundReason = reason;
  payment.refundedAt = new Date();
  await payment.save();

  return res.status(200).json({
    status: 'success',
    message: 'Refund processed successfully',
    data: { payment },
  });
});
