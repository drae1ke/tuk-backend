const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide a name'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters'],
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please provide a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Please provide a phone number'],
    unique: true,
    match: [/^254\d{9}$/, 'Please provide a valid Kenyan phone number']
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  profilePhoto: {
    type: String,
    default: 'default-avatar.png'
  },
  rating: {
    type: Number,
    default: 5.0,
    min: 0,
    max: 5
  },
  totalRides: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  preferredLanguage: {
    type: String,
    default: 'en'
  },
  emergencyContact: {
    name: String,
    phone: String,
    relationship: String
  },
  savedAddresses: [{
    name: String,
    address: String,
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: [Number]
    }
  }],
  paymentMethods: [{
    type: {
      type: String,
      enum: ['mpesa', 'card', 'cash'],
      default: 'mpesa'
    },
    last4: String,
    isDefault: Boolean
  }],
  pushToken: String,
  isActive: {
    type: Boolean,
    default: true
  },
  role: {
    type: String,
    enum: ['user', 'driver', 'admin'],
    default: 'user'
  },
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  emailVerified: {
    type: Boolean,
    default: false
  },
  phoneVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: Date
}, {
  timestamps: true
});

// Index for geospatial queries
userSchema.index({ 'savedAddresses.location': '2dsphere' });

// Hash password before saving
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Update last login
userSchema.methods.updateLastLogin = function() {
  this.lastLogin = new Date();
  return this.save({ validateBeforeSave: false });
};

module.exports = mongoose.model('User', userSchema);
