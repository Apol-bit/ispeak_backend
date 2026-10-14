const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.JWT_SECRET = 'database-audit-test-only-secret-at-least-32-characters';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/not-used';
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { app, startServer, validateEnvironment } = require('../server');
const User = require('../models/User');
const SpeechSession = require('../models/SpeechSession');
const { authenticate } = require('../middleware/auth');
const { login } = require('../controllers/authController');
const { getUserHistory } = require('../controllers/sessionController');
const jwt = require('jsonwebtoken');

test('Atlas SRV parses with TLS and explicit database without contacting DNS', () => {
  const client = new MongoClient('mongodb+srv://example.invalid/ispeak?retryWrites=true&w=majority');
  assert.equal(client.options.tls, true);
  assert.equal(client.options.dbName, 'ispeak');
});

test('MONGO_URI is required; MONGODB_URI is not a fallback', () => {
  const uri = process.env.MONGO_URI;
  process.env.MONGO_URI = '';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/not-used';
  try { assert.throws(validateEnvironment, /Missing required environment variables: MONGO_URI/); }
  finally { process.env.MONGO_URI = uri; delete process.env.MONGODB_URI; }
});

for (const [name, uri] of [['invalid URI', 'not-a-mongo-uri'], ['unavailable Mongo', 'mongodb://127.0.0.1:1/not-used']]) {
  test(`${name} rejects startup before opening HTTP listener`, async () => {
    const savedUri = process.env.MONGO_URI;
    const connect = mongoose.connect;
    const listen = app.listen;
    let listened = false;
    process.env.MONGO_URI = uri;
    mongoose.connect = value => connect.call(mongoose, value, { serverSelectionTimeoutMS: 250 });
    app.listen = () => { listened = true; throw new Error('Unexpected HTTP listener'); };
    try { await assert.rejects(startServer()); assert.equal(listened, false); }
    finally { mongoose.connect = connect; app.listen = listen; process.env.MONGO_URI = savedUri; await mongoose.disconnect(); }
  });
}

test('health transitions not-ready -> ready -> not-ready -> ready (simulated DB states)', async () => {
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    for (const state of [0, 1, 0, 1]) {
      mongoose.connection._readyState = state;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.equal(response.status, state === 1 ? 200 : 503);
      assert.equal((await response.json()).database, state === 1 ? 'connected' : 'disconnected');
    }
  } finally { mongoose.connection._readyState = 0; await new Promise(resolve => server.close(resolve)); }
});

function response() { return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
test('DB outage produces controlled auth 503 and login 500 without raw error response', async () => {
  const findById = User.findById, findOne = User.findOne;
  const log = console.error;
  const failure = () => { throw new Error('PRIVATE_DATABASE_HOST_PASSWORD'); };
  User.findById = () => ({ select: failure }); User.findOne = failure; console.error = () => {};
  try {
    const token = jwt.sign({ userId: 'a'.repeat(24) }, process.env.JWT_SECRET, { issuer: 'ispeak-api', audience: 'ispeak-clients' });
    const authResponse = response();
    await authenticate({ get: () => `Bearer ${token}` }, authResponse, () => assert.fail('outage admitted'));
    assert.equal(authResponse.code, 503);
    const loginResponse = response(); await login({ body: { email: 'audit@example.test', password: 'test-only' } }, loginResponse);
    assert.equal(loginResponse.code, 500);
    assert.doesNotMatch(JSON.stringify([authResponse.body, loginResponse.body]), /PRIVATE_DATABASE/);
  } finally { User.findById = findById; User.findOne = findOne; console.error = log; }
});

test('DB outage produces controlled history error without raw error response', async () => {
  const find = SpeechSession.find, log = console.error;
  SpeechSession.find = () => { throw new Error('PRIVATE_DATABASE_HOST_PASSWORD'); }; console.error = () => {};
  try {
    const res = response(); await getUserHistory({ params: { userId: 'a'.repeat(24) }, query: {} }, res);
    assert.equal(res.code, 500); assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_DATABASE/);
  } finally { SpeechSession.find = find; console.error = log; }
});
