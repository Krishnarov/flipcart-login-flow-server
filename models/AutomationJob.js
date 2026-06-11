import mongoose from 'mongoose';

const automationJobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  uploadedFile: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'stopped'],
    default: 'pending'
  },
  reason: {
    type: String,
    default: ''
  },
  completedAt: {
    type: Date,
    default: null
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  }
}, {
  timestamps: true
});

const AutomationJob = mongoose.model('AutomationJob', automationJobSchema);
export default AutomationJob;
