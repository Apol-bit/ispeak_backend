'use strict';
// Deployment adapter; mount a reviewed numeric Secret Manager version read-only.
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const TARGET = 'https://ispeak-python-679718595301.asia-southeast1.run.app';
const EXPECTED = {"controllers/sessionController.js": "a21850343cb564351e49b80c46ae258348ae47575a65209be9f107b2f60031dc", "docker/entrypoint.sh": "7226d86972f11c5188d94a4a054e883871b55beb0b433f4a75a7a0737f1e598b", "docker/validateConfiguration.js": "d53fe31f99ff77b44eb5b0218c85ee60d1600f5f5339db5461c9092bfd42161e", "server.js": "f29a7840cf0d3c84afed318c57276346dc903c8cd92259ab53164cad02480289", "services/audioStorageService.js": "fa154cbeb9982e0193208747ed842c2de9898c9c2edb0f60d31573bb62828679", "services/readOnlyStartup.js": "8622aaf69e22f25464df86e3baffb633c2d8a5b3f484d8486b3eb4bdefa936ee", "services/retentionService.js": "9bf896412aa3ce8e77b57756c3254e17d945ee6fac6c5f7f4775bee69d47c5e7", "services/storageService.js": "2dea22e72fd74042d4f91cb267bcc8e5c9f208664789e3cba44a9df6eba41dba"}; // Populated from the preserved frozen-context manifest.

function verifyFiles(root = '/app') {
  if (!Object.keys(EXPECTED).length) throw new Error('Empty application identity guard');
  for (const [file, expected] of Object.entries(EXPECTED)) {
    if (createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex') !== expected) {
      throw new Error('Application identity guard rejected');
    }
  }
}

function install({ appRequire, env, fetchToken, now = Date.now }) {
  if (env.NODE_ENV !== 'production' || env.PYTHON_BACKEND_URL !== TARGET ||
      env.STORAGE_DRIVER !== 'r2') throw new Error('Deployment adapter configuration rejected');
  const mongoose = appRequire('mongoose');
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  const retention = appRequire('./services/retentionService');
  const { audioStorage } = appRequire('./services/audioStorageService');
  if (typeof retention.startRetentionSchedule !== 'function' ||
      typeof audioStorage.startCleanupSchedule !== 'function') {
    throw new Error('Deployment adapter startup contract rejected');
  }
  // Installed before server.js destructures these exports. No cleanup scan runs.
  retention.startRetentionSchedule = () => null;
  audioStorage.startCleanupSchedule = () => null;
  const axios = appRequire('axios');
  let cached, pending;
  async function getToken() {
    if (cached && cached.expires > now() + 60000) return cached.token;
    if (!pending) pending = (async () => {
      try {
        const token = await fetchToken(TARGET);
        if (typeof token !== 'string' || token.length > 16384 || /\s/.test(token)) throw Error();
        const parts = token.split('.');
        if (parts.length !== 3) throw Error();
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (claims.aud !== TARGET || !Number.isFinite(claims.exp) ||
            claims.exp * 1000 <= now() + 60000) throw Error();
        cached = { token, expires: claims.exp * 1000 };
        return token;
      } catch { throw new Error('Python IAM token unavailable'); }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  axios.interceptors.request.use(async config => {
    const url = new URL(config.url, config.baseURL || TARGET);
    if (url.origin !== TARGET) return config;
    if (url.username || url.password || url.pathname !== '/transcribe') {
      throw new Error('Python IAM destination rejected');
    }
    config.headers = axios.AxiosHeaders.from(config.headers);
    config.headers.set('X-Serverless-Authorization', `Bearer ${await getToken()}`);
    config.maxRedirects = 0;
    return config;
  });
}

if (require.main !== module) {
  try {
    verifyFiles();
    install({ appRequire: createRequire('/app/package.json'), env: process.env,
      fetchToken: async audience => {
        const endpoint = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
        const response = await fetch(`${endpoint}?audience=${encodeURIComponent(audience)}&format=full`, {
          headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw Error();
        return response.text();
      }
    });
  } catch {
    console.error('Deployment adapter validation failed');
    process.exit(1);
  }
}
module.exports = { install, verifyFiles, TARGET, EXPECTED };
