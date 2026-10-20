const mongoose = require('mongoose');
const { isUsableTranscript } = require('../services/transcriptValidation');

const speechSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  language: {
    type: String,
    enum: ['English', 'Filipino', 'Taglish'],
    default: 'English',
    required: true
  },
  audioPath: {
    type: String,
    default: null
  },
  audioDeletedAt: {
    type: Date,
    default: null
  },
  durationSeconds: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Failed'],
    default: 'Pending',
    validate: {
      validator: function (value) {
        return value !== 'Completed' || isUsableTranscript(this.get('transcription'));
      },
      message: 'Completed sessions require a usable transcription.'
    }
  },
  // SMART ROUTING DATA
  // No default: legacy sessions and older clients have no verified activity.
  practiceMode: {
    type: String,
    enum: ['ordinary', 'script', 'challenge']
  },
  challengeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LearningResource'
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LearningResource'
  },

  // Optional for existing sessions; no data migration is required.
  analysisValid: { type: Boolean, default: null },
  analysisAvailability: {
    pitch: { type: Boolean, default: null },
    pronunciation: { type: Boolean, default: null },
    fillers: { type: Boolean, default: null },
  },
  analysisFeedback: {
    pace: { type: String, default: '' },
    clarity: { type: String, default: '' },
    energy: { type: String, default: '' },
  },

  // AI EVALUATION METRICS
  paceScore: { type: Number, default: 0 },
  clarityScore: { type: Number, default: 0 },
  energyScore: { type: Number, default: 0 },
  overallScore: { type: Number, default: 0 },

  // Raw counts for the Results Page
  wpmScore: { type: Number, default: 0 },
  fillerWordCount: { type: Number, default: 0 },
  // Missing legacy values are treated conservatively as "not verified".
  fillerAnalysisAvailable: { type: Boolean, default: false },
  // Only the bounded, allow-listed service mapping is assigned by the API.
  fillerAnalysis: { type: mongoose.Schema.Types.Mixed, default: undefined },
  assessmentDetails: { type: mongoose.Schema.Types.Mixed, default: undefined },

  transcription: {
    type: String,
    required: function () { return this.get('status') === 'Completed'; },
    validate: {
      validator: function (value) {
        return this.get('status') !== 'Completed' || isUsableTranscript(value);
      },
      message: 'Completed sessions require a usable transcription.'
    }
  },
  aiFeedback: {
    type: String,
    default: "AI is still processing or failed to generate feedback."
  },
  // Word-level timestamps from Whisper AI (for teleprompter replay)
  wordTimestamps: [{
    word: { type: String },
    start: { type: Number },
    end: { type: Number }
  }]
}, {
  timestamps: true
});

speechSessionSchema.index({ userId: 1, createdAt: -1 });

// Query validators cannot inspect the stored status/transcription pair. Require
// an explicit pair when completing or editing a transcript, without reading or
// rewriting legacy rows. Unrelated updates (e.g. audio retention) remain allowed.
speechSessionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
  const update = this.getUpdate() || {};
  if (Array.isArray(update)) throw new Error('SpeechSession pipeline updates are unsupported; use document save().');
  const values = { ...update, ...update.$set };
  const touchesTranscript = Object.hasOwn(values, 'transcription')
    || Object.values(update).some(value => value && typeof value === 'object'
      && (Object.hasOwn(value, 'transcription') || Object.values(value).includes('transcription')));
  const touchesStatusOperator = Object.entries(update).some(([key, value]) =>
    key !== '$set' && key.startsWith('$') && value && typeof value === 'object'
    && (Object.hasOwn(value, 'status') || Object.values(value).includes('status')));
  const transcriptOperator = Object.entries(update).some(([key, value]) =>
    key !== '$set' && key.startsWith('$') && value && typeof value === 'object'
    && (Object.hasOwn(value, 'transcription') || Object.values(value).includes('transcription')));
  // Upsert filters can supply status to a newly inserted row. Do not infer the
  // resulting document from a filter; require the status in the update itself.
  const unsafeUpsert = this.getOptions().upsert && !['Pending', 'Failed'].includes(values.status)
    && !(values.status === 'Completed' && isUsableTranscript(values.transcription));
  if (unsafeUpsert || touchesStatusOperator || (transcriptOperator && !['Pending', 'Failed'].includes(values.status))
    || ((values.status === 'Completed' || touchesTranscript)
    && !(['Pending', 'Failed'].includes(values.status))
    && !(values.status === 'Completed' && isUsableTranscript(values.transcription)))) {
    throw new Error('Completed/transcription updates require explicit status and a usable transcription; use document save() for partial changes.');
  }
});

module.exports = mongoose.model('SpeechSession', speechSessionSchema);
