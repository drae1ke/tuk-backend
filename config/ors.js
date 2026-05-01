const axios = require('axios');
const { DEFAULT_PRICING } = require('../utils/pricing');

const orsConfig = {
  baseURL: process.env.ORS_BASE_URL || 'https://api.openrouteservice.org/v2',
  apiKey: process.env.ORS_API_KEY,
  headers: {
    'Authorization': process.env.ORS_API_KEY,
    'Content-Type': 'application/json'
  }
};

const orsClient = axios.create({
  baseURL: orsConfig.baseURL,
  headers: orsConfig.headers
});

// Directions API - FIXED VERSION
const getDirections = async (start, end, profile = 'driving-car') => {
  try {
    console.log('📍 Requesting directions from ORS...');
    console.log('Start:', start);
    console.log('End:', end);
    
    // ORS expects coordinates as [longitude, latitude]
    const response = await orsClient.post(`/directions/${profile}`, {
      coordinates: [start, end],
      instructions: 'true',  // Changed from 'detailed' to 'true'
      language: 'en',
      units: 'km'
    });
    
    console.log('✅ Directions received successfully');
    
    return {
      distance: response.data.routes[0].summary.distance,
      duration: response.data.routes[0].summary.duration,
      geometry: response.data.routes[0].geometry,
      steps: response.data.routes[0].segments[0].steps || []
    };
  } catch (error) {
    console.error('❌ ORS Directions Error:');
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
    console.error('Message:', error.message);
    
    // Return mock data in development
    if (process.env.NODE_ENV === 'development') {
      console.log('🔄 Using mock data for development');
      return {
        distance: 5000, // 5km in meters
        duration: 600, // 10 minutes in seconds
        geometry: null,
        steps: []
      };
    }
    
    throw new Error(`Failed to get directions: ${error.response?.data?.error?.message || error.message}`);
  }
};

// Alternative version with fewer options
const getDirectionsSimple = async (start, end, profile = 'driving-car') => {
  try {
    const response = await orsClient.post(`/directions/${profile}`, {
      coordinates: [start, end]
      // Minimal parameters to avoid errors
    });
    
    return {
      distance: response.data.routes[0].summary.distance,
      duration: response.data.routes[0].summary.duration,
      geometry: response.data.routes[0].geometry,
      steps: []
    };
  } catch (error) {
    console.error('ORS Directions Error:', error.response?.data || error.message);
    throw error;
  }
};

// Calculate fare
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
