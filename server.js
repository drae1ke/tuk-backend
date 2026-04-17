const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config();

// Import configurations
const { connectDB } = require('./config/database');
const { initializeSocket } = require('./config/socket');

// Import middleware
const { errorHandler } = require('./middleware/errorMiddleware');
const rateLimiter = require('./middleware/rateLimiter');

// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const driverRoutes = require('./routes/driverRoutes');
const rideRoutes = require('./routes/rideRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminRoutes = require('./routes/adminRoutes');

// Initialize express app
const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware - make sure all are functions
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiter middleware
app.use(rateLimiter);

// Initialize socket.io
initializeSocket(io);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'TUKTUK-RIDE API is running',
    timestamp: new Date().toISOString()
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    status: 'fail',
    message: `Cannot find ${req.originalUrl} on this server`
  });
});

// Global error handler
app.use(errorHandler);

// Connect to database and start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    console.log('✅ MongoDB connected successfully');
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Socket.IO ready for real-time connections`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});

module.exports = { app, server, io };