const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { protect, restrictUserType } = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validationMiddleware');

// All routes require authentication and user type
router.use(protect);
router.use(restrictUserType('user'));

// Profile routes
router.get('/profile', userController.getUserProfile);
router.patch('/profile', userController.updateUserProfile);

// Address routes
router.get('/addresses', userController.getUserProfile); // Addresses are in profile
router.post('/addresses', userController.addSavedAddress);
router.patch('/addresses/:addressId', userController.updateSavedAddress);
router.delete('/addresses/:addressId', userController.deleteSavedAddress);

// Payment methods
router.get('/payment-methods', userController.getUserProfile);
router.post('/payment-methods', userController.addPaymentMethod);
router.delete('/payment-methods/:methodId', userController.deletePaymentMethod);

// Stats and history
router.get('/stats', userController.getUserStats);
router.get('/recent-rides', userController.getRecentRides);
router.get('/favorite-drivers', userController.getFavoriteDrivers);

// Promo codes
router.get('/promos', userController.getPromoCodes);
router.post('/apply-promo', userController.applyPromoCode);

module.exports = router;