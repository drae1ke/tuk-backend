const SchedulerRun = require('../models/SchedulerRun');
const logger = require('../utils/logger');
const { DEFAULT_TIMEZONE, getPreviousWeekWindow, getWeekRelativeDate } = require('../utils/businessTime');
const {
  restrictOverdueDrivers,
  runWeeklySettlement,
  sendGraceWarnings,
  sendPaymentReminders
} = require('./commissionService');

let schedulerHandle = null;
let schedulerTickInProgress = false;

const STALE_JOB_WINDOW_MS = Number(process.env.SCHEDULER_STALE_JOB_WINDOW_MS || 30 * 60 * 1000);

const acquireJob = async ({ jobName, jobKey, scheduledFor }) => {
  try {
    return await SchedulerRun.create({
      jobName,
      jobKey,
      scheduledFor,
      status: 'running',
      startedAt: new Date()
    });
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }

    const staleCutoff = new Date(Date.now() - STALE_JOB_WINDOW_MS);
    return SchedulerRun.findOneAndUpdate(
      {
        jobKey,
        $or: [
          { status: 'failed' },
          { status: 'running', startedAt: { $lt: staleCutoff } }
        ]
      },
      {
        $set: {
          status: 'running',
          startedAt: new Date(),
          completedAt: null,
          error: null,
          result: null
        }
      },
      { new: true }
    );
  }
};

const markJobCompleted = async (job, result) => {
  if (!job) {
    return;
  }

  job.status = 'completed';
  job.completedAt = new Date();
  job.result = result;
  await job.save();
};

const markJobFailed = async (job, error) => {
  if (!job) {
    return;
  }

  job.status = 'failed';
  job.completedAt = new Date();
  job.error = error.message;
  await job.save();
};

const runScheduledJob = async ({ jobName, jobKey, scheduledFor, task }) => {
  if (Date.now() < scheduledFor.getTime()) {
    return null;
  }

  const job = await acquireJob({ jobName, jobKey, scheduledFor });
  if (!job) {
    return null;
  }

  try {
    const result = await task();
    await markJobCompleted(job, result);
    return result;
  } catch (error) {
    await markJobFailed(job, error);
    throw error;
  }
};

const runDueCommissionJobs = async () => {
  const now = new Date();
  const previousWeek = getPreviousWeekWindow(now, DEFAULT_TIMEZONE);
  const schedule = [
    {
      jobName: 'weekly-settlement',
      jobKey: `weekly-settlement:${previousWeek.weekKey}`,
      scheduledFor: getWeekRelativeDate(previousWeek.weekStart, 6, 23, 59, 0, 0, DEFAULT_TIMEZONE),
      task: () => runWeeklySettlement({
        referenceDate: now,
        targetWeekStart: previousWeek.weekStart,
        triggeredBy: 'scheduler'
      })
    },
    {
      jobName: 'payment-reminder',
      jobKey: `payment-reminder:${previousWeek.weekKey}`,
      scheduledFor: getWeekRelativeDate(previousWeek.weekStart, 7, 8, 0, 0, 0, DEFAULT_TIMEZONE),
      task: () => sendPaymentReminders({ targetWeekStart: previousWeek.weekStart })
    },
    {
      jobName: 'grace-warning',
      jobKey: `grace-warning:${previousWeek.weekKey}`,
      scheduledFor: getWeekRelativeDate(previousWeek.weekStart, 8, 8, 0, 0, 0, DEFAULT_TIMEZONE),
      task: () => sendGraceWarnings({ targetWeekStart: previousWeek.weekStart })
    },
    {
      jobName: 'restrict-overdue',
      jobKey: `restrict-overdue:${previousWeek.weekKey}`,
      scheduledFor: getWeekRelativeDate(previousWeek.weekStart, 9, 0, 0, 0, 0, DEFAULT_TIMEZONE),
      task: () => restrictOverdueDrivers({
        referenceDate: now,
        targetWeekStart: previousWeek.weekStart
      })
    }
  ];

  for (const job of schedule) {
    try {
      await runScheduledJob(job);
    } catch (error) {
      logger.error(`Scheduler job ${job.jobName} failed: ${error.message}`);
    }
  }
};

const startScheduler = () => {
  if (process.env.ENABLE_COMMISSION_SCHEDULER === 'false' || schedulerHandle) {
    return;
  }

  const tick = async () => {
    if (schedulerTickInProgress) {
      return;
    }

    schedulerTickInProgress = true;
    try {
      await runDueCommissionJobs();
    } finally {
      schedulerTickInProgress = false;
    }
  };

  setTimeout(tick, 5000);
  schedulerHandle = setInterval(tick, 60 * 1000);
  logger.info('Commission scheduler started');
};

const stopScheduler = () => {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
};

module.exports = {
  startScheduler,
  stopScheduler
};
