const mongoose = require('mongoose');

const speechSessionSchema = new mongoose.Schema({
  //Links this practice session to the specific user who recorded it
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  //Pace Metric (Words per minute)
  wpmScore: {
    type: Number,
    required: true
  },
  //Clarity Metric (Counting "um", "uh", "like")
  fillerWordCount: {
    type: Number,
    required: true
  },
  //Energy Metric (Overall volume/pitch rating)
  energyScore: {
    type: Number,
    required: true
  },
  //Actual text of what they said (from the Whisper model)
  transcription: {
    type: String,
    required: true
  }
}, { 
  timestamps: true //Automatically saves the exact date and time of the practice
});

const SpeechSessionSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  audioPath: { 
    type: String, 
    required: true //stores the folder path: "uploads/123456789.mp3"
  },
  wpmScore: { type: Number, default: 0 },
  fillerWordCount: { type: Number, default: 0 },
  energyScore: { type: Number, default: 0 },
  transcription: { type: String, default: "" },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('SpeechSession', SpeechSessionSchema);
