const driverSocket = require('./driverSocket');
const rideSocket = require('./rideSocket');
const locationSocket = require('./locationSocket');

const setupSockets = (io) => {
  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    // Initialize all socket handlers
    driverSocket(io, socket);
    rideSocket(io, socket);
    locationSocket(io, socket);
    
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
};

module.exports = { setupSockets };