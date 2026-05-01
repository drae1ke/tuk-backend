const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  rideId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride',
    required: true
  },
  fare: {
    type: Number,
    required: true,
    min: 0
  },
  commissionAmount: {
    type: Number,
    required: true,
    min: 0
  },
  completedAt: {
    type: Date,
    required: true
  }
}, { _id: false });

const notificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['summary', 'reminder', 'warning', 'restriction', 'payment_success', 'payment_failure'],
    required: true
  },
  channel: {
    type: String,
    enum: ['email', 'log', 'system'],
    default: 'system'
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  metadata: mongoose.Schema.Types.Mixed
}, { _id: false });

const commissionSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
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
    default: 0,
    min: 0
  },
  dueAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  outstandingAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  grossFares: {
    type: Number,
    default: 0,
    min: 0
  },
  rideCount: {
    type: Number,
    default: 0,
    min: 0
  },
  rideIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride'
  }],
  lineItems: [lineItemSchema],
  status: {
    type: String,
    enum: ['accruing', 'pending', 'overdue', 'paid'],
    default: 'accruing'
  },
  currency: {
    type: String,
    default: 'KES'
  },
  settledAt: Date,
  dueAt: Date,
  graceEndsAt: Date,
  paidAt: Date,
  restrictedAt: Date,
  lastReminderAt: Date,
  notifications: [notificationSchema],
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

commissionSchema.index({ driverId: 1, weekStart: 1 }, { unique: true });
commissionSchema.index({ status: 1, graceEndsAt: 1 });
commissionSchema.index({ driverId: 1, status: 1, weekStart: -1 });

module.exports = mongoose.model('Commission', commissionSchema);
