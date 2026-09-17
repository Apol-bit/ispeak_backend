const SpeechSession = require('../models/SpeechSession');
const { storage } = require('./storageService');

async function purgeExpiredRecordings() {
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
      console.error(`Retention cleanup failed for session ${session._id}:`, error.message);
    }
  }
  return deleted;
}

function startRetentionSchedule() {
  const run = () => purgeExpiredRecordings().catch((error) => {
    console.error('Recording retention job failed:', error.message);
  });
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { purgeExpiredRecordings, startRetentionSchedule };
