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
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
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
