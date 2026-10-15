const { validateDatabaseTls } = require('./securityConfiguration');

function readOnlyStartup(env = process.env) {
  const flag = env.ISPEAK_READ_ONLY_STARTUP;
  if (flag !== undefined && flag !== 'true' && flag !== 'false') {
    throw new Error('ISPEAK_READ_ONLY_STARTUP must be true or false');
  }
  if (flag !== 'true') {
    if (env.ISPEAK_BACKGROUND_JOBS !== undefined && env.ISPEAK_BACKGROUND_JOBS !== 'enabled') {
      throw new Error('ISPEAK_BACKGROUND_JOBS is incompatible with normal startup');
    }
    return false;
  }
  if (env.NODE_ENV !== 'production' || env.ISPEAK_BACKGROUND_JOBS !== 'disabled' ||
      env.STORAGE_DRIVER !== 'r2' || env.R2_BUCKET !== 'ispeak-prod-audio' ||
      !/^ispeak_integration_[a-zA-Z0-9_]+$/.test(env.ISPEAK_AUTHORIZED_TEST_DATABASE || '') ||
      !/^deployment-tests\/[a-f0-9]{32}\/$/.test(env.R2_TEST_PREFIX || '') ||
      env.ISPEAK_AUTHORIZED_R2_TEST_PREFIX !== env.R2_TEST_PREFIX) {
    throw new Error('Invalid read-only disposable integration startup authorization or background-job settings');
  }
  let options;
  try { options = new (require('mongoose').mongo.MongoClient)(env.MONGO_URI).options; }
  catch { throw new Error('Invalid read-only integration database configuration'); }
  if (!env.MONGO_URI.startsWith('mongodb+srv://') ||
      options.dbName !== env.ISPEAK_AUTHORIZED_TEST_DATABASE ||
      options.credentials?.username !== 'ispeak_integration') {
    throw new Error('Read-only startup requires the exact authorized disposable database and test user');
  }
  validateDatabaseTls(env.MONGO_URI);
  return true;
}

module.exports = { readOnlyStartup };
