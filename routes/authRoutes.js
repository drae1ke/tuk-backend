const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validate, userValidations } = require('../middleware/validationMiddleware');
const { protect } = require('../middleware/authMiddleware');

// Public routes
router.post('/register', validate(userValidations.register), authController.register);
router.post('/login', validate(userValidations.login), authController.login);
router.post('/driver/register', authController.registerDriver);
// Legacy alias for older clients. New clients should use /auth/login.
router.post('/driver/login', authController.driverLogin);
router.post('/refresh-token', authController.refreshToken);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);
router.post('/verify-email/:token', authController.verifyEmail);

// Protected routes
router.use(protect);
router.post('/logout', authController.logout);
router.get('/me', authController.getMe);
router.get('/sessions', authController.getSessions);
router.delete('/sessions/:sessionId', authController.logoutSession);
router.patch('/update-password', authController.updatePassword);
router.post('/change-phone', authController.changePhone);
router.post('/verify-phone', authController.verifyPhone);

module.exports = router;
