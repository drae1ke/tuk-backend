const mongoose = require('mongoose');

const rideSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver'
  },
  pickupLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      required: true
    },
    address: String
  },
  destination: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      required: true
    },
    address: String
  },
  waypoints: [{
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: [Number]
    },
    address: String
  }],
  path: [{
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: [Number],
    timestamp: Date
  }],
  distance: {
    type: Number,
    required: true,
    min: 0
  },
  duration: {
    type: Number,
    required: true,
    min: 0
  },
  fare: {
    type: Number,
    required: true,
    min: 0
  },
  surgeMultiplier: {
    type: Number,
    default: 1.0,
    min: 1.0,
    max: 3.0
  },
  vehicleType: {
    type: String,
    enum: ['standard', 'premium', 'shared'],
    default: 'standard'
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'arrived', 'started', 'completed', 'cancelled'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'mpesa', 'card'],
    default: 'cash'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending'
  },
  paymentId: String,
  cancellationReason: String,
  cancellationFee: {
    type: Number,
    default: 0
  },
  cancelledBy: {
    type: String,
    enum: ['user', 'driver', 'system']
  },
  driverRating: {
    type: Number,
    min: 1,
    max: 5
  },
  driverFeedback: String,
  userRating: {
    type: Number,
    min: 1,
    max: 5
  },
  userFeedback: String,
  acceptedAt: Date,
  arrivedAt: Date,
  startedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  estimatedPickupTime: Date,
  estimatedDropoffTime: Date
}, {
  timestamps: true
});

// Indexes for efficient queries
rideSchema.index({ userId: 1, createdAt: -1 });
rideSchema.index({ driverId: 1, createdAt: -1 });
rideSchema.index({ status: 1, createdAt: -1 });
rideSchema.index({ pickupLocation: '2dsphere' });
rideSchema.index({ destination: '2dsphere' });

// Calculate ride time
rideSchema.virtual('totalTime').get(function() {
  if (this.completedAt && this.acceptedAt) {
    return (this.completedAt - this.acceptedAt) / 60000; // minutes
  }
  return null;
});

// Check if ride is cancellable
rideSchema.methods.isCancellable = function() {
  return ['pending', 'accepted'].includes(this.status);
};

// Calculate cancellation fee
rideSchema.methods.getCancellationFee = function() {
  if (this.status === 'accepted' && this.acceptedAt) {
    const minutesSinceAccept = (Date.now() - this.acceptedAt) / 60000;
    if (minutesSinceAccept > 5) {
      return Math.min(this.fare * 0.5, 100); // Max 100 KES cancellation fee
    }
  }
  return 0;
};

module.exports = mongoose.model('Ride', rideSchema);