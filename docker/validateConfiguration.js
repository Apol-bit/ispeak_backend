// Docker-only validation. Never print configured values or raw exceptions.
const fs = require('node:fs');
const fields = new Set(['MONGO_URI', 'JWT_SECRET', 'CORS_ORIGINS', 'PYTHON_BACKEND_URL',
  'PYTHON_SERVICE_TOKEN', 'STORAGE_DRIVER', 'ALLOW_LOCAL_STORAGE_IN_PRODUCTION',
  'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
  'R2_ENDPOINT', 'TRUST_PROXY_CIDRS']);
let storage;
try {
  storage = require('../services/storageService').storage;
  require('../server').validateEnvironment();
} catch (error) {
  const names = [...new Set((String(error?.message).match(/\b[A-Z][A-Z0-9_]+\b/g) || [])
    .filter(name => fields.has(name)))];
  console.error('Invalid container production configuration. Verify ' +
    (names.length ? names.join(', ') : 'the required storage, database, JWT, CORS and Python configuration') + '.');
  process.exitCode = 1;
} finally {
  if (storage?.temporaryUploads) fs.rmSync(storage.tempRoot, { recursive: true, force: true });
}
