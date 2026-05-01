const mongoose = require('mongoose');

const schedulerRunSchema = new mongoose.Schema({
  jobName: {
    type: String,
    required: true
  },
  jobKey: {
    type: String,
    required: true,
    unique: true
  },
  scheduledFor: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running'
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  error: String,
  result: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

module.exports = mongoose.model('SchedulerRun', schedulerRunSchema);
