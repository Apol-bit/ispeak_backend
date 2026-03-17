const mongoose = require('mongoose');

const speechSessionSchema = new mongoose.Schema({
  // Links this practice session to the specific user who recorded it
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  
  // Tracks whether the AI evaluated this in English or Filipino
  language: {
    type: String,
    enum: ['English', 'Filipino'],
    default: 'English',
    required: true
  },

  // Stores the physical file location: "uploads/ispeak_17154...m4a"
  audioPath: { 
    type: String, 
    required: true 
  },

  // --- AI EVALUATION METRICS (Matched exactly to your Flutter Progress UI) ---
  paceScore: { 
    type: Number, 
    default: 0 
  },
  clarityScore: { 
    type: Number, 
    default: 0 
  },
  energyScore: { 
    type: Number, 
    default: 0 
  },
  overallScore: { 
    type: Number, 
    default: 0 
  },

  // The actual text of what they said (from the Whisper model)
  transcription: { 
    type: String, 
    default: "No transcription available." 
  }

}, { 
  // Automatically adds 'createdAt' and 'updatedAt' timestamps perfectly
  timestamps: true 
});

module.exports = mongoose.model('SpeechSession', speechSessionSchema);