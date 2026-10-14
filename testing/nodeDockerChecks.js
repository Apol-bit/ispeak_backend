// Mounted read-only by scripts/verifyNodeDocker.py; never bundled in the image.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('/app/node_modules/axios');
const FormData = require('/app/node_modules/form-data');
const fs = require('node:fs');
const { usableAnalysis } = require('/app/services/analysisResponse');

async function main() {
  const api = 'http://127.0.0.1:' + process.env.PORT;
  const request = (url, options = {}) => axios({ url, validateStatus: () => true, timeout: 300000, maxRedirects: 0, ...options });
  if (process.argv[2] === 'health-down') {
    const response = await request(api + '/health');
    assert.equal(response.status, 503);
    assert.equal(response.data.database, 'disconnected');
    return { databaseOutageHealth: 'PASS' };
  }
  const health = await request(api + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.database, 'connected');
  if (process.argv[2] === 'health-up') return { databaseRecoveryHealth: 'PASS' };
  const invalid = await request(api + '/api/auth/me', { headers: { Authorization: 'Bearer invalid-test-token' } });
  assert.equal(invalid.status, 401);
  assert.equal((await request(api + '/health', { headers: { Origin: 'https://unapproved.example.invalid' } })).status, 403);
  assert.equal((await request(api + '/health', { headers: { Origin: process.env.CORS_ORIGINS } })).headers['access-control-allow-origin'], process.env.CORS_ORIGINS);
  const python = process.env.PYTHON_BACKEND_URL;
  assert.equal((await request(python + '/metrics')).status, 401);
  assert.equal((await request(python + '/metrics', { headers: { 'X-iSpeak-Service-Token': process.env.PYTHON_SERVICE_TOKEN } })).status, 200);
  const data = new FormData();
  data.append('file', fs.createReadStream('/verification/generated-speech.wav'));
  data.append('language', 'English');
  const analysis = await request(python + '/transcribe', { method: 'POST', data, headers: { ...data.getHeaders(), 'X-iSpeak-Service-Token': process.env.PYTHON_SERVICE_TOKEN } });
  assert.equal(analysis.status, 200);
  assert.ok(usableAnalysis(analysis.data));
  // Exercise actual Node authentication and failed-analysis response handling
  // against ONLY the disposable database; no valid audio is persisted to R2.
  const id = crypto.randomUUID().replaceAll('-', '');
  const password = crypto.randomBytes(24).toString('hex');
  const email = id + '@example.invalid';
  const signup = await request(api + '/api/signup', { method: 'POST', data: { firstName: 'Disposable', lastName: 'Test', username: id, email, password, acceptTerms: true, termsVersion: process.env.TERMS_VERSION || '1.0' } });
  assert.equal(signup.status, 201);
  const login = await request(api + '/api/login', { method: 'POST', data: { email, password } });
  assert.equal(login.status, 200);
  const invalidAudio = new FormData();
  const bytes = Buffer.alloc(44 + 8000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(8000, 40);
  invalidAudio.append('audio', bytes, { filename: 'generated-short.wav', contentType: 'audio/wav' });
  invalidAudio.append('language', 'English');
  const rejected = await request(api + '/api/upload-audio', { method: 'POST', data: invalidAudio, headers: { ...invalidAudio.getHeaders(), Authorization: 'Bearer ' + login.data.token } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.message, /recording is too short/);
  const mongoose = require('/app/node_modules/mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    assert.equal(await mongoose.connection.db.collection('speechsessions').countDocuments(), 0);
    const indexes = await mongoose.connection.db.collection('storagecleanups').indexes();
    assert.ok(indexes.some(index => index.unique && index.key.namespace === 1 && index.key.key === 1));
  } finally { await mongoose.disconnect(); }
  return { health: 'PASS', invalidAuthentication: 'PASS', cors: 'PASS', pythonPrivateAuthentication: 'PASS', realSyntheticSpeechAnalysis: 'PASS', usableAnalysis: 'PASS', nodeInvalidAudioHandling: 'PASS', noSessionOnFailure: 'PASS', cleanupJournalIndex: 'PASS' };
}
main().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Container verification failed; raw errors suppressed.'); process.exitCode = 1; });
