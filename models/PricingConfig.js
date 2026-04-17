const mongoose = require('mongoose');

const pricingConfigSchema = new mongoose.Schema({
  market: {
    type: String,
    default: 'kenya'
  },
  city: {
    type: String,
    default: 'Nairobi'
  },
  currency: {
    type: String,
    default: 'KES'
  },
  baseFare: {
    type: Number,
    default: 80
  },
  bookingFee: {
    type: Number,
    default: 30
  },
  perKm: {
    type: Number,
    default: 45
  },
  perMinute: {
    type: Number,
    default: 4
  },
  minimumFare: {
    type: Number,
    default: 150
  },
  cancellationFee: {
    type: Number,
    default: 100
  },
  nightSurcharge: {
    type: Number,
    default: 40
  },
  cbdSurcharge: {
    type: Number,
    default: 30
  },
  trafficMultiplier: {
    type: Number,
    default: 1.15
  },
  demandMultiplier: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PricingConfig', pricingConfigSchema);
