import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import authRoutes from './routes/auth.js';
import emailRoutes from './routes/emails.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
  }
});

// Attach io to app so routes/controllers can emit events
app.locals.io = io;

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/excel_login_db';

// Middleware
app.use(cors());
app.use(express.json());
app.use('/screenshots', express.static('screenshots'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/emails', emailRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running smoothly' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ success: false, message: err.message || 'Internal Server Error' });
});

import AutomationJob from './models/AutomationJob.js';
import LoginEmail from './models/LoginEmail.js';

// Database Connection and Server Start
mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Successfully connected to MongoDB Database');
    // Reset stuck 'running' jobs on server start
    const fixedJobs = await AutomationJob.updateMany(
      { status: 'running' },
      { status: 'stopped', reason: 'Server restarted - automation was interrupted.' }
    );
    if (fixedJobs.modifiedCount > 0) console.log(`Reset ${fixedJobs.modifiedCount} stuck running job(s) to stopped.`);
    // Reset stuck 'inprogress' emails back to 'pending'
    const fixedEmails = await LoginEmail.updateMany(
      { status: 'inprogress' },
      { status: 'pending', reason: 'Server restarted - queued again.' }
    );
    if (fixedEmails.modifiedCount > 0) console.log(`Reset ${fixedEmails.modifiedCount} stuck inprogress email(s) to pending.`);
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database Connection Error:', err);
    process.exit(1);
  });
