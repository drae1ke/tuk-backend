const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  accountType: {
    type: String,
    enum: ['user', 'driver'],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  userAgent: String,
  ipAddress: String,
  lastSeenAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Session', sessionSchema);
