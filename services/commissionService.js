const crypto = require('crypto');
const Commission = require('../models/Commission');
const Driver = require('../models/Driver');
const PaymentTransaction = require('../models/PaymentTransaction');
const Ride = require('../models/Ride');
const logger = require('../utils/logger');
const { sendEmail } = require('../utils/emailService');
const {
  DEFAULT_TIMEZONE,
  getCountdownMs,
  getGraceDeadlineForWeek,
  getPreviousWeekWindow,
  getWeekRelativeDate,
  getWeekWindow
} = require('../utils/businessTime');
const { initiateStkPush } = require('./mpesaService');

const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.1);
const STK_RETRY_WINDOW_MS = Number(process.env.MPESA_STK_RETRY_WINDOW_MS || 120000);

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const calculateRideCommission = (fare) => roundCurrency(Number(fare || 0) * COMMISSION_RATE);

const getCommissionTargetAmount = (commission) => (
  roundCurrency(
    commission?.dueAmount && Number(commission.dueAmount) > 0
      ? commission.dueAmount
      : commission?.amount || 0
  )
);

const getCommissionPayableAmount = (commission) => (
  roundCurrency(Math.max(getCommissionTargetAmount(commission) - Number(commission?.paidAmount || 0), 0))
);

const canDriverReceiveRequests = (driver) => (
  Boolean(driver) &&
  driver.status === 'active' &&
  driver.commissionAccountStatus === 'active' &&
  driver.online &&
  driver.available
);

const recordNotification = async (commissions, type, channel, metadata = {}) => {
  if (!commissions.length) {
    return;
  }

  await Commission.updateMany(
    { _id: { $in: commissions.map((commission) => commission._id) } },
    {
      $push: {
        notifications: {
          type,
          channel,
          metadata,
          sentAt: new Date()
        }
      },
      ...(type === 'reminder' ? { $set: { lastReminderAt: new Date() } } : {})
    }
  );
};

const sendDriverNotification = async ({ driver, commissions, type, subject, body }) => {
  let channel = 'log';

  if (driver?.email && process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      await sendEmail(
        driver.email,
        subject,
        `<p>${body}</p>`
      );
      channel = 'email';
    } catch (error) {
      logger.warn(`Commission notification email failed for driver ${driver._id}: ${error.message}`);
    }
  }

  logger.info({
    event: 'commission.notification',
    driverId: driver?._id?.toString(),
    type,
    subject,
    body
  });

  await recordNotification(commissions, type, channel, { subject, body });
};

const getDriverOutstandingCommissions = async (driverId) => (
  Commission.find({
    driverId,
    status: { $in: ['pending', 'overdue'] },
    outstandingAmount: { $gt: 0 }
  }).sort({ weekStart: 1 })
);

const getDriverPayableCommissions = async (driverId) => {
  const commissions = await Commission.find({
    driverId,
    status: { $in: ['accruing', 'pending', 'overdue'] }
  }).sort({ weekStart: 1 });

  return commissions.filter((commission) => getCommissionPayableAmount(commission) > 0);
};

const refreshDriverCommissionState = async (driverId, options = {}) => {
  const now = options.now || new Date();
  const { weekStart } = getWeekWindow(now, DEFAULT_TIMEZONE);

  const [driver, currentWeekCommission, outstandingCommissions] = await Promise.all([
    Driver.findById(driverId),
    Commission.findOne({
      driverId,
      weekStart,
      status: 'accruing'
    }),
    getDriverOutstandingCommissions(driverId)
  ]);

  if (!driver) {
    return null;
  }

  const outstandingCommissionBalance = roundCurrency(
    outstandingCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
  );

  const shouldRestrict = outstandingCommissions.some((commission) => (
    commission.graceEndsAt && commission.graceEndsAt.getTime() < now.getTime()
  ));

  const earliestGraceDeadline = outstandingCommissions
    .map((commission) => commission.graceEndsAt)
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0] || null;

  const nextAvailability = shouldRestrict
    ? false
    : Boolean(driver.status === 'active' && driver.online && !driver.currentRide && driver.commissionAccountStatus === 'restricted');

  const updates = {
    weeklyCommissionBalance: roundCurrency(currentWeekCommission?.amount || 0),
    currentCommissionWeekStart: weekStart,
    currentCommissionWeekEnd: getWeekWindow(now, DEFAULT_TIMEZONE).weekEnd,
    outstandingCommissionBalance,
    commissionGraceEndsAt: earliestGraceDeadline,
    commissionAccountStatus: shouldRestrict ? 'restricted' : 'active',
    restrictionReason: shouldRestrict ? 'Outstanding weekly commission was not paid before the grace deadline' : null
  };

  if (shouldRestrict) {
    updates.available = false;
  } else if (nextAvailability) {
    updates.available = true;
  }

  await Driver.findByIdAndUpdate(driverId, updates, { new: true });

  return {
    ...updates,
    canReceiveRideRequests: canDriverReceiveRequests({
      ...driver.toObject(),
      ...updates,
      available: updates.available !== undefined ? updates.available : driver.available
    })
  };
};

const recordRideCommission = async (ride) => {
  if (!ride?.driverId || ride.status !== 'completed') {
    return { skipped: true, reason: 'ride-not-eligible' };
  }

  const completedAt = ride.completedAt ? new Date(ride.completedAt) : new Date();
  const { weekStart, weekEnd } = getWeekWindow(completedAt, DEFAULT_TIMEZONE);
  const commissionAmount = calculateRideCommission(ride.fare);
  const grossFare = roundCurrency(ride.fare);

  const updatedRide = await Ride.findOneAndUpdate(
    {
      _id: ride._id,
      $or: [
        { commissionProcessedAt: { $exists: false } },
        { commissionProcessedAt: null }
      ]
    },
    {
      $set: {
        commissionAmount,
        commissionRate: COMMISSION_RATE,
        commissionWeekStart: weekStart,
        commissionWeekEnd: weekEnd,
        commissionProcessedAt: new Date()
      }
    },
    { new: true }
  );

  if (!updatedRide) {
    return { skipped: true, reason: 'already-processed' };
  }

  await Commission.findOneAndUpdate(
    { driverId: ride.driverId, weekStart },
    {
      $setOnInsert: {
        driverId: ride.driverId,
        weekStart,
        weekEnd,
        amount: 0,
        dueAmount: 0,
        paidAmount: 0,
        outstandingAmount: 0,
        grossFares: 0,
        rideCount: 0,
        currency: 'KES',
        status: 'accruing'
      },
      $inc: {
        amount: commissionAmount,
        grossFares: grossFare,
        rideCount: 1
      },
      $addToSet: {
        rideIds: ride._id
      },
      $push: {
        lineItems: {
          rideId: ride._id,
          fare: grossFare,
          commissionAmount,
          completedAt
        }
      }
    },
    { upsert: true }
  );

  await refreshDriverCommissionState(ride.driverId, { now: completedAt });

  return {
    commissionAmount,
    weekStart,
    weekEnd
  };
};

const runWeeklySettlement = async ({
  referenceDate = new Date(),
  targetWeekStart = null,
  triggeredBy = 'scheduler'
} = {}) => {
  const targetWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(referenceDate, DEFAULT_TIMEZONE);
  const now = new Date();
  const graceEndsAt = getGraceDeadlineForWeek(targetWindow.weekStart, DEFAULT_TIMEZONE);

  const rides = await Ride.find({
    driverId: { $ne: null },
    status: 'completed',
    completedAt: { $gte: targetWindow.weekStart, $lte: targetWindow.weekEnd }
  }).select('_id driverId fare completedAt commissionAmount').lean();

  const grouped = new Map();
  const missingCommissionUpdates = [];

  for (const ride of rides) {
    const driverId = ride.driverId.toString();
    const commissionAmount = roundCurrency(
      ride.commissionAmount != null ? ride.commissionAmount : calculateRideCommission(ride.fare)
    );

    if (ride.commissionAmount == null) {
      missingCommissionUpdates.push({
        updateOne: {
          filter: { _id: ride._id },
          update: {
            $set: {
              commissionAmount,
              commissionRate: COMMISSION_RATE,
              commissionWeekStart: targetWindow.weekStart,
              commissionWeekEnd: targetWindow.weekEnd,
              commissionProcessedAt: new Date()
            }
          }
        }
      });
    }

    if (!grouped.has(driverId)) {
      grouped.set(driverId, {
        driverId: ride.driverId,
        amount: 0,
        grossFares: 0,
        rideCount: 0,
        rideIds: [],
        lineItems: []
      });
    }

    const summary = grouped.get(driverId);
    summary.amount = roundCurrency(summary.amount + commissionAmount);
    summary.grossFares = roundCurrency(summary.grossFares + roundCurrency(ride.fare));
    summary.rideCount += 1;
    summary.rideIds.push(ride._id);
    summary.lineItems.push({
      rideId: ride._id,
      fare: roundCurrency(ride.fare),
      commissionAmount,
      completedAt: ride.completedAt
    });
  }

  if (missingCommissionUpdates.length) {
    await Ride.bulkWrite(missingCommissionUpdates);
  }

  const affectedDriverIds = [];
  const settledCommissions = [];

  for (const summary of grouped.values()) {
    const commission = await Commission.findOne({
      driverId: summary.driverId,
      weekStart: targetWindow.weekStart
    });

    const paidAmount = roundCurrency(commission?.paidAmount || 0);
    const outstandingAmount = roundCurrency(Math.max(summary.amount - paidAmount, 0));

    const payload = {
      driverId: summary.driverId,
      weekStart: targetWindow.weekStart,
      weekEnd: targetWindow.weekEnd,
      amount: summary.amount,
      dueAmount: summary.amount,
      paidAmount,
      outstandingAmount,
      grossFares: summary.grossFares,
      rideCount: summary.rideCount,
      rideIds: summary.rideIds,
      lineItems: summary.lineItems,
      currency: 'KES',
      settledAt: commission?.settledAt || now,
      dueAt: graceEndsAt,
      graceEndsAt,
      metadata: {
        ...(commission?.metadata || {}),
        lastSettledBy: triggeredBy,
        lastSettledAt: now
      }
    };

    if (outstandingAmount <= 0) {
      payload.status = 'paid';
      payload.paidAt = commission?.paidAt || now;
    } else {
      payload.status = now > graceEndsAt ? 'overdue' : 'pending';
      payload.paidAt = commission?.paidAt || undefined;
    }

    const updated = await Commission.findOneAndUpdate(
      { driverId: summary.driverId, weekStart: targetWindow.weekStart },
      { $set: payload, $setOnInsert: { notifications: [] } },
      { new: true, upsert: true }
    );

    settledCommissions.push(updated);
    affectedDriverIds.push(summary.driverId.toString());
  }

  const drivers = await Driver.find({ _id: { $in: affectedDriverIds } });

  for (const driver of drivers) {
    const driverCommissions = settledCommissions.filter((commission) => (
      commission.driverId.toString() === driver._id.toString() && commission.outstandingAmount > 0
    ));

    if (driverCommissions.length) {
      const totalDue = roundCurrency(
        driverCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
      );

      await sendDriverNotification({
        driver,
        commissions: driverCommissions,
        type: 'summary',
        subject: 'Weekly commission summary',
        body: `Your commission for ${targetWindow.weekKey} is KES ${totalDue}. Please pay by ${graceEndsAt.toISOString()}.`
      });
    }
  }

  await Promise.all(affectedDriverIds.map((driverId) => refreshDriverCommissionState(driverId)));

  return {
    weekStart: targetWindow.weekStart,
    weekEnd: targetWindow.weekEnd,
    driversSettled: affectedDriverIds.length,
    totalCommission: roundCurrency(
      settledCommissions.reduce((sum, commission) => sum + Number(commission.dueAmount || 0), 0)
    )
  };
};

const buildAccountReference = (driverId, commissions) => {
  const oldestWeek = commissions[0]?.weekStart
    ? new Date(commissions[0].weekStart).toISOString().slice(2, 10).replace(/-/g, '')
    : 'COMM';

  return `TR${oldestWeek}${driverId.toString().slice(-4)}`;
};

const initiateCommissionPayment = async ({
  driverId,
  requestSource = 'driver',
  idempotencyKey = null
}) => {
  const [driver, commissions] = await Promise.all([
    Driver.findById(driverId),
    getDriverPayableCommissions(driverId)
  ]);

  if (!driver) {
    throw new Error('Driver not found');
  }

  if (!commissions.length) {
    throw new Error('No accrued commission balance to pay');
  }

  const totalPayable = roundCurrency(
    commissions.reduce((sum, commission) => sum + getCommissionPayableAmount(commission), 0)
  );
  const phoneNumber = driver.mpesaNumber || driver.phone;

  if (!phoneNumber) {
    throw new Error('Driver does not have a registered M-Pesa number');
  }

  if (idempotencyKey) {
    const existingByKey = await PaymentTransaction.findOne({ idempotencyKey });
    if (existingByKey) {
      return { transaction: existingByKey, reused: true };
    }
  }

  const existingPendingTransaction = await PaymentTransaction.findOne({
    driverId,
    status: { $in: ['initiated', 'pending_callback'] },
    createdAt: { $gte: new Date(Date.now() - STK_RETRY_WINDOW_MS) }
  }).sort({ createdAt: -1 });

  if (existingPendingTransaction) {
    return { transaction: existingPendingTransaction, reused: true };
  }

  const transaction = await PaymentTransaction.create({
    driverId,
    commissionIds: commissions.map((commission) => commission._id),
    amount: totalPayable,
    phoneNumber,
    requestSource,
    status: 'initiated',
    idempotencyKey: idempotencyKey || `comm_${Date.now()}_${crypto.randomUUID()}`,
    allocation: commissions.map((commission) => ({
      commissionId: commission._id,
      weekStart: commission.weekStart,
      weekEnd: commission.weekEnd,
      amount: getCommissionPayableAmount(commission)
    }))
  });

  try {
    const mpesaResponse = await initiateStkPush({
      phoneNumber,
      amount: totalPayable,
      accountReference: buildAccountReference(driverId, commissions),
      description: 'Driver commission',
      transactionId: transaction._id.toString()
    });

    transaction.status = 'pending_callback';
    transaction.phoneNumber = mpesaResponse.normalizedPhone;
    transaction.requestPayload = mpesaResponse.requestPayload;
    transaction.responsePayload = mpesaResponse.responsePayload;
    transaction.merchantRequestId = mpesaResponse.responsePayload.MerchantRequestID;
    transaction.checkoutRequestId = mpesaResponse.responsePayload.CheckoutRequestID;
    await transaction.save();

    return { transaction, reused: false };
  } catch (error) {
    transaction.status = 'failed';
    transaction.failureReason = error.response?.data?.errorMessage || error.message;
    transaction.responsePayload = error.response?.data || null;
    await transaction.save();

    await sendDriverNotification({
      driver,
      commissions,
      type: 'payment_failure',
      subject: 'Commission payment failed',
      body: `We could not start your M-Pesa STK Push. Reason: ${transaction.failureReason}`
    });

    throw error;
  }
};

const applyPaymentAllocation = async (transaction, paidAmount) => {
  const commissions = await Commission.find({
    _id: { $in: transaction.commissionIds }
  }).sort({ weekStart: 1 });

  let remaining = roundCurrency(paidAmount);
  const allocations = [];

  for (const commission of commissions) {
    const payableAmount = getCommissionPayableAmount(commission);

    if (remaining <= 0 || payableAmount <= 0) {
      allocations.push({
        commissionId: commission._id,
        weekStart: commission.weekStart,
        weekEnd: commission.weekEnd,
        amount: 0
      });
      continue;
    }

    const appliedAmount = roundCurrency(Math.min(payableAmount, remaining));
    commission.paidAmount = roundCurrency(commission.paidAmount + appliedAmount);
    commission.outstandingAmount = roundCurrency(Math.max(getCommissionTargetAmount(commission) - commission.paidAmount, 0));

    if (commission.status === 'accruing' && (!commission.dueAmount || Number(commission.dueAmount) === 0)) {
      commission.status = 'accruing';
      if (commission.outstandingAmount === 0) {
        commission.paidAt = null;
      }
    } else {
      commission.status = commission.outstandingAmount > 0
        ? (new Date() > commission.graceEndsAt ? 'overdue' : 'pending')
        : 'paid';

      if (commission.status === 'paid') {
        commission.paidAt = new Date();
      }
    }

    await commission.save();

    allocations.push({
      commissionId: commission._id,
      weekStart: commission.weekStart,
      weekEnd: commission.weekEnd,
      amount: appliedAmount
    });

    remaining = roundCurrency(remaining - appliedAmount);
  }

  transaction.allocation = allocations;
  return { allocations, remaining };
};

const handleCommissionPaymentCallback = async (callback) => {
  const transaction = await PaymentTransaction.findOne({
    checkoutRequestId: callback.checkoutRequestId
  });

  if (!transaction) {
    logger.warn(`M-Pesa callback received for unknown checkout request ${callback.checkoutRequestId}`);
    return { handled: false, reason: 'not-found' };
  }

  if (['succeeded', 'failed', 'partially_allocated'].includes(transaction.status)) {
    return { handled: true, transaction, duplicate: true };
  }

  transaction.callbackPayload = callback.raw;
  transaction.resultCode = callback.resultCode;
  transaction.resultDesc = callback.resultDesc;
  transaction.callbackReceivedAt = new Date();

  const driver = await Driver.findById(transaction.driverId);
  const commissions = await Commission.find({ _id: { $in: transaction.commissionIds } });

  if (callback.resultCode === 0) {
    const paidAmount = roundCurrency(callback.metadata.Amount || transaction.amount);
    transaction.mpesaReceipt = callback.metadata.MpesaReceiptNumber;
    transaction.completedAt = new Date();
    transaction.status = 'succeeded';

    const { remaining } = await applyPaymentAllocation(transaction, paidAmount);
    if (remaining > 0) {
      transaction.status = 'partially_allocated';
    }

    await transaction.save();

    if (driver) {
      driver.lastPaymentDate = new Date();
      await driver.save();
      await refreshDriverCommissionState(driver._id);
    }

    await sendDriverNotification({
      driver,
      commissions,
      type: 'payment_success',
      subject: 'Commission payment received',
      body: `Your M-Pesa payment of KES ${paidAmount} was received successfully.`
    });

    return { handled: true, transaction };
  }

  transaction.status = 'failed';
  transaction.failureReason = callback.resultDesc;
  await transaction.save();

  await sendDriverNotification({
    driver,
    commissions,
    type: 'payment_failure',
    subject: 'Commission payment failed',
    body: `Your M-Pesa payment was not completed. Reason: ${callback.resultDesc}`
  });

  return { handled: true, transaction };
};

const getDriverCommissionSnapshot = async (driverId) => {
  const now = new Date();
  const { weekStart, weekEnd } = getWeekWindow(now, DEFAULT_TIMEZONE);

  const [driver, currentWeekCommission, outstandingCommissions, payableCommissions, recentTransactions] = await Promise.all([
    Driver.findById(driverId).lean(),
    Commission.findOne({ driverId, weekStart, status: 'accruing' }).lean(),
    Commission.find({
      driverId,
      status: { $in: ['pending', 'overdue'] },
      outstandingAmount: { $gt: 0 }
    }).sort({ weekStart: 1 }).lean(),
    Commission.find({
      driverId,
      status: { $in: ['accruing', 'pending', 'overdue'] }
    }).sort({ weekStart: 1 }).lean(),
    PaymentTransaction.find({ driverId }).sort({ createdAt: -1 }).limit(5).lean()
  ]);

  if (!driver) {
    throw new Error('Driver not found');
  }

  const totalDue = roundCurrency(
    outstandingCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
  );
  const payableNow = roundCurrency(
    payableCommissions.reduce((sum, commission) => sum + getCommissionPayableAmount(commission), 0)
  );
  const currentWeekPayable = roundCurrency(getCommissionPayableAmount(currentWeekCommission));
  const nextDeadline = outstandingCommissions
    .map((commission) => commission.graceEndsAt)
    .filter(Boolean)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null;

  return {
    accountStatus: driver.commissionAccountStatus || 'active',
    onboardingStatus: driver.status,
    canReceiveRideRequests: Boolean(
      driver.status === 'active' &&
      (driver.commissionAccountStatus || 'active') === 'active' &&
      driver.online &&
      driver.available
    ),
    currentWeek: {
      weekStart,
      weekEnd,
      accruedAmount: roundCurrency(currentWeekCommission?.amount || 0),
      paidAmount: roundCurrency(currentWeekCommission?.paidAmount || 0),
      payableNow: currentWeekPayable,
      rideCount: currentWeekCommission?.rideCount || 0
    },
    payableNow,
    outstanding: {
      totalDue,
      commissionCount: outstandingCommissions.length,
      graceEndsAt: nextDeadline,
      countdownMs: getCountdownMs(nextDeadline),
      commissions: outstandingCommissions.map((commission) => ({
        id: commission._id,
        amount: commission.amount,
        dueAmount: commission.dueAmount,
        outstandingAmount: commission.outstandingAmount,
        weekStart: commission.weekStart,
        weekEnd: commission.weekEnd,
        status: commission.status
      }))
    },
    lastPaymentDate: driver.lastPaymentDate || null,
    latestTransaction: recentTransactions[0] || null,
    recentTransactions
  };
};

const sendPaymentReminders = async ({ targetWeekStart = null } = {}) => {
  const referenceWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(new Date(), DEFAULT_TIMEZONE);

  const commissions = await Commission.find({
    status: { $in: ['pending', 'overdue'] },
    outstandingAmount: { $gt: 0 },
    weekStart: { $lte: referenceWindow.weekStart }
  }).populate('driverId');

  const byDriver = new Map();

  for (const commission of commissions) {
    const key = commission.driverId._id.toString();
    if (!byDriver.has(key)) {
      byDriver.set(key, { driver: commission.driverId, commissions: [] });
    }
    byDriver.get(key).commissions.push(commission);
  }

  let remindersSent = 0;

  for (const { driver, commissions: driverCommissions } of byDriver.values()) {
    const totalDue = roundCurrency(
      driverCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
    );

    await sendDriverNotification({
      driver,
      commissions: driverCommissions,
      type: 'reminder',
      subject: 'Commission payment reminder',
      body: `You have KES ${totalDue} due in commission payments. Please pay before ${driverCommissions[0].graceEndsAt.toISOString()}.`
    });

    remindersSent += 1;

    if (process.env.COMMISSION_AUTO_STK_PUSH === 'true') {
      try {
        await initiateCommissionPayment({
          driverId: driver._id,
          requestSource: 'system'
        });
      } catch (error) {
        logger.warn(`Automatic commission STK push failed for ${driver._id}: ${error.message}`);
      }
    }
  }

  return { remindersSent };
};

const sendGraceWarnings = async ({ targetWeekStart = null } = {}) => {
  const referenceWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(new Date(), DEFAULT_TIMEZONE);

  const commissions = await Commission.find({
    status: { $in: ['pending', 'overdue'] },
    outstandingAmount: { $gt: 0 },
    weekStart: { $lte: referenceWindow.weekStart }
  }).populate('driverId');

  const byDriver = new Map();

  for (const commission of commissions) {
    const key = commission.driverId._id.toString();
    if (!byDriver.has(key)) {
      byDriver.set(key, { driver: commission.driverId, commissions: [] });
    }
    byDriver.get(key).commissions.push(commission);
  }

  let warningsSent = 0;

  for (const { driver, commissions: driverCommissions } of byDriver.values()) {
    const totalDue = roundCurrency(
      driverCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
    );
    const nearestDeadline = driverCommissions
      .map((commission) => commission.graceEndsAt)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await sendDriverNotification({
      driver,
      commissions: driverCommissions,
      type: 'warning',
      subject: 'Grace period warning',
      body: `Your account will be restricted if the outstanding commission of KES ${totalDue} is not paid before ${nearestDeadline.toISOString()}.`
    });

    warningsSent += 1;
  }

  return { warningsSent };
};

const restrictOverdueDrivers = async ({ referenceDate = new Date(), targetWeekStart = null } = {}) => {
  const targetWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(referenceDate, DEFAULT_TIMEZONE);

  const now = new Date();
  const overdueCommissions = await Commission.find({
    outstandingAmount: { $gt: 0 },
    graceEndsAt: { $lt: now },
    weekStart: { $lte: targetWindow.weekStart }
  }).populate('driverId');

  const byDriver = new Map();

  for (const commission of overdueCommissions) {
    const key = commission.driverId._id.toString();
    if (!byDriver.has(key)) {
      byDriver.set(key, { driver: commission.driverId, commissions: [] });
    }
    byDriver.get(key).commissions.push(commission);
  }

  let restrictedDrivers = 0;

  for (const { driver, commissions: driverCommissions } of byDriver.values()) {
    for (const commission of driverCommissions) {
      commission.status = 'overdue';
      commission.restrictedAt = commission.restrictedAt || now;
      await commission.save();
    }

    await refreshDriverCommissionState(driver._id, { now });

    const totalDue = roundCurrency(
      driverCommissions.reduce((sum, commission) => sum + Number(commission.outstandingAmount || 0), 0)
    );

    await sendDriverNotification({
      driver,
      commissions: driverCommissions,
      type: 'restriction',
      subject: 'Account restricted',
      body: `Your driver account has been restricted because KES ${totalDue} in weekly commission remains unpaid.`
    });

    restrictedDrivers += 1;
  }

  return { restrictedDrivers };
};

module.exports = {
  calculateRideCommission,
  canDriverReceiveRequests,
  getDriverCommissionSnapshot,
  handleCommissionPaymentCallback,
  initiateCommissionPayment,
  recordRideCommission,
  refreshDriverCommissionState,
  restrictOverdueDrivers,
  runWeeklySettlement,
  sendGraceWarnings,
  sendPaymentReminders
};
