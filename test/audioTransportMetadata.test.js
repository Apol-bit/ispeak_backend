const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { wav } = require('../testing/storageFixtures');
const { audioTransportMetadata } = require('../services/audioFile');

test('transport metadata hashes exact bytes and reads PCM WAV properties', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-audio-metadata-'));
  const file = path.join(root, 'phone.wav');
  const bytes = wav();
  fs.writeFileSync(file, bytes);
  try {
    const actual = await audioTransportMetadata(file);
    assert.equal(actual.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(actual.bytes, bytes.length);
    assert.equal(actual.extension, '.wav');
    assert.equal(actual.sampleRate, 16000);
    assert.equal(actual.channels, 1);
    assert.equal(actual.bitsPerSample, 16);
    assert.equal(actual.durationSeconds, 0.01);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
