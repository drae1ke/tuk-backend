const express = require('express');
const router = express.Router();
const rideController = require('../controllers/rideController');
const { protect, restrictUserType } = require('../middleware/authMiddleware');
const { validate, rideValidations } = require('../middleware/validationMiddleware');

// Debug: Check if controller functions exist
console.log('rideController functions:', Object.keys(rideController));

// All routes require authentication
router.use(protect);

// User routes
router.get('/user/history', 
  restrictUserType('user'),
  rideController.getUserRideHistory
);

router.get('/user/current', 
  restrictUserType('user'),
  rideController.getCurrentUserRide
);

router.post('/request', 
  restrictUserType('user'),
  validate(rideValidations.request),
  rideController.requestRide
);

// Driver routes
router.get('/driver/available', 
  restrictUserType('driver'),
  rideController.getAvailableRides
);

router.get('/driver/history', 
  restrictUserType('driver'),
  rideController.getDriverRideHistory
);

router.get('/driver/current', 
  restrictUserType('driver'),
  rideController.getCurrentDriverRide
);

// Routes with rideId parameter
router.patch('/:rideId/accept', 
  restrictUserType('driver'),
  rideController.acceptRide
);

router.patch('/:rideId/arrive', 
  restrictUserType('driver'),
  rideController.arriveAtPickup
);

router.patch('/:rideId/start', 
  restrictUserType('driver'),
  rideController.startRide
);

router.patch('/:rideId/complete', 
  restrictUserType('driver'),
  rideController.completeRide
);

router.patch('/:rideId/cancel', 
  rideController.cancelRide
);

router.post('/:rideId/rate', 
  rideController.rateRide
);

router.get('/:rideId', 
  rideController.getRideDetails
);

router.get('/:rideId/track', 
  rideController.trackRide
);

module.exports = router;