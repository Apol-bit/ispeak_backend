const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-32-characters';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27099/not-used';

const User = require('../models/User');
const { app } = require('../server');

const users = {
  user1: {
    _id: { toString: () => 'user1' }, firstName: 'Test', lastName: 'User',
    username: 'testuser', email: 'user@example.test', role: 'user',
    status: 'Active', isArchived: false,
  },
  user2: {
    _id: { toString: () => 'user2' }, firstName: 'Other', lastName: 'User',
    username: 'otheruser', email: 'other@example.test', role: 'user',
    status: 'Active', isArchived: false,
  },
  admin1: {
    _id: { toString: () => 'admin1' }, firstName: 'Admin', lastName: 'User',
    username: 'admin', email: 'admin@example.test', role: 'admin',
    status: 'Active', isArchived: false,
  },
  validator1: {
    _id: { toString: () => 'validator1' }, firstName: 'Validator', lastName: 'User',
    username: 'validator', email: 'validator@example.test', role: 'validator',
    status: 'Active', isArchived: false,
  },
  banned1: {
    _id: { toString: () => 'banned1' }, firstName: 'Banned', lastName: 'User',
    username: 'banned', email: 'banned@example.test', role: 'user',
    status: 'Banned', isArchived: false,
  },
};

const originalFindById = User.findById;
const originalFind = User.find;
User.findById = (id) => ({ select: async () => users[id] || null });
User.find = () => ({ select: async () => [] });

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

function tokenFor(id) {
  return jwt.sign(
    { userId: id, role: users[id]?.role || 'user' },
    process.env.JWT_SECRET,
    {
      algorithm: 'HS256', expiresIn: '1h',
      issuer: 'ispeak-api', audience: 'ispeak-clients',
    }
  );
}

async function api(path, token) {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test.after(async () => {
  User.findById = originalFindById;
  User.find = originalFind;
  await new Promise((resolve) => server.close(resolve));
});

test('protected endpoint rejects a missing token', async () => {
  const response = await api('/api/user/user1');
  assert.equal(response.status, 401);
});

test('user can read their own profile without a password hash', async () => {
  const response = await api('/api/user/user1', tokenFor('user1'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.email, users.user1.email);
  assert.equal(body.password, undefined);
});

test('IDOR attempt against another profile is forbidden', async () => {
  const response = await api('/api/user/user2', tokenFor('user1'));
  assert.equal(response.status, 403);
});

test('regular users cannot list users', async () => {
  const response = await api('/api/users', tokenFor('user1'));
  assert.equal(response.status, 403);
});

test('admin can access the protected user list', async () => {
  const response = await api('/api/users', tokenFor('admin1'));
  assert.equal(response.status, 200);
});

test('validator cannot access admin-only global statistics', async () => {
  const response = await api('/api/admin/stats', tokenFor('validator1'));
  assert.equal(response.status, 403);
});

test('expired token is rejected', async () => {
  const expired = jwt.sign(
    { userId: 'user1', role: 'user', exp: Math.floor(Date.now() / 1000) - 1 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'ispeak-api', audience: 'ispeak-clients' }
  );
  const response = await api('/api/user/user1', expired);
  assert.equal(response.status, 401);
});

test('banned user is rejected even with a valid token', async () => {
  const response = await api('/api/user/banned1', tokenFor('banned1'));
  assert.equal(response.status, 403);
});
