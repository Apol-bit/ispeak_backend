const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inventory } = require('../scripts/audioInventory');

test('read-only inventory separates referenced, missing, orphan and cloud keys without file changes', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ispeak-inventory-test-'));
  try {
    const root = path.join(projectRoot, 'uploads'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'used.wav'), '1234'); await fs.writeFile(path.join(root, 'orphan.wav'), '12');
    const result = await inventory({ root, projectRoot,
      sessions: [{ audioPath: 'uploads/used.wav' }, { audioPath: 'uploads/missing.wav' }, { audioPath: '../outside.wav' }],
      resources: [{ referenceAudioPath: 'uploads/used.wav' }, { referenceAudioPath: 'reference-audio/' + 'a'.repeat(24) + '/' + 'b'.repeat(36) + '.wav' }] });
    assert.equal(result.localFiles, 2); assert.equal(result.localBytes, 6);
    assert.equal(result.existingReferences, 2); assert.equal(result.referencedFiles, 1); assert.equal(result.referencedBytes, 4);
    assert.equal(result.orphanCandidates, 1); assert.equal(result.orphanCandidateBytes, 2);
    assert.equal(result.missingReferences, 1); assert.equal(result.cloudReferences, 1); assert.equal(result.unsafeOrUnsupportedReferences, 1);
    assert.deepEqual((await fs.readdir(root)).sort(), ['orphan.wav', 'used.wav']);
    assert.equal(await fs.readFile(path.join(root, 'used.wav'), 'utf8'), '1234');
    const partial = await inventory({ root, projectRoot, databaseAvailable: false });
    assert.equal(partial.localFiles, 2); assert.equal(partial.orphanCandidates, null);
  } finally { await fs.rm(projectRoot, { recursive: true, force: true }); }
});
