const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { readRegistrationPolicy, registrationAllowed } = require('../services/registrationPolicy');

test('production startup rejects registration misconfiguration before database connection or listening', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const mongoose = require('mongoose');
    let connects = 0, listens = 0;
    mongoose.connect = async () => { connects++; throw Error('unexpected connection'); };
    mongoose.disconnect = async () => {};
    const { app, startServer } = require('./server');
    app.listen = () => { listens++; throw Error('unexpected listener'); };
    (async () => {
      for (const mode of [undefined, '', 'wrong', 'invite']) {
        if (mode === undefined) delete process.env.REGISTRATION_MODE;
        else process.env.REGISTRATION_MODE = mode;
        delete process.env.REGISTRATION_INVITES_JSON;
        await assert.rejects(startServer(), /REGISTRATION_MODE|invitation/);
      }
      assert.equal(connects, 0); assert.equal(listens, 0);
    })().catch(() => { process.exitCode = 1; });
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_ENV: 'production', CORS_ORIGINS: 'https://admin.example.test',
      STORAGE_DRIVER: 'local', ISPEAK_READ_ONLY_STARTUP: 'false' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('local defaults to open; production requires an explicit valid mode', () => {
  assert.equal(readRegistrationPolicy({}).mode, 'open');
  for (const mode of [undefined, '', 'INVITE', 'invalid']) {
    assert.throws(() => readRegistrationPolicy({ NODE_ENV: 'production', REGISTRATION_MODE: mode }));
  }
  for (const mode of ['open', 'closed']) {
    const policy = readRegistrationPolicy({ NODE_ENV: 'production', REGISTRATION_MODE: mode });
    assert.equal(registrationAllowed(policy, 'any@example.test'), mode === 'open');
  }
});

test('invitations are email-bound and reject missing, malformed or wrong codes', () => {
  const code = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(code).digest('hex');
  const policy = readRegistrationPolicy({ REGISTRATION_MODE: 'invite',
    REGISTRATION_INVITES_JSON: JSON.stringify({ 'Tester@Example.test': hash }) });
  assert.equal(registrationAllowed(policy, ' TESTER@example.test ', code), true);
  assert.equal(registrationAllowed(policy, 'other@example.test', code), false);
  for (const invalid of [undefined, null, {}, [], '', 'a'.repeat(5000), randomBytes(32).toString('base64url')]) {
    assert.equal(registrationAllowed(policy, 'tester@example.test', invalid), false);
  }
});

test('invalid configuration never falls back to open and errors never reveal values', () => {
  const privateValue = 'PRIVATE_CONFIG_VALUE';
  for (const json of [undefined, '', '{', 'null', '[]', '{}',
    JSON.stringify({ 'invalid-email': 'a'.repeat(64) }),
    JSON.stringify({ 'tester@example.test': privateValue }),
    JSON.stringify({ 'tester@example.test': 'a'.repeat(64), ' TESTER@example.test ': 'b'.repeat(64) })]) {
    assert.throws(() => readRegistrationPolicy({ REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: json }),
      error => !error.message.includes(privateValue));
  }
  assert.throws(() => readRegistrationPolicy({ REGISTRATION_MODE: 'open', REGISTRATION_INVITES_JSON: '[]' }));
});
