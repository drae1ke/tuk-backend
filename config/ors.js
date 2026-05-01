const axios = require('axios');
const { DEFAULT_PRICING } = require('../utils/pricing');

const orsConfig = {
  baseURL: process.env.ORS_BASE_URL || 'https://api.openrouteservice.org/v2',
  apiKey: process.env.ORS_API_KEY,
  headers: {
    ...(process.env.ORS_API_KEY ? { Authorization: process.env.ORS_API_KEY } : {}),
    'Content-Type': 'application/json'
  }
};

const orsClient = axios.create({
  baseURL: orsConfig.baseURL,
  headers: orsConfig.headers,
  timeout: 10000
});

const osrmClient = axios.create({
  baseURL: process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  timeout: 10000
});

const haversineDistanceMeters = (start, end) => {
  const [lng1, lat1] = start;
  const [lng2, lat2] = end;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const buildStraightLineRoute = (start, end) => {
  const directDistance = haversineDistanceMeters(start, end);
  const estimatedRoadDistance = Math.max(directDistance * 1.2, 250);
  const averageSpeedKph = 26;
  const durationSeconds = (estimatedRoadDistance / 1000 / averageSpeedKph) * 3600;

  return {
    distance: estimatedRoadDistance,
    duration: durationSeconds,
    geometry: {
      type: 'LineString',
      coordinates: [start, end],
    },
    steps: [],
    source: 'fallback'
  };
};

const getDirectionsFromOrs = async (start, end, profile) => {
  if (!orsConfig.apiKey) {
    throw new Error('ORS API key not configured');
  }

  const response = await orsClient.post(`/directions/${profile}`, {
    coordinates: [start, end],
    instructions: true,
    language: 'en',
  });
  const route = response.data?.routes?.[0];

  if (!route?.summary) {
    throw new Error('ORS did not return a route summary');
  }

  return {
    distance: route.summary.distance,
    duration: route.summary.duration,
    geometry: route.geometry || null,
    steps: route.segments?.[0]?.steps || [],
    source: 'ors'
  };
};

const getDirectionsFromOsrm = async (start, end) => {
  const response = await osrmClient.get(
    `/route/v1/driving/${start[0]},${start[1]};${end[0]},${end[1]}`,
    {
      params: {
        overview: 'false',
        steps: 'false',
      },
    }
  );
  const route = response.data?.routes?.[0];

  if (!route) {
    throw new Error('OSRM did not return a route');
  }

  return {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry || null,
    steps: [],
    source: 'osrm'
  };
};

const getDirections = async (start, end, profile = 'driving-car') => {
  try {
    return await getDirectionsFromOrs(start, end, profile);
  } catch (orsError) {
    console.warn('ORS directions failed, falling back:', orsError.response?.data || orsError.message);
  }

  try {
    return await getDirectionsFromOsrm(start, end);
  } catch (osrmError) {
    console.warn('OSRM directions failed, using straight-line fallback:', osrmError.response?.data || osrmError.message);
  }

  return buildStraightLineRoute(start, end);
};

const getDirectionsSimple = async (start, end, profile = 'driving-car') =>
  getDirections(start, end, profile);

const calculateFare = (distance, surgeMultiplier = 1.0) => {
  const baseFare = DEFAULT_PRICING.baseFare + DEFAULT_PRICING.bookingFee;
  const distanceFare = distance * DEFAULT_PRICING.perKm;
  const fare = Math.max(baseFare + distanceFare, DEFAULT_PRICING.minimumFare) * surgeMultiplier;
  return Math.ceil(fare / 10) * 10;
};

module.exports = {
  orsConfig,
  orsClient,
  getDirections,
  getDirectionsSimple,
  calculateFare
};
