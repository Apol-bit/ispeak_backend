const test = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../models/SpeechSession');
const User = require('../models/User');
const controller = require('../controllers/sessionController');
const { eligibleAssessmentFilter, statisticsPipeline, summarizeStatistics } = require('../services/performanceStatistics');
const id = '507f1f77bcf86cd799439011';
const valid = (score = 80, language = 'English') => ({ userId: id, status: 'Completed',
  transcription: language === 'English' ? 'Hello everyone' : 'Magandang araw', language,
  overallScore: score, paceScore: score, clarityScore: score, energyScore: score, createdAt: new Date() });
const valueAt = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
// Small deterministic Mongo query/aggregation harness; no database connection.
function matches(row, filter) {
  return Object.entries(filter).every(([key, rule]) => {
    if (key === '$expr') return rule.$and.every(condition => {
      if (condition.$isNumber) return typeof valueAt(row, condition.$isNumber.slice(1)) === 'number';
      const [expression, expected] = condition.$eq;
      return typeof valueAt(row, expression.$type.slice(1)) === expected;
    });
    const value = valueAt(row, key);
    if (!rule || typeof rule !== 'object' || rule._bsontype) return String(value) === String(rule);
    return Object.entries(rule).every(([op, expected]) => {
      if (op === '$type') return expected === 'number' ? typeof value === 'number' : typeof value === expected;
      if (op === '$regex') return typeof value === 'string' && expected.test(value);
      if (op === '$not') return typeof value !== 'string' || !expected.test(value);
      if (op === '$ne') return value !== expected;
      if (op === '$nin') return !expected.includes(value);
      if (op === '$gte') return value >= expected;
      if (op === '$lte') return value <= expected;
      throw new Error(`Unsupported query operator ${op}`);
    });
  });
}
function evaluate(rows, pipeline) {
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
    else if (stage.$facet) rows = [Object.fromEntries(Object.entries(stage.$facet).map(([key, steps]) => [key, evaluate(rows, steps)]))];
    else if (stage.$group) {
      if (!rows.length) return [];
      const group = { _id: null };
      for (const [key, accumulator] of Object.entries(stage.$group)) {
        if (key === '_id') continue;
        if (accumulator.$avg) group[key] = rows.reduce((sum, row) => sum + valueAt(row, accumulator.$avg.slice(1)), 0) / rows.length;
        else if (accumulator.$sum === 1) group[key] = rows.length;
        else {
          const [field, value] = accumulator.$sum.$cond[0].$eq;
          group[key] = rows.filter(row => valueAt(row, field.slice(1)) === value).length;
        }
      }
      rows = [group];
    }
  }
  return rows;
}

test('eligibility accepts legacy, partial and zero scores; rejects unusable records', () => {
  const filter = eligibleAssessmentFilter();
  for (const row of [valid(), valid(0, 'Filipino'), valid(60, 'Taglish'),
    { ...valid(), assessmentDetails: { completeness: 'partial', availability: { pronunciation: false } } },
    { ...valid(), analysisValid: true, assessmentDetails: { version: 1, completeness: 'complete' } }]) assert.ok(matches(row, filter));
  for (const change of [{ status: 'Pending' }, { status: 'Failed' }, { transcription: undefined }, { transcription: null },
    { transcription: '' }, { transcription: ' \n ' }, { transcription: ' NO TRANSCRIPTION AVAILABLE. ' },
    { transcription: 'No transcription available' }, { overallScore: undefined }, { paceScore: null },
    { transcription: ['hello'] }, { status: ['Completed'] }, { overallScore: [80] },
    { clarityScore: '80' }, { energyScore: NaN }, { overallScore: Infinity }, { paceScore: -1 },
    { clarityScore: 101 }, { analysisValid: false }, { assessmentDetails: { usable: false } },
    { assessmentDetails: { analysisValid: false } }, { assessmentDetails: { completeness: 'unusable' } }]) {
    assert.equal(matches({ ...valid(), ...change }, filter), false, JSON.stringify(change));
  }
});

test('mixed-language aggregation keeps attempt counts but excludes invalid scores from averages', () => {
  const rows = [valid(0), valid(60, 'Filipino'), valid(90, 'Taglish'),
    { ...valid(100), transcription: 'No transcription available.' }, { ...valid(100), analysisValid: false },
    { ...valid(100), status: 'Failed' }];
  const summary = summarizeStatistics(evaluate(rows, statisticsPipeline())[0]);
  assert.deepEqual(summary, { totalSessions: 6, eligibleScoredSessions: 3, completedSessions: 5, failedSessions: 1,
    excludedSessions: 3, avgScore: 50, avgPace: 50, avgClarity: 50, avgEnergy: 50 });
  for (const count of [9, 10, 11]) {
    const data = [...Array.from({ length: count }, () => valid(80)), ...rows.slice(3)];
    const result = summarizeStatistics(evaluate(data, statisticsPipeline())[0]);
    assert.equal(result.eligibleScoredSessions, count); assert.equal(result.avgScore, 80);
  }
  for (const data of [[], rows.slice(3)]) {
    const result = summarizeStatistics(evaluate(data, statisticsPipeline())[0]);
    assert.equal(result.eligibleScoredSessions, 0); assert.equal(result.avgScore, null);
  }
});

test('user compact/summary/default and admin endpoints share eligibility; history stays separate', async () => {
  const originals = { find: Session.find, aggregate: Session.aggregate, count: User.countDocuments };
  const rows = [valid(60), valid(80, 'Filipino'), valid(100, 'Taglish'), { ...valid(), transcription: 'No transcription available.' }];
  Session.find = filter => ({ sort() { return this; }, select() { return this; }, populate() { return this; },
    async lean() { return rows.filter(row => matches(row, filter)); } });
  Session.aggregate = async pipeline => evaluate(rows, pipeline);
  User.countDocuments = async () => 1;
  const response = () => ({ status() { return this; }, json(body) { this.body = body; } });
  try {
    for (const view of ['compact', 'summary', undefined]) {
      const res = response(); await controller.getUserStats({ params: { userId: id }, query: { view } }, res);
      assert.equal(res.body.statisticsVersion, 1); assert.equal(res.body.overallStats.totalSessions, 4);
      assert.equal(res.body.overallStats.eligibleScoredSessions, 3); assert.equal(res.body.overallStats.avgScore, 80);
      assert.equal(res.body.sessions.length, view === 'summary' ? 0 : 3);
    }
    const admin = response(); await controller.getAdminGlobalStats({}, admin);
    assert.equal(admin.body.totalSessions, 4); assert.equal(admin.body.eligibleScoredSessions, 3);
    assert.equal(admin.body.avgAppScore, 80); assert.equal(admin.body.avgScoreAvailable, true);
    rows.length = 0;
    const empty = response(); await controller.getAdminGlobalStats({}, empty);
    assert.equal(empty.body.totalSessions, 0); assert.equal(empty.body.eligibleScoredSessions, 0);
    assert.equal(empty.body.avgAppScore, 0); assert.equal(empty.body.avgScoreAvailable, false);
  } finally { Session.find = originals.find; Session.aggregate = originals.aggregate; User.countDocuments = originals.count; }
});
