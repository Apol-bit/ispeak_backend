const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readOnlyStartup } = require('../services/readOnlyStartup');
const prefix = `deployment-tests/${'a'.repeat(32)}/`;
const env = {
  NODE_ENV: 'production', REGISTRATION_MODE: 'closed', ISPEAK_READ_ONLY_STARTUP: 'true', ISPEAK_BACKGROUND_JOBS: 'disabled',
  ISPEAK_AUTHORIZED_TEST_DATABASE: 'ispeak_integration_fake',
  ISPEAK_AUTHORIZED_R2_TEST_PREFIX: prefix, R2_TEST_PREFIX: prefix,
  MONGO_URI: 'mongodb+srv://ispeak_integration:fake@cluster.example.mongodb.net/ispeak_integration_fake?tls=true',
  STORAGE_DRIVER: 'r2', R2_BUCKET: 'ispeak-prod-audio', R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_ACCESS_KEY_ID: 'fake', R2_SECRET_ACCESS_KEY: 'fake',
  JWT_SECRET: 'fictional-readonly-test-secret-at-least-32-characters',
  PYTHON_SERVICE_TOKEN: 'fictional-readonly-test-token-at-least-32-characters',
  PYTHON_BACKEND_URL: 'http://python:8000', CORS_ORIGINS: 'https://localhost', PORT: '0',
};

test('read-only activation is explicit and rejects unsafe or incompatible configuration', () => {
  assert.equal(readOnlyStartup({}), false);
  assert.equal(readOnlyStartup(env), true);
  for (const change of [
    { ISPEAK_READ_ONLY_STARTUP: 'TRUE' }, { ISPEAK_READ_ONLY_STARTUP: '' },
    { ISPEAK_READ_ONLY_STARTUP: 'false' }, { NODE_ENV: 'development' },
    { ISPEAK_BACKGROUND_JOBS: 'enabled' }, { ISPEAK_BACKGROUND_JOBS: undefined },
    { ISPEAK_AUTHORIZED_TEST_DATABASE: 'ispeak_prod' },
    { MONGO_URI: env.MONGO_URI.replace('ispeak_integration_fake', 'ispeak_prod') },
    { MONGO_URI: env.MONGO_URI.replace('tls=true', 'tlsAllowInvalidCertificates=true') },
    { MONGO_URI: env.MONGO_URI.replace('ispeak_integration:', 'admin:') },
    { R2_TEST_PREFIX: 'deployment-tests/' },
    { ISPEAK_AUTHORIZED_R2_TEST_PREFIX: `deployment-tests/${'b'.repeat(32)}/` },
    { STORAGE_DRIVER: 'local' }, { R2_BUCKET: 'other-bucket' },
  ]) assert.throws(() => readOnlyStartup({ ...env, ...change }));
});

for (const readonly of [true, false]) {
  test(`${readonly ? 'read-only' : 'normal'} startup preserves expected initialization and health`, () => {
    const code = `
      const assert=require('node:assert/strict'),mongoose=require('mongoose');
      let connects=0,init=0,retention=0,cleanup=0,writes=0,options;
      const mock=(name,exports)=>{const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};};
      mock('./services/retentionService',{startRetentionSchedule(){retention++;return null;}});
      mock('./services/audioStorageService',{audioStorage:{startCleanupSchedule(){cleanup++;return null;}}});
      mongoose.connect=async(uri,o)=>{connects++;options=o;mongoose.connection._readyState=1;};
      mongoose.disconnect=async()=>{mongoose.connection._readyState=0;};
      const {app,startServer,shutdown}=require('./server');
      const Model=require('./models/StorageCleanup');Model.init=async()=>{init++;};
      for(const name of ['createCollection','createIndexes','insertOne','updateOne','deleteOne']){
        mongoose.Collection.prototype[name]=()=>{writes++;throw Error('external write forbidden');};
      }
      (async()=>{let server;try{
        server=await startServer();assert.equal(connects,1);
        assert.equal(init,${readonly ? 0 : 1});assert.equal(retention,${readonly ? 0 : 1});assert.equal(cleanup,${readonly ? 0 : 1});
        ${readonly ? "assert.deepEqual(options,{autoCreate:false,autoIndex:false});assert.equal(mongoose.get('autoCreate'),false);assert.equal(mongoose.get('autoIndex'),false);" : 'assert.equal(options,undefined);'}
        const url='http://127.0.0.1:'+server.address().port;
        assert.equal((await fetch(url+'/health')).status,200);
        mongoose.connection._readyState=0;assert.equal((await fetch(url+'/health')).status,503);
        mongoose.connection._readyState=1;
        assert.equal((await fetch(url+'/health',{headers:{Origin:'https://evil.invalid'}})).status,403);
        ${readonly ? `
          for(const method of ['GET','POST','PUT','DELETE'])assert.equal((await fetch(url+'/api/signup',{method})).status,503);
          const {storage}=require('./services/storageService');let sdk=0;storage.client={send(){sdk++;throw Error('SDK forbidden')}};
          const key=storage.createKey('fixture.wav',{ownerId:'507f1f77bcf86cd799439011'});
          await assert.rejects(storage.storeFile('nonexistent.wav',{key}));await assert.rejects(storage.delete(key));assert.equal(sdk,0);
        ` : "assert.equal((await fetch(url+'/api/auth/me')).status,401);"}
        assert.equal(writes,0);
      }finally{await shutdown('test');const s=require('./services/storageService').storage;require('fs').rmSync(s.tempRoot,{recursive:true,force:true});}})().catch(()=>{process.exitCode=1;});
    `;
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ...env, ISPEAK_READ_ONLY_STARTUP: String(readonly), ISPEAK_BACKGROUND_JOBS: readonly ? 'disabled' : 'enabled' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('direct background-worker and journal entry points cannot write in read-only mode', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');require('./server');
    const retention=require('./services/retentionService');
    const {createAudioStorage}=require('./services/audioStorageService');
    let operations=0;
    const forbidden=()=>{operations++;throw Error('external operation forbidden');};
    const lifecycle=createAudioStorage({provider:{driver:'r2',namespace:'test',assertKey:forbidden,delete:forbidden,createKey:forbidden},
      jobs:{find:forbidden,updateOne:forbidden,deleteOne:forbidden},isReferenced:forbidden});
    (async()=>{
      assert.equal(retention.startRetentionSchedule(),null);
      assert.equal(await retention.purgeExpiredRecordings(),0);
      assert.equal(lifecycle.startCleanupSchedule(),null);await lifecycle.retryCleanup();
      await assert.rejects(lifecycle.prepareRemoval('key'));await assert.rejects(lifecycle.committed('key'));
      await assert.rejects(lifecycle.removeIfUnreferenced('key'));await assert.rejects(lifecycle.storeUpload({},{}));
      assert.equal(operations,0);
      const storage=require('./services/storageService').storage;require('fs').rmSync(storage.tempRoot,{recursive:true,force:true});
    })().catch(()=>{process.exitCode=1;});
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
