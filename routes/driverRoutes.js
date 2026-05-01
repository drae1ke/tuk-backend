const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driverController');
const { protect, restrictUserType } = require('../middleware/authMiddleware');
const { validate, driverValidations } = require('../middleware/validationMiddleware');

// All routes require authentication and driver type
router.use(protect);
router.use(restrictUserType('driver'));

// Profile routes
router.get('/profile', driverController.getDriverProfile);
router.get('/commission', driverController.getCommissionSummary);
router.get('/status', driverController.getDriverStatus);
router.patch('/profile', driverController.updateDriverProfile);
router.patch('/location', 
  validate(driverValidations.location),
  driverController.updateLocation
);
router.patch('/online-status', driverController.updateOnlineStatus);

// Vehicle routes
router.patch('/vehicle', driverController.updateVehicle);

// Document routes
router.patch('/documents', driverController.updateDocuments);
router.patch('/bank-details', driverController.updateBankDetails);
router.patch('/mpesa-number', driverController.updateMpesaNumber);

// Earnings and stats
router.get('/earnings', driverController.getEarnings);
router.get('/stats', driverController.getStats);

// Availability and nearby
router.get('/nearby', driverController.getNearbyDrivers);
router.get('/availability-zones', driverController.getAvailabilityZones);

module.exports = router;
