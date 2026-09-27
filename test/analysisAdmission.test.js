const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAnalysisAdmission } = require('../middleware/analysisAdmission');

function request(userId = 'user') {
  const req = { auth: { userId } };
  const res = new EventEmitter();
  res.headers = {};
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.status = (value) => { res.statusCode = value; return res; };
  res.json = (value) => { res.body = value; return res; };
  return {req, res};
}

test('duplicates cannot enter, other users can, and disconnect retains running slot', () => {
  const middleware = createAnalysisAdmission();
  const first = request(); let entered = 0;
  middleware(first.req, first.res, () => entered++);
  first.req.analysisStarted = true;
  first.res.emit('close');
  const duplicate = request();
  middleware(duplicate.req, duplicate.res, () => entered++);
  assert.equal(duplicate.res.statusCode, 429);
  const other = request('other');
  middleware(other.req, other.res, () => entered++);
  assert.equal(entered, 2);
  first.req.releaseAnalysis(); first.req.releaseAnalysis();
  const retry = request(); middleware(retry.req, retry.res, () => entered++);
  assert.equal(entered, 3);
});

test('submission rate is per user and advertises retry delay', () => {
  process.env.ANALYSIS_RATE_LIMIT_MAX = '2';
  const middleware = createAnalysisAdmission();
  delete process.env.ANALYSIS_RATE_LIMIT_MAX;
  for (let i = 0; i < 2; i++) {
    const {req, res} = request(); middleware(req, res, () => {}); res.emit('finish');
  }
  const limited = request(); middleware(limited.req, limited.res, () => assert.fail());
  assert.equal(limited.res.statusCode, 429);
  assert.ok(Number(limited.res.headers['Retry-After']) > 0);
  const other = request('other');
  middleware(other.req, other.res, () => {});
  assert.equal(other.res.statusCode, undefined);
});
