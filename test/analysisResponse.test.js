const test = require('node:test');
const assert = require('node:assert/strict');
const {mapAiError, usableAnalysis, analysisFeedback} = require('../services/analysisResponse');
test('AI error mapping preserves safe validation, unavailable, timeout and failure distinctions', () => {
  for (const [error,status] of [
    [{response:{status:400,data:{detail:'secret /server/path traceback'}}},400],
    [{response:{status:422}},422],[{response:{status:413}},413],
    [{code:'ECONNREFUSED'},503],[{response:{status:503}},503],
    [{code:'ECONNABORTED'},504],[{code:'ETIMEDOUT'},504],[{response:{status:504}},504],
    [{response:{status:500,data:{detail:'secret'}}},502],[{code:'UNKNOWN'},502],
  ]) {
    const result=mapAiError(error);assert.equal(result.status,status);
    assert.ok(!result.message.includes('secret'));assert.ok(!result.message.includes('/server/path'));
  }
  assert.match(mapAiError({response:{status:400,data:{detail:{code:'recording_too_short'}}}}).message,/too short/);
});
function valid() {return {analysis_valid:true,transcription:'Good morning everyone',duration_seconds:2,pacing:{wpm:90},scores:{overall:80,pacing:75,clarity:80,energy:85},articulation:{score:80,accurate_pronunciation:{available:false}},fillers:{analysis_available:true,count:0,rate:0},vocal_variety:{frequency_pitch:{analysis_available:false},signal_intensity:{loudness_status:'Too loud (shouting)'},temporal_pauses:{}}};}
test('unusable upstream successes cannot be saved as completed sessions',()=>{
 assert.equal(usableAnalysis(valid()),true);
 for(const invalid of [{...valid(),analysis_valid:false},{...valid(),transcription:''},{...valid(),pacing:{wpm:0}},{...valid(),scores:{overall:NaN}}])assert.equal(usableAnalysis(invalid),false);
});
test('feedback respects unavailable pitch and actual high volume, without perfect clarity claims',()=>{
 const r=analysisFeedback(valid());assert.equal(r.availability.pitch,false);
 assert.match(r.feedback.energy,/level is high/);assert.match(r.feedback.energy,/partial estimate/);
 assert.doesNotMatch(r.feedback.energy,/speak louder|Great/);assert.doesNotMatch(r.feedback.clarity,/Perfect/);
 assert.match(r.feedback.clarity,/Pronunciation confidence was unavailable/);
});
test('reference pace and missing fillers use the actual assessment basis',()=>{
 const a=valid();a.speaking_rate={reference_wpm:90};a.scores.pacing=100;a.fillers.analysis_available=false;
 const r=analysisFeedback(a);assert.match(r.feedback.pace,/close to the reference/);assert.match(r.feedback.clarity,/articulation evidence only/);
});
