const Payment = require('../models/Payment');
const Ride = require('../models/Ride');
const User = require('../models/User');
const Driver = require('../models/Driver');
const PaymentTransaction = require('../models/PaymentTransaction');
const { AppError } = require('../middleware/errorMiddleware');
const catchAsync = require('../utils/catchAsync');
const axios = require('axios');
const { getDriverCommissionSnapshot, handleCommissionPaymentCallback, initiateCommissionPayment } = require('../services/commissionService');
const { isCallbackAuthorized, parseStkPushCallback } = require('../services/mpesaService');

// Initialize M-Pesa payment
exports.initiateMpesaPayment = catchAsync(async (req, res, next) => {
  const { rideId, phoneNumber } = req.body;
  
  const ride = await Ride.findById(rideId);
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.userId.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }
  
  if (ride.paymentStatus === 'paid') {
    return next(new AppError('Ride already paid', 400));
  }
  
  // Create payment record
  const payment = await Payment.create({
    rideId: ride._id,
    userId: req.user.id,
    driverId: ride.driverId,
    amount: ride.fare,
    method: 'mpesa',
    status: 'processing'
  });
  
  // In production, integrate with M-Pesa API
  // This is a placeholder for M-Pesa STK Push
  const mpesaResponse = await initiateMpesaSTKPush(
    phoneNumber || req.user.phone,
    ride.fare,
    payment._id.toString()
  );
  
  payment.mpesaCheckoutRequestID = mpesaResponse.CheckoutRequestID;
  payment.mpesaMerchantRequestID = mpesaResponse.MerchantRequestID;
  await payment.save();
  
  res.status(200).json({
    status: 'success',
    message: 'M-Pesa payment initiated',
    data: {
      paymentId: payment._id,
      checkoutRequestId: mpesaResponse.CheckoutRequestID
    }
  });
});

// M-Pesa callback (webhook)
exports.mpesaCallback = catchAsync(async (req, res, next) => {
  const { Body: { stkCallback } } = req.body;
  
  const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;
  
  const payment = await Payment.findOne({ mpesaCheckoutRequestID: CheckoutRequestID });
  if (!payment) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment not found' });
  }
  
  if (ResultCode === 0) {
    // Payment successful
    const metadata = {};
    CallbackMetadata.Item.forEach(item => {
      metadata[item.Name] = item.Value;
    });
    
    payment.status = 'completed';
    payment.completedAt = new Date();
    payment.mpesaReceiptNumber = metadata.MpesaReceiptNumber;
    payment.metadata = metadata;
    await payment.save();
    
    // Update ride payment status
    await Ride.findByIdAndUpdate(payment.rideId, {
      paymentStatus: 'paid',
      paymentId: payment._id
    });
    
    // Update driver earnings (already done in ride completion)
  } else {
    // Payment failed
    payment.status = 'failed';
    payment.failureReason = ResultDesc;
    await payment.save();
  }
  
  // Always respond with success to M-Pesa
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});

exports.initiateCommissionStkPush = catchAsync(async (req, res, next) => {
  if (req.userType !== 'driver') {
    return next(new AppError('Only drivers can pay commission through this endpoint', 403));
  }

  const { transaction, reused } = await initiateCommissionPayment({
    driverId: req.user.id,
    requestSource: 'driver',
    idempotencyKey: req.headers['x-idempotency-key']
  });
  const summary = await getDriverCommissionSnapshot(req.user.id);

  res.status(200).json({
    status: 'success',
    message: reused ? 'An STK Push is already pending for this commission balance' : 'Commission payment STK Push initiated',
    data: {
      transaction,
      commission: summary
    }
  });
});

exports.commissionCallback = async (req, res) => {
  if (!isCallbackAuthorized(req)) {
    return res.status(403).json({
      ResultCode: 1,
      ResultDesc: 'Unauthorized callback'
    });
  }

  try {
    const callback = parseStkPushCallback(req.body);
    await handleCommissionPaymentCallback(callback);

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  } catch (error) {
    console.error('Commission callback handling failed:', error);

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  }
};

// Initialize M-Pesa STK Push (placeholder)
const initiateMpesaSTKPush = async (phoneNumber, amount, paymentId) => {
  // In production, implement actual M-Pesa API call
  // This is a mock response
  return {
    MerchantRequestID: `MERCH-${Date.now()}`,
    CheckoutRequestID: `CHECKOUT-${Date.now()}`,
    ResponseCode: '0',
    ResponseDescription: 'Success. Request accepted for processing',
    CustomerMessage: 'Enter your M-Pesa PIN to complete payment'
  };
};

// Process cash payment
exports.processCashPayment = catchAsync(async (req, res, next) => {
  const { rideId } = req.body;
  
  const ride = await Ride.findById(rideId);
  if (!ride) {
    return next(new AppError('Ride not found', 404));
  }
  
  if (ride.userId.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }
  
  if (ride.paymentStatus === 'paid') {
    return next(new AppError('Ride already paid', 400));
  }
  
  const payment = await Payment.create({
    rideId: ride._id,
    userId: req.user.id,
    driverId: ride.driverId,
    amount: ride.fare,
    method: 'cash',
    status: 'completed',
    completedAt: new Date()
  });
  
  await Ride.findByIdAndUpdate(rideId, {
    paymentStatus: 'paid',
    paymentId: payment._id
  });
  
  res.status(200).json({
    status: 'success',
    data: { payment }
  });
});

// Get payment history
exports.getPaymentHistory = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  
  const payments = await Payment.find({ userId: req.user.id })
    .sort('-createdAt')
    .skip(skip)
    .limit(limit)
    .populate('rideId', 'pickupLocation destination distance duration');
  
  const total = await Payment.countDocuments({ userId: req.user.id });
  
  res.status(200).json({
    status: 'success',
    data: {
      payments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

// Get payment details
exports.getPaymentDetails = catchAsync(async (req, res, next) => {
  const { paymentId } = req.params;
  
  const payment = await Payment.findById(paymentId)
    .populate('rideId', 'pickupLocation destination distance duration status')
    .populate('driverId', 'name vehicle');
  
  if (!payment) {
    return next(new AppError('Payment not found', 404));
  }
  
  if (payment.userId.toString() !== req.user.id && req.user.role !== 'admin') {
    return next(new AppError('Not authorized', 403));
  }
  
  res.status(200).json({
    status: 'success',
    data: { payment }
  });
});

// Request refund
exports.requestRefund = catchAsync(async (req, res, next) => {
  const { paymentId, reason } = req.body;
  
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    return next(new AppError('Payment not found', 404));
  }
  
  if (payment.userId.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }
  
  if (payment.status !== 'completed') {
    return next(new AppError('Only completed payments can be refunded', 400));
  }
  
  if (payment.refundedAt) {
    return next(new AppError('Payment already refunded', 400));
  }
  
  // Process refund (in production, call M-Pesa reversal)
  payment.status = 'refunded';
  payment.refundAmount = payment.amount;
  payment.refundReason = reason;
  payment.refundedAt = new Date();
  await payment.save();
  
  res.status(200).json({
    status: 'success',
    message: 'Refund requested successfully',
    data: { payment }
  });
});

exports.getCommissionPaymentHistory = catchAsync(async (req, res, next) => {
  if (req.userType !== 'driver') {
    return next(new AppError('Only drivers can access commission payment history', 403));
  }

  const transactions = await PaymentTransaction.find({ driverId: req.user.id })
    .sort('-createdAt')
    .limit(20);

  res.status(200).json({
    status: 'success',
    data: { transactions }
  });
});
