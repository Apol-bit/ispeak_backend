const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-gateway-test-'));
process.env.LOCAL_STORAGE_ROOT = root;
process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.PYTHON_TIMEOUT_MS = '100';
const User = require('../models/User');
const SpeechSession = require('../models/SpeechSession');
const {app} = require('../server');
const id = '507f1f77bcf86cd799439011';
let saves = 0;
let databaseFailure = false;
User.findById = () => ({select: async () => ({_id:id,role:'user',status:'Active',isArchived:false})});
User.exists = async () => ({_id:id});
SpeechSession.prototype.save = async function() {if(databaseFailure) throw new Error('database offline'); saves++; return this;};
const token = jwt.sign({userId:id}, process.env.JWT_SECRET, {algorithm:'HS256',issuer:'ispeak-api',audience:'ispeak-clients',expiresIn:'1h'});
let ai, gateway, url, mode, serviceHeader;
async function listen(server) { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; }
test.before(async()=>{
 ai=http.createServer((request,response)=>{
  serviceHeader = request.headers['x-ispeak-service-token'];
  request.resume();request.on('end',()=>{
   if(mode==='connection'){request.socket.destroy();return;}
   if(mode==='timeout'){return;}
   const status=mode==='unusable'?200:Number(mode);
   response.writeHead(status,{'Content-Type':'application/json'});
   response.end(JSON.stringify(mode==='unusable'?{analysis_valid:false,transcription:''}:mode==='200'?{analysis_valid:true,transcription:'This is valid speech.',duration_seconds:10,pacing:{wpm:130},scores:{overall:80,pacing:80,clarity:80,energy:80},fillers:{analysis_available:true,count:0}}:{detail:{code:'recording_too_short',message:'secret /private/path'}}));
  });
 });
 process.env.PYTHON_BACKEND_URL=await listen(ai);
 gateway=http.createServer(app);url=await listen(gateway);
});
test.after(async()=>{
 gateway.closeAllConnections();ai.closeAllConnections();
 await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>ai.close(r))]);
 fs.rmSync(root,{recursive:true,force:true});
});
for(const [scenario,status] of [['400',400],['500',502],['503',503],['connection',503],['timeout',504],['unusable',502]]) {
 test(`gateway ${scenario}: safe status, file cleanup, no session save`,async()=>{
  mode=scenario;const form=new FormData();form.append('audio',new Blob([Buffer.from('test upload')]),'test.wav');form.append('language','English');
  const response=await fetch(url+'/api/upload-audio',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});
  const body=await response.json();assert.equal(response.status,status);assert.equal(typeof body.message,'string');assert.doesNotMatch(body.message,/secret|private/);assert.equal(saves,0);
  assert.deepEqual(fs.readdirSync(root).filter(name=>name!=='reference_audio'),[]);
 });
}

test('successful analysis preserves result contract and stores one session',async()=>{
 mode='200'; const form=new FormData();form.append('audio',new Blob(['speech']),'test.wav');
 const response=await fetch(url+'/api/upload-audio',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.userId,id);assert.equal(body.audioPath,undefined);assert.equal(saves,1);
 for(const name of fs.readdirSync(root)) if(name!=='reference_audio') fs.unlinkSync(path.join(root,name));
});
test('session database save failure returns 500, cleans audio, and retains authentication',async()=>{
 mode='200';databaseFailure=true;
 try {
  const form=new FormData();form.append('audio',new Blob(['speech']),'test.wav');
  const response=await fetch(url+'/api/upload-audio',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});
  assert.equal(response.status,500);assert.equal(saves,1);
  assert.deepEqual(fs.readdirSync(root).filter(name=>name!=='reference_audio'),[]);
  assert.equal((await fetch(url+'/api/auth/me',{headers:{Authorization:'Bearer '+token}})).status,200);
 } finally {databaseFailure=false;}
});

test('Node forwards only configured private service token to Python', async()=>{
 process.env.PYTHON_SERVICE_TOKEN='gateway-test-only-service-token-not-a-real-secret'; mode='200';
 try {
  const form=new FormData();form.append('audio',new Blob(['speech']),'test.wav');
  const response=await fetch(url+'/api/upload-audio',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});
  assert.equal(response.status,200);
  assert.equal(serviceHeader,process.env.PYTHON_SERVICE_TOKEN);
  assert.doesNotMatch(await response.text(), /gateway-test-only-service-token/);
 } finally {delete process.env.PYTHON_SERVICE_TOKEN;}
});
