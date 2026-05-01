const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const { getDirections } = require('../config/ors');
const { calculateRidePricing } = require('../utils/pricing');
const { getDriverCommissionSnapshot, recordRideCommission } = require('../services/commissionService');

module.exports = (io, socket) => {
  // User requests ride
  socket.on('ride:request', async (data) => {
    try {
      const { pickup, destination, vehicleType } = data;
      
      // Calculate route and fare
      const route = await getDirections(
        [pickup.longitude, pickup.latitude],
        [destination.longitude, destination.latitude]
      );
      
      const distance = route.distance / 1000;
      const duration = route.duration / 60;
      const pricing = await calculateRidePricing({
        distanceKm: distance,
        durationMinutes: duration,
        pickupAddress: pickup.address,
        destinationAddress: destination.address,
      });
      
      // Create ride
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
        distance,
        duration,
        fare: pricing.fare,
        pricingBreakdown: pricing.breakdown,
        vehicleType: vehicleType || 'standard',
        status: 'pending'
      });
      
      // Find nearby drivers
      const nearbyDrivers = await Driver.find({
        online: true,
        available: true,
        status: 'active',
        commissionAccountStatus: 'active',
        currentLocation: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [pickup.longitude, pickup.latitude]
            },
            $maxDistance: 5000
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
          duration: ride.duration,
          timestamp: new Date()
        });
      });
      
      // Confirm to user
      socket.emit('ride:requested', {
        rideId: ride._id,
        fare: ride.fare,
        distance: ride.distance,
        duration: ride.duration,
        status: 'pending'
      });
      
    } catch (error) {
      console.error('Ride request error:', error);
      socket.emit('ride:error', { message: 'Failed to request ride' });
    }
  });
  
  // Driver accepts ride
  socket.on('ride:accept', async (data) => {
    try {
      const { rideId } = data;
      
      const ride = await Ride.findById(rideId);
      if (!ride || ride.status !== 'pending') {
        return socket.emit('ride:error', { message: 'Ride not available' });
      }
      
      ride.driverId = socket.userId;
      ride.status = 'accepted';
      ride.acceptedAt = new Date();
      await ride.save();
      
      const driver = await Driver.findById(socket.userId);
      if (!driver || driver.status !== 'active' || driver.commissionAccountStatus !== 'active') {
        return socket.emit('ride:error', { message: 'Your account cannot accept new rides right now' });
      }
      driver.available = false;
      driver.currentRide = rideId;
      await driver.save();
      
      // Notify user
      io.to(`user:${ride.userId}`).emit('ride:accepted', {
        rideId: ride._id,
        driver: {
          id: driver._id,
          name: driver.name,
          phone: driver.phone,
          rating: driver.rating,
          vehicle: driver.vehicle,
          profilePhoto: driver.profilePhoto
        },
        driverLocation: driver.currentLocation,
        eta: calculateETA(driver.currentLocation, ride.pickupLocation)
      });
      
      // Notify driver
      socket.emit('ride:accepted-confirmation', {
        rideId: ride._id,
        pickup: ride.pickupLocation,
        destination: ride.destination,
        fare: ride.fare
      });
      
    } catch (error) {
      console.error('Ride accept error:', error);
      socket.emit('ride:error', { message: 'Failed to accept ride' });
    }
  });
  
  // Driver arrives at pickup
  socket.on('ride:arrived', async (data) => {
    try {
      const { rideId } = data;
      
      const ride = await Ride.findById(rideId);
      if (!ride || ride.driverId.toString() !== socket.userId) {
        return;
      }
      
      ride.status = 'arrived';
      ride.arrivedAt = new Date();
      await ride.save();
      
      io.to(`user:${ride.userId}`).emit('ride:driver-arrived', {
        rideId,
        message: 'Your driver has arrived'
      });
      
    } catch (error) {
      console.error('Ride arrived error:', error);
    }
  });
  
  // Driver starts ride
  socket.on('ride:start', async (data) => {
    try {
      const { rideId } = data;
      
      const ride = await Ride.findById(rideId);
      if (!ride || ride.driverId.toString() !== socket.userId) {
        return;
      }
      
      ride.status = 'started';
      ride.startedAt = new Date();
      await ride.save();
      
      io.to(`user:${ride.userId}`).emit('ride:started', {
        rideId,
        message: 'Your ride has started'
      });
      
    } catch (error) {
      console.error('Ride start error:', error);
    }
  });
  
  // Driver completes ride
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
      
      const driver = await Driver.findById(socket.userId);
      driver.available = true;
      driver.currentRide = null;
      driver.totalRides += 1;
      driver.totalEarnings += ride.fare;
      await driver.save();

      try {
        await recordRideCommission(ride);
      } catch (error) {
        console.error('Commission accrual failed after socket ride completion:', error);
      }

      try {
        const commissionSummary = await getDriverCommissionSnapshot(socket.userId);
        socket.emit('ride:completed-confirmation', {
          rideId,
          commission: commissionSummary
        });
      } catch (error) {
        console.error('Failed to emit commission summary after completion:', error);
      }
      
      io.to(`user:${ride.userId}`).emit('ride:completed', {
        rideId,
        fare: ride.fare,
        distance: ride.distance,
        duration: ride.duration,
        message: 'Ride completed'
      });
      
    } catch (error) {
      console.error('Ride complete error:', error);
    }
  });
  
  // Cancel ride
  socket.on('ride:cancel', async (data) => {
    try {
      const { rideId, reason } = data;
      
      const ride = await Ride.findById(rideId);
      if (!ride) return;
      
      const isUser = socket.userType === 'user';
      
      if ((isUser && ride.userId.toString() !== socket.userId) ||
          (!isUser && ride.driverId?.toString() !== socket.userId)) {
        return;
      }
      
      if (ride.status !== 'pending' && ride.status !== 'accepted') {
        return socket.emit('ride:error', { message: 'Cannot cancel ride now' });
      }
      
      ride.status = 'cancelled';
      ride.cancelledAt = new Date();
      ride.cancellationReason = reason;
      ride.cancelledBy = socket.userType;
      await ride.save();
      
      // Notify other party
      if (isUser && ride.driverId) {
        io.to(`user:${ride.driverId}`).emit('ride:cancelled', {
          rideId,
          reason,
          cancelledBy: 'user'
        });
        
        await Driver.findByIdAndUpdate(ride.driverId, {
          available: true,
          currentRide: null
        });
      } else if (!isUser && ride.userId) {
        io.to(`user:${ride.userId}`).emit('ride:cancelled', {
          rideId,
          reason,
          cancelledBy: 'driver'
        });
      }
      
      socket.emit('ride:cancelled-confirmation', { rideId });
      
    } catch (error) {
      console.error('Ride cancel error:', error);
    }
  });
};

// Helper function
const calculateETA = (driverLocation, pickupLocation) => {
  // Simple distance calculation
  const lat1 = driverLocation.coordinates[1];
  const lon1 = driverLocation.coordinates[0];
  const lat2 = pickupLocation.coordinates[1];
  const lon2 = pickupLocation.coordinates[0];
  
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  
  const avgSpeed = 30; // km/h
  const minutes = Math.ceil((distance / avgSpeed) * 60);
  return `${minutes} minutes`;
};
