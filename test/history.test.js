const test = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../models/SpeechSession');
const controller = require('../controllers/sessionController');
const id = '507f1f77bcf86cd799439011';
function response() {
  return { headers: {}, status(n) { this.statusCode = n; return this; },
    set(k,v) { this.headers[k] = v; return this; }, json(body) { this.body = body; return this; } };
}

test('history is bounded, retains array contract, and exposes an exclusive cursor', async () => {
  const original = {find:Session.find,count:Session.countDocuments};
  const rows = [3,2,1].map(n=>({_id:`507f1f77bcf86cd79943901${n}`,createdAt:new Date('2026-09-26')}));
  let filter; let limit;
  Session.find = (f) => { filter=f;return {select(){return this;},sort(){return this;},limit(n){limit=n;return this;},populate(){return this;},async lean(){return [...rows];}}; };
  Session.countDocuments = async()=>45;
  try {
    const res=response(); await controller.getUserHistory({params:{userId:id},query:{limit:'2'}},res);
    assert.equal(limit,3);assert.equal(res.statusCode,200);assert.equal(res.body.length,2);
    assert.equal(res.headers['X-Total-Count'],'45');
    const cursor=res.headers['X-Next-Cursor'];assert.ok(cursor);
    await controller.getUserHistory({params:{userId:id},query:{limit:'2',before:cursor}},response());
    assert.ok(filter.$or[0].createdAt.$lt instanceof Date);
    assert.equal(filter.$or[1]._id.$lt.toString(),rows[1]._id);
    const bad=response();await controller.getUserHistory({params:{userId:id},query:{limit:'1000'}},bad);
    assert.equal(bad.statusCode,400);
  } finally {Session.find=original.find;Session.countDocuments=original.count;}
});

test('compact statistics keep all dates and scores; summary skips session rows', async () => {
  const original={find:Session.find,aggregate:Session.aggregate};let fields;let finds=0;
  Session.find=()=>{finds++;return {sort(){return this;},select(f){fields=f;return this;},async lean(){return [{createdAt:'old-date'},{createdAt:'new-date'}];}};};
  Session.aggregate=async()=>[{attempts:[{totalSessions:200}],eligible:[{eligibleScoredSessions:2,avgScore:75}]}];
  try {
    const compact=response();await controller.getUserStats({params:{userId:id},query:{view:'compact'}},compact);
    assert.equal(compact.body.sessions.length,2);assert.equal(compact.body.overallStats.totalSessions,200);
    assert.match(fields,/createdAt/);assert.match(fields,/practiceMode/);assert.doesNotMatch(fields,/transcription|wordTimestamps/);
    const summary=response();await controller.getUserStats({params:{userId:id},query:{view:'summary'}},summary);
    assert.equal(finds,1);assert.deepEqual(summary.body.sessions,[]);assert.equal(summary.body.overallStats.avgScore,75);
  } finally {Session.find=original.find;Session.aggregate=original.aggregate;}
});
