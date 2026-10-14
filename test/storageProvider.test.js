const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.STORAGE_DRIVER = 'local';
const { R2StorageProvider, LocalStorageProvider, r2Configuration } = require('../services/storageService');
const { StorageError } = require('../services/storageErrors');
const { MAX_AUDIO_BYTES } = require('../services/audioFile');
const { wav, fakeR2, config, ownerId } = require('../testing/storageFixtures');

let root, client, provider, file, key;
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-provider-test-'));
  client = fakeR2(); provider = new R2StorageProvider(config, { client, tempRoot: root });
  file = path.join(provider.getUploadDirectory(), 'fixture.WAV'); fs.writeFileSync(file, wav());
  key = provider.createKey(file, { ownerId });
});
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('R2 upload uses private internal key, validated MIME, bounded body and no personal metadata', async () => {
  assert.equal(await provider.storeFile(file, { key }), key);
  assert.match(key, /^recordings\/[a-f0-9]{24}\/[a-f0-9-]{36}\.wav$/);
  const input = client.calls[0].input;
  assert.equal(input.ContentType, 'audio/wav'); assert.equal(input.ContentLength, wav().length);
  assert.equal(input.ACL, undefined); assert.equal(input.Metadata, undefined);
  assert.equal(input.Key.includes('fixture'), false);
  assert.notEqual(provider.createKey(file, { ownerId }), key);
});

test('R2 get completes before returning stream and preserves bytes', async () => {
  await provider.storeFile(file, { key });
  const stream = await provider.openReadStream(key);
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), wav());
  assert.equal(stream.audioLength, wav().length);
});

test('R2 delete and repeated missing delete are idempotent', async () => {
  await provider.storeFile(file, { key }); await provider.delete(key); await provider.delete(key);
  assert.equal(client.objects.size, 0);
  provider.client = { async send() { throw Object.assign(new Error('private'), { name: 'NoSuchKey' }); } };
  await provider.delete(key);
});

for (const operation of ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']) {
  test(`R2 ${operation} failure is controlled and contains no credentials`, async () => {
    client.state.fail = operation;
    const action = operation === 'PutObjectCommand' ? () => provider.storeFile(file, { key })
      : operation === 'GetObjectCommand' ? () => provider.openReadStream(key) : () => provider.delete(key);
    await assert.rejects(action, error => {
      assert.ok(error instanceof StorageError); assert.equal(error.status, 503);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /SHOULD_NOT_LEAK|SignedRequest|secret-access-key/);
      assert.equal(error.cause, undefined); return true;
    });
  });
}

test('R2 late body errors are storage errors before Python can be contacted', async () => {
  await provider.storeFile(file, { key }); client.state.brokenRead = true;
  await assert.rejects(provider.openReadStream(key), error => error instanceof StorageError && !error.message.includes('SHOULD_NOT_LEAK'));
});

test('R2 missing object is a safe 404', async () => {
  await assert.rejects(provider.openReadStream(key), error => error.status === 404);
});

test('R2 rejects traversal, local paths, URLs and invalid owner IDs before SDK calls', async () => {
  for (const invalid of ['../file.wav', 'uploads/file.wav', 'C:\\private.wav', 'https://bucket/file.wav', key.replace('recordings/', 'recordings/../')]) {
    await assert.rejects(provider.delete(invalid), StorageError);
    await assert.rejects(provider.openReadStream(invalid), StorageError);
  }
  assert.throws(() => provider.createKey(file, { ownerId: '../user' }));
  assert.equal(client.calls.length, 0);
});

test('R2 rejects disguised and oversized audio before transferring', async () => {
  fs.writeFileSync(file, 'not audio');
  await assert.rejects(provider.storeFile(file, { key }), error => error.status === 400);
  fs.writeFileSync(file, wav()); fs.truncateSync(file, MAX_AUDIO_BYTES + 1);
  await assert.rejects(provider.storeFile(file, { key }), error => error.status === 413);
  assert.equal(client.calls.length, 0);
});

test('R2 configuration fails closed and supports explicit/derived endpoint without printing values', () => {
  const env = { R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'test-audio', R2_ACCESS_KEY_ID: 'test-only', R2_SECRET_ACCESS_KEY: 'test-only' };
  assert.equal(r2Configuration(env).endpoint, config.endpoint);
  assert.equal(r2Configuration({ ...env, R2_ACCOUNT_ID: '', R2_ENDPOINT: config.endpoint }).region, 'auto');
  for (const endpoint of ['http://localhost:9000', 'https://user:SHOULD_NOT_LEAK@example.com', config.endpoint + '/path', 'https://attacker.invalid']) {
    assert.throws(() => r2Configuration({ ...env, R2_ENDPOINT: endpoint }), error => !error.message.includes('SHOULD_NOT_LEAK'));
  }
  assert.throws(() => r2Configuration({}), /Missing R2 configuration/);
});

test('local provider retains files, relative keys, stream reads and idempotent deletion', async () => {
  const local = new LocalStorageProvider(root);
  const localKey = local.createKey(file);
  assert.equal(await local.storeFile(file), localKey);
  assert.ok(fs.existsSync(file));
  const chunks = []; for await (const chunk of local.openReadStream(localKey)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), wav());
  assert.throws(() => local.resolve('../outside.wav'));
  await local.delete(localKey); await local.delete(localKey); assert.equal(fs.existsSync(file), false);
});

test('recording and reference keys normalize owners and extensions without embedding filenames', () => {
  for (const [category, prefix] of [['recordings', 'recordings'], ['reference_audio', 'reference-audio']]) {
    const generated = provider.createKey(path.join(root, 'private-person-name.WAV'), { category, ownerId: ownerId.toUpperCase() });
    assert.ok(generated.startsWith(`${prefix}/${ownerId}/`));
    assert.ok(generated.endsWith('.wav'));
    assert.equal(generated.includes('private-person-name'), false);
    provider.assertKey(generated);
    for (const invalid of [generated + '?token=secret', generated.replace(prefix, '..'), generated.replace(ownerId, '../owner')]) {
      assert.throws(() => provider.assertKey(invalid), StorageError);
    }
  }
  assert.equal(client.calls.length, 0);
});
