const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const User = require('../models/User');
const { getDirections, calculateFare } = require('./ors');

let io;

const initializeSocket = (server) => {
  io = server;
  
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication error'));
      }
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userType = decoded.userType;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });
  
  io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id} - User: ${socket.userId} (${socket.userType})`);
    
    // Join user to their room
    socket.join(`user:${socket.userId}`);
    
    // Handle driver location updates
    socket.on('driver:location', async (data) => {
      try {
        const { latitude, longitude, heading, speed, accuracy } = data;
        
        // Update driver location in database
        await Driver.findByIdAndUpdate(socket.userId, {
          'currentLocation': {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          'lastLocationUpdate': new Date(),
          'heading': heading,
          'speed': speed,
          'online': true
        });
        
        // Notify nearby users with active ride requests
        const nearbyRequests = await Ride.find({
          status: 'pending',
          'pickupLocation.coordinates': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude]
              },
              $maxDistance: 5000 // 5km radius
            }
          }
        });
        
        nearbyRequests.forEach(ride => {
          io.to(`user:${ride.userId}`).emit('ride:nearby-driver', {
            driverId: socket.userId,
            location: { latitude, longitude },
            distance: calculateDistance(
              latitude, longitude,
              ride.pickupLocation.coordinates[1],
              ride.pickupLocation.coordinates[0]
            )
          });
        });
      } catch (error) {
        console.error('Driver location update error:', error);
      }
    });
    
    // Handle ride request
    socket.on('ride:request', async (data) => {
      try {
        const { pickup, destination, vehicleType } = data;
        
        // Calculate route and fare
        const route = await getDirections(
          [pickup.longitude, pickup.latitude],
          [destination.longitude, destination.latitude]
        );
        
        const fare = calculateFare(route.distance / 1000);
        
        // Create ride request
        const ride = await Ride.create({
          userId: socket.userId,
          pickupLocation: {
            type: 'Point',
            coordinates: [pickup.longitude, pickup.latitude],
            address: pickup.address
          },
          destination: {
            type: 'Point',
            coordinates: [destination.longitude, destination.latitude],
            address: destination.address
          },
          distance: route.distance / 1000,
          duration: route.duration / 60,
          fare: fare,
          vehicleType: vehicleType || 'standard',
          status: 'pending'
        });
        
        // Find nearby available drivers
        const nearbyDrivers = await Driver.find({
          online: true,
          available: true,
          'currentLocation': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [pickup.longitude, pickup.latitude]
              },
              $maxDistance: 3000 // 3km radius
            }
          }
        }).limit(10);
        
        // Notify drivers
        nearbyDrivers.forEach(driver => {
          io.to(`user:${driver._id}`).emit('ride:new-request', {
            rideId: ride._id,
            pickup: ride.pickupLocation,
            destination: ride.destination,
            fare: ride.fare,
            distance: ride.distance,
            duration: ride.duration
          });
        });
        
        // Notify user
        socket.emit('ride:requested', {
          rideId: ride._id,
          fare: ride.fare,
          distance: ride.distance,
          duration: ride.duration,
          estimatedPickup: '3-5 minutes'
        });
      } catch (error) {
        console.error('Ride request error:', error);
        socket.emit('ride:error', { message: 'Failed to request ride' });
      }
    });
    
    // Handle driver accepting ride
    socket.on('ride:accept', async (data) => {
      try {
        const { rideId } = data;
        
        const ride = await Ride.findById(rideId);
        if (!ride || ride.status !== 'pending') {
          return socket.emit('ride:error', { message: 'Ride not available' });
        }
        
        // Update ride with driver
        ride.driverId = socket.userId;
        ride.status = 'accepted';
        ride.acceptedAt = new Date();
        await ride.save();
        
        // Update driver status
        await Driver.findByIdAndUpdate(socket.userId, {
          available: false,
          currentRide: rideId
        });
        
        // Get driver location
        const driver = await Driver.findById(socket.userId);
        
        // Notify user
        io.to(`user:${ride.userId}`).emit('ride:accepted', {
          rideId: ride._id,
          driver: {
            id: driver._id,
            name: driver.name,
            phone: driver.phone,
            rating: driver.rating,
            vehicle: driver.vehicle
          },
          driverLocation: driver.currentLocation.coordinates,
          eta: calculateETA(
            driver.currentLocation.coordinates,
            ride.pickupLocation.coordinates
          )
        });
        
        // Start tracking
        startTracking(ride, driver);
      } catch (error) {
        console.error('Ride acceptance error:', error);
        socket.emit('ride:error', { message: 'Failed to accept ride' });
      }
    });
    
    // Handle driver location during active ride
    socket.on('ride:tracking', async (data) => {
      try {
        const { rideId, latitude, longitude } = data;
        
        const ride = await Ride.findById(rideId);
        if (!ride || ride.driverId.toString() !== socket.userId) {
          return;
        }
        
        // Update ride path
        ride.path.push({
          type: 'Point',
          coordinates: [longitude, latitude],
          timestamp: new Date()
        });
        await ride.save();
        
        // Notify user
        io.to(`user:${ride.userId}`).emit('ride:location-update', {
          rideId,
          location: { latitude, longitude },
          remainingDistance: calculateRemainingDistance(
            [longitude, latitude],
            ride.destination.coordinates
          )
        });
      } catch (error) {
        console.error('Tracking error:', error);
      }
    });
    
    // Handle ride completion
    socket.on('ride:complete', async (data) => {
      try {
        const { rideId } = data;
        
        const ride = await Ride.findById(rideId);
        if (!ride || ride.driverId.toString() !== socket.userId) {
          return;
        }
        
        ride.status = 'completed';
        ride.completedAt = new Date();
        await ride.save();
        
        // Update driver availability
        await Driver.findByIdAndUpdate(socket.userId, {
          available: true,
          currentRide: null
        });
        
        // Notify user
        io.to(`user:${ride.userId}`).emit('ride:completed', {
          rideId,
          fare: ride.fare,
          distance: ride.distance,
          duration: ride.duration
        });
      } catch (error) {
        console.error('Ride completion error:', error);
      }
    });
    
    // Handle ride cancellation
    socket.on('ride:cancel', async (data) => {
      try {
        const { rideId, reason } = data;
        
        const ride = await Ride.findById(rideId);
        if (!ride) return;
        
        ride.status = 'cancelled';
        ride.cancelledAt = new Date();
        ride.cancellationReason = reason;
        await ride.save();
        
        // Notify other party
        if (socket.userType === 'user') {
          io.to(`user:${ride.driverId}`).emit('ride:cancelled', {
            rideId,
            reason,
            cancelledBy: 'user'
          });
          // Free up driver
          await Driver.findByIdAndUpdate(ride.driverId, {
            available: true,
            currentRide: null
          });
        } else {
          io.to(`user:${ride.userId}`).emit('ride:cancelled', {
            rideId,
            reason,
            cancelledBy: 'driver'
          });
        }
        
        socket.emit('ride:cancelled-confirmation', { rideId });
      } catch (error) {
        console.error('Ride cancellation error:', error);
      }
    });
    
    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`Disconnected: ${socket.id}`);
      
      if (socket.userType === 'driver') {
        await Driver.findByIdAndUpdate(socket.userId, {
          online: false
        });
      }
    });
  });
  
  return io;
};

// Helper functions
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const calculateETA = (driverLocation, pickupLocation) => {
  const distance = calculateDistance(
    driverLocation[1], driverLocation[0],
    pickupLocation[1], pickupLocation[0]
  );
  const avgSpeed = 30; // km/h in urban areas
  const minutes = Math.ceil((distance / avgSpeed) * 60);
  return `${minutes} minutes`;
};

const calculateRemainingDistance = (currentLocation, destination) => {
  return calculateDistance(
    currentLocation[1], currentLocation[0],
    destination[1], destination[0]
  );
};

const startTracking = (ride, driver) => {
  // Real-time tracking logic
  const trackingInterval = setInterval(async () => {
    const updatedRide = await Ride.findById(ride._id);
    if (['completed', 'cancelled'].includes(updatedRide.status)) {
      clearInterval(trackingInterval);
      return;
    }
    
    // Check if driver is near destination
    const remainingDistance = calculateRemainingDistance(
      driver.currentLocation.coordinates,
      ride.destination.coordinates
    );
    
    if (remainingDistance < 0.1) { // 100 meters
      io.to(`user:${ride.userId}`).emit('ride:near-destination', {
        rideId: ride._id,
        remainingDistance
      });
    }
  }, 10000); // Check every 10 seconds
};

module.exports = { initializeSocket, io };