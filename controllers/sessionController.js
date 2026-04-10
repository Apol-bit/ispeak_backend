const SpeechSession = require('../models/SpeechSession');
const User = require('../models/User');
const mongoose = require('mongoose');

// Required for the AI FastAPI Connection
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

/* // PRODUCTION AI ROUTE (Uncomment this when FastAPI is running!)
exports.uploadAudioAI = async (req, res) => {
  try {
    const { userId, language, challengeId, resourceId } = req.body;
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });

    const formData = new FormData();
    formData.append('audio', fs.createReadStream(req.file.path)); 
    formData.append('language', language || 'English');

    let aiScores;
    try {
      const fastApiResponse = await axios.post('http://127.0.0.1:8000/analyze', formData, {
        headers: { ...formData.getHeaders() }
      });
      aiScores = fastApiResponse.data; 
    } catch (aiError) {
      console.error("FastAPI Connection Error:", aiError.message);
      return res.status(503).json({ message: "AI Evaluation Engine offline." });
    }

    const newSession = new SpeechSession({ 
      userId: userId, 
      language: language || 'English',
      audioPath: req.file.path,
      status: 'Completed',
      challengeId: challengeId,
      resourceId: resourceId,
      paceScore: aiScores.paceScore || 0,
      clarityScore: aiScores.clarityScore || 0,
      energyScore: aiScores.energyScore || 0,
      overallScore: aiScores.overallScore || 0,
      transcription: aiScores.transcription || "No transcription available."
    });

    await newSession.save();
    res.status(200).json({ message: "Audio analyzed successfully!", sessionId: newSession._id, scores: aiScores });
  } catch (error) {
    console.error('Audio Upload/AI Error:', error);
    res.status(500).json({ message: "Internal server error during audio processing." });
  }
}; 
*/

// ACTIVE LOCAL ROUTE (Works right now without the AI)
exports.uploadAudioLocal = async (req, res) => {
  try {
    const { userId, language, challengeId, resourceId } = req.body;
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });

    const newSession = new SpeechSession({ 
      userId: userId, 
      language: language || 'English',
      audioPath: req.file.path,
      status: 'Completed',
      challengeId: challengeId,
      resourceId: resourceId
    });

    await newSession.save();

    res.status(200).json({ 
      message: "Audio uploaded locally (AI Disabled)!", 
      sessionId: newSession._id 
    });
  } catch (error) {
    console.error('Audio Upload Error:', error);
    res.status(500).json({ message: "Error saving audio locally" });
  }
};

// ANALYTICS & STATS ROUTES
exports.getUserHistory = async (req, res) => {
  try {
    const sessions = await SpeechSession.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.status(200).json(sessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching history" });
  }
};

exports.getUserStats = async (req, res) => {
  try {
    const { userId } = req.params;
    const sessions = await SpeechSession.find({ userId }).sort({ createdAt: 1 });

    const stats = await SpeechSession.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { 
          _id: "$userId", 
          totalSessions: { $sum: 1 }, 
          avgOverall: { $avg: "$overallScore" }, 
          avgWpm: { $avg: "$wpmScore" },
          avgClarity: { $avg: "$clarityScore" }, 
          avgEnergy: { $avg: "$energyScore" } 
        } 
      }
    ]);

    res.status(200).json({ sessions, overallStats: stats[0] || null });
  } catch (error) {
    res.status(500).json({ message: "Error calculating stats" });
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
    const recentSessions = await SpeechSession.find().sort({ createdAt: -1 }).limit(100);
    res.status(200).json(recentSessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching recent sessions" });
  }
};