const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const { readOnlyStartup } = require('./services/readOnlyStartup');
const readOnly = readOnlyStartup();
// Set before importing any model: model compilation can schedule initialization.
if (readOnly) {
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
}
const { authenticate, authorizeRoles } = require('./middleware/auth');
const { storage } = require('./services/storageService');
const { startRetentionSchedule } = require('./services/retentionService');
const { audioStorage } = require('./services/audioStorageService');
const StorageCleanup = require('./models/StorageCleanup');
const { logError } = require('./services/safeLogger');
const { proxyTrust, validateProductionOrigins, validateDatabaseTls } = require('./services/securityConfiguration');
const { readRegistrationPolicy } = require('./services/registrationPolicy');

const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) validateProductionOrigins(configuredOrigins);
app.set('trust proxy', proxyTrust(process.env.TRUST_PROXY_CIDRS));
app.disable('x-powered-by');

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

// Preserve legacy authenticated local URLs. Cloud scratch files are NEVER served.
if (storage.driver === 'local') app.use(
  '/uploads/reference_audio',
  authenticate,
  authorizeRoles('admin', 'validator'),
  express.static(storage.getUploadDirectory('reference_audio'))
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
// This mode is exclusively for health/networking checks, never API workflows.
if (readOnly) app.use('/api', (req, res) => res.status(503).json({
  message: 'Application workflows are unavailable during read-only startup verification',
}));
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
  logError('unhandled_request_failed', error);
  return res.status(500).json({ message: 'Internal server error' });
});

// MONGODB CONNECTION & SERVER INIT
let httpServer;
let retentionTimer;
let cleanupTimer;

function validateEnvironment() {
  readRegistrationPolicy();
  if (readOnlyStartup() !== readOnly) throw new Error('Startup mode cannot change after initialization');
  const required = ['MONGO_URI', 'JWT_SECRET'];
  if (isProduction) required.push('CORS_ORIGINS', 'PYTHON_BACKEND_URL');
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  if (isProduction) validateDatabaseTls(process.env.MONGO_URI);
  if (isProduction && (!process.env.PYTHON_SERVICE_TOKEN || process.env.PYTHON_SERVICE_TOKEN.length < 32)) {
    throw new Error('PYTHON_SERVICE_TOKEN must contain at least 32 characters in production');
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
  try {
    validateEnvironment();
    await mongoose.connect(process.env.MONGO_URI, readOnly ? { autoCreate: false, autoIndex: false } : undefined);
    console.log('Successfully connected to MongoDB!');
    if (!readOnly) {
      if (storage.driver === 'r2') await StorageCleanup.init();
      retentionTimer = startRetentionSchedule();
      cleanupTimer = audioStorage.startCleanupSchedule();
    }
    const PORT = Number(process.env.PORT || 5000);
    await new Promise((resolve, reject) => {
      httpServer = app.listen(PORT, '0.0.0.0', resolve);
      httpServer.once('error', reject);
    });
    console.log(`Server is listening on port ${PORT}`);
    return httpServer;
  } catch (error) {
    try { await shutdown('Startup failure'); }
    catch (cleanupError) { logError('startup_cleanup_failed', cleanupError); }
    throw error;
  }
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  clearInterval(retentionTimer);
  clearInterval(cleanupTimer);
  try {
    if (httpServer) {
      const server = httpServer;
      httpServer = undefined;
      await new Promise((resolve, reject) => server.close(error =>
        error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    }
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) {
  startServer().catch((error) => {
    logError('server_startup_failed', error);
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
          logError('server_shutdown_failed', error);
          process.exit(1);
        });
    });
  }
}

module.exports = { app, shutdown, startServer, validateEnvironment };
