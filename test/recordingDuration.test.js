const test = require('node:test');
const assert = require('node:assert/strict');
const { recordingDuration } = require('../services/recordingDuration');

test('duration declarations are optional, strictly parsed, and bounded', () => {
  assert.deepEqual(recordingDuration({}), { maximum: 300, declared: undefined });
  for (const duration of ['0', '299', '300']) assert.equal(recordingDuration({ durationSeconds: duration }).declared, Number(duration));
  for (const duration of ['300.001', '301', '', '-1', 'NaN', 'Infinity', '1e2', ' 1 ', [], null, 300]) {
    assert.throws(() => recordingDuration({ durationSeconds: duration }));
  }
  for (const body of [{ practiceMode: 'upload' }, { practiceMode: 'challenge' },
    { challengeId: 'id', resourceId: 'id' }, { practiceMode: 'ordinary', challengeId: 'id' }]) {
    assert.throws(() => recordingDuration(body));
  }
});

test('only stored challenge configuration establishes a shorter limit', () => {
  assert.equal(recordingDuration({ challengeId: 'id', max_duration_seconds: 999 }).maximum, 300);
  assert.equal(recordingDuration({}, { type: 'Script', timeLimitSeconds: 10 }).maximum, 300);
  assert.equal(recordingDuration({}, { type: 'Challenge', timeLimitSeconds: 60 }).maximum, 60);
  assert.equal(recordingDuration({}, { type: 'Challenge', timeLimitSeconds: 600 }).maximum, 300);
  assert.throws(() => recordingDuration({ challengeId: 'id', durationSeconds: '61' }, { type: 'Challenge', timeLimitSeconds: 60 }));
});
