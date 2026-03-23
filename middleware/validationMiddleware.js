const { body, validationResult } = require('express-validator');

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));
    
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }
    
    res.status(400).json({
      status: 'fail',
      message: 'Validation failed',
      errors: errors.array()
    });
  };
};

// User validations
const userValidations = {
  register: [
    body('name').notEmpty().withMessage('Name is required').isLength({ min: 2, max: 50 }),
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('phone').matches(/^[0-9]{10}$/).withMessage('Please provide a valid 10-digit phone number'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
  ],
  login: [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').notEmpty().withMessage('Password is required')
  ],
  updateProfile: [
    body('name').optional().isLength({ min: 2, max: 50 }),
    body('phone').optional().matches(/^[0-9]{10}$/),
    body('email').optional().isEmail()
  ]
};

// Driver validations
const driverValidations = {
  register: [
    body('name').notEmpty(),
    body('email').isEmail(),
    body('phone').matches(/^[0-9]{10}$/),
    body('password').isLength({ min: 6 }),
    body('idNumber').notEmpty(),
    body('licenseNumber').notEmpty(),
    body('vehicle.plateNumber').notEmpty(),
    body('vehicle.make').notEmpty(),
    body('vehicle.model').notEmpty(),
    body('vehicle.color').notEmpty()
  ],
  location: [
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 })
  ]
};

// Ride validations
const rideValidations = {
  request: [
    body('pickup.latitude').isFloat({ min: -90, max: 90 }),
    body('pickup.longitude').isFloat({ min: -180, max: 180 }),
    body('pickup.address').optional(),
    body('destination.latitude').isFloat({ min: -90, max: 90 }),
    body('destination.longitude').isFloat({ min: -180, max: 180 }),
    body('destination.address').optional(),
    body('vehicleType').optional().isIn(['standard', 'premium', 'shared'])
  ]
};

module.exports = { validate, userValidations, driverValidations, rideValidations };