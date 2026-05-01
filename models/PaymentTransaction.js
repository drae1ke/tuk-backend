const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema({
  commissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Commission',
    required: true
  },
  weekStart: {
    type: Date,
    required: true
  },
  weekEnd: {
    type: Date,
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const paymentTransactionSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true
  },
  commissionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Commission'
  }],
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'KES'
  },
  phoneNumber: {
    type: String,
    required: true
  },
  requestSource: {
    type: String,
    enum: ['driver', 'system', 'admin'],
    default: 'driver'
  },
  status: {
    type: String,
    enum: ['initiated', 'pending_callback', 'succeeded', 'failed', 'cancelled', 'partially_allocated'],
    default: 'initiated'
  },
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true
  },
  mpesaReceipt: {
    type: String,
    unique: true,
    sparse: true
  },
  merchantRequestId: String,
  checkoutRequestId: {
    type: String,
    unique: true,
    sparse: true
  },
  resultCode: Number,
  resultDesc: String,
  failureReason: String,
  requestPayload: mongoose.Schema.Types.Mixed,
  responsePayload: mongoose.Schema.Types.Mixed,
  callbackPayload: mongoose.Schema.Types.Mixed,
  allocation: [allocationSchema],
  initiatedAt: {
    type: Date,
    default: Date.now
  },
  callbackReceivedAt: Date,
  completedAt: Date
}, {
  timestamps: true
});

paymentTransactionSchema.index({ driverId: 1, createdAt: -1 });
paymentTransactionSchema.index({ status: 1, createdAt: -1 });
paymentTransactionSchema.index({ merchantRequestId: 1 });

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);
