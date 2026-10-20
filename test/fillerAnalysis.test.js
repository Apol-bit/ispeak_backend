const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { mapFillerAnalysis } = require('../services/fillerAnalysis');
const Session = require('../models/SpeechSession');

test('actual mocked Python classifier output survives Node and session serialization', async () => {
  const file = path.resolve(__dirname, '../../ispeak_python-backendV2/audio_analysis_processing_files/filler_words.py');
  const script = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('f',sys.argv[1]);f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
r=f.analyze_fillers([dict(text='um',start=0,end=.5),dict(text='um',start=.5,end=1)],classifier=lambda t:[dict(entity_group='FILLER',start=0,end=5,score=.95)],full_transcript='um um hello')
print(json.dumps(dict(analysis_available=r['analysis_available'],count=r['filler_count'],rate=r['filler_rate'],score=r['filler_score'],words=r['filler_words'],candidates=r['filler_candidates'],candidate_count=r['candidate_count'],coverage=r['coverage'],threshold=r['threshold'])))`;
  const pythonRoot = path.resolve(__dirname, '../../ispeak_python-backendV2');
  const localPython = path.join(pythonRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = require('node:fs').existsSync(localPython) ? localPython : 'python';
  const result = spawnSync(python, ['-B', '-c', script, file], {
    encoding: 'utf8', cwd: pythonRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  const detail = mapFillerAnalysis(JSON.parse(result.stdout));
  const doc = new Session({ userId: '507f1f77bcf86cd799439011', status: 'Completed',
    transcription: 'um um hello', fillerAnalysis: detail, fillerWordCount: detail.count, fillerAnalysisAvailable: detail.available });
  await doc.validate();
  const saved = Session.hydrate(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(saved.fillerAnalysis, detail);
  assert.equal(saved.fillerAnalysis.words[0].word, 'um um');
  assert.equal(saved.fillerAnalysis.words[0].confidence, .95);
  assert.equal(saved.fillerAnalysis.coverage.status, 'mismatch');
});

test('mapping distinguishes unavailable and uncertain zero; bounds and allow-lists details', () => {
  assert.equal(mapFillerAnalysis().count, null);
  assert.equal(mapFillerAnalysis({ analysis_available: true, count: -1 }).available, false);
  const item = { word: 'um'.repeat(100), start: 0, end: 1, confidence: .59, secret: 'discard' };
  const detail = mapFillerAnalysis({ analysis_available: true, count: 0, rate: 0, score: 100,
    candidates: Array(150).fill(item), rawTokens: ['discard'], coverage: { status: 'mismatch' } });
  assert.equal(detail.count, 0); assert.equal(detail.candidateCount, 150);
  assert.equal(detail.candidates.length, 100); assert.equal(detail.detailsTruncated, true);
  assert.equal(detail.candidates[0].word.length, 120);
  assert.equal(detail.candidates[0].secret, undefined); assert.equal(detail.rawTokens, undefined);
  assert.equal(new Session().fillerAnalysis, undefined);
});
