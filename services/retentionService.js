const SpeechSession = require('../models/SpeechSession');
const { storage } = require('./storageService');
const { logError } = require('./safeLogger');
const { readOnlyStartup } = require('./readOnlyStartup');

async function purgeExpiredRecordings() {
  if (require('./localAudioUat').localAudioUat()) return 0;
  if (readOnlyStartup()) return 0;
  const retentionDays = Number(process.env.RECORDING_RETENTION_DAYS || 30);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const sessions = await SpeechSession.find({
    createdAt: { $lt: cutoff },
    audioDeletedAt: null,
    audioPath: { $nin: ['', null] },
  }).select('_id audioPath');

  let deleted = 0;
  for (const session of sessions) {
    try {
      await storage.delete(session.audioPath);
      session.audioPath = null;
      session.audioDeletedAt = new Date();
      await session.save();
      deleted += 1;
    } catch (error) {
      logError('recording_retention_item_failed', error);
    }
  }
  return deleted;
}

function startRetentionSchedule() {
  if (require('./localAudioUat').localAudioUat()) return null;
  if (readOnlyStartup()) return null;
  const run = () => purgeExpiredRecordings().catch((error) => {
    logError('recording_retention_scan_failed', error);
  });
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { purgeExpiredRecordings, startRetentionSchedule };
