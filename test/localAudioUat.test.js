const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { localAudioUat, storageRoot } = require('../services/localAudioUat');
const filesystem = {
  statSync: () => ({ isDirectory: () => true }),
  realpathSync: () => storageRoot,
  lstatSync: () => ({ isSymbolicLink: () => false }),
  readdirSync: () => [],
};
const env = {
  ISPEAK_LOCAL_AUDIO_UAT: 'true', NODE_ENV: 'development',
  MONGO_URI: 'mongodb://127.0.0.1:27017/ispeak_audio_uat',
  STORAGE_DRIVER: 'local', LOCAL_STORAGE_ROOT: storageRoot, PORT: '5001',
  PYTHON_BACKEND_URL: 'http://127.0.0.1:8000', RECORDING_RETENTION_DAYS: '0',
  JWT_SECRET: 'fictional-uat-jwt-secret-at-least-32-characters',
  PYTHON_SERVICE_TOKEN: 'fictional-uat-service-token-at-least-32-characters',
};

test('local UAT requires exact disposable DB, storage and service settings', () => {
  assert.equal(localAudioUat(env, filesystem), true);
  assert.equal(localAudioUat({}), false);
  assert.equal(localAudioUat({ NODE_ENV: 'production' }), false);
  for (const key of Object.keys(env)) {
    if (key === 'ISPEAK_LOCAL_AUDIO_UAT') continue;
    const missing = { ...env }; delete missing[key];
    assert.throws(() => localAudioUat(missing, filesystem), undefined, key);
  }
  for (const patch of [
    { ISPEAK_LOCAL_AUDIO_UAT: 'TRUE' }, { NODE_ENV: 'production' },
    { MONGO_URI: 'mongodb://127.0.0.1:27017/ispeak_db' },
    { MONGO_URI: 'mongodb+srv://example.invalid/ispeak_audio_uat' },
    { MONGO_URI: env.MONGO_URI + '?authSource=ispeak_db' },
    { STORAGE_DRIVER: 'r2' }, { LOCAL_STORAGE_ROOT: 'uploads' },
    { LOCAL_STORAGE_ROOT: require('node:path').dirname(storageRoot) },
    { PYTHON_BACKEND_URL: 'https://example.railway.app' },
    { PORT: '5000' }, { RECORDING_RETENTION_DAYS: '30' },
    { ISPEAK_READ_ONLY_STARTUP: 'true' },
  ]) assert.throws(() => localAudioUat({ ...env, ...patch }, filesystem));
});

test('missing, redirected and symlink storage fails before provider creation', () => {
  for (const patch of [
    { statSync() { throw Error('missing'); } },
    { statSync: () => ({ isDirectory: () => false }) },
    { realpathSync: () => 'historical/uploads' },
    { lstatSync: () => ({ isSymbolicLink: () => true }) },
    { readdirSync: () => [{ isSymbolicLink: () => true }] },
  ]) assert.throws(() => localAudioUat(env, { ...filesystem, ...patch }));
});

test('dedicated launcher cannot load historical .env as a fallback', () => {
  for (const flag of ['', 'false', 'true']) {
    const result = spawnSync(process.execPath, ['scripts/startLocalAudioUat.js'], {
      cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ISPEAK_LOCAL_AUDIO_UAT: flag, MONGO_URI: 'mongodb://127.0.0.1:27017/ispeak_db' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no service started/);
    assert.doesNotMatch(result.stdout, /dotenv|connected|listening/);
  }
});

for (const isolated of [true, false]) test(`mocked ${isolated ? 'isolated' : 'normal'} startup binding and retention`, () => {
  const code = `
    const assert=require('node:assert/strict');
    const mock=(name,exports)=>{const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};};
    mock('dotenv',{config(){if (${isolated}) throw Error('UAT must not load historical .env');}});
    const guard=require('./services/localAudioUat');
    mock('./services/localAudioUat',{...guard,localAudioUat:(e=process.env)=>guard.localAudioUat(e,{
      statSync:()=>({isDirectory:()=>true}),realpathSync:()=>guard.storageRoot,lstatSync:()=>({isSymbolicLink:()=>false}),readdirSync:()=>[]
    })});
    const mongoose=require('mongoose');let connected;
    mongoose.connect=async uri=>{connected=uri};mongoose.disconnect=async()=>{};
    mock('./services/storageService',{storage:{driver:'local',getUploadDirectory:()=>guard.storageRoot}});
    mock('./services/audioStorageService',{audioStorage:{startCleanupSchedule:()=>null}});
    let retentionStarts=0;
    if (!${isolated}) mock('./services/retentionService',{startRetentionSchedule(){retentionStarts++;return null}});
    const {app,startServer,shutdown}=require('./server');let binding;
    app.listen=(port,host,callback)=>{binding={port,host};queueMicrotask(callback);return {once(){},close(cb){cb()}}};
    const Session=require('./models/SpeechSession');Session.find=()=>{throw Error('historical query forbidden')};
    (async()=>{await startServer();assert.equal(connected,'mongodb://127.0.0.1:27017/ispeak_audio_uat');
      assert.deepEqual(binding,{port:${isolated ? 5001 : 5000},host:'${isolated ? '127.0.0.1' : '0.0.0.0'}'});
      if (${isolated}) {
      const r=require('./services/retentionService');assert.equal(r.startRetentionSchedule(),null);
      assert.equal(await r.purgeExpiredRecordings(),0);
      } else assert.equal(retentionStarts,1);
      await shutdown('mock test');process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...env, ISPEAK_LOCAL_AUDIO_UAT: String(isolated), PORT: isolated ? '5001' : '', REGISTRATION_MODE: 'open', ISPEAK_READ_ONLY_STARTUP: 'false', ISPEAK_BACKGROUND_JOBS: 'enabled' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
