const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function validate(values) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-env-test-'));
  try {
    return spawnSync(process.execPath, ['-e', `
      let storage;
      try { storage = require('./services/storageService').storage; require('./server').validateEnvironment(); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
      finally { if (storage?.temporaryUploads) require('node:fs').rmSync(storage.tempRoot, {recursive:true,force:true}); }
    `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://example.invalid/not-contacted',
      JWT_SECRET: 'environment-test-only-secret-not-for-production', CORS_ORIGINS: 'https://admin.example.invalid',
      PYTHON_SERVICE_TOKEN: 'environment-tests-only-service-token-not-real',
      PYTHON_BACKEND_URL: 'http://python.internal:8000', LOCAL_STORAGE_ROOT: root, STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'false', R2_BUCKET: 'test-audio', R2_ACCOUNT_ID: 'a'.repeat(32),
      R2_ACCESS_KEY_ID: 'test-only', R2_SECRET_ACCESS_KEY: 'test-only', R2_ENDPOINT: '', ...values,
    } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('production rejects local storage without explicit persistent-volume acknowledgement', () => {
  const result = validate({}); assert.equal(result.status, 1); assert.match(result.stderr, /Local recording storage is disabled/);
});
test('production permits explicitly acknowledged local storage and configured R2 without a local bypass', () => {
  assert.equal(validate({ ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true' }).status, 0);
  assert.equal(validate({ STORAGE_DRIVER: 'r2' }).status, 0);
});
test('R2 startup rejects absent credentials and unsafe endpoints without credential output', () => {
  const result = validate({ STORAGE_DRIVER: 'r2', R2_SECRET_ACCESS_KEY: '' });
  assert.equal(result.status, 1); assert.match(result.stderr, /R2_SECRET_ACCESS_KEY/);
  const endpoint = validate({ STORAGE_DRIVER: 'r2', R2_ENDPOINT: 'https://test:SHOULD_NOT_LEAK@example.invalid' });
  assert.equal(endpoint.status, 1); assert.doesNotMatch(endpoint.stderr, /SHOULD_NOT_LEAK/);
});

test('production requires a private Python service credential and exact HTTPS CORS origins', () => {
  const missing = validate({ PYTHON_SERVICE_TOKEN: '' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /PYTHON_SERVICE_TOKEN/);
  const wildcard = validate({ CORS_ORIGINS: 'https://*.example.invalid' });
  assert.equal(wildcard.status, 1); assert.match(wildcard.stderr, /exact HTTPS origins/);
});
