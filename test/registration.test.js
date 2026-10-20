const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.AUTH_RATE_LIMIT_MAX = '100';
const User = require('../models/User');
const app = express();
app.use(express.json());
app.use('/api', require('../routes/authRoutes'));
let server, url, saved, lookups;
const originalFind = User.findOne;
const originalSave = User.prototype.save;
const payload = { firstName: 'Approved', lastName: 'Tester', username: 'tester',
  email: ' Tester@Example.test ', password: randomBytes(16).toString('hex'),
  acceptTerms: true, termsVersion: process.env.TERMS_VERSION || '1.0' };

test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  url = `http://127.0.0.1:${server.address().port}/api/signup`;
});
test.beforeEach(() => {
  saved = []; lookups = 0;
  process.env.REGISTRATION_MODE = 'open';
  delete process.env.REGISTRATION_INVITES_JSON;
  User.findOne = async () => { lookups++; return null; };
  User.prototype.save = async function () { saved.push(this); return this; };
});
test.after(async () => {
  User.findOne = originalFind; User.prototype.save = originalSave;
  await new Promise(resolve => server.close(resolve));
});
function signup(body = payload) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('approved signup preserves JWT, hashed password, terms and default role', async () => {
  const response = await signup({ ...payload, role: 'admin', status: 'Banned' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].email, 'tester@example.test');
  assert.equal(saved[0].role, 'user');
  assert.equal(saved[0].status, 'Active');
  assert.ok(saved[0].termsAcceptedAt instanceof Date);
  assert.equal(await bcrypt.compare(payload.password, saved[0].password), true);
  assert.equal(saved[0].toObject().invitationCode, undefined);
  assert.equal(body.user.password, undefined);
  const claims = jwt.verify(body.token, process.env.JWT_SECRET, {
    algorithms: ['HS256'], issuer: 'ispeak-api', audience: 'ispeak-clients',
  });
  assert.equal(claims.userId, saved[0]._id.toString());
  assert.equal(claims.role, 'user');
});

test('public signup accepts missing and obsolete codes without email invitations', async () => {
  for (const body of [{ ...payload, invitationCode: undefined },
    { ...payload, invitationCode: randomBytes(32).toString('base64url') },
    { ...payload, email: 'stranger@example.test' }, { ...payload, invitationCode: {} }]) {
    const response = await signup(body);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(typeof result.token, 'string');
    assert.equal(result.user.role, 'user');
  }
  assert.equal(saved.length, 4);
});

test('closed and broken settings cannot create accounts', async () => {
  process.env.REGISTRATION_MODE = 'closed';
  assert.equal((await signup()).status, 403);
  process.env.REGISTRATION_MODE = 'invalid';
  assert.equal((await signup()).status, 503);
  process.env.REGISTRATION_MODE = 'invite';
  assert.equal((await signup()).status, 503);
  assert.equal(lookups, 0); assert.equal(saved.length, 0);
});

test('public signup preserves terms, password and duplicate checks', async () => {
  assert.equal((await signup({ ...payload, password: 'short' })).status, 400);
  assert.equal((await signup({ ...payload, acceptTerms: false })).status, 400);
  assert.equal((await signup({ ...payload, termsVersion: 'outdated' })).status, 400);
  User.findOne = async () => ({ email: 'tester@example.test' });
  assert.equal((await signup()).status, 400);
  User.findOne = async () => null;
  User.prototype.save = async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); };
  assert.equal((await signup()).status, 409);
  assert.equal(saved.length, 0);
});

test('authentication rate limiter rejects excess attempts', () => {
  const limiter = require('../middleware/rateLimit').createRateLimiter({ windowMs: 60000, max: 2, message: 'Limited' });
  let passed = 0, status;
  const response = { set() {}, status(value) { status = value; return this; }, json() {} };
  for (let i = 0; i < 3; i++) limiter({ ip: '127.0.0.1' }, response, () => passed++);
  assert.equal(passed, 2); assert.equal(status, 429);
});

test('unset local mode preserves signup without invitation', async () => {
  delete process.env.REGISTRATION_MODE;
  delete process.env.REGISTRATION_INVITES_JSON;
  assert.equal((await signup({ ...payload, invitationCode: undefined })).status, 201);
});

test('the actual signup route rejects excess requests with retry guidance', async () => {
  let response;
  for (let attempts = 0; attempts <= 100; attempts++) {
    response = await signup({});
    if (response.status === 429) break;
  }
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.equal(response.headers.get('ratelimit-remaining'), '0');
  assert.equal(lookups, 0);
  assert.equal(saved.length, 0);
});
