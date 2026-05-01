/**
 * services/commissionService.js
 *
 * All commission lifecycle logic:
 *   recordRideCommission        → accrue after a completed ride
 *   runWeeklySettlement         → Sunday 23:59 — finalize totals, set due amounts
 *   sendPaymentReminders        → Monday 08:00 — remind drivers
 *   sendGraceWarnings           → Following Sunday 08:00 — final warning
 *   restrictOverdueDrivers      → Following Monday 00:00 — cut off late-payers
 *   initiateCommissionPayment   → STK Push trigger (manual or system)
 *   handleCommissionPaymentCallback → M-Pesa callback handler
 *   getDriverCommissionSnapshot → full dashboard state for a driver
 *   refreshDriverCommissionState → sync Driver doc fields from Commission truth
 */

'use strict';

const crypto = require('crypto');
const Commission = require('../models/Commission');
const Driver = require('../models/Driver');
const PaymentTransaction = require('../models/PaymentTransaction');
const Ride = require('../models/Ride');
const logger = require('../utils/logger');
const { sendEmail } = require('../utils/emailService');
const { initiateStkPush } = require('./mpesaService');
const {
  DEFAULT_TIMEZONE,
  getCountdownMs,
  getGraceDeadlineForWeek,
  getPreviousWeekWindow,
  getWeekWindow,
  getWeekRelativeDate,
} = require('../utils/businessTime');

// ── Constants ─────────────────────────────────────────────────────────────────
const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.10);
// How long (ms) to consider an STK Push still "pending" before allowing retry
const STK_RETRY_WINDOW_MS = Number(process.env.MPESA_STK_RETRY_WINDOW_MS || 120_000);

// ── Currency helpers ──────────────────────────────────────────────────────────
const roundCurrency = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

const calculateRideCommission = (fare) =>
  roundCurrency(Number(fare || 0) * COMMISSION_RATE);

/** Amount the driver still owes on a single Commission record */
const getCommissionPayableAmount = (commission) => {
  if (!commission) return 0;
  const target = roundCurrency(
    Number(commission.dueAmount) > 0
      ? commission.dueAmount
      : commission.amount || 0
  );
  return roundCurrency(Math.max(target - Number(commission.paidAmount || 0), 0));
};

// ── Notification helper ───────────────────────────────────────────────────────
const _sendDriverNotification = async ({ driver, commissions = [], type, subject, body }) => {
  let channel = 'log';
  const emailConfigured =
    driver?.email &&
    process.env.EMAIL_HOST &&
    process.env.EMAIL_USER &&
    process.env.EMAIL_PASS;

  if (emailConfigured) {
    try {
      await sendEmail(driver.email, subject, `<p>${body}</p>`);
      channel = 'email';
    } catch (err) {
      logger.warn(`Notification email failed for driver ${driver._id}: ${err.message}`);
    }
  }

  logger.info({ event: 'commission.notification', driverId: driver?._id, type, subject });

  if (commissions.length) {
    await Commission.updateMany(
      { _id: { $in: commissions.map((c) => c._id) } },
      {
        $push: { notifications: { type, channel, sentAt: new Date(), metadata: { subject, body } } },
        ...(type === 'reminder' ? { $set: { lastReminderAt: new Date() } } : {}),
      }
    );
  }
};

// ── Driver state refresh ──────────────────────────────────────────────────────
/**
 * Re-derives Driver document fields (balances, status, restriction) from
 * the ground-truth Commission collection.  Call this after any mutation.
 */
const refreshDriverCommissionState = async (driverId, { now = new Date() } = {}) => {
  console.log('[Commission] refreshDriverCommissionState START:', {
    driverId,
    now: now.toISOString(),
    timezone: DEFAULT_TIMEZONE
  });
  
  const { weekStart, weekEnd } = getWeekWindow(now, DEFAULT_TIMEZONE);
  console.log('[Commission] Week window:', { weekStart, weekEnd });

  const [driver, currentWeekCommission, outstandingCommissions] = await Promise.all([
    Driver.findById(driverId),
    Commission.findOne({ driverId, weekStart, status: 'accruing' }),
    Commission.find({
      driverId,
      status: { $in: ['pending', 'overdue'] },
      outstandingAmount: { $gt: 0 },
    }).sort({ weekStart: 1 }),
  ]);

  console.log('[Commission] Data fetched:', {
    driverId,
    driverFound: !!driver,
    currentWeekCommissionFound: !!currentWeekCommission,
    currentWeekCommissionAmount: currentWeekCommission?.amount,
    outstandingCommissionsCount: outstandingCommissions.length
  });

  if (!driver) {
    console.log('[Commission] Driver not found, returning null');
    return null;
  }

  const outstandingCommissionBalance = roundCurrency(
    outstandingCommissions.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
  );

  console.log('[Commission] Outstanding commissions:', {
    count: outstandingCommissions.length,
    totalBalance: outstandingCommissionBalance,
    details: outstandingCommissions.map(c => ({
      weekStart: c.weekStart,
      status: c.status,
      amount: c.amount,
      dueAmount: c.dueAmount,
      outstandingAmount: c.outstandingAmount
    }))
  });

  const shouldRestrict = outstandingCommissions.some(
    (c) => c.graceEndsAt && new Date(c.graceEndsAt) < now
  );

  const earliestGrace = outstandingCommissions
    .map((c) => c.graceEndsAt)
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0] || null;

  console.log('[Commission] Restriction check:', {
    shouldRestrict,
    earliestGrace,
    overdueCount: outstandingCommissions.filter(c => c.graceEndsAt && new Date(c.graceEndsAt) < now).length
  });

  const canBeAvailable =
    driver.status === 'active' &&
    driver.online &&
    !driver.currentRide &&
    !shouldRestrict;

  const updates = {
    weeklyCommissionBalance: roundCurrency(currentWeekCommission?.amount || 0),
    currentCommissionWeekStart: weekStart,
    currentCommissionWeekEnd: weekEnd,
    outstandingCommissionBalance,
    commissionGraceEndsAt: earliestGrace,
    commissionAccountStatus: shouldRestrict ? 'restricted' : 'active',
    restrictionReason: shouldRestrict
      ? 'Unpaid weekly remittance is more than 7 days overdue'
      : null,
    available: canBeAvailable,
  };

  console.log('[Commission] Updating driver with:', updates);
  
  await Driver.findByIdAndUpdate(driverId, updates);
  
  console.log('[Commission] Driver updated successfully');
  
  return { ...updates, canReceiveRideRequests: !shouldRestrict && driver.status === 'active' };
};

// ── Ride commission accrual ───────────────────────────────────────────────────
/**
 * Called immediately after a ride is marked `completed`.
 * Idempotent: uses commissionProcessedAt field to prevent double-counting.
 */
const recordRideCommission = async (rideRef) => {
  console.log('[Commission] recordRideCommission START:', {
    input: rideRef?._id || rideRef,
    timestamp: new Date().toISOString()
  });
  
  const rideId = rideRef?._id || rideRef;
  if (!rideId) {
    console.log('[Commission] SKIPPED: no rideId provided', { reason: 'no-ride-id' });
    return { skipped: true, reason: 'no-ride-id' };
  }

  // Always re-read the persisted ride so commission accrual does not depend
  // on whether the caller passed a fresh or stale in-memory document.
  console.log('[Commission] Fetching ride from DB:', { rideId });
  const ride = await Ride.findById(rideId).select(
    '_id driverId status fare completedAt commissionProcessedAt'
  );

  console.log('[Commission] Ride fetched from DB:', {
    rideId: ride?._id,
    driverId: ride?.driverId,
    status: ride?.status,
    fare: ride?.fare,
    completedAt: ride?.completedAt,
    commissionProcessedAt: ride?.commissionProcessedAt,
    rideFound: !!ride
  });

  if (!ride) {
    console.log('[Commission] SKIPPED: ride not found in database', { rideId });
    return { skipped: true, reason: 'ride-not-found' };
  }
  
  if (!ride?.driverId) {
    console.log('[Commission] SKIPPED: no driverId on ride', { rideId, driverId: ride?.driverId });
    return { skipped: true, reason: 'no-driver-id' };
  }
  
  if (ride.status !== 'completed') {
    console.log('[Commission] SKIPPED: ride not completed', { rideId, status: ride.status });
    return { skipped: true, reason: 'not-completed' };
  }
  
  console.log('[Commission] Ride validation passed, proceeding with accrual');

  const completedAt = ride.completedAt ? new Date(ride.completedAt) : new Date();
  const { weekStart, weekEnd } = getWeekWindow(completedAt, DEFAULT_TIMEZONE);
  const commissionAmount = calculateRideCommission(ride.fare);
  const grossFare = roundCurrency(ride.fare);
  
  console.log('[Commission] Calculated commission:', {
    rideId: ride._id,
    driverId: ride.driverId,
    fare: ride.fare,
    commissionRate: COMMISSION_RATE,
    commissionAmount,
    grossFare,
    weekStart,
    weekEnd,
    timezone: DEFAULT_TIMEZONE
  });

  // Atomic idempotency guard
  console.log('[Commission] Updating ride with commission metadata...');
  const updated = await Ride.findOneAndUpdate(
    {
      _id: ride._id,
      $or: [
        { commissionProcessedAt: { $exists: false } },
        { commissionProcessedAt: null },
      ],
    },
    {
      $set: {
        commissionAmount,
        commissionRate: COMMISSION_RATE,
        commissionWeekStart: weekStart,
        commissionWeekEnd: weekEnd,
        commissionProcessedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    console.log('[Commission] SKIPPED: ride already processed (idempotency check)', { rideId: ride._id });
    return { skipped: true, reason: 'already-processed' };
  }
  
  console.log('[Commission] Ride updated with commission info:', {
    rideId: updated._id,
    commissionAmount: updated.commissionAmount,
    commissionProcessedAt: updated.commissionProcessedAt
  });

  // Upsert the commission bucket for this driver-week
  console.log('[Commission] Upserting Commission record for driver-week:', {
    driverId: ride.driverId,
    weekStart,
    weekEnd,
    increment_amount: commissionAmount
  });
  
  const commissionRecord = await Commission.findOneAndUpdate(
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
        status: 'accruing',
        notifications: [],
      },
      $inc: { amount: commissionAmount, grossFares: grossFare, rideCount: 1 },
      $addToSet: { rideIds: ride._id },
      $push: {
        lineItems: {
          rideId: ride._id,
          fare: grossFare,
          commissionAmount,
          completedAt,
        },
      },
    },
    { upsert: true, new: true }
  );
  
  console.log('[Commission] Commission record upserted:', {
    commissionId: commissionRecord._id,
    driverId: commissionRecord.driverId,
    weekStart: commissionRecord.weekStart,
    totalAmount: commissionRecord.amount,
    rideCount: commissionRecord.rideCount,
    grossFares: commissionRecord.grossFares,
    status: commissionRecord.status
  });

  console.log('[Commission] Refreshing driver commission state for:', { driverId: ride.driverId });
  await refreshDriverCommissionState(ride.driverId, { now: completedAt });
  console.log('[Commission] Driver commission state refreshed');

  console.log('[Commission] ✅ recordRideCommission COMPLETED successfully:', {
    rideId: ride._id,
    driverId: ride.driverId,
    commissionAmount,
    weekStart,
    weekEnd,
    timestamp: new Date().toISOString()
  });
  
  return { commissionAmount, weekStart, weekEnd };
};

// ── Weekly settlement ─────────────────────────────────────────────────────────
/**
 * Run at Sunday 23:59.
 * Reads all completed rides for the target week, (re-)builds Commission totals,
 * sets dueAmount / graceEndsAt, transitions status from 'accruing' → 'pending'.
 */
const runWeeklySettlement = async ({
  referenceDate = new Date(),
  targetWeekStart = null,
  triggeredBy = 'scheduler',
} = {}) => {
  const targetWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(referenceDate, DEFAULT_TIMEZONE);

  const now = new Date();
  const graceEndsAt = getGraceDeadlineForWeek(targetWindow.weekStart, DEFAULT_TIMEZONE);

  // Aggregate rides for the week
  const rides = await Ride.find({
    driverId: { $ne: null },
    status: 'completed',
    completedAt: { $gte: targetWindow.weekStart, $lte: targetWindow.weekEnd },
  })
    .select('_id driverId fare completedAt commissionAmount')
    .lean();

  // Group by driver
  const grouped = new Map();
  const rideUpdates = [];

  for (const ride of rides) {
    const driverId = ride.driverId.toString();
    const commissionAmount = roundCurrency(
      ride.commissionAmount != null
        ? ride.commissionAmount
        : calculateRideCommission(ride.fare)
    );

    if (ride.commissionAmount == null) {
      rideUpdates.push({
        updateOne: {
          filter: { _id: ride._id, commissionProcessedAt: null },
          update: {
            $set: {
              commissionAmount,
              commissionRate: COMMISSION_RATE,
              commissionWeekStart: targetWindow.weekStart,
              commissionWeekEnd: targetWindow.weekEnd,
              commissionProcessedAt: now,
            },
          },
        },
      });
    }

    if (!grouped.has(driverId)) {
      grouped.set(driverId, {
        driverId: ride.driverId,
        amount: 0,
        grossFares: 0,
        rideCount: 0,
        rideIds: [],
        lineItems: [],
      });
    }

    const g = grouped.get(driverId);
    g.amount = roundCurrency(g.amount + commissionAmount);
    g.grossFares = roundCurrency(g.grossFares + roundCurrency(ride.fare));
    g.rideCount += 1;
    g.rideIds.push(ride._id);
    g.lineItems.push({
      rideId: ride._id,
      fare: roundCurrency(ride.fare),
      commissionAmount,
      completedAt: ride.completedAt,
    });
  }

  if (rideUpdates.length) await Ride.bulkWrite(rideUpdates);

  const affectedDriverIds = [];
  const settledCommissions = [];

  for (const g of grouped.values()) {
    const existing = await Commission.findOne({
      driverId: g.driverId,
      weekStart: targetWindow.weekStart,
    });

    const paidAmount = roundCurrency(existing?.paidAmount || 0);
    const outstandingAmount = roundCurrency(Math.max(g.amount - paidAmount, 0));

    const status =
      outstandingAmount <= 0
        ? 'paid'
        : now > graceEndsAt
        ? 'overdue'
        : 'pending';

    const payload = {
      driverId: g.driverId,
      weekStart: targetWindow.weekStart,
      weekEnd: targetWindow.weekEnd,
      amount: g.amount,
      dueAmount: g.amount,
      paidAmount,
      outstandingAmount,
      grossFares: g.grossFares,
      rideCount: g.rideCount,
      rideIds: g.rideIds,
      lineItems: g.lineItems,
      currency: 'KES',
      status,
      settledAt: existing?.settledAt || now,
      dueAt: graceEndsAt,
      graceEndsAt,
      paidAt: status === 'paid' ? (existing?.paidAt || now) : existing?.paidAt,
      metadata: {
        ...(existing?.metadata || {}),
        lastSettledBy: triggeredBy,
        lastSettledAt: now,
      },
    };

    const commission = await Commission.findOneAndUpdate(
      { driverId: g.driverId, weekStart: targetWindow.weekStart },
      { $set: payload, $setOnInsert: { notifications: [] } },
      { upsert: true, new: true }
    );

    settledCommissions.push(commission);
    affectedDriverIds.push(g.driverId.toString());
  }

  // Notify drivers with outstanding balances
  const drivers = await Driver.find({ _id: { $in: affectedDriverIds } }).lean();
  for (const driver of drivers) {
    const driverCommissions = settledCommissions.filter(
      (c) =>
        c.driverId.toString() === driver._id.toString() && c.outstandingAmount > 0
    );
    if (!driverCommissions.length) continue;

    const totalDue = roundCurrency(
      driverCommissions.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
    );

    await _sendDriverNotification({
      driver,
      commissions: driverCommissions,
      type: 'summary',
      subject: `TookRide: Your weekly commission — KES ${totalDue}`,
      body: `Your commission for the week of ${targetWindow.weekKey} is <strong>KES ${totalDue}</strong>. Please pay by ${graceEndsAt.toDateString()} to keep your account active.`,
    });
  }

  // Refresh all driver documents
  await Promise.all(affectedDriverIds.map((id) => refreshDriverCommissionState(id)));

  logger.info({
    event: 'commission.settlement',
    weekKey: targetWindow.weekKey,
    driversSettled: affectedDriverIds.length,
    totalCommission: roundCurrency(
      settledCommissions.reduce((s, c) => s + Number(c.dueAmount || 0), 0)
    ),
    triggeredBy,
  });

  return {
    weekStart: targetWindow.weekStart,
    weekEnd: targetWindow.weekEnd,
    driversSettled: affectedDriverIds.length,
    totalCommission: roundCurrency(
      settledCommissions.reduce((s, c) => s + Number(c.dueAmount || 0), 0)
    ),
  };
};

// ── Reminder jobs ─────────────────────────────────────────────────────────────
const sendPaymentReminders = async ({ targetWeekStart = null } = {}) => {
  const referenceWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(new Date(), DEFAULT_TIMEZONE);

  const commissions = await Commission.find({
    status: { $in: ['pending', 'overdue'] },
    outstandingAmount: { $gt: 0 },
    weekStart: { $lte: referenceWindow.weekStart },
  }).populate('driverId');

  const byDriver = new Map();
  for (const c of commissions) {
    const key = c.driverId._id.toString();
    if (!byDriver.has(key)) byDriver.set(key, { driver: c.driverId, commissions: [] });
    byDriver.get(key).commissions.push(c);
  }

  let remindersSent = 0;
  for (const { driver, commissions: dcs } of byDriver.values()) {
    const totalDue = roundCurrency(
      dcs.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
    );
    const nearestDeadline = dcs
      .map((c) => c.graceEndsAt)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await _sendDriverNotification({
      driver,
      commissions: dcs,
      type: 'reminder',
      subject: `TookRide: Pay KES ${totalDue} commission by ${nearestDeadline?.toDateString()}`,
      body: `You owe <strong>KES ${totalDue}</strong> in platform commission. Log in to TookRide and tap <em>Pay Now</em> to avoid losing ride access.`,
    });
    remindersSent++;

    // Optional: trigger automated STK push on reminder day
    if (process.env.COMMISSION_AUTO_STK_PUSH === 'true') {
      initiateCommissionPayment({ driverId: driver._id, requestSource: 'system' }).catch(
        (err) => logger.warn(`Auto STK push failed for ${driver._id}: ${err.message}`)
      );
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
    weekStart: { $lte: referenceWindow.weekStart },
  }).populate('driverId');

  const byDriver = new Map();
  for (const c of commissions) {
    const key = c.driverId._id.toString();
    if (!byDriver.has(key)) byDriver.set(key, { driver: c.driverId, commissions: [] });
    byDriver.get(key).commissions.push(c);
  }

  let warningsSent = 0;
  for (const { driver, commissions: dcs } of byDriver.values()) {
    const totalDue = roundCurrency(
      dcs.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
    );
    const nearestDeadline = dcs
      .map((c) => c.graceEndsAt)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await _sendDriverNotification({
      driver,
      commissions: dcs,
      type: 'warning',
      subject: `⚠️ TookRide: Last chance — KES ${totalDue} due TODAY`,
      body: `Your grace period ends ${nearestDeadline?.toDateString()}. If you don't pay <strong>KES ${totalDue}</strong> before midnight, your account will be <strong>restricted</strong> and you will not receive new ride requests.`,
    });
    warningsSent++;
  }

  return { warningsSent };
};

const restrictOverdueDrivers = async ({ referenceDate = new Date(), targetWeekStart = null } = {}) => {
  const targetWindow = targetWeekStart
    ? getWeekWindow(new Date(targetWeekStart), DEFAULT_TIMEZONE)
    : getPreviousWeekWindow(referenceDate, DEFAULT_TIMEZONE);

  const now = new Date();
  const overdue = await Commission.find({
    outstandingAmount: { $gt: 0 },
    graceEndsAt: { $lt: now },
    weekStart: { $lte: targetWindow.weekStart },
  }).populate('driverId');

  const byDriver = new Map();
  for (const c of overdue) {
    const key = c.driverId._id.toString();
    if (!byDriver.has(key)) byDriver.set(key, { driver: c.driverId, commissions: [] });
    byDriver.get(key).commissions.push(c);
  }

  let restrictedDrivers = 0;
  for (const { driver, commissions: dcs } of byDriver.values()) {
    // Mark each commission overdue
    for (const c of dcs) {
      c.status = 'overdue';
      c.restrictedAt = c.restrictedAt || now;
      await c.save();
    }

    await refreshDriverCommissionState(driver._id, { now });

    const totalDue = roundCurrency(
      dcs.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
    );

    await _sendDriverNotification({
      driver,
      commissions: dcs,
      type: 'restriction',
      subject: '🚫 TookRide: Account restricted — pay commission to resume',
      body: `Your account has been restricted because <strong>KES ${totalDue}</strong> in weekly commission was not paid before the grace period ended. Log in and pay to resume receiving ride requests.`,
    });

    restrictedDrivers++;
  }

  logger.info({ event: 'commission.restriction', restrictedDrivers });
  return { restrictedDrivers };
};

// ── Payment initiation ────────────────────────────────────────────────────────
const _buildAccountReference = (driverId, commissions) => {
  const weekTag = commissions[0]?.weekStart
    ? new Date(commissions[0].weekStart).toISOString().slice(2, 10).replace(/-/g, '')
    : 'COMM';
  return `TR${weekTag}${driverId.toString().slice(-4)}`;
};

/**
 * Trigger STK Push for all payable (accruing + pending + overdue) commission.
 * Idempotent: reuses any pending transaction within the retry window.
 */
const initiateCommissionPayment = async ({
  driverId,
  requestSource = 'driver',
  idempotencyKey = null,
}) => {
  const [driver, payableCommissions] = await Promise.all([
    Driver.findById(driverId),
    Commission.find({
      driverId,
      status: { $in: ['accruing', 'pending', 'overdue'] },
    })
      .sort({ weekStart: 1 })
      .then((cs) => cs.filter((c) => getCommissionPayableAmount(c) > 0)),
  ]);

  if (!driver) throw new Error('Driver not found');
  if (!payableCommissions.length) throw new Error('No payable commission balance');

  const totalPayable = roundCurrency(
    payableCommissions.reduce((s, c) => s + getCommissionPayableAmount(c), 0)
  );
  const phoneNumber = driver.mpesaNumber || driver.phone;
  if (!phoneNumber) throw new Error('Driver has no registered M-Pesa number');

  // Idempotency by caller-supplied key
  if (idempotencyKey) {
    const byKey = await PaymentTransaction.findOne({ idempotencyKey });
    if (byKey) return { transaction: byKey, reused: true };
  }

  // Idempotency by time window (prevent accidental double-sends)
  const pending = await PaymentTransaction.findOne({
    driverId,
    status: { $in: ['initiated', 'pending_callback'] },
    initiatedAt: { $gte: new Date(Date.now() - STK_RETRY_WINDOW_MS) },
  }).sort({ initiatedAt: -1 });
  if (pending) return { transaction: pending, reused: true };

  const transaction = await PaymentTransaction.create({
    driverId,
    commissionIds: payableCommissions.map((c) => c._id),
    amount: totalPayable,
    phoneNumber,
    requestSource,
    status: 'initiated',
    idempotencyKey: idempotencyKey || `comm_${Date.now()}_${crypto.randomUUID()}`,
    allocation: payableCommissions.map((c) => ({
      commissionId: c._id,
      weekStart: c.weekStart,
      weekEnd: c.weekEnd,
      amount: getCommissionPayableAmount(c),
    })),
    initiatedAt: new Date(),
  });

  try {
    const mpesa = await initiateStkPush({
      phoneNumber,
      amount: totalPayable,
      accountReference: _buildAccountReference(driverId, payableCommissions),
      description: 'TookRide comm',
      transactionId: transaction._id.toString(),
    });

    transaction.status = 'pending_callback';
    transaction.phoneNumber = mpesa.normalizedPhone;
    transaction.requestPayload = mpesa.requestPayload;
    transaction.responsePayload = mpesa.responsePayload;
    transaction.merchantRequestId = mpesa.responsePayload.MerchantRequestID;
    transaction.checkoutRequestId = mpesa.responsePayload.CheckoutRequestID;
    await transaction.save();

    return { transaction, reused: false };
  } catch (error) {
    transaction.status = 'failed';
    transaction.failureReason =
      error.darajaError?.errorMessage || error.message;
    transaction.responsePayload = error.darajaError || null;
    await transaction.save();

    await _sendDriverNotification({
      driver,
      commissions: payableCommissions,
      type: 'payment_failure',
      subject: 'TookRide: Commission payment could not be initiated',
      body: `We could not send the M-Pesa STK Push. Reason: <em>${transaction.failureReason}</em>. Please try again from your dashboard.`,
    });

    throw error;
  }
};

// ── Payment callback handling ─────────────────────────────────────────────────
/**
 * Apply a successful payment proportionally across the driver's outstanding
 * commission records (oldest first).
 */
const _applyPaymentAllocation = async (transaction, paidAmount) => {
  const commissions = await Commission.find({
    _id: { $in: transaction.commissionIds },
  }).sort({ weekStart: 1 });

  let remaining = roundCurrency(paidAmount);
  for (const c of commissions) {
    const payable = getCommissionPayableAmount(c);
    if (remaining <= 0 || payable <= 0) continue;

    const applied = roundCurrency(Math.min(payable, remaining));
    const isAccruingCommission =
      c.status === 'accruing' ||
      (!c.graceEndsAt && Number(c.dueAmount || 0) <= 0);

    c.paidAmount = roundCurrency(c.paidAmount + applied);
    const remainingBalance = roundCurrency(
      Math.max(
        (Number(c.dueAmount) > 0 ? Number(c.dueAmount) : Number(c.amount)) - c.paidAmount,
        0
      )
    );
    c.outstandingAmount = isAccruingCommission ? 0 : remainingBalance;

    const isFullyPaid = remainingBalance <= 0;
    if (isAccruingCommission) {
      c.status = 'accruing';
      if (isFullyPaid) {
        c.paidAt = new Date();
      }
    } else if (isFullyPaid) {
      c.status = 'paid';
      c.paidAt = new Date();
    } else {
      c.status = new Date() > c.graceEndsAt ? 'overdue' : 'pending';
    }

    await c.save();
    remaining = roundCurrency(remaining - applied);
  }

  return { remaining };
};

const handleCommissionPaymentCallback = async (callback) => {
  const transaction = await PaymentTransaction.findOne({
    checkoutRequestId: callback.checkoutRequestId,
  });

  if (!transaction) {
    logger.warn(`Callback received for unknown checkout: ${callback.checkoutRequestId}`);
    return { handled: false, reason: 'not-found' };
  }

  // Skip if already terminal
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
    // SUCCESS
    const paidAmount = roundCurrency(callback.metadata.Amount || transaction.amount);
    transaction.mpesaReceipt = callback.metadata.MpesaReceiptNumber;
    transaction.completedAt = new Date();
    transaction.status = 'succeeded';

    const { remaining } = await _applyPaymentAllocation(transaction, paidAmount);
    if (remaining > 0) transaction.status = 'partially_allocated';
    await transaction.save();

    if (driver) {
      driver.lastPaymentDate = new Date();
      await driver.save();
      await refreshDriverCommissionState(driver._id);
    }

    await _sendDriverNotification({
      driver,
      commissions,
      type: 'payment_success',
      subject: `✅ TookRide: KES ${paidAmount} commission payment received`,
      body: `Your M-Pesa payment of <strong>KES ${paidAmount}</strong> (receipt: ${transaction.mpesaReceipt}) was received. Your account status has been updated.`,
    });
  } else {
    // FAILURE
    transaction.status = 'failed';
    transaction.failureReason = callback.resultDesc;
    await transaction.save();

    await _sendDriverNotification({
      driver,
      commissions,
      type: 'payment_failure',
      subject: 'TookRide: M-Pesa payment was not completed',
      body: `Your M-Pesa commission payment failed. Reason: <em>${callback.resultDesc}</em>. Please try again from your dashboard.`,
    });
  }

  return { handled: true, transaction };
};

// ── Dashboard snapshot ────────────────────────────────────────────────────────
const getDriverCommissionSnapshot = async (driverId) => {
  const now = new Date();
  const refreshedState = await refreshDriverCommissionState(driverId, { now });
  const { weekStart, weekEnd } = getWeekWindow(now, DEFAULT_TIMEZONE);

  const [driver, currentWeekCommission, outstandingCommissions, payableCommissions, recentTransactions] =
    await Promise.all([
      Driver.findById(driverId).lean(),
      Commission.findOne({ driverId, weekStart, status: 'accruing' }).lean(),
      Commission.find({
        driverId,
        status: { $in: ['pending', 'overdue'] },
        outstandingAmount: { $gt: 0 },
      })
        .sort({ weekStart: 1 })
        .lean(),
      Commission.find({
        driverId,
        status: { $in: ['accruing', 'pending', 'overdue'] },
      })
        .sort({ weekStart: 1 })
        .lean(),
      PaymentTransaction.find({ driverId })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

  if (!driver) throw new Error('Driver not found');

  const totalDue = roundCurrency(
    outstandingCommissions.reduce((s, c) => s + Number(c.outstandingAmount || 0), 0)
  );
  const payableNow = roundCurrency(
    payableCommissions.reduce((s, c) => s + getCommissionPayableAmount(c), 0)
  );
  const nextDeadline = outstandingCommissions
    .map((c) => c.graceEndsAt)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0] || null;

  return {
    accountStatus: refreshedState?.commissionAccountStatus || driver.commissionAccountStatus || 'active',
    onboardingStatus: driver.status,
    canReceiveRideRequests: Boolean(
      driver.status === 'active' &&
        (refreshedState?.commissionAccountStatus || driver.commissionAccountStatus || 'active') === 'active' &&
        driver.online &&
        (typeof refreshedState?.available === 'boolean' ? refreshedState.available : driver.available)
    ),
    currentWeek: {
      weekStart,
      weekEnd,
      accruedAmount: roundCurrency(currentWeekCommission?.amount || 0),
      paidAmount: roundCurrency(currentWeekCommission?.paidAmount || 0),
      payableNow: roundCurrency(getCommissionPayableAmount(currentWeekCommission)),
      rideCount: currentWeekCommission?.rideCount || 0,
    },
    payableNow,
    outstanding: {
      totalDue,
      commissionCount: outstandingCommissions.length,
      graceEndsAt: nextDeadline,
      countdownMs: getCountdownMs(nextDeadline),
      commissions: outstandingCommissions.map((c) => ({
        id: c._id,
        amount: c.amount,
        dueAmount: c.dueAmount,
        outstandingAmount: c.outstandingAmount,
        weekStart: c.weekStart,
        weekEnd: c.weekEnd,
        status: c.status,
      })),
    },
    lastPaymentDate: driver.lastPaymentDate || null,
    latestTransaction: recentTransactions[0] || null,
    recentTransactions,
  };
};

module.exports = {
  calculateRideCommission,
  getDriverCommissionSnapshot,
  handleCommissionPaymentCallback,
  initiateCommissionPayment,
  recordRideCommission,
  refreshDriverCommissionState,
  restrictOverdueDrivers,
  runWeeklySettlement,
  sendGraceWarnings,
  sendPaymentReminders,
};
