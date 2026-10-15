const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MongoClient } = require('mongoose').mongo;
const { readOnlyStartup } = require('../services/readOnlyStartup');
process.env.STORAGE_DRIVER = 'local';
const { R2StorageProvider, r2Configuration } = require('../services/storageService');
const { createAudioStorage, RECOVERY_DELAY_MS } = require('../services/audioStorageService');
const { fakeR2, fakeJobs, config, ownerId, wav } = require('../testing/storageFixtures');
const prefix = `deployment-tests/${'a'.repeat(32)}/`;

test('test R2 lifecycle and recovery cannot access production or other runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-isolation-'));
  try {
    const client = fakeR2(), jobs = fakeJobs();
    const provider = new R2StorageProvider({ ...config, testPrefix: prefix }, { client, tempRoot: root });
    const production = new R2StorageProvider(config, { client, tempRoot: root });
    const realKey = production.createKey('real.wav', { ownerId });
    client.objects.set(realKey, { body: wav() });
    const file = { path: path.join(root, 'test.wav') }; fs.writeFileSync(file.path, wav());
    let clock = Date.now();
    const lifecycle = createAudioStorage({ provider, jobs, isReferenced: async () => false, now: () => clock, log: () => {} });
    const key = await lifecycle.storeUpload(file, { ownerId });
    assert.ok(key.startsWith(prefix + 'recordings/' + ownerId + '/'));
    const chunks = []; for await (const chunk of await provider.openReadStream(key)) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), wav());
    for (const bad of [realKey, key.replace(prefix, `deployment-tests/${'b'.repeat(32)}/`), prefix + '../' + realKey]) {
      const before = client.calls.length;
      await assert.rejects(provider.storeFile(file.path, { key: bad }));
      await assert.rejects(provider.openReadStream(bad));
      await assert.rejects(provider.delete(bad));
      assert.equal(client.calls.length, before);
    }
    assert.throws(() => production.assertKey(key));
    const other = new R2StorageProvider({ ...config, testPrefix: `deployment-tests/${'b'.repeat(32)}/` }, { client, tempRoot: root });
    clock += RECOVERY_DELAY_MS + 1;
    await createAudioStorage({ provider: other, jobs, isReferenced: async () => false, now: () => clock }).retryCleanup();
    assert.ok(client.objects.has(key));
    await lifecycle.retryCleanup(); await lifecycle.retryCleanup();
    assert.equal(client.objects.has(key), false); assert.ok(client.objects.has(realKey));
    assert.equal(jobs.rows.size, 0);
    assert.ok(client.calls.every(call => call.input.Key.startsWith(prefix)));
    assert.ok(provider.createKey('ref.wav', { ownerId, category: 'reference_audio' }).startsWith(prefix + 'reference-audio/'));
    assert.throws(() => provider.createKey('test.wav', { ownerId: '../owner' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R2 test configuration rejects unsafe prefixes', () => {
  const env = { R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'test-audio', R2_ACCESS_KEY_ID: 'fake', R2_SECRET_ACCESS_KEY: 'fake' };
  for (const bad of ['deployment-tests/', 'recordings/', prefix + '../', prefix.toUpperCase(), prefix.slice(0, -1), null]) {
    assert.throws(() => r2Configuration({ ...env, R2_TEST_PREFIX: bad }));
  }
  assert.equal(r2Configuration({ ...env, R2_TEST_PREFIX: prefix }).testPrefix, prefix);
});

test('fictional encoded credentials parse offline and disposable startup rejects unsafe databases and TLS', () => {
  const password = 'fictional#@%/:password';
  const database = 'ispeak_integration_fixture';
  const uri = `mongodb+srv://ispeak_integration:${encodeURIComponent(password)}@cluster.example.mongodb.net/${database}?tls=true`;
  const options = new MongoClient(uri).options; // Parsing only: never connect.
  assert.equal(options.credentials.username, 'ispeak_integration');
  assert.equal(options.credentials.password, password);
  assert.equal(options.dbName, database);
  const env = {
    NODE_ENV: 'production', ISPEAK_READ_ONLY_STARTUP: 'true', ISPEAK_BACKGROUND_JOBS: 'disabled',
    STORAGE_DRIVER: 'r2', R2_BUCKET: 'ispeak-prod-audio', R2_TEST_PREFIX: prefix,
    ISPEAK_AUTHORIZED_R2_TEST_PREFIX: prefix, ISPEAK_AUTHORIZED_TEST_DATABASE: database,
    MONGO_URI: uri,
  };
  assert.equal(readOnlyStartup(env), true);
  for (const MONGO_URI of [
    uri.replace(database, 'ispeak_prod'),
    uri.replace('tls=true', 'tlsAllowInvalidCertificates=true'),
    uri.replace('tls=true', 'tls=false'),
    'malformed',
  ]) assert.throws(() => readOnlyStartup({ ...env, MONGO_URI }));
});
