const test = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../models/SpeechSession');
const { isUsableTranscript } = require('../services/transcriptValidation');
const { usableAnalysis } = require('../services/analysisResponse');
const invalid = [undefined, null, '', ' \n\t ', 'No transcription available',
  'No transcription available.', '  nO tRaNsCrIpTiOn AvAiLaBlE. \n'];
const valid = ['Hello.', 'Magandang araw sa inyong lahat.', 'Oo'];
const base = { analysis_valid: true, duration_seconds: 3, pacing: { wpm: 120 },
  scores: { overall: 80, pacing: 80, clarity: 80, energy: 80 } };
const userId = '507f1f77bcf86cd799439011';

test('transcript validation rejects placeholders without rejecting short genuine speech', () => {
  for (const transcription of invalid) {
    assert.equal(isUsableTranscript(transcription), false);
    assert.equal(usableAnalysis({ ...base, transcription }), false);
  }
  for (const transcription of valid) {
    assert.equal(isUsableTranscript(transcription), true);
    assert.equal(usableAnalysis({ ...base, transcription }), true);
  }
});

test('new and hydrated Completed documents require usable transcripts', async () => {
  for (const transcription of invalid) {
    const doc = new Session({ userId, status: 'Completed', transcription });
    await assert.rejects(doc.validate(), /usable transcription|required/);
    const legacy = Session.hydrate({ userId, status: 'Completed', transcription });
    legacy.energyScore = 50;
    await assert.rejects(legacy.validate(), /usable transcription|required/);
  }
  for (const transcription of valid) {
    await new Session({ userId, status: 'Completed', transcription }).validate();
  }
  const pending = new Session({ userId });
  await pending.validate();
  pending.status = 'Completed';
  await assert.rejects(pending.validate());
  await new Session({ userId, status: 'Failed' }).validate();
});

test('query updates guard completion/transcription even without runValidators', async () => {
  const original = Session.collection.updateOne;
  let writes = 0;
  Session.collection.updateOne = async () => { writes++; return { acknowledged: true }; };
  try {
    for (const update of [
      { $set: { status: 'Completed' } },
      { $set: { transcription: 'No transcription available.' } },
      { $unset: { transcription: 1 } },
      { $rename: { transcription: 'oldTranscript' } },
      { $set: { status: 'Completed', transcription: 'Hello' }, $unset: { transcription: 1 } },
      [{ $set: { status: 'Completed' } }]
    ]) await assert.rejects(Session.updateOne({}, update, { updatePipeline: Array.isArray(update) }).exec());
    assert.equal(writes, 0);
    await assert.rejects(Session.updateOne({ status: 'Completed' }, { $set: { energyScore: 80 } }, { upsert: true }).exec());
    await assert.rejects(Session.updateOne({}, { $setOnInsert: { status: 'Completed' } }, { upsert: true }).exec());
    await Session.updateOne({}, { $set: { status: 'Completed', transcription: 'Magandang araw.' } }, { runValidators: true });
    await Session.updateOne({}, { $set: { audioDeletedAt: new Date() } });
    assert.equal(writes, 2);
  } finally { Session.collection.updateOne = original; }
});

test('all guarded query methods reject incomplete completion before database access', async () => {
  for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
    await assert.rejects(Session[method]({}, { status: 'Completed' }).exec(), /usable transcription/);
  }
});
