const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

// Public webhook (no auth)
router.post('/mpesa-callback', paymentController.mpesaCallback);

// Protected routes
router.use(protect);

// Payment initiation
router.post('/mpesa', paymentController.initiateMpesaPayment);
router.post('/cash', paymentController.processCashPayment);

// Payment history
router.get('/history', paymentController.getPaymentHistory);
router.get('/:paymentId', paymentController.getPaymentDetails);

// Refunds
router.post('/refund', paymentController.requestRefund);

module.exports = router;