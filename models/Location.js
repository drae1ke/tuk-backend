const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    sparse: true
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    sparse: true
  },
  rideId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride'
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true
    },
    coordinates: {
      type: [Number],
      required: true
    }
  },
  heading: Number,
  speed: Number,
  accuracy: Number,
  timestamp: {
    type: Date,
    default: Date.now,
    expires: 3600 // Auto-delete after 1 hour
  }
});

// Compound indexes
locationSchema.index({ userId: 1, timestamp: -1 });
locationSchema.index({ driverId: 1, timestamp: -1 });
locationSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Location', locationSchema);