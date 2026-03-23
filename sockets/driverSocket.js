const Driver = require('../models/Driver');
const Ride = require('../models/Ride');

module.exports = (io, socket) => {
  // Driver goes online
  socket.on('driver:online', async (data) => {
    try {
      await Driver.findByIdAndUpdate(socket.userId, {
        online: true,
        available: true,
        lastActive: new Date()
      });
      
      socket.emit('driver:status', { online: true, available: true });
      console.log(`Driver ${socket.userId} is now online`);
    } catch (error) {
      console.error('Driver online error:', error);
    }
  });
  
  // Driver goes offline
  socket.on('driver:offline', async () => {
    try {
      await Driver.findByIdAndUpdate(socket.userId, {
        online: false,
        available: false
      });
      
      socket.emit('driver:status', { online: false, available: false });
      console.log(`Driver ${socket.userId} is now offline`);
    } catch (error) {
      console.error('Driver offline error:', error);
    }
  });
  
  // Toggle availability
  socket.on('driver:toggle-availability', async (data) => {
    try {
      const { available } = data;
      const driver = await Driver.findByIdAndUpdate(
        socket.userId,
        { available },
        { new: true }
      );
      
      io.to(`user:${socket.userId}`).emit('driver:availability-updated', {
        available: driver.available
      });
    } catch (error) {
      console.error('Toggle availability error:', error);
    }
  });
  
  // Driver location update
  socket.on('driver:location', async (data) => {
    try {
      const { latitude, longitude, heading, speed, accuracy } = data;
      
      await Driver.findByIdAndUpdate(socket.userId, {
        'currentLocation.coordinates': [longitude, latitude],
        lastLocationUpdate: new Date(),
        heading,
        speed,
        accuracy
      });
      
      // Broadcast location to all connected clients (for tracking)
      socket.broadcast.emit('driver:location-update', {
        driverId: socket.userId,
        location: { latitude, longitude, heading, speed }
      });
    } catch (error) {
      console.error('Driver location update error:', error);
    }
  });
};