const Location = require('../models/Location');
const Ride = require('../models/Ride');

module.exports = (io, socket) => {
  // Save location history
  socket.on('location:save', async (data) => {
    try {
      const { latitude, longitude, heading, speed, accuracy, rideId } = data;
      
      const locationData = {
        location: {
          type: 'Point',
          coordinates: [longitude, latitude]
        },
        heading,
        speed,
        accuracy,
        timestamp: new Date()
      };
      
      if (socket.userType === 'user') {
        locationData.userId = socket.userId;
      } else if (socket.userType === 'driver') {
        locationData.driverId = socket.userId;
      }
      
      if (rideId) {
        locationData.rideId = rideId;
        
        // Also add to ride path
        await Ride.findByIdAndUpdate(rideId, {
          $push: {
            path: {
              type: 'Point',
              coordinates: [longitude, latitude],
              timestamp: new Date()
            }
          }
        });
      }
      
      await Location.create(locationData);
      
    } catch (error) {
      console.error('Location save error:', error);
    }
  });
  
  // Get location history for a ride
  socket.on('location:history', async (data) => {
    try {
      const { rideId } = data;
      
      const locations = await Location.find({ rideId })
        .sort('timestamp')
        .limit(100);
      
      socket.emit('location:history-response', {
        rideId,
        locations: locations.map(loc => ({
          latitude: loc.location.coordinates[1],
          longitude: loc.location.coordinates[0],
          timestamp: loc.timestamp,
          heading: loc.heading,
          speed: loc.speed
        }))
      });
      
    } catch (error) {
      console.error('Location history error:', error);
    }
  });
  
  // Subscribe to real-time location updates for a ride
  socket.on('location:subscribe', async (data) => {
    try {
      const { rideId } = data;
      
      // Verify user is part of this ride
      const ride = await Ride.findById(rideId);
      if (!ride) return;
      
      const isAuthorized = 
        ride.userId.toString() === socket.userId ||
        ride.driverId?.toString() === socket.userId;
      
      if (!isAuthorized) return;
      
      // Join ride room for location updates
      socket.join(`ride:${rideId}`);
      
      socket.emit('location:subscribed', { rideId });
      
    } catch (error) {
      console.error('Location subscribe error:', error);
    }
  });
  
  // Unsubscribe from location updates
  socket.on('location:unsubscribe', async (data) => {
    try {
      const { rideId } = data;
      socket.leave(`ride:${rideId}`);
      socket.emit('location:unsubscribed', { rideId });
    } catch (error) {
      console.error('Location unsubscribe error:', error);
    }
  });
};