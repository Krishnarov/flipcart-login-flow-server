import mongoose from 'mongoose';

const loginEmailSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationJob',
    required: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true
  },
  slot: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'inprogress', 'success', 'failed'],
    default: 'pending'
  },
  screenshot: {
    type: String,
    default: ''
  },
  reason: {
    type: String,
    default: ''
  },
  completedAt: {
    type: Date,
    default: null
  },
  cookies: {
    type: Array,
    default: []
  },
  localStorage: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  sessionStorage: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

const LoginEmail = mongoose.model('LoginEmail', loginEmailSchema);
export default LoginEmail;
