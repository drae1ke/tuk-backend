/**
 * middleware/commissionGuard.js
 *
 * Express middleware that blocks restricted drivers from accepting new rides.
 * Attach to any driver-only route that creates or accepts a ride.
 *
 * Usage:
 *   router.patch('/:id/accept', protect, restrictUserType('driver'), commissionGuard, acceptRide);
 */

'use strict';

const Driver = require('../models/Driver');
const { AppError } = require('./errorMiddleware');
const catchAsync = require('../utils/catchAsync');

/**
 * Allows the request through only if:
 *   - Driver account status is 'active'
 *   - Commission account status is 'active'
 *
 * Re-reads from DB to get fresh status (avoids stale JWT claims).
 */
const commissionGuard = catchAsync(async (req, res, next) => {
  const driver = await Driver.findById(req.user.id)
    .select('status commissionAccountStatus commissionGraceEndsAt outstandingCommissionBalance')
    .lean();

  if (!driver) {
    return next(new AppError('Driver account not found', 404));
  }

  if (driver.status !== 'active') {
    return next(
      new AppError(
        `Your driver account is ${driver.status}. Please contact support.`,
        403
      )
    );
  }

  if (driver.commissionAccountStatus === 'restricted') {
    const outstanding = driver.outstandingCommissionBalance || 0;
    const deadline = driver.commissionGraceEndsAt
      ? new Date(driver.commissionGraceEndsAt).toDateString()
      : 'past due';

    return next(
      new AppError(
        `Your account is restricted due to unpaid commission of KES ${outstanding} (deadline: ${deadline}). Pay via your dashboard to resume receiving rides.`,
        403
      )
    );
  }

  next();
});

module.exports = { commissionGuard };