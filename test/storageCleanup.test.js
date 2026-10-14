const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.STORAGE_DRIVER = 'local';
const { R2StorageProvider } = require('../services/storageService');
const { createAudioStorage, RECOVERY_DELAY_MS } = require('../services/audioStorageService');
const { fakeR2, fakeJobs, config, ownerId, wav } = require('../testing/storageFixtures');

let root, client, provider, jobs, references, logs, clock, lifecycle, file;
const makeLifecycle = () => createAudioStorage({ provider, jobs, isReferenced: async key => references.has(key), log: text => logs.push(text), now: () => clock });
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-cleanup-test-'));
  client = fakeR2(); jobs = fakeJobs(); references = new Set(); logs = []; clock = Date.now();
  provider = new R2StorageProvider(config, { client, tempRoot: root }); lifecycle = makeLifecycle();
  file = { path: path.join(provider.getUploadDirectory(), 'audio.wav') }; fs.writeFileSync(file.path, wav());
});
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('write-ahead journal failure prevents any R2 upload', async () => {
  jobs.state.failWrite = true;
  await assert.rejects(lifecycle.storeUpload(file, { ownerId }), /storage/i);
  assert.equal(client.calls.length, 0);
});

test('successful commit removes upload intent and scratch file but retains durable object', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId });
  assert.equal(jobs.rows.size, 1); references.add(key);
  await lifecycle.committed(key); await lifecycle.cleanupTemp(file, { preserveLocal: true });
  assert.equal(jobs.rows.size, 0); assert.equal(fs.existsSync(file.path), false); assert.ok(client.objects.has(key));
});

test('uncertain upload failure survives restart and is reconciled idempotently', async () => {
  client.state.ambiguousPut = true;
  await assert.rejects(lifecycle.storeUpload(file, { ownerId }));
  assert.equal(jobs.rows.size, 1); assert.equal(client.objects.size, 1);
  client.state.ambiguousPut = false; clock += RECOVERY_DELAY_MS + 1;
  await makeLifecycle().retryCleanup(); await makeLifecycle().retryCleanup();
  assert.equal(jobs.rows.size, 0); assert.equal(client.objects.size, 0);
});

test('failed Mongo save leaves recoverable intent; delayed worker removes only unreferenced object', async () => {
  await lifecycle.storeUpload(file, { ownerId });
  await lifecycle.retryCleanup(); assert.equal(client.objects.size, 1);
  clock += RECOVERY_DELAY_MS + 1; await lifecycle.retryCleanup();
  assert.equal(client.objects.size, 0); assert.equal(jobs.rows.size, 0);
});

test('ambiguous Mongo success never loses the referenced recording', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId }); references.add(key);
  clock += RECOVERY_DELAY_MS + 1; await lifecycle.retryCleanup();
  assert.ok(client.objects.has(key)); assert.equal(jobs.rows.size, 1);
});

test('R2 delete failure stays journaled and logs no SDK secrets; later retry succeeds', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId });
  client.state.fail = 'DeleteObjectCommand'; await lifecycle.removeIfUnreferenced(key);
  assert.equal(jobs.rows.size, 1); assert.ok(client.objects.has(key));
  assert.ok(logs.length); assert.doesNotMatch(logs.join(' '), /SignedRequest|SHOULD_NOT_LEAK/);
  client.state.fail = ''; clock += 60_001; await lifecycle.retryCleanup();
  assert.equal(client.objects.size, 0); assert.equal(jobs.rows.size, 0);
});

test('reference lookup outage prevents deletion and retains recovery intent', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId });
  const failed = createAudioStorage({ provider, jobs, isReferenced: async () => { throw new Error('DB offline'); }, log: () => {} });
  await failed.removeIfUnreferenced(key); assert.ok(client.objects.has(key)); assert.equal(jobs.rows.size, 1);
});

test('cleanup namespace prevents deletion against a different bucket', async () => {
  await lifecycle.storeUpload(file, { ownerId }); clock += RECOVERY_DELAY_MS + 1;
  const other = new R2StorageProvider({ ...config, bucket: 'other-audio' }, { client, tempRoot: root });
  await createAudioStorage({ provider: other, jobs, isReferenced: async () => false, now: () => clock }).retryCleanup();
  assert.equal(client.objects.size, 1); assert.equal(jobs.rows.size, 1);
});

test('upload finalization cannot erase a concurrently scheduled resource deletion', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId }); references.add(key);
  await lifecycle.prepareRemoval(key);
  await lifecycle.committed(key); assert.equal(jobs.rows.size, 1);
  references.delete(key); clock += RECOVERY_DELAY_MS + 1;
  await lifecycle.retryCleanup(); assert.equal(client.objects.size, 0); assert.equal(jobs.rows.size, 0);
});

test('repeated cleanup outages retain one intent and resolve once storage recovers', async () => {
  const key = await lifecycle.storeUpload(file, { ownerId });
  client.state.fail = 'DeleteObjectCommand';
  await lifecycle.removeIfUnreferenced(key);
  for (let attempt = 2; attempt <= 3; attempt++) {
    clock += 60_001;
    await lifecycle.retryCleanup();
    assert.equal(jobs.rows.size, 1);
    const intent = [...jobs.rows.values()][0];
    assert.equal(intent.attempts, attempt);
    assert.ok(intent.nextAttemptAt > new Date(clock));
    assert.ok(client.objects.has(key));
  }
  client.state.fail = ''; clock += 60_001;
  await lifecycle.retryCleanup();
  assert.equal(client.objects.size, 0); assert.equal(jobs.rows.size, 0);
  const calls = client.calls.length;
  await lifecycle.retryCleanup(); assert.equal(client.calls.length, calls);
  assert.doesNotMatch(logs.join(' '), /SignedRequest|SHOULD_NOT_LEAK/);
});
