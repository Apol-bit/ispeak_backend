const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readRegistrationPolicy } = require('../services/registrationPolicy');

const source = fs.readFileSync(path.join(__dirname, '../docker/validateConfiguration.js'), 'utf8');

// Execute the real container reporter with the real registration validator.
// Stub storage/server initialization so no files or external services are touched.
function diagnose(validateEnvironment) {
  const output = [];
  const processStub = {};
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'node:fs') return { rmSync() { assert.fail('Unexpected filesystem mutation'); } };
      if (name === '../services/storageService') return { storage: { temporaryUploads: false } };
      if (name === '../server') return { validateEnvironment };
      assert.fail('Unexpected import');
    },
    process: processStub,
    console: { error: message => output.push(message) },
  });
  return { exitCode: processStub.exitCode, output };
}

const dummyEmail = 'dummy-private@example.invalid';
const dummyHash = 'ab'.repeat(32);
const validJson = JSON.stringify({ [dummyEmail]: dummyHash });

for (const [label, settings, field] of [
  ['missing production mode', {}, 'REGISTRATION_MODE'],
  ['invalid mode', { REGISTRATION_MODE: 'PRIVATE_INVALID_MODE' }, 'REGISTRATION_MODE'],
  ['missing invitations', { REGISTRATION_MODE: 'invite' }, 'REGISTRATION_INVITES_JSON'],
  ['empty invitations', { REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: '{}' }, 'REGISTRATION_INVITES_JSON'],
  ['malformed JSON', { REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: validJson + 'PRIVATE_CODE' }, 'REGISTRATION_INVITES_JSON'],
  ['invalid hash', { REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: JSON.stringify({ [dummyEmail]: 'PRIVATE_CODE' }) }, 'REGISTRATION_INVITES_JSON'],
  ['non-object JSON', { REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: '[]' }, 'REGISTRATION_INVITES_JSON'],
]) {
  test(`container diagnostic identifies ${label} without disclosing values`, () => {
    const result = diagnose(() => readRegistrationPolicy({ NODE_ENV: 'production', ...settings }));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, [`Invalid container production configuration. Verify ${field}.`]);
    const text = result.output.join('\n');
    for (const value of [dummyEmail, dummyHash, validJson, 'PRIVATE_CODE', 'PRIVATE_INVALID_MODE']) {
      assert.equal(text.includes(value), false);
    }
  });
}

test('valid invitations still pass container configuration validation', () => {
  const result = diagnose(() => readRegistrationPolicy({ NODE_ENV: 'production',
    REGISTRATION_MODE: 'invite', REGISTRATION_INVITES_JSON: validJson }));
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.output, []);
});

test('existing production failures remain fatal and raw exceptions stay private', () => {
  for (const [message, expected] of [
    ['JWT_SECRET PRIVATE_CREDENTIAL', 'JWT_SECRET'],
    ['R2_SECRET_ACCESS_KEY PRIVATE_CREDENTIAL', 'R2_SECRET_ACCESS_KEY'],
    ['PRIVATE_CREDENTIAL', 'the required storage, database, JWT, CORS and Python configuration'],
  ]) {
    const result = diagnose(() => { throw new Error(message); });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, [`Invalid container production configuration. Verify ${expected}.`]);
  }
});
