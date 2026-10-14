const fs = require('node:fs');
const { storage } = require('./storageService');
const Cleanup = require('../models/StorageCleanup');
const SpeechSession = require('../models/SpeechSession');
const Resource = require('../models/LearningResource');
const { inspectAudio } = require('./audioFile');
const { StorageError } = require('./storageErrors');

const RECOVERY_DELAY_MS = 24 * 60 * 60 * 1000;

function createAudioStorage({ provider = storage, jobs = Cleanup,
  isReferenced = async key => Boolean(await SpeechSession.exists({ audioPath: key }) ||
    await Resource.exists({ referenceAudioPath: key })),
  log = message => console.error(message), now = () => Date.now() } = {}) {
  const cloud = provider.driver === 'r2';
  const filter = key => ({ namespace: provider.namespace, key });

  async function prepareRemoval(key, { upload = false } = {}) {
    if (!key || !cloud) return;
    provider.assertKey(key);
    try {
      await jobs.updateOne(filter(key), { $setOnInsert: {
        ...filter(key), nextAttemptAt: new Date(now() + RECOVERY_DELAY_MS), attempts: 0,
        ...(upload ? { purpose: 'upload' } : {}),
      }, ...(!upload ? { $set: { purpose: 'cleanup' } } : {}) }, { upsert: true });
    } catch { throw new StorageError('cleanup_journal'); }
  }

  async function committed(key) {
    if (!key || !cloud) return;
    // A concurrent resource/account delete may have promoted this intent to
    // cleanup after the DB save. Finalizing an upload must not erase that work.
    try { await jobs.deleteOne({ ...filter(key), purpose: 'upload' }); }
    catch { log('Audio cleanup journal finalization deferred; referenced audio will be preserved.'); }
  }

  async function removeIfUnreferenced(key) {
    if (!key) return;
    if (!cloud) {
      try { await provider.delete(key); }
      catch { log('Local audio cleanup failed; manual reconciliation may be required.'); }
      return;
    }
    try {
      // An ambiguous DB acknowledgement must never trigger blind compensation.
      // A failed reference lookup leaves the durable intent for another attempt.
      if (await isReferenced(key)) return;
      await provider.delete(key);
      await jobs.deleteOne(filter(key));
    } catch {
      log('Audio cleanup deferred; retryable storage cleanup intent retained.');
      try {
        await jobs.updateOne(filter(key), { $set: { nextAttemptAt: new Date(now() + 60_000) }, $inc: { attempts: 1 } });
      } catch { log('Audio cleanup retry scheduling unavailable; existing intent retained.'); }
    }
  }

  async function storeUpload(file, options) {
    // Preserve established local session behavior; Python already decodes user
    // recordings. R2 adds a second size/signature guard before any transfer.
    if (cloud) await inspectAudio(file.path);
    const key = provider.createKey(file.path, options);
    await prepareRemoval(key, { upload: true }); // Must succeed BEFORE uploading an object.
    await provider.storeFile(file.path, { key });
    return key;
  }

  async function cleanupTemp(file, { preserveLocal = false } = {}) {
    if (!file || (preserveLocal && !provider.temporaryUploads)) return;
    try { await fs.promises.rm(file.path, { force: true }); }
    catch { log('Temporary audio cleanup failed; scratch-file reconciliation required.'); }
  }

  let running = false;
  async function retryCleanup() {
    if (!cloud || running) return;
    running = true;
    try {
      const pending = await jobs.find({ namespace: provider.namespace, nextAttemptAt: { $lte: new Date(now()) } })
        .sort({ nextAttemptAt: 1 }).limit(100).lean();
      for (const item of pending) {
        // Retain referenced intents and check again later: an interrupted
        // replacement may still complete. Never delete an object in use.
        if (await isReferenced(item.key)) {
          await jobs.updateOne(filter(item.key), { $set: { nextAttemptAt: new Date(now() + RECOVERY_DELAY_MS) } });
          continue;
        }
        await removeIfUnreferenced(item.key);
      }
    } catch { log('Audio cleanup scan unavailable; durable intents retained.'); }
    finally { running = false; }
  }

  function startCleanupSchedule() {
    if (!cloud) return null;
    void retryCleanup();
    const timer = setInterval(() => void retryCleanup(), 60_000);
    timer.unref();
    return timer;
  }

  return { storeUpload, prepareRemoval, committed, removeIfUnreferenced, cleanupTemp, retryCleanup, startCleanupSchedule };
}

module.exports = { createAudioStorage, RECOVERY_DELAY_MS, audioStorage: createAudioStorage() };
