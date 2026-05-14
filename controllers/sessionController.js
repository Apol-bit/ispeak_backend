const SpeechSession = require('../models/SpeechSession');
const LearningResource = require('../models/LearningResource');
const User = require('../models/User');
const mongoose = require('mongoose');

// Required for the AI FastAPI Connection
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

exports.uploadAudioAI = async (req, res) => {
  try {
    const { userId, language, challengeId, resourceId } = req.body;
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });

    const formData = new FormData();
    formData.append('file', fs.createReadStream(req.file.path));

    // Look up the resource to get reference audio path (if it exists)
    let referenceAudioPath = null;
    if (resourceId && mongoose.Types.ObjectId.isValid(resourceId)) {
      const resource = await LearningResource.findById(resourceId);
      if (resource && resource.referenceAudioPath) {
        referenceAudioPath = resource.referenceAudioPath;
      }
    }

    // If reference audio exists, attach it for comparison scoring
    if (referenceAudioPath) {
      const absRefPath = path.resolve(referenceAudioPath);
      if (fs.existsSync(absRefPath)) {
        formData.append('reference_audio', fs.createReadStream(absRefPath));
      }
    }

    let aiScores;
    try {
      // Point exactly to the Python /transcribe route
      const fastApiResponse = await axios.post('http://127.0.0.1:8000/transcribe', formData, {
        headers: { ...formData.getHeaders() }
      });
      aiScores = fastApiResponse.data;
    } catch (aiError) {
      console.error("FastAPI Connection Error:", aiError.message);
      return res.status(503).json({ message: "AI Evaluation Engine offline." });
    }

    // Extract out-of-100 scores from the nested Python dictionary
    const paceScore = aiScores?.scores?.pacing || 0;
    const clarityScore = aiScores?.scores?.clarity || 0;
    const energyScore = aiScores?.scores?.energy || 0;
    const overallScore = aiScores?.scores?.overall || 0;
    const transcription = aiScores?.transcription || "No transcription available.";

    // Extract raw counts using the exact keys from Python
    const wpmScore = aiScores?.pacing?.wpm || 0;
    const fillerWordCount = aiScores?.fillers?.count || 0;

    // Extract word-level timestamps for karaoke teleprompter
    const wordTimestamps = aiScores?.word_timestamps || [];

    // Calculate audio duration from word timestamps or file size
    let durationSeconds = 0;
    if (wordTimestamps.length > 0) {
      // Use the last word's end time as the duration
      durationSeconds = Math.round(wordTimestamps[wordTimestamps.length - 1].end || 0);
    } else {
      // Fallback: estimate from file size (WAV 16kHz, 16-bit, mono = 32000 bytes/sec)
      const fileStats = fs.statSync(req.file.path);
      durationSeconds = Math.round(fileStats.size / 32000);
    }

    // Generate AI feedback from the response data
    const pronunciationMsg = aiScores?.pronunciation?.message || '';
    const feedbackParts = [];
    if (paceScore > 0) feedbackParts.push(`Pacing: ${paceScore >= 80 ? 'Great' : paceScore >= 60 ? 'Good' : 'Needs work'} (${paceScore}/100).`);
    if (clarityScore > 0) feedbackParts.push(`Clarity: ${clarityScore >= 80 ? 'Great' : clarityScore >= 60 ? 'Good' : 'Needs work'} (${clarityScore}/100).`);
    if (energyScore > 0) feedbackParts.push(`Energy: ${energyScore >= 80 ? 'Great' : energyScore >= 60 ? 'Good' : 'Needs work'} (${energyScore}/100).`);
    if (pronunciationMsg) feedbackParts.push(pronunciationMsg);
    const aiFeedback = feedbackParts.length > 0 ? feedbackParts.join(' ') : "Analysis complete.";

    const newSession = new SpeechSession({
      userId: userId,
      language: language || 'English',
      audioPath: req.file.path,
      durationSeconds,
      status: 'Completed',
      challengeId: challengeId,
      resourceId: resourceId,
      paceScore,
      clarityScore,
      energyScore,
      overallScore,
      wpmScore,
      fillerWordCount,
      transcription,
      aiFeedback,
      wordTimestamps
    });

    await newSession.save();

    // Return the full saved session document so Flutter gets flat keys
    res.status(200).json(newSession.toObject());
  } catch (error) {
    console.error('Audio Upload/AI Error:', error);
    res.status(500).json({ message: "Internal server error during audio processing." });
  }
};

// ANALYTICS & STATS ROUTES
exports.getUserHistory = async (req, res) => {
  try {
    const sessions = await SpeechSession.find({ userId: req.params.userId })
      .sort({ createdAt: -1 });

    res.status(200).json(sessions);
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ message: "Error fetching history" });
  }
};

exports.getUserStats = async (req, res) => {
  try {
    const { userId } = req.params;

    // Safety check to prevent MongoDB from crashing the server
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid User ID format", sessions: [], overallStats: null });
    }

    const sessions = await SpeechSession.find({ userId })
      .sort({ createdAt: 1 });

    const stats = await SpeechSession.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: "$userId",
          totalSessions: { $sum: 1 },
          avgScore: { $avg: "$overallScore" },
          avgPace: { $avg: "$paceScore" },
          avgClarity: { $avg: "$clarityScore" },
          avgEnergy: { $avg: "$energyScore" }
        }
      }
    ]);

    res.status(200).json({ sessions, overallStats: stats[0] || null });
  } catch (error) {
    console.error("Stats calculation error:", error);
    res.status(500).json({ message: "Error calculating stats", error: error.message, stack: error.stack });
  }
};

exports.getAdminGlobalStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalSessions = await SpeechSession.countDocuments();
    const globalStats = await SpeechSession.aggregate([{ $group: { _id: null, avgOverall: { $avg: "$overallScore" } } }]);

    res.status(200).json({ totalUsers, totalSessions, avgAppScore: Math.round(globalStats[0]?.avgOverall || 0) });
  } catch (error) {
    res.status(500).json({ message: "Error fetching stats" });
  }
};

exports.getAdminRecentSessions = async (req, res) => {
  try {
    const recentSessions = await SpeechSession.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('userId', 'firstName lastName email');

    res.status(200).json(recentSessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching recent sessions" });
  }
};