const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { logError } = require('../services/safeLogger');
const { proxyTrust, validateProductionOrigins, validateDatabaseTls } = require('../services/securityConfiguration');

test('safe logging excludes messages, stack, URI, headers, unknown names/codes and nested errors', () => {
  const logs = [], original = console.error;
  console.error = value => logs.push(value);
  try {
    logError('database_failed', Object.assign(new Error('PRIVATE_SECRET_URI'), {
      name: 'MongoServerError', code: 11000, keyValue: { email: 'PRIVATE_EMAIL' }, cause: 'PRIVATE_CAUSE',
    }));
    logError('upstream_failed', { name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', headers: { Authorization: 'PRIVATE_TOKEN' } });
  } finally { console.error = original; }
  assert.doesNotMatch(logs.join(''), /PRIVATE/);
  assert.deepEqual(JSON.parse(logs[0]), { event: 'database_failed', category: 'MongoServerError', code: 11000 });
});

test('production CORS permits only exact HTTPS origins', () => {
  validateProductionOrigins(['https://admin.example.invalid']);
  for (const origin of ['*', 'https://*.example.invalid', 'http://example.invalid',
    'https://user:PRIVATE@example.invalid', 'https://example.invalid/path', 'https://example.invalid?PRIVATE']) {
    assert.throws(() => validateProductionOrigins([origin]));
  }
  assert.throws(() => validateProductionOrigins([]));
});

test('trust proxy rejects blanket trust, hop counts and zero-prefix networks', () => {
  assert.equal(proxyTrust(''), false);
  for (const input of ['true', '1', '0.0.0.0/0', '::/0', 'loopback', '10.0.0.1/33', '10.0.0.1,']) {
    assert.throws(() => proxyTrust(input));
  }
});

test('production rejects explicit Mongo TLS and certificate-validation bypasses', () => {
  validateDatabaseTls('mongodb+srv://example.invalid/ispeak');
  validateDatabaseTls('mongodb://example.invalid/ispeak?tls=true');
  validateDatabaseTls('mongodb://first.example.invalid:27017,second.example.invalid:27017/ispeak?tls=true&replicaSet=test');
  assert.throws(() => validateDatabaseTls('mongodb://example.invalid/ispeak'));
  for (const option of ['tls=false', 'ssl=false', 'tlsInsecure=true', 'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true']) {
    assert.throws(() => validateDatabaseTls(`mongodb+srv://example.invalid/ispeak?${option}`));
  }
});

test('untrusted forwarding headers do not bypass limiter; explicit trusted chain ignores spoofed leftmost IP', async () => {
  const { createRateLimiter } = require('../middleware/rateLimit');
  const app = express();
  app.set('trust proxy', false);
  app.get('/limited', createRateLimiter({ windowMs: 60000, max: 1, message: 'limited' }), (req, res) => res.json({ ip: req.ip }));
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/limited', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 200);
    assert.equal((await fetch(url + '/limited', { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 429);
    app.set('trust proxy', proxyTrust('127.0.0.1/32'));
    const response = await fetch(url + '/ip', { headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.2' } });
    assert.equal((await response.json()).ip, '198.51.100.2');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('proxy-addr patched IPv6 subnets cannot inadvertently trust all IPv4 clients', () => {
  const proxy = require('proxy-addr');
  assert.equal(require('proxy-addr/package.json').version, '2.0.8');
  assert.equal(proxy.compile(['::ffff:10.0.0.0/8'])('203.0.113.1'), false);
  assert.equal(proxy.compile(['::/1'])('203.0.113.1'), false);
});

test('post-connect cleanup-model failure disconnects Mongo and never opens HTTP', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    process.env.NODE_ENV='test'; process.env.STORAGE_DRIVER='local';
    process.env.JWT_SECRET='startup-test-only-secret-at-least-32-characters';
    process.env.MONGO_URI='mongodb://127.0.0.1:1/not-contacted';
    const mongoose=require('mongoose');
    let disconnects=0, listened=false;
    mongoose.connect=async()=>{}; mongoose.disconnect=async()=>{disconnects++;};
    const provider=require('./services/storageService').storage; provider.driver='r2';
    require('./models/StorageCleanup').init=async()=>{throw new Error('PRIVATE_URI');};
    const {app,startServer}=require('./server');
    app.listen=()=>{listened=true;throw new Error('unexpected listener');};
    (async()=>{await assert.rejects(startServer());assert.equal(disconnects,1);assert.equal(listened,false);console.log('STARTUP_CLEANUP_PASS');})().catch(()=>{process.exitCode=1;});
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STARTUP_CLEANUP_PASS/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_URI/);
});
