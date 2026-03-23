const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  rideId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver'
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'KES'
  },
  method: {
    type: String,
    enum: ['cash', 'mpesa', 'card'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded'],
    default: 'pending'
  },
  transactionId: String,
  mpesaReceiptNumber: String,
  mpesaCheckoutRequestID: String,
  mpesaMerchantRequestID: String,
  cardLast4: String,
  cardBrand: String,
  refundAmount: Number,
  refundReason: String,
  refundedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
  completedAt: Date,
  failedAt: Date,
  failureReason: String
}, {
  timestamps: true
});

// Indexes
paymentSchema.index({ rideId: 1 });
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ transactionId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);