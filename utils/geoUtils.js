// Convert degrees to radians
const degToRad = (deg) => deg * (Math.PI / 180);

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Calculate ETA based on distance and speed
const calculateETA = (distance, avgSpeed = 30) => {
  const hours = distance / avgSpeed;
  const minutes = Math.ceil(hours * 60);
  return minutes;
};

// Check if point is within radius
const isWithinRadius = (point, center, radiusKm) => {
  const distance = calculateDistance(
    point.latitude, point.longitude,
    center.latitude, center.longitude
  );
  return distance <= radiusKm;
};

// Get bounding box from center and radius
const getBoundingBox = (center, radiusKm) => {
  const lat = center.latitude;
  const lon = center.longitude;
  const radiusDeg = radiusKm / 111; // Approximate conversion
  
  return {
    minLat: lat - radiusDeg,
    maxLat: lat + radiusDeg,
    minLon: lon - radiusDeg,
    maxLon: lon + radiusDeg
  };
};

// Calculate surge multiplier based on demand and supply
const calculateSurgeMultiplier = (demand, supply, baseMultiplier = 1.0) => {
  if (supply === 0) return 3.0;
  
  const ratio = demand / supply;
  
  if (ratio < 1.5) return baseMultiplier;
  if (ratio < 2) return 1.5;
  if (ratio < 3) return 2.0;
  if (ratio < 4) return 2.5;
  return 3.0;
};

module.exports = {
  calculateDistance,
  calculateETA,
  isWithinRadius,
  getBoundingBox,
  calculateSurgeMultiplier
};