const fs = require('node:fs');
const path = require('node:path');

const storageRoot = path.resolve(__dirname, '../.local-audio-uat/audio');

function localAudioUat(env = process.env, filesystem = fs) {
  if (env.ISPEAK_LOCAL_AUDIO_UAT === undefined || env.ISPEAK_LOCAL_AUDIO_UAT === 'false') return false;
  const fail = () => { throw new Error('Invalid isolated local audio UAT configuration'); };
  if (env.ISPEAK_LOCAL_AUDIO_UAT !== 'true' || env.NODE_ENV !== 'development'
    || env.STORAGE_DRIVER !== 'local' || env.ISPEAK_READ_ONLY_STARTUP === 'true'
    || env.MONGO_URI !== 'mongodb://127.0.0.1:27017/ispeak_audio_uat'
    || env.PYTHON_BACKEND_URL !== 'http://127.0.0.1:8000'
    || env.PORT !== '5001' || !env.LOCAL_STORAGE_ROOT
    || path.resolve(env.LOCAL_STORAGE_ROOT) !== storageRoot
    || !env.JWT_SECRET || env.JWT_SECRET.length < 32
    || !env.PYTHON_SERVICE_TOKEN || env.PYTHON_SERVICE_TOKEN.length < 32
    || env.RECORDING_RETENTION_DAYS !== '0') fail();
  // Reject aliases/junctions, including a redirected ancestor directory.
  try {
    if (!filesystem.statSync(storageRoot).isDirectory()
      || filesystem.realpathSync(storageRoot) !== storageRoot) fail();
    let cursor = storageRoot;
    while (cursor !== path.dirname(cursor)) {
      if (filesystem.lstatSync(cursor).isSymbolicLink()) fail();
      cursor = path.dirname(cursor);
    }
    const inspect = directory => {
      for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) fail();
        if (entry.isDirectory()) inspect(path.join(directory, entry.name));
      }
    };
    inspect(storageRoot);
  } catch { fail(); }
  return true;
}

module.exports = { localAudioUat, storageRoot };
