const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);
router.use(restrictTo('admin'));

router.get('/dashboard', adminController.getDashboardStats);
router.post('/run-weekly-settlement', adminController.runWeeklySettlement);
router.get('/pricing', adminController.getPricing);
router.patch('/pricing', adminController.updatePricing);
router.get('/drivers', adminController.getDrivers);
router.patch('/drivers/:id', adminController.updateDriverStatus);
router.delete('/drivers/:id', adminController.deleteDriver);

router.get('/clients', adminController.getClients);
router.patch('/clients/:id', adminController.updateClientStatus);
router.delete('/clients/:id', adminController.deleteClient);

module.exports = router;
