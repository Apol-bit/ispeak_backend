const SpeechSession = require('../models/SpeechSession');
const LearningResource = require('../models/LearningResource');
const User = require('../models/User');
const mongoose = require('mongoose');

// Required for the AI FastAPI Connection
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { storage } = require('../services/storageService');

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Failed to clean up uploaded audio:', error.message);
  }
}

exports.uploadAudioAI = async (req, res) => {
  try {
    const { language, challengeId, resourceId } = req.body;
    const userId = req.auth.userId;
    const sessionLanguage = language || 'English';
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });
    if (challengeId && !mongoose.Types.ObjectId.isValid(challengeId)) {
      removeUploadedFile(req.file.path);
      return res.status(400).json({ message: "Invalid Challenge ID format" });
    }
    if (resourceId && !mongoose.Types.ObjectId.isValid(resourceId)) {
      removeUploadedFile(req.file.path);
      return res.status(400).json({ message: "Invalid Resource ID format" });
    }
    if (!['English', 'Filipino', 'Taglish'].includes(sessionLanguage)) {
      removeUploadedFile(req.file.path);
      return res.status(400).json({ message: "Invalid language" });
    }
    const userExists = await User.exists({ _id: userId });
    if (!userExists) {
      removeUploadedFile(req.file.path);
      return res.status(404).json({ message: "User not found" });
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(req.file.path));
    formData.append('language', sessionLanguage);

    // Look up either practice resource type to get reference audio (if it exists).
    let referenceAudioPath = null;
    const scoringResourceId = resourceId || challengeId;
    if (scoringResourceId) {
      const resource = await LearningResource.findById(scoringResourceId);
      if (resource && resource.referenceAudioPath) {
        referenceAudioPath = resource.referenceAudioPath;
      }
    }

    // If reference audio exists, attach it for comparison scoring
    if (referenceAudioPath) {
      try {
        formData.append('reference_audio', storage.openReadStream(referenceAudioPath));
      } catch (error) {
        console.error('Reference audio is unavailable:', error.message);
      }
    }

    let aiScores;
    try {
      // Point exactly to the Python /transcribe route
      const pythonUrl = (process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:8000')
        .replace(/\/+$/, '');
      const timeout = Number(process.env.PYTHON_TIMEOUT_MS || 300000);
      const fastApiResponse = await axios.post(`${pythonUrl}/transcribe`, formData, {
        headers: { ...formData.getHeaders() },
        timeout: Number.isFinite(timeout) ? timeout : 300000,
        maxBodyLength: 26 * 1024 * 1024
      });
      aiScores = fastApiResponse.data;
    } catch (aiError) {
      console.error("FastAPI Connection Error:", aiError.message);
      removeUploadedFile(req.file.path);
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
    const fillerAnalysisAvailable = aiScores?.fillers?.analysis_available === true;

    // Extract word-level timestamps for teleprompter
    const wordTimestamps = aiScores?.word_timestamps || [];

    // Python measures decoded media duration. Word timestamps are only a
    // secondary fallback because they may exclude leading/trailing silence.
    const measuredDuration = Number(aiScores?.duration_seconds);
    const timestampDuration = Number(wordTimestamps.at(-1)?.end || 0);
    const durationSeconds = Math.round(
      Number.isFinite(measuredDuration) && measuredDuration >= 0
        ? measuredDuration
        : timestampDuration
    );

    // Generate AI feedback from the response data
    const pronunciationMsg = aiScores?.pronunciation?.message || '';
    const feedbackParts = [];
    if (paceScore > 0) feedbackParts.push(`Pacing: ${paceScore >= 80 ? 'Great' : paceScore >= 60 ? 'Good' : 'Needs work'} (${paceScore}/100).`);
    if (clarityScore > 0) feedbackParts.push(`Clarity: ${clarityScore >= 80 ? 'Great' : clarityScore >= 60 ? 'Good' : 'Needs work'} (${clarityScore}/100).`);
    if (energyScore > 0) feedbackParts.push(`Energy: ${energyScore >= 80 ? 'Great' : energyScore >= 60 ? 'Good' : 'Needs work'} (${energyScore}/100).`);
    if (pronunciationMsg) feedbackParts.push(pronunciationMsg);
    const aiFeedback = feedbackParts.length > 0 ? feedbackParts.join(' ') : "Analysis complete.";

    const storedAudioPath = storage.toKey(req.file.path);
    const newSession = new SpeechSession({
      userId: userId,
      language: sessionLanguage,
      audioPath: storedAudioPath,
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
      fillerAnalysisAvailable,
      transcription,
      aiFeedback,
      wordTimestamps
    });

    await newSession.save();

    // Storage keys are internal; clients receive only analysis/session data.
    const responseSession = newSession.toObject();
    delete responseSession.audioPath;
    res.status(200).json(responseSession);
  } catch (error) {
    console.error('Audio Upload/AI Error:', error);
    removeUploadedFile(req.file?.path);
    res.status(500).json({ message: "Internal server error during audio processing." });
  }
};

// ANALYTICS & STATS ROUTES
exports.getUserHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid User ID format", sessions: [] });
    }

    const sessions = await SpeechSession.find({ userId })
      .select('-audioPath')
      .sort({ createdAt: -1 })
      .populate('challengeId')
      .populate('resourceId');

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
      .select('-audioPath')
      .sort({ createdAt: 1 })
      .populate('challengeId')
      .populate('resourceId');

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
    const recentSessions = await SpeechSession.find()
      .select('-audioPath')
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('userId', 'firstName lastName email');

    res.status(200).json(recentSessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching recent sessions" });
  }
};
