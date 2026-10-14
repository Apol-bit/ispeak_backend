// Read-only: raw Mongo collection reads, no app startup, schemas, index creation,
// retention, storage provider, cloud access, file writes or deletion.
const fs = require('node:fs/promises');
const path = require('node:path');

async function inventory({ root, projectRoot, sessions = [], resources = [], databaseAvailable = true, details = false }) {
  root = path.resolve(root);
  const files = new Map();
  let skippedSymlinks = 0;
  async function walk(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skippedSymlinks++; continue; }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.set(absolute, (await fs.stat(absolute)).size);
    }
  }
  await walk(root);
  const summary = { databaseAvailable, localFiles: files.size,
    localBytes: [...files.values()].reduce((a, b) => a + b, 0), skippedSymlinks };
  if (!databaseAvailable) return { ...summary, referencedFiles: null, orphanCandidates: null, migrationCandidates: null };
  const referenced = new Set();
  const referenceDetails = [];
  const counts = { sessionReferences: 0, resourceReferences: 0, existingReferences: 0, missingReferences: 0,
    cloudReferences: 0, unsafeOrUnsupportedReferences: 0 };
  for (const [kind, rows, field] of [['sessionReferences', sessions, 'audioPath'], ['resourceReferences', resources, 'referenceAudioPath']]) {
    for (const row of rows) {
      const key = row[field]; if (!key) continue;
      counts[kind]++;
      const detail = { kind, id: row._id == null ? null : String(row._id), key, classification: 'unsupported', bytes: null };
      if (details) referenceDetails.push(detail);
      if (/^(recordings|reference-audio)\/[a-f0-9]{24}\/[a-f0-9-]{36}\.(wav|mp3|m4a|aac|flac|ogg)$/.test(key)) { counts.cloudReferences++; detail.classification = 'cloud-key'; continue; }
      // Windows absolute paths on Linux must not be interpreted as relative keys.
      if (typeof key !== 'string' || key.includes('://') || (path.sep === '/' && /^[A-Za-z]:[\\/]/.test(key))) { counts.unsafeOrUnsupportedReferences++; continue; }
      const absolute = path.resolve(projectRoot, key);
      const relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { counts.unsafeOrUnsupportedReferences++; continue; }
      if (files.has(absolute)) { referenced.add(absolute); counts.existingReferences++; detail.classification = 'existing-local'; detail.bytes = files.get(absolute); }
      else { counts.missingReferences++; detail.classification = 'missing-local'; }
    }
  }
  const referencedBytes = [...referenced].reduce((sum, file) => sum + files.get(file), 0);
  return { ...summary, ...counts, referencedFiles: referenced.size, referencedBytes,
    orphanCandidates: files.size - referenced.size, orphanCandidateBytes: summary.localBytes - referencedBytes,
    migrationCandidates: referenced.size,
    ...(details ? { references: referenceDetails, orphanFiles: [...files].filter(([file]) => !referenced.has(file))
      .map(([file, bytes]) => ({ path: path.relative(projectRoot, file).replace(/\\/g, '/'), bytes })) } : {}),
    note: 'Candidates require owner/retention/valid-audio review; this command never migrates or deletes.' };
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  require('dotenv').config({ path: path.join(projectRoot, '.env'), quiet: true });
  const root = path.resolve(projectRoot, process.env.LOCAL_STORAGE_ROOT || 'uploads');
  const mongoose = require('mongoose');
  let connection, sessions = [], resources = [], databaseAvailable = false;
  try {
    if (process.env.MONGO_URI) {
      connection = mongoose.createConnection(process.env.MONGO_URI, {
        autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 3000,
      });
      await connection.asPromise();
      sessions = await connection.db.collection('speechsessions').find({}, { projection: { _id: 1, audioPath: 1 } }).toArray();
      resources = await connection.db.collection('learningresources').find({}, { projection: { _id: 1, referenceAudioPath: 1 } }).toArray();
      databaseAvailable = true;
    }
  } catch {
    // No URI, credentials, DB names, user identity or transcript output.
    console.error('Mongo inventory unavailable; reporting filesystem totals only.');
  } finally { await connection?.close().catch(() => {}); }
  console.log(JSON.stringify(await inventory({ root, projectRoot, sessions, resources, databaseAvailable, details: process.argv.includes('--details') }), null, 2));
  if (!databaseAvailable) process.exitCode = 2;
}

if (require.main === module) main().catch(() => { console.error('Audio inventory failed; no data changed.'); process.exitCode = 1; });
module.exports = { inventory };
