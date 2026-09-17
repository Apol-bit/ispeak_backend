const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const { authenticate, authorizeRoles } = require('./middleware/auth');
const { storage } = require('./services/storageService');
const { startRetentionSchedule } = require('./services/retentionService');

const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && configuredOrigins.length === 0) {
  throw new Error('CORS_ORIGINS is required when NODE_ENV=production');
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || (!isProduction && configuredOrigins.length === 0)) {
      return callback(null, true);
    }
    if (configuredOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json());

const referenceAudioRoot = storage.getUploadDirectory('reference_audio');

// User recordings stay private. Only validator reference audio is public until
// production storage is moved behind an authenticated object-storage service.
app.use(
  '/uploads/reference_audio',
  authenticate,
  authorizeRoles('admin', 'validator'),
  express.static(referenceAudioRoot)
);

// Log incoming requests for debugging
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

// ROUTE IMPORTS
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const sessionRoutes = require('./routes/sessionRoutes');
const resourceRoutes = require('./routes/resourceRoutes');

// MOUNT ROUTES
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', sessionRoutes);
app.use('/api', resourceRoutes);

app.get('/health', (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? 'ready' : 'not-ready',
    database: databaseReady ? 'connected' : 'disconnected',
  });
});

app.get('/', (req, res) => res.send('iSpeak API is running!'));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed' });
  }
  console.error('Unhandled request error:', error);
  return res.status(500).json({ message: 'Internal server error' });
});

// MONGODB CONNECTION & SERVER INIT
let httpServer;

function validateEnvironment() {
  const required = ['MONGO_URI', 'JWT_SECRET'];
  if (isProduction) required.push('CORS_ORIGINS', 'PYTHON_BACKEND_URL');
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  const storageDriver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (
    isProduction &&
    storageDriver === 'local' &&
    process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'Local recording storage is disabled in production. Configure an object-storage adapter or explicitly acknowledge persistent local storage.'
    );
  }
}

async function startServer() {
  validateEnvironment();
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Successfully connected to MongoDB!');
  startRetentionSchedule();
  const PORT = Number(process.env.PORT || 5000);
  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
  });
  return httpServer;
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
          console.error('Shutdown failed:', error.message);
          process.exit(1);
        });
    });
  }
}

module.exports = { app, shutdown, startServer, validateEnvironment };
