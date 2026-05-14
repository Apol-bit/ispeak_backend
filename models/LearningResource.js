const mongoose = require('mongoose');

const learningResourceSchema = new mongoose.Schema({
  // COMMON FIELDS (Used by all types)
  type: { 
    type: String, 
    enum: ['Script', 'Challenge', 'GuidedTask'], 
    required: true 
  },
  title: { 
    type: String, 
    required: true // e.g., "Self Introduction", "Quick Pitch", "Breathing & Projection"
  },
  description: { 
    type: String, 
    required: true // e.g., "A simple intro...", "Deliver a 60-s pitch", "6 steps"
  },

  // Different resources track time differently
  estimatedMinutes: { type: Number, default: 0 }, // For Scripts & Guided Tasks
  timeLimitSeconds: { type: Number, default: 0 }, // For Timed Challenges

  // Classification Tags
  language: { 
    type: String, 
    enum: ['English', 'Filipino', 'Taglish', 'None'], 
    default: 'English' 
  },
  difficulty: { 
    type: String, 
    enum: ['Beginner', 'Intermediate', 'Advanced', 'None'], 
    default: 'None' 
  },
  category: { 
    type: String, 
    default: "" // Used for Guided Tasks (e.g., "Foundation", "Clarity", "Timing")
  },
  iconName: {
    type: String,
    default: "" // Used for Guided Tasks (e.g., "volume_up", "chat_bubble", "timer")
  },

  // TYPE-SPECIFIC FIELDS (Optional depending on Type)


  // For Scripts
  content: { 
    type: String, 
    default: "" // The actual long-form text they read aloud
  },

  // Reference Audio (uploaded by Validator)
  // TODO [CLOUD]: When migrating to cloud storage (S3/GCS), replace local path
  //   with the full cloud URL. Update resourceController.js upload logic accordingly.
  referenceAudioPath: {
    type: String,
    default: ""
  },
  transcript: {
    type: String,
    default: ""
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // For Challenges
  targetMetric: { 
    type: String, 
    default: "" // e.g., "120-140 WPM"
  },
  prompt: { 
    type: String, 
    default: "" // The situational context for the challenge
  },
  tips: [{ 
    type: String // Bullet points for challenges
  }],

  // For Guided Tasks
  steps: [{ 
    type: String // Numbered instructions (e.g., "Stand up straight...")
  }],
  proTip: { 
    type: String, 
    default: "" // Highlighted tip box at the bottom
  }

}, { timestamps: true });

module.exports = mongoose.model('LearningResource', learningResourceSchema);