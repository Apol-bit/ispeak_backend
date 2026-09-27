const mongoose = require('mongoose');

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
    default: 'Pending'
  },
  // SMART ROUTING DATA
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

  transcription: {
    type: String,
    default: "No transcription available."
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

module.exports = mongoose.model('SpeechSession', speechSessionSchema);
