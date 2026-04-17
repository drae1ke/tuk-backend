const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide driver name'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    unique: true,
    lowercase: true
  },
  phone: {
    type: String,
    required: [true, 'Please provide a phone number'],
    unique: true
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: 6,
    select: false
  },
  profilePhoto: String,
  idNumber: {
    type: String,
    required: true,
    unique: true
  },
  licenseNumber: {
    type: String,
    required: true,
    unique: true
  },
  licensePhoto: String,
  vehicle: {
    make: String,
    model: String,
    year: Number,
    color: String,
    plateNumber: {
      type: String,
      required: true,
      unique: true
    },
    type: {
      type: String,
      enum: ['tuktuk', 'bajaj', 'auto'],
      default: 'tuktuk'
    },
    capacity: {
      type: Number,
      default: 3
    },
    photo: String,
    insuranceExpiry: Date,
    inspectionExpiry: Date
  },
  currentLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },
  lastLocationUpdate: Date,
  online: {
    type: Boolean,
    default: false
  },
  available: {
    type: Boolean,
    default: true
  },
  currentRide: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride'
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
  totalEarnings: {
    type: Number,
    default: 0
  },
  ratingCount: {
    type: Number,
    default: 0
  },
  documents: {
    nationalId: String,
    drivingLicense: String,
    insurance: String,
    inspection: String,
    isVerified: {
      type: Boolean,
      default: false
    }
  },
  bankDetails: {
    bankName: String,
    accountNumber: String,
    accountName: String
  },
  mpesaNumber: String,
  operatingCity: {
    type: String,
    default: 'Nairobi'
  },
  serviceAreas: [{
    type: String
  }],
  bio: String,
  emergencyContact: {
    name: String,
    phone: String,
    relationship: String
  },
  pushToken: String,
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended', 'rejected'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastActive: Date
}, {
  timestamps: true
});

// Index for geospatial queries
driverSchema.index({ currentLocation: '2dsphere' });
driverSchema.index({ online: 1, available: 1, status: 1 });

// Hash password
driverSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password
driverSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Update earnings and rating
driverSchema.methods.updateStats = async function(earnings, rating) {
  this.totalRides += 1;
  this.totalEarnings += earnings;
  
  if (rating) {
    this.rating = (this.rating * this.ratingCount + rating) / (this.ratingCount + 1);
    this.ratingCount += 1;
  }
  
  await this.save();
};

module.exports = mongoose.model('Driver', driverSchema);
