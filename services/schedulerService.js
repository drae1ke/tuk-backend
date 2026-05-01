/**
 * services/schedulerService.js
 *
 * Lightweight cron-like scheduler for commission lifecycle jobs.
 *
 * Every 60 s the tick function fires and checks whether any scheduled
 * job is due for the PREVIOUS week.  Jobs are recorded in MongoDB via
 * SchedulerRun so they are idempotent across restarts and multiple instances.
 *
 * Job schedule (all times in Africa/Nairobi):
 *   Sunday  23:59  → weekly-settlement
 *   Monday  08:00  → payment-reminder
 *   Sunday  08:00  → grace-warning
 *   Monday  00:00  → restrict-overdue
 */

'use strict';

const SchedulerRun = require('../models/SchedulerRun');
const logger = require('../utils/logger');
const {
  DEFAULT_TIMEZONE,
  getPreviousWeekWindow,
  getWeekRelativeDate,
} = require('../utils/businessTime');
const {
  restrictOverdueDrivers,
  runWeeklySettlement,
  sendGraceWarnings,
  sendPaymentReminders,
} = require('./commissionService');

// ── Config ────────────────────────────────────────────────────────────────────
const TICK_INTERVAL_MS = 60_000;          // check every 60 seconds
const STALE_JOB_WINDOW_MS = 30 * 60_000; // treat running jobs stale after 30 min

let _schedulerHandle = null;
let _tickInProgress = false;

// ── Job locking (distributed-safe via MongoDB unique index) ───────────────────
/**
 * Try to acquire a job slot.  Returns the SchedulerRun document on success,
 * or null if another instance already holds the lock.
 */
const _acquireJob = async ({ jobName, jobKey, scheduledFor }) => {
  try {
    return await SchedulerRun.create({
      jobName,
      jobKey,
      scheduledFor,
      status: 'running',
      startedAt: new Date(),
    });
  } catch (err) {
    if (err.code !== 11000) throw err; // unexpected error

    // Duplicate key — check for a stale/failed run we can reclaim
    const staleCutoff = new Date(Date.now() - STALE_JOB_WINDOW_MS);
    return SchedulerRun.findOneAndUpdate(
      {
        jobKey,
        $or: [
          { status: 'failed' },
          { status: 'running', startedAt: { $lt: staleCutoff } },
        ],
      },
      { $set: { status: 'running', startedAt: new Date(), error: null, result: null } },
      { new: true }
    );
  }
};

const _completeJob = (job, result) => {
  if (!job) return Promise.resolve();
  return SchedulerRun.findByIdAndUpdate(job._id, {
    status: 'completed',
    completedAt: new Date(),
    result,
  });
};

const _failJob = (job, error) => {
  if (!job) return Promise.resolve();
  return SchedulerRun.findByIdAndUpdate(job._id, {
    status: 'failed',
    completedAt: new Date(),
    error: error.message,
  });
};

/**
 * Run a named job if its scheduledFor time has passed and we can acquire the lock.
 */
const _runJob = async ({ jobName, jobKey, scheduledFor, task }) => {
  if (Date.now() < scheduledFor.getTime()) return null; // not yet due

  const job = await _acquireJob({ jobName, jobKey, scheduledFor });
  if (!job) return null; // another instance holds it

  try {
    const result = await task();
    await _completeJob(job, result);
    logger.info({ event: 'scheduler.job.completed', jobName, jobKey });
    return result;
  } catch (err) {
    await _failJob(job, err);
    logger.error({ event: 'scheduler.job.failed', jobName, jobKey, error: err.message });
    throw err;
  }
};

// ── Tick ──────────────────────────────────────────────────────────────────────
const _tick = async () => {
  if (_tickInProgress) return;
  _tickInProgress = true;

  try {
    const now = new Date();
    const prevWeek = getPreviousWeekWindow(now, DEFAULT_TIMEZONE);

    const schedule = [
      // Sunday 23:59 — settlement
      {
        jobName: 'weekly-settlement',
        jobKey: `weekly-settlement:${prevWeek.weekKey}`,
        scheduledFor: getWeekRelativeDate(prevWeek.weekStart, 6, 23, 59, 0, 0, DEFAULT_TIMEZONE),
        task: () =>
          runWeeklySettlement({
            referenceDate: now,
            targetWeekStart: prevWeek.weekStart,
            triggeredBy: 'scheduler',
          }),
      },
      // Monday 08:00 — reminder
      {
        jobName: 'payment-reminder',
        jobKey: `payment-reminder:${prevWeek.weekKey}`,
        scheduledFor: getWeekRelativeDate(prevWeek.weekStart, 7, 8, 0, 0, 0, DEFAULT_TIMEZONE),
        task: () => sendPaymentReminders({ targetWeekStart: prevWeek.weekStart }),
      },
      // Following Sunday 08:00 — grace warning
      {
        jobName: 'grace-warning',
        jobKey: `grace-warning:${prevWeek.weekKey}`,
        scheduledFor: getWeekRelativeDate(prevWeek.weekStart, 13, 8, 0, 0, 0, DEFAULT_TIMEZONE),
        task: () => sendGraceWarnings({ targetWeekStart: prevWeek.weekStart }),
      },
      // Following Monday 00:00 — restrict
      {
        jobName: 'restrict-overdue',
        jobKey: `restrict-overdue:${prevWeek.weekKey}`,
        scheduledFor: getWeekRelativeDate(prevWeek.weekStart, 14, 0, 0, 0, 0, DEFAULT_TIMEZONE),
        task: () =>
          restrictOverdueDrivers({
            referenceDate: now,
            targetWeekStart: prevWeek.weekStart,
          }),
      },
    ];

    for (const job of schedule) {
      await _runJob(job).catch((err) =>
        logger.error(`Scheduler tick error [${job.jobName}]: ${err.message}`)
      );
    }
  } finally {
    _tickInProgress = false;
  }
};

// ── Public API ────────────────────────────────────────────────────────────────
const startScheduler = () => {
  if (process.env.ENABLE_COMMISSION_SCHEDULER === 'false') {
    logger.info('Commission scheduler disabled via ENABLE_COMMISSION_SCHEDULER=false');
    return;
  }
  if (_schedulerHandle) return; // already running

  // First tick after 5 s (give the DB time to connect)
  setTimeout(_tick, 5_000);
  _schedulerHandle = setInterval(_tick, TICK_INTERVAL_MS);
  logger.info('Commission scheduler started');
};

const stopScheduler = () => {
  if (_schedulerHandle) {
    clearInterval(_schedulerHandle);
    _schedulerHandle = null;
    logger.info('Commission scheduler stopped');
  }
};

module.exports = { startScheduler, stopScheduler };
