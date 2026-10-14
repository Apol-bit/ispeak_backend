const mongoose = require('mongoose');

// Write-ahead cleanup intents, not a second session/job system. No credentials,
// filenames, transcripts, or SDK error payloads are stored here.
const schema = new mongoose.Schema({
  namespace: { type: String, required: true },
  key: { type: String, required: true },
  purpose: { type: String, enum: ['upload', 'cleanup'], required: true },
  nextAttemptAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
}, { timestamps: true });
schema.index({ namespace: 1, key: 1 }, { unique: true });
schema.index({ namespace: 1, nextAttemptAt: 1 });
module.exports = mongoose.model('StorageCleanup', schema);
