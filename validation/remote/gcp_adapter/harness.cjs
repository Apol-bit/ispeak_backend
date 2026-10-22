'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const appRequire=createRequire('/app/package.json');
const checks=[
 'Node v24.22.1, non-root user, readable 0444 adapter mount',
 'real --require loading and all eight image-file hash guards',
 'proposed sh/entrypoint/node/--require/server command; HTTP health on 8080 (mock database)',
 'IAM header + iSpeak header + multipart preservation; token cache (mock metadata/transport)',
 'both startup cleanup schedules suppressed; zero DB queries/R2 calls',
 'graceful server shutdown'
];
let phase=checks[0];
const completed=new Set();
function pass(label){completed.add(label);console.log('PASS: '+label);}
const categories=new Set(['Error','TypeError','ReferenceError','SyntaxError','AssertionError','RangeError','MongooseError']);
const codes=new Set(['ERR_ASSERTION','EADDRINUSE','EACCES','ENOENT','ECONNREFUSED','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND']);
function fail(error,origin='caught'){
 console.error('FAIL: '+phase+'; event='+origin);
 console.error('DIAGNOSTIC: '+JSON.stringify({
   category:categories.has(error?.name)?error.name:'Error',
   code:codes.has(error?.code)?error.code:undefined,
   guard:['cleanup-timer','startup-timeout','db-operation','r2-operation','cleanup-job'].includes(error?.verificationGuard)?error.verificationGuard:undefined
 }));
 // Only static source file locations. Never print error messages, values or raw stacks.
 const frames=String(error?.stack||'').split('\n').slice(1);
 for(const line of frames.slice(0,6)){
   const match=line.match(/((?:\/app\/|\/verification\/|\/etc\/ispeak-runtime\/|node:)[A-Za-z0-9_@./:-]+:\d+:\d+)/);
   if(match)console.error('FRAME: '+match[1]);
 }
 for(const label of checks)if(!completed.has(label)&&label!==phase)console.log('NOT TESTED: '+label);
 console.log('NOT TESTED: real Google IAM acceptance, real integrations, actual Secret Manager delivery');
 process.exit(1);
}
process.on('unhandledRejection',error=>fail(error,'unhandledRejection'));
process.on('uncaughtException',(error,origin)=>fail(error,origin));
function blocked(guard){const error=new Error('Verification guard');error.verificationGuard=guard;return error;}
console.log('STAGE: '+(process.argv[1]==='/app/docker/validateConfiguration.js'?'entrypoint validator':'runtime'));
assert.equal(process.version,'v24.22.1');
assert.equal(process.getuid(),1000);
assert.equal(fs.statSync('/etc/ispeak-runtime/preload.cjs').mode & 0o777,0o444);
const mongoose=appRequire('mongoose');
mongoose.set('autoCreate',false);
mongoose.set('autoIndex',false);
const flags=new Set();
const originalSet=mongoose.set.bind(mongoose);
mongoose.set=function(k,v){if(v===false)flags.add(k);return originalSet(...arguments);};
let connects=0,queries=0,r2=0,trips=0,metadata=0,dispatches=0;
mongoose.connect=async()=>{connects++;mongoose.connection._readyState=1;return mongoose;};
mongoose.disconnect=async()=>{mongoose.connection._readyState=0;};
mongoose.Query.prototype.exec=async()=>{queries++;throw blocked('db-operation');};
const storage=appRequire('./services/storageService').storage;
storage.client.send=async()=>{r2++;throw blocked('r2-operation');};
const retention=appRequire('./services/retentionService');
const audio=appRequire('./services/audioStorageService').audioStorage;
const trap=()=>{trips++;throw blocked('cleanup-job');};
retention.startRetentionSchedule=trap;
retention.purgeExpiredRecordings=trap;
audio.startCleanupSchedule=trap;
audio.retryCleanup=trap;
appRequire('./models/StorageCleanup').init=async()=>{
  assert.equal(mongoose.get('autoCreate'),false);
  assert.equal(mongoose.get('autoIndex'),false);
};
// The validation subprocess receives the same isolation, but not the adapter.
if(process.argv[1]==='/app/docker/validateConfiguration.js'){
  process.on('exit',code=>{if(code===0)pass('original entrypoint configuration validator (synthetic values)');});
}else{
  assert.equal(process.argv[1],'/app/server.js');
  pass('Node v24.22.1, non-root user, readable 0444 adapter mount');
  phase='adapter preload and application module initialization';
  const target=process.env.PYTHON_BACKEND_URL;
  const jwt='synthetic.'+Buffer.from(JSON.stringify({aud:target,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature';
  global.fetch=async(url,options)=>{
    metadata++;
    const u=new URL(url);
    assert.equal(u.origin,'http://metadata.google.internal');
    assert.equal(u.pathname,'/computeMetadata/v1/instance/service-accounts/default/identity');
    assert.equal(u.searchParams.get('audience'),target);
    assert.equal(u.searchParams.get('format'),'full');
    assert.equal(options.headers['Metadata-Flavor'],'Google');
    assert.equal(options.redirect,'error');
    return {ok:true,text:async()=>jwt};
  };
  const axios=appRequire('axios');
  axios.defaults.adapter=async config=>{
    dispatches++;
    assert.equal(config.url,target+'/transcribe');
    assert.equal(config.headers.get('X-iSpeak-Service-Token'),process.env.PYTHON_SERVICE_TOKEN);
    assert.equal(config.headers.get('X-Serverless-Authorization'),'Bearer '+jwt);
    assert.match(config.headers.get('Content-Type'),/^multipart\/form-data; boundary=/);
    assert.equal(config.maxRedirects,0);
    return {status:200,statusText:'OK',config,headers:{},data:{synthetic:true}};
  };
  // Block timers by their audio-cleanup source, not by duration.
  // middleware/rateLimit.js legitimately schedules a 60-second in-memory timer.
  const interval=global.setInterval;
  global.setInterval=(fn,delay,...args)=>{
    const stack=String(new Error().stack||'');
    if(/[/\\]services[/\\](?:retentionService|audioStorageService)\.js:\d+:\d+/.test(stack)){
      trips++;throw blocked('cleanup-timer');
    }
    return interval(fn,delay,...args);
  };
  const watchdog=setTimeout(()=>fail(blocked('startup-timeout'),'watchdog'),15000);
  setImmediate(async()=>{
    try{
      phase=checks[1];
      const adapter=require('/etc/ispeak-runtime/preload.cjs');
      adapter.verifyFiles();
      assert.equal(Object.keys(adapter.EXPECTED).length,8);
      assert(flags.has('autoCreate')&&flags.has('autoIndex'));
      assert.notEqual(retention.startRetentionSchedule,trap);
      assert.notEqual(audio.startCleanupSchedule,trap);
      assert.equal(retention.startRetentionSchedule(),null);
      assert.equal(audio.startCleanupSchedule(),null);
      pass('real --require loading and all eight image-file hash guards');
      phase=checks[2];
      const http=require('node:http');
      let healthy=false;
      for(let i=0;i<50&&!healthy;i++){
        healthy=await new Promise(resolve=>{
          const req=http.get('http://127.0.0.1:8080/health',res=>{res.resume();resolve(res.statusCode===200);});
          req.on('error',()=>resolve(false));req.setTimeout(500,()=>req.destroy());
        });
        if(!healthy)await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert(healthy);assert.equal(connects,1);
      pass('proposed sh/entrypoint/node/--require/server command; HTTP health on 8080 (mock database)');
      phase=checks[3];
      for(let i=0;i<2;i++)await axios.post(target+'/transcribe',Buffer.from('synthetic multipart body'),{
        headers:{'Content-Type':'multipart/form-data; boundary=verification','X-iSpeak-Service-Token':process.env.PYTHON_SERVICE_TOKEN}
      });
      assert.equal(dispatches,2);assert.equal(metadata,1);
      pass('IAM header + iSpeak header + multipart preservation; token cache (mock metadata/transport)');
      phase=checks[4];
      assert.equal(trips,0);assert.equal(queries,0);assert.equal(r2,0);
      pass('both startup cleanup schedules suppressed; zero DB queries/R2 calls');
      console.log('NOT TESTED: real Google IAM acceptance, real integrations, actual Secret Manager delivery');
      phase=checks[5];
      await appRequire('./server.js').shutdown('Offline verification complete');
      clearTimeout(watchdog);
      console.log('PASS: graceful server shutdown');
      console.log('OVERALL PASS: exact-container adapter compatibility with mocked external dependencies');
      process.exit(0);
    }catch(error){fail(error,'verification');}
  });
}
