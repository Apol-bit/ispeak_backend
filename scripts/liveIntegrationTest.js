const assert = require('node:assert/strict');
const fs = require('node:fs');
const mongoose = require('mongoose');
const User = require('../models/User');

const apiUrl = process.env.LIVE_API_URL;
const mongoUri = process.env.LIVE_MONGO_URI;
const audioPath = process.env.LIVE_AUDIO_PATH;

if (!apiUrl || !mongoUri || !audioPath) {
  throw new Error('LIVE_API_URL, LIVE_MONGO_URI, and LIVE_AUDIO_PATH are required');
}

const runId = Date.now();
const password = 'AuditPass123!';
const emails = {
  user1: `audit-user1-${runId}@example.test`,
  user2: `audit-user2-${runId}@example.test`,
  admin: `audit-admin-${runId}@example.test`,
  validator: `audit-validator-${runId}@example.test`,
};

async function request(path, { token, method = 'GET', body, form } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* no JSON body */ }
  return { status: response.status, body: payload };
}

async function signup(label, email) {
  const result = await request('/signup', {
    method: 'POST',
    body: {
      firstName: label,
      lastName: 'Audit',
      username: `${label.toLowerCase()}-${runId}`,
      email,
      password,
      acceptTerms: true,
      termsVersion: '1.0',
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function login(email) {
  const result = await request('/login', {
    method: 'POST', body: { email, password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function main() {
  const created = {};
  let adminToken;
  let resourceId;
  try {
    created.user1 = await signup('UserOne', emails.user1);
    created.user2 = await signup('UserTwo', emails.user2);
    created.admin = await signup('Admin', emails.admin);
    created.validator = await signup('Validator', emails.validator);

    await mongoose.connect(mongoUri);
    await User.updateOne({ email: emails.admin }, { role: 'admin' });
    await User.updateOne({ email: emails.validator }, { role: 'validator' });
    await mongoose.disconnect();

    const admin = await login(emails.admin);
    const validator = await login(emails.validator);
    adminToken = admin.token;
    const userToken = created.user1.token;

    assert.equal((await request(`/user/${created.user1.user.id}`)).status, 401);
    assert.equal((await request(`/user/${created.user1.user.id}`, { token: userToken })).status, 200);
    assert.equal((await request(`/user/${created.user2.user.id}`, { token: userToken })).status, 403);
    assert.equal((await request('/users', { token: userToken })).status, 403);
    assert.equal((await request('/users', { token: admin.token })).status, 200);
    assert.equal((await request('/admin/stats', { token: validator.token })).status, 403);
    assert.equal((await request('/admin/ai-logs', { token: validator.token })).status, 200);

    const resourceForm = new FormData();
    resourceForm.append('type', 'Script');
    resourceForm.append('title', `Audit Resource ${runId}`);
    resourceForm.append('description', 'Temporary integration resource');
    resourceForm.append('difficulty', 'Beginner');
    resourceForm.append('language', 'Taglish');
    resourceForm.append('transcript', 'Temporary integration script');
    const resource = await request('/admin/resources', {
      token: validator.token, method: 'POST', form: resourceForm,
    });
    assert.equal(resource.status, 201, JSON.stringify(resource.body));
    resourceId = resource.body.resource._id;

    const uploadForm = new FormData();
    uploadForm.append('userId', created.user2.user.id);
    uploadForm.append('language', 'Taglish');
    uploadForm.append('resourceId', resourceId);
    uploadForm.append(
      'audio',
      new Blob([fs.readFileSync(audioPath)], { type: 'audio/aac' }),
      'audit-speech.aac'
    );
    const upload = await request('/upload-audio', {
      token: userToken, method: 'POST', form: uploadForm,
    });
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.userId, created.user1.user.id);
    assert.equal(upload.body.language, 'Taglish');
    assert.equal(upload.body.audioPath, undefined);
    assert.ok(upload.body.durationSeconds > 0);
    assert.ok(upload.body.transcription.length > 0);

    const ownStats = await request(`/stats/${created.user1.user.id}`, { token: userToken });
    assert.equal(ownStats.status, 200);
    assert.equal(ownStats.body.overallStats.totalSessions, 1);
    assert.equal((await request(`/stats/${created.user2.user.id}`, { token: userToken })).status, 403);

    assert.equal((await request(`/users/${created.user1.user.id}/status`, {
      token: admin.token, method: 'PATCH',
    })).status, 200);
    assert.equal((await request('/auth/me', { token: userToken })).status, 403);

    console.log('Live integration PASS: auth, RBAC, IDOR, V2 inference, duration, and Mongo persistence');
  } finally {
    if (adminToken) {
      if (resourceId) {
        await request(`/admin/resources/${resourceId}`, { token: adminToken, method: 'DELETE' });
      }
      for (const key of ['user1', 'user2', 'validator']) {
        if (created[key]?.user?.id) {
          if (key === 'user1') {
            await request(`/users/${created[key].user.id}/status`, {
              token: adminToken, method: 'PATCH',
            });
          }
          await request(`/users/${created[key].user.id}`, {
            token: adminToken, method: 'DELETE',
          });
        }
      }
    }
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(mongoUri);
    await User.deleteMany({ email: { $in: Object.values(emails) } });
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Live integration FAIL:', error);
  process.exitCode = 1;
});
