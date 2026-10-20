// HTTP regressions use the real SDK commands/provider/controllers with an
// in-memory R2 transport and Mongo stubs. No real bucket or database is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { config, fakeR2, fakeJobs, ownerId, wav } = require('../testing/storageFixtures');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-r2-flow-'));
process.env.NODE_ENV = 'test'; process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_ROOT = path.join(root, 'local');
process.env.JWT_SECRET = 'storage-tests-only-not-a-real-secret-value';
process.env.ANALYSIS_RATE_LIMIT_MAX = '1000';
const service = require('../services/storageService');
const client = fakeR2();
const provider = new service.R2StorageProvider(config, { client, tempRoot: path.join(root, 'scratch') });
service.storage = provider;
const jobs = fakeJobs();
const Cleanup = require('../models/StorageCleanup');
for (const method of ['updateOne', 'deleteOne', 'find']) Cleanup[method] = jobs[method].bind(jobs);
const User = require('../models/User');
const Session = require('../models/SpeechSession');
const Resource = require('../models/LearningResource');
const sessions = new Map(); const resources = new Map();
let sessionFailure, resourceFailure, referenceConflict, pythonStatus, pythonCalls, multipart, deletedUser;
let holdPython, releasePython, pythonArrived;
let pythonTranscription;
let pythonFillers;
let pythonAssessment, pythonScores;
let pythonDuration;
const clone = doc => doc && new doc.constructor(doc.toObject());
const user = { _id: ownerId, role: 'admin', status: 'Active', isArchived: false };
User.findById = () => ({ select: async () => user, then: (resolve, reject) => Promise.resolve(user).then(resolve, reject) });
User.exists = async () => ({ _id: ownerId });
User.findByIdAndDelete = async () => { deletedUser = true; };
Session.prototype.save = async function () {
  if (sessionFailure === 'before') throw new Error('DB unavailable');
  sessions.set(String(this._id), clone(this));
  if (sessionFailure === 'after') throw new Error('uncertain DB acknowledgement');
  return this;
};
Session.exists = async filter => [...sessions.values()].find(doc => filter.userId
  ? String(doc.userId) === String(filter.userId) : doc.audioPath === filter.audioPath) || null;
Session.find = filter => ({ select: async () => [...sessions.values()].filter(doc =>
  (!filter.userId || String(doc.userId) === String(filter.userId)) &&
  (!filter.createdAt || doc.createdAt < filter.createdAt.$lt) &&
  (!filter.audioPath || (doc.audioPath && !doc.audioDeletedAt))).map(clone) });
Session.deleteMany = async () => sessions.clear();
Resource.prototype.save = async function () {
  if (resourceFailure) throw new Error('DB unavailable');
  await this.validate(); resources.set(String(this._id), clone(this)); return this;
};
Resource.find = filter => ({ sort: async () => [...resources.values()].filter(doc =>
  (!filter.type || doc.type === filter.type) && (!filter.difficulty || doc.difficulty === filter.difficulty)).map(clone) });
Resource.findById = async id => clone(resources.get(String(id)));
Resource.exists = async filter => [...resources.values()].find(doc => doc.referenceAudioPath === filter.referenceAudioPath) || null;
Resource.findByIdAndUpdate = async (id, data) => {
  if (resourceFailure) throw new Error('DB unavailable');
  const doc = clone(resources.get(String(id))); if (!doc) return null;
  doc.set(data); await doc.validate(); resources.set(String(id), clone(doc)); return doc;
};
Resource.findOneAndUpdate = async (filter, data) => {
  const old = resources.get(String(filter._id));
  if (referenceConflict || !old || old.referenceAudioPath !== filter.referenceAudioPath) return null;
  return Resource.findByIdAndUpdate(filter._id, data);
};
Resource.findByIdAndDelete = async id => { if (resourceFailure) throw new Error('DB unavailable'); resources.delete(String(id)); };
Resource.findOneAndDelete = async filter => {
  if (resourceFailure) throw new Error('DB unavailable');
  const doc = resources.get(String(filter._id));
  if (referenceConflict || !doc || doc.referenceAudioPath !== filter.referenceAudioPath) return null;
  resources.delete(String(filter._id)); return doc;
};
const { app, validateEnvironment } = require('../server');
const { audioStorage, RECOVERY_DELAY_MS } = require('../services/audioStorageService');
const { purgeExpiredRecordings } = require('../services/retentionService');
let gateway, python, url;
const token = role => jwt.sign({ userId: ownerId }, process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'ispeak-api', audience: 'ispeak-clients', expiresIn: '1h' });
const result = { analysis_valid: true, transcription: 'A valid sample sentence.', duration_seconds: 10,
  pacing: { wpm: 130 }, scores: { overall: 80, pacing: 80, clarity: 80, energy: 80 }, fillers: { analysis_available: true, count: 0 } };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function request(route, { method = 'GET', fields, audio, audioField = 'audio', authenticated = true } = {}) {
  const headers = authenticated ? { Authorization: 'Bearer ' + token() } : {};
  let body;
  if (fields || audio) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields || {})) body.append(key, value);
    if (audio) body.append(audioField, new Blob([audio], { type: 'application/octet-stream' }), 'input.WAV');
  }
  const response = await fetch(url + route, { method, headers, body });
  return { status: response.status, body: await response.json() };
}
const upload = (fields = {}, audio = wav()) => request('/api/upload-audio', { method: 'POST', fields, audio });
const createResource = () => request('/api/admin/resources', { method: 'POST', audio: wav(), audioField: 'referenceAudio',
  fields: { type: 'Script', title: 'Fixture', description: 'Reference', difficulty: 'Beginner' } });
const replace = id => request('/api/admin/resources/' + id, { method: 'PUT', audio: wav(), audioField: 'referenceAudio' });
const scratchFiles = () => ['recordings', 'reference_audio'].flatMap(dir => {
  const location = path.join(root, 'scratch', dir); return fs.existsSync(location) ? fs.readdirSync(location) : [];
});
async function drainRecovery() {
  for (const row of jobs.rows.values()) row.nextAttemptAt = new Date(Date.now() - RECOVERY_DELAY_MS);
  await audioStorage.retryCleanup();
}

test.before(async () => {
  python = http.createServer((req, res) => {
    pythonCalls++; const chunks = [];
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      multipart = Buffer.concat(chunks);
      const respond = () => {
        res.writeHead(pythonStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pythonStatus === 200 ? { ...result, transcription: pythonTranscription,
          fillers: pythonFillers, scores: pythonScores, assessment_details: pythonAssessment,
          duration_seconds: pythonDuration } : { detail: 'test rejection' }));
      };
      if (holdPython) releasePython = respond;
      else respond();
      pythonArrived?.();
    });
  });
  process.env.PYTHON_BACKEND_URL = await listen(python);
  gateway = http.createServer(app); url = await listen(gateway);
});
test.beforeEach(() => {
  sessions.clear(); resources.clear(); jobs.rows.clear(); client.objects.clear(); client.calls.length = 0;
  jobs.state.failWrite = false; client.state.fail = ''; client.state.ambiguousPut = false; client.state.brokenRead = false;
  sessionFailure = ''; resourceFailure = false; referenceConflict = false;
  pythonStatus = 200; pythonCalls = 0; multipart = null; deletedUser = false; user.role = 'admin';
  pythonTranscription = result.transcription;
  pythonFillers = result.fillers;
  pythonAssessment = undefined; pythonScores = result.scores;
  pythonDuration = result.duration_seconds;
  holdPython = false; releasePython = null; pythonArrived = null;
});
test.after(async () => {
  gateway.closeAllConnections(); python.closeAllConnections();
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => python.close(resolve))]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('R2 successful analysis stores only object key, preserves response and cleans scratch', async () => {
  const response = await upload(); assert.equal(response.status, 200); assert.equal(response.body.audioPath, undefined);
  const session = [...sessions.values()][0]; assert.match(session.audioPath, /^recordings\//);
  assert.ok(client.objects.has(session.audioPath)); assert.equal(jobs.rows.size, 0);
  assert.equal(session.status, 'Completed'); assert.deepEqual(scratchFiles(), []);
  assert.equal(session.transcription, result.transcription);
  assert.equal(response.body.transcription, result.transcription);
  assert.equal(response.body.fillerAnalysis.version, 1);
  assert.equal(response.body.fillerAnalysis.count, 0);
  assert.deepEqual(session.fillerAnalysis, response.body.fillerAnalysis);
  assert.equal(typeof response.body.aiFeedback, 'string');
});

for (const practiceMode of ['ordinary', 'script', 'challenge', undefined]) {
  test(`activity ${practiceMode ?? 'legacy'} survives upload and mocked persistence`, async () => {
    const fields = practiceMode ? { practiceMode } : {};
    if (practiceMode === 'challenge') fields.challengeId = '507f1f77bcf86cd799439099';
    if (practiceMode === 'script') fields.resourceId = '507f1f77bcf86cd799439098';
    const response = await upload(fields);
    assert.equal(response.status, 200);
    assert.equal(response.body.practiceMode, practiceMode);
    const session = [...sessions.values()][0];
    assert.equal(session.practiceMode, practiceMode);
    if (fields.resourceId) assert.equal(String(session.resourceId), fields.resourceId);
    if (fields.challengeId) assert.equal(String(session.challengeId), fields.challengeId);
  });
}

test('activity schema has no legacy default and rejects unsupported modes', () => {
  assert.equal(new Session({ userId: ownerId }).practiceMode, undefined);
  assert.ok(new Session({ userId: ownerId, practiceMode: 'unknown' }).validateSync().errors.practiceMode);
});

for (const transcription of [undefined, null, '', ' \n ', 'No transcription available',
  'No transcription available.', '  NO TRANSCRIPTION AVAILABLE.  ']) {
  test(`invalid Python transcript ${JSON.stringify(transcription)} never persists session or R2 audio`, async () => {
    pythonTranscription = transcription;
    const response = await upload();
    assert.equal(response.status, 502);
    assert.equal(sessions.size, 0);
    assert.equal(client.objects.size, 0);
    assert.equal(client.calls.some(call => call.operation === 'PutObjectCommand'), false);
    assert.deepEqual(scratchFiles(), []);
  });
}

test('valid Filipino Python transcript persists unchanged', async () => {
  pythonTranscription = 'Magandang araw sa inyong lahat.';
  const response = await upload({ language: 'Filipino' });
  assert.equal(response.status, 200);
  assert.equal(response.body.transcription, pythonTranscription);
  assert.equal([...sessions.values()][0].transcription, pythonTranscription);
});

for (const durationSeconds of ['301', '300.001', 'NaN', '-1', '']) {
  test(`duration ${durationSeconds} is rejected before Python and permanent storage`, async () => {
    const response = await upload({ durationSeconds });
    assert.equal(response.status, 400); assert.equal(pythonCalls, 0);
    assert.equal(client.objects.size, 0); assert.equal(sessions.size, 0);
    assert.deepEqual(scratchFiles(), []);
  });
}

test('trusted challenge limit is forwarded and excessive declared duration rejected', async () => {
  const resource = new Resource({ type: 'Challenge', title: 'Fixture', description: 'Fixture', timeLimitSeconds: 60 });
  resources.set(String(resource._id), resource);
  assert.equal((await upload({ challengeId: String(resource._id), durationSeconds: '61' })).status, 400);
  assert.equal(pythonCalls, 0);
  assert.equal((await upload({ challengeId: String(resource._id), durationSeconds: '60' })).status, 200);
  assert.match(multipart.toString(), /name="max_duration_seconds"\r\n\r\n60/);
});

test('spoofed short declaration cannot make excessive decoded result persist', async () => {
  pythonDuration = 301;
  assert.equal((await upload({ durationSeconds: '1' })).status, 400);
  assert.equal(pythonCalls, 1); assert.equal(client.objects.size, 0); assert.equal(sessions.size, 0);
  assert.deepEqual(scratchFiles(), []);
});

test('Python scoring evidence survives successful API and mocked Mongo persistence', async () => {
  const { spawnSync } = require('node:child_process');
  const fixture = spawnSync('python', ['-B', path.resolve(__dirname,
    '../../ispeak_python-backendV2/testing_script/test_assessment_details.py'), '--fixture'], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  const r = JSON.parse(fixture.stdout);
  pythonScores = r.scores; pythonAssessment = r.assessment_details; pythonFillers = r.fillers;
  const response = await upload();
  assert.equal(response.status, 200);
  assert.equal(response.body.assessmentDetails.scores.overall, 96.8);
  assert.equal(response.body.assessmentDetails.completeness, 'complete');
  assert.equal(response.body.status, 'Completed');
  assert.equal(response.body.analysisValid, true);
  assert.deepEqual([...sessions.values()][0].assessmentDetails, response.body.assessmentDetails);
});

for (const state of ['positive', 'uncertain', 'unavailable']) {
  test(`filler ${state} evidence persists through upload and serialization`, async () => {
    const item = { word: 'um um', start: 0, end: 1, confidence: state === 'uncertain' ? .59 : .95 };
    pythonFillers = { analysis_available: state !== 'unavailable', count: state === 'positive' ? 1 : 0,
      score: state === 'unavailable' ? null : 100, rate: 0,
      words: state === 'positive' ? [item] : [], candidates: state === 'uncertain' ? [item] : [],
      coverage: { status: 'mismatch' }, failure: { code: 'classifier_inference_failed' } };
    const response = await upload();
    assert.equal(response.status, 200);
    assert.deepEqual([...sessions.values()][0].fillerAnalysis, response.body.fillerAnalysis);
    assert.equal(response.body.fillerAnalysis.count, state === 'unavailable' ? null : state === 'positive' ? 1 : 0);
    assert.equal(response.body.fillerAnalysisAvailable, state !== 'unavailable');
    assert.equal(response.body.fillerWordCount, state === 'positive' ? 1 : 0);
    if (state === 'uncertain') assert.equal(response.body.fillerAnalysis.candidateCount, 1);
    if (state === 'positive') assert.equal(response.body.fillerAnalysis.words[0].confidence, .95);
  });
}

for (const status of [400, 500, 503]) test(`Python ${status} never uploads durable audio or saves a completed session`, async () => {
  pythonStatus = status; const response = await upload(); assert.equal(response.status, status === 500 ? 502 : status);
  assert.equal(client.objects.size, 0); assert.equal(sessions.size, 0); assert.deepEqual(scratchFiles(), []);
});

test('failed R2 upload returns a storage error, never a false completed session', async () => {
  client.state.fail = 'PutObjectCommand'; const response = await upload();
  assert.equal(response.status, 503); assert.match(response.body.message, /storage/i);
  assert.doesNotMatch(JSON.stringify(response.body), /SHOULD_NOT_LEAK|Evaluation Engine|SignedRequest/);
  assert.equal(sessions.size, 0); assert.equal(jobs.rows.size, 1); assert.deepEqual(scratchFiles(), []);
});

for (const failure of ['before', 'after']) test(`Mongo save ${failure} acknowledgement: cleanup checks actual references`, async () => {
  sessionFailure = failure; const response = await upload(); assert.equal(response.status, 500);
  assert.equal(client.objects.size, 1); assert.equal(jobs.rows.size, 1); assert.deepEqual(scratchFiles(), []);
  await drainRecovery(); assert.equal(client.objects.size, failure === 'before' ? 0 : 1);
});

test('reference create, authenticated fetch and Python multipart preserve private bytes', async () => {
  const created = await createResource(); assert.equal(created.status, 201);
  const resource = created.body.resource; assert.match(resource.referenceAudioPath, /^reference-audio\//);
  assert.ok(client.objects.has(resource.referenceAudioPath));
  const response = await fetch(url + `/api/admin/resources/${resource._id}/reference-audio`, { headers: { Authorization: 'Bearer ' + token() } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav());
  assert.equal((await request(`/api/admin/resources/${resource._id}/reference-audio`, { authenticated: false })).status, 401);
  user.role = 'user'; assert.equal((await request(`/api/admin/resources/${resource._id}/reference-audio`)).status, 403); user.role = 'admin';
  assert.equal((await upload({ resourceId: resource._id })).status, 200);
  assert.match(multipart.toString(), /name="reference_audio"/); assert.ok(multipart.includes(wav()));
  assert.deepEqual(scratchFiles(), []);
});

test('reference R2 read failure prevents Python request and preserves resource', async () => {
  const resource = (await createResource()).body.resource; client.state.fail = 'GetObjectCommand';
  const response = await upload({ resourceId: resource._id });
  assert.equal(response.status, 503); assert.match(response.body.message, /storage/i);
  assert.equal(pythonCalls, 0); assert.equal(sessions.size, 0); assert.ok(client.objects.has(resource.referenceAudioPath));
  assert.deepEqual(scratchFiles(), []);
});

test('reference replacement uploads first, commits new key, then deletes old object', async () => {
  const old = (await createResource()).body.resource; client.calls.length = 0;
  const response = await replace(old._id); assert.equal(response.status, 200);
  const updated = response.body.resource; assert.notEqual(updated.referenceAudioPath, old.referenceAudioPath);
  assert.ok(client.objects.has(updated.referenceAudioPath)); assert.equal(client.objects.has(old.referenceAudioPath), false);
  assert.deepEqual(client.calls.map(call => call.operation), ['PutObjectCommand', 'DeleteObjectCommand']);
  assert.deepEqual(scratchFiles(), []);
});

for (const failure of ['upload', 'database', 'conflict']) test(`reference replacement ${failure} preserves original and handles new orphan`, async () => {
  const old = (await createResource()).body.resource;
  if (failure === 'upload') client.state.fail = 'PutObjectCommand';
  if (failure === 'database') resourceFailure = true;
  if (failure === 'conflict') referenceConflict = true;
  const response = await replace(old._id); assert.equal(response.status, failure === 'upload' ? 503 : failure === 'conflict' ? 409 : 500);
  assert.equal(resources.get(old._id).referenceAudioPath, old.referenceAudioPath);
  assert.ok(client.objects.has(old.referenceAudioPath)); client.state.fail = ''; await drainRecovery();
  assert.equal(client.objects.size, 1); assert.deepEqual(scratchFiles(), []);
});

test('resource deletion with unavailable R2 retains intent, later retry deletes the object', async () => {
  const resource = (await createResource()).body.resource; client.state.fail = 'DeleteObjectCommand';
  assert.equal((await request('/api/admin/resources/' + resource._id, { method: 'DELETE' })).status, 200);
  assert.equal(resources.size, 0); assert.ok(client.objects.has(resource.referenceAudioPath)); assert.equal(jobs.rows.size, 1);
  client.state.fail = ''; await drainRecovery(); assert.equal(client.objects.size, 0);
});

test('resource deletion journal failure leaves both resource and object unchanged', async () => {
  const resource = (await createResource()).body.resource; jobs.state.failWrite = true;
  assert.equal((await request('/api/admin/resources/' + resource._id, { method: 'DELETE' })).status, 503);
  assert.equal(resources.size, 1); assert.ok(client.objects.has(resource.referenceAudioPath));
});

test('resource deletion refuses a concurrent replacement rather than orphaning its new object', async () => {
  const resource = (await createResource()).body.resource; referenceConflict = true;
  assert.equal((await request('/api/admin/resources/' + resource._id, { method: 'DELETE' })).status, 409);
  assert.equal(resources.size, 1); await drainRecovery(); assert.ok(client.objects.has(resource.referenceAudioPath));
});

test('retention removes old R2 audio, clears key, timestamps deletion and is repeatable', async () => {
  await upload(); const session = [...sessions.values()][0]; session.createdAt = new Date(0);
  assert.equal(await purgeExpiredRecordings(), 1);
  const saved = sessions.get(String(session._id)); assert.equal(saved.audioPath, null); assert.ok(saved.audioDeletedAt);
  assert.equal(client.objects.size, 0); assert.equal(await purgeExpiredRecordings(), 0);
});

test('retention tolerates missing object; temporary delete failure retains session key', async () => {
  await upload(); const session = [...sessions.values()][0]; session.createdAt = new Date(0);
  client.state.fail = 'DeleteObjectCommand'; assert.equal(await purgeExpiredRecordings(), 0);
  assert.equal(sessions.get(String(session._id)).audioPath, session.audioPath);
  client.state.fail = ''; client.objects.clear(); assert.equal(await purgeExpiredRecordings(), 1);
});

test('account deletion records durable cleanup before removing sessions; cloud retry is safe', async () => {
  await upload(); client.state.fail = 'DeleteObjectCommand';
  const response = await request('/api/users/507f1f77bcf86cd799439022', { method: 'DELETE' });
  assert.equal(response.status, 200); assert.ok(deletedUser); assert.equal(sessions.size, 0);
  assert.equal(jobs.rows.size, 1); assert.equal(client.objects.size, 1);
  client.state.fail = ''; await drainRecovery(); assert.equal(client.objects.size, 0);
});

test('account deletion journal failure prevents data deletion', async () => {
  await upload(); jobs.state.failWrite = true;
  assert.equal((await request('/api/users/507f1f77bcf86cd799439022', { method: 'DELETE' })).status, 503);
  assert.equal(deletedUser, false); assert.equal(sessions.size, 1); assert.equal(client.objects.size, 1);
});

test('disguised reference upload rejected without transfer; missing resource cleans upload', async () => {
  const rejected = await request('/api/admin/resources', { method: 'POST', audio: Buffer.from('not audio'), audioField: 'referenceAudio', fields: { type: 'Script', title: 'Fixture', description: 'Fixture' } });
  assert.equal(rejected.status, 400); assert.equal(client.objects.size, 0);
  assert.equal((await replace('507f1f77bcf86cd799439099')).status, 404); assert.deepEqual(scratchFiles(), []);
});

for (const reference of [false, true]) test(`${reference ? 'reference' : 'recording'} oversized multipart is rejected before R2 transfer`, async () => {
  const response = await request(reference ? '/api/admin/resources' : '/api/upload-audio', {
    method: 'POST', audio: Buffer.alloc(25 * 1024 * 1024 + 1), audioField: reference ? 'referenceAudio' : 'audio',
    fields: reference ? { type: 'Script', title: 'Fixture', description: 'Fixture' } : {},
  });
  assert.equal(response.status, 400); assert.equal(client.calls.length, 0); assert.equal(pythonCalls, 0);
  assert.equal(sessions.size, 0); assert.equal(resources.size, 0); assert.deepEqual(scratchFiles(), []);
});

test('reference create DB failure retains recoverable object intent and removes scratch', async () => {
  resourceFailure = true; assert.equal((await createResource()).status, 500);
  assert.equal(resources.size, 0); assert.equal(jobs.rows.size, 1); assert.equal(client.objects.size, 1);
  await drainRecovery(); assert.equal(client.objects.size, 0); assert.deepEqual(scratchFiles(), []);
});

test('replacement old-object delete outage does not roll back the committed new reference', async () => {
  const old = (await createResource()).body.resource; client.state.fail = 'DeleteObjectCommand';
  const updated = await replace(old._id); assert.equal(updated.status, 200);
  assert.notEqual(updated.body.resource.referenceAudioPath, old.referenceAudioPath);
  assert.equal(client.objects.size, 2); assert.equal(jobs.rows.size, 1);
  client.state.fail = ''; await drainRecovery(); assert.equal(client.objects.size, 1);
  assert.ok(client.objects.has(updated.body.resource.referenceAudioPath));
});

test('retention DB save failure is retryable after the object was already removed', async () => {
  await upload(); const session = [...sessions.values()][0]; session.createdAt = new Date(0); sessionFailure = 'before';
  assert.equal(await purgeExpiredRecordings(), 0); assert.equal(client.objects.size, 0);
  assert.equal(sessions.get(String(session._id)).audioPath, session.audioPath);
  sessionFailure = ''; assert.equal(await purgeExpiredRecordings(), 1);
  assert.equal(sessions.get(String(session._id)).audioPath, null);
});

test('client disconnect during inference retains admission until work finishes and persists valid durable result', async () => {
  holdPython = true;
  const arrived = new Promise(resolve => { pythonArrived = resolve; });
  const abort = new AbortController();
  const body = new FormData(); body.append('audio', new Blob([wav()]), 'audio.wav');
  const pending = fetch(url + '/api/upload-audio', { method: 'POST', body,
    headers: { Authorization: 'Bearer ' + token() }, signal: abort.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await arrived; abort.abort(); await rejected;
  assert.equal((await upload()).status, 429); assert.equal(sessions.size, 0);
  releasePython();
  const deadline = Date.now() + 3000;
  while ((sessions.size !== 1 || scratchFiles().length) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(sessions.size, 1); assert.equal(client.objects.size, 1);
  assert.ok(client.objects.has([...sessions.values()][0].audioPath));
  assert.deepEqual(scratchFiles(), []);
});

test('Python timeout in R2 mode returns 504, cleans scratch and never uploads or saves', async () => {
  const previous = process.env.PYTHON_TIMEOUT_MS;
  process.env.PYTHON_TIMEOUT_MS = '50'; holdPython = true;
  try {
    const response = await upload(); assert.equal(response.status, 504);
    assert.match(response.body.message, /too long/i); assert.equal(sessions.size, 0);
    assert.equal(client.objects.size, 0); assert.deepEqual(scratchFiles(), []);
  } finally {
    releasePython?.();
    if (previous === undefined) delete process.env.PYTHON_TIMEOUT_MS;
    else process.env.PYTHON_TIMEOUT_MS = previous;
  }
});

test('two simultaneous reference replacements preserve only the winning committed object', async () => {
  const old = (await createResource()).body.resource;
  const original = Resource.findOneAndUpdate;
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  // Emulate Mongo's atomic conditional update after both PUTs reached the DB.
  Resource.findOneAndUpdate = async (filter, data) => {
    if (++arrivals === 2) release();
    await barrier;
    const current = resources.get(String(filter._id));
    if (!current || current.referenceAudioPath !== filter.referenceAudioPath) return null;
    const updated = clone(current); updated.set(data);
    const error = updated.validateSync(); if (error) throw error;
    resources.set(String(updated._id), clone(updated));
    return updated;
  };
  try {
    const outcomes = await Promise.all([replace(old._id), replace(old._id)]);
    assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
    const winner = outcomes.find(response => response.status === 200).body.resource;
    assert.equal(resources.get(old._id).referenceAudioPath, winner.referenceAudioPath);
    assert.equal(client.objects.size, 1); assert.ok(client.objects.has(winner.referenceAudioPath));
    assert.equal(client.objects.has(old.referenceAudioPath), false);
    await drainRecovery(); assert.equal(client.objects.size, 1);
    assert.deepEqual(scratchFiles(), []);
  } finally { Resource.findOneAndUpdate = original; }
});

test('retention retries an existing object after outage and second successful cleanup is a no-op', async () => {
  await upload(); const session = [...sessions.values()][0]; session.createdAt = new Date(0);
  const key = session.audioPath;
  client.state.fail = 'DeleteObjectCommand';
  assert.equal(await purgeExpiredRecordings(), 0);
  assert.ok(client.objects.has(key)); assert.equal(sessions.get(String(session._id)).audioPath, key);
  client.state.fail = '';
  assert.equal(await purgeExpiredRecordings(), 1);
  assert.equal(client.objects.has(key), false);
  assert.equal(sessions.get(String(session._id)).audioPath, null);
  const calls = client.calls.length;
  assert.equal(await purgeExpiredRecordings(), 0); assert.equal(client.calls.length, calls);
});
