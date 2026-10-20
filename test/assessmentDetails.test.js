const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const Session = require('../models/SpeechSession');
const { mapAssessmentDetails } = require('../services/assessmentDetails');

function fixture() {
  const result = spawnSync('python', ['-B', path.resolve(__dirname,
    '../../ispeak_python-backendV2/testing_script/test_assessment_details.py'), '--fixture'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Python evidence round-trips through bounded Node mapping and session serialization', async () => {
  const r = fixture();
  r.assessment_details.secret = 'discard';
  const detail = mapAssessmentDetails(r.assessment_details, r.scores);
  assert.equal(detail.completeness, 'complete');
  assert.equal(detail.secret, undefined);
  const doc = new Session({ userId: '507f1f77bcf86cd799439011', status: 'Completed',
    transcription: 'Good morning everyone', assessmentDetails: detail });
  await doc.validate();
  const saved = Session.hydrate(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(saved.assessmentDetails, detail);
  assert.equal(saved.assessmentDetails.scores.overall, 96.8);
  assert.equal(new Session().assessmentDetails, undefined);
});

test('invalid weights, scores, flags and invented measurements are not stored', () => {
  const r = fixture();
  for (const mutate of [d => { d.weights.overall.clarity = .9; },
    d => { d.scores.overall = 101; }, d => { d.availability.pitch = 'true'; },
    d => { d.availability.pronunciation = false; }, d => { d.components.pauses = Infinity; }]) {
    const d = structuredClone(r.assessment_details); mutate(d);
    assert.equal(mapAssessmentDetails(d, r.scores), undefined);
  }
  assert.equal(mapAssessmentDetails(undefined, r.scores), undefined);
});
