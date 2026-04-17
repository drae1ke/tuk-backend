const PricingConfig = require('../models/PricingConfig');

const DEFAULT_PRICING = {
  currency: 'KES',
  baseFare: 80,
  bookingFee: 30,
  perKm: 45,
  perMinute: 4,
  minimumFare: 150,
  cancellationFee: 100,
  nightSurcharge: 40,
  cbdSurcharge: 30,
  trafficMultiplier: 1.15,
  demandMultiplier: 1
};

let cachedPricing = null;
let cachedAt = 0;
const CACHE_TTL = 60_000;

const getPricingConfig = async () => {
  if (cachedPricing && Date.now() - cachedAt < CACHE_TTL) {
    return cachedPricing;
  }

  let config = await PricingConfig.findOne().sort('-updatedAt').lean();
  if (!config) {
    config = await PricingConfig.create(DEFAULT_PRICING);
    config = config.toObject();
  }

  cachedPricing = { ...DEFAULT_PRICING, ...config };
  cachedAt = Date.now();
  return cachedPricing;
};

const isNightTime = (date = new Date()) => {
  const hour = date.getHours();
  return hour >= 22 || hour < 5;
};

const isPeakTrafficTime = (date = new Date()) => {
  const hour = date.getHours();
  return (hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 20);
};

const isCbdAddress = (...addresses) => {
  return addresses.some((address = '') => /cbd|central business district|tom mboya|kenyatta avenue|uhuru highway/i.test(address));
};

const roundCurrency = (value) => Math.ceil(value / 10) * 10;

const calculateRidePricing = async ({
  distanceKm,
  durationMinutes,
  pickupAddress = '',
  destinationAddress = '',
  demandMultiplier
}) => {
  const config = await getPricingConfig();
  const activeDemandMultiplier = Math.max(1, demandMultiplier || config.demandMultiplier || 1);
  const distanceFare = distanceKm * config.perKm;
  const timeFare = durationMinutes * config.perMinute;
  const nightSurcharge = isNightTime() ? config.nightSurcharge : 0;
  const trafficSurcharge = isPeakTrafficTime() ? (distanceFare + timeFare) * (config.trafficMultiplier - 1) : 0;
  const zoneSurcharge = isCbdAddress(pickupAddress, destinationAddress) ? config.cbdSurcharge : 0;
  const subtotal = config.baseFare + config.bookingFee + distanceFare + timeFare + nightSurcharge + trafficSurcharge + zoneSurcharge;
  const fare = Math.max(config.minimumFare, subtotal * activeDemandMultiplier);

  return {
    fare: roundCurrency(fare),
    breakdown: {
      currency: config.currency,
      baseFare: roundCurrency(config.baseFare),
      distanceFare: roundCurrency(distanceFare),
      timeFare: roundCurrency(timeFare),
      bookingFee: roundCurrency(config.bookingFee),
      nightSurcharge: roundCurrency(nightSurcharge),
      trafficSurcharge: roundCurrency(trafficSurcharge),
      zoneSurcharge: roundCurrency(zoneSurcharge),
      demandMultiplier: activeDemandMultiplier,
      subtotal: roundCurrency(subtotal)
    },
    config
  };
};

const invalidatePricingCache = () => {
  cachedPricing = null;
  cachedAt = 0;
};

module.exports = {
  DEFAULT_PRICING,
  getPricingConfig,
  calculateRidePricing,
  invalidatePricingCache
};
