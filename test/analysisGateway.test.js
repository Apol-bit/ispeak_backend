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
User.findById = () => ({select: async () => ({_id:id,role:'user',status:'Active',isArchived:false})});
User.exists = async () => ({_id:id});
SpeechSession.prototype.save = async function() {saves++; return this;};
const token = jwt.sign({userId:id}, process.env.JWT_SECRET, {algorithm:'HS256',issuer:'ispeak-api',audience:'ispeak-clients',expiresIn:'1h'});
let ai, gateway, url, mode;
async function listen(server) { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; }
test.before(async()=>{
 ai=http.createServer((request,response)=>{
  request.resume();request.on('end',()=>{
   if(mode==='connection'){request.socket.destroy();return;}
   if(mode==='timeout'){return;}
   const status=mode==='unusable'?200:Number(mode);
   response.writeHead(status,{'Content-Type':'application/json'});
   response.end(JSON.stringify(mode==='unusable'?{analysis_valid:false,transcription:''}:{detail:{code:'recording_too_short',message:'secret /private/path'}}));
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
