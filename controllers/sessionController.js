const SpeechSession = require('../models/SpeechSession');
const LearningResource = require('../models/LearningResource');
const User = require('../models/User');
const mongoose = require('mongoose');

// Required for the AI FastAPI Connection
const fs = require('fs');
const path = require('node:path');
const axios = require('axios');
const FormData = require('form-data');
const { storage } = require('../services/storageService');
const { audioStorage } = require('../services/audioStorageService');
const { storageFailure, StorageError } = require('../services/storageErrors');
const { AUDIO_TYPES } = require('../services/audioFile');
const { mapAiError, usableAnalysis, analysisFeedback } = require('../services/analysisResponse');
const { logError } = require('../services/safeLogger');

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    logError('temporary_audio_cleanup_failed', error);
  }
}

exports.uploadAudioAI = async (req, res) => {
  req.analysisStarted = true;
  let recordingStream;
  let referenceStream;
  let saved = false;
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

    const formData = new FormData();
    recordingStream = fs.createReadStream(req.file.path);
    formData.append('file', recordingStream);
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
        referenceStream = await storage.openReadStream(referenceAudioPath);
        formData.append('reference_audio', referenceStream, {
          filename: path.posix.basename(referenceAudioPath),
          contentType: AUDIO_TYPES[path.posix.extname(referenceAudioPath)],
          ...(referenceStream.audioLength != null ? { knownLength: referenceStream.audioLength } : {}),
        });
      } catch {
        // Do not silently change reference comparison to unreferenced scoring.
        throw new StorageError('reference_read');
      }
    }

    let aiScores;
    try {
      // Point exactly to the Python /transcribe route
      const pythonUrl = (process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:8000')
        .replace(/\/+$/, '');
      const timeout = Number(process.env.PYTHON_TIMEOUT_MS || 300000);
      const fastApiResponse = await axios.post(`${pythonUrl}/transcribe`, formData, {
        headers: { ...formData.getHeaders(), ...(process.env.PYTHON_SERVICE_TOKEN
          ? { 'X-iSpeak-Service-Token': process.env.PYTHON_SERVICE_TOKEN } : {}) },
        maxRedirects: 0, // Do not forward the service credential to another host.
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 300000,
        maxBodyLength: 51 * 1024 * 1024
      });
      for (const header of ['x-analysis-queue-wait-ms', 'x-analysis-processing-ms']) {
        if (fastApiResponse.headers[header]) res.set(header, fastApiResponse.headers[header]);
      }
      aiScores = fastApiResponse.data;
    } catch (aiError) {
      logError('speech_analysis_request_failed', aiError);
      removeUploadedFile(req.file.path);
      const failure = mapAiError(aiError);
      if ([429, 503].includes(failure.status)) res.set('Retry-After', '5');
      return res.status(failure.status).json({ message: failure.message });
    }

    if (!usableAnalysis(aiScores)) {
      removeUploadedFile(req.file.path);
      return res.status(502).json({ message: 'Speech analysis did not return a usable result. Please record again.' });
    }
    const { availability, feedback } = analysisFeedback(aiScores);

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

    const aiFeedback = [feedback.pace, feedback.clarity, feedback.energy].join(' ');

    const storedAudioPath = await audioStorage.storeUpload(req.file, { category: 'recordings', ownerId: userId });
    const newSession = new SpeechSession({
      userId: userId,
      language: sessionLanguage,
      audioPath: storedAudioPath,
      durationSeconds,
      status: 'Completed',
      analysisValid: true,
      analysisAvailability: availability,
      analysisFeedback: feedback,
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
    saved = true;
    await audioStorage.committed(storedAudioPath);

    // Storage keys are internal; clients receive only analysis/session data.
    const responseSession = newSession.toObject();
    delete responseSession.audioPath;
    recordingStream?.destroy();
    referenceStream?.destroy();
    await audioStorage.cleanupTemp(req.file, { preserveLocal: true });
    res.status(200).json(responseSession);
  } catch (error) {
    console.error('Audio upload failed:', error instanceof StorageError ? error.code : 'SESSION_SAVE_OR_PROCESSING');
    removeUploadedFile(req.file?.path);
    if (storageFailure(res, error)) return;
    res.status(500).json({ message: "Internal server error during audio processing." });
  } finally {
    recordingStream?.destroy();
    referenceStream?.destroy();
    await audioStorage.cleanupTemp(req.file, { preserveLocal: saved });
    req.releaseAnalysis?.();
  }
};

// ANALYTICS & STATS ROUTES
exports.getUserHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid User ID format", sessions: [] });
    }

    const requestedLimit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      return res.status(400).json({ message: 'limit must be an integer from 1 to 100' });
    }
    const filter = { userId };
    if (req.query.before) {
      try {
        const cursor = JSON.parse(Buffer.from(req.query.before, 'base64url').toString());
        const date = new Date(cursor.date);
        if (!Number.isFinite(date.getTime()) || !mongoose.Types.ObjectId.isValid(cursor.id)) throw new Error('Invalid cursor');
        filter.$or = [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } }];
      } catch {
        return res.status(400).json({ message: 'Invalid history cursor' });
      }
    }
    const sessions = await SpeechSession.find(filter)
      .select('-audioPath')
      .sort({ createdAt: -1, _id: -1 })
      .limit(requestedLimit + 1)
      .populate('challengeId')
      .populate('resourceId')
      .lean();

    const hasMore = sessions.length > requestedLimit;
    if (hasMore) sessions.pop();
    const last = sessions.at(-1);
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ date: last.createdAt, id: last._id })).toString('base64url') : '';
    res.set('X-Next-Cursor', nextCursor);
    res.set('X-Total-Count', String(await SpeechSession.countDocuments({ userId })));
    res.set('Access-Control-Expose-Headers', 'X-Next-Cursor, X-Total-Count');

    res.status(200).json(sessions);
  } catch (error) {
    logError('history_query_failed', error);
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

    // Compact rows retain EVERY date/score used by lifetime averages, local
    // calendar streaks and weekly charts. Legacy callers retain full rows.
    const view = req.query.view;
    if (view && !['compact', 'summary'].includes(view)) {
      return res.status(400).json({ message: 'Unsupported statistics view' });
    }
    let sessions = [];
    if (view !== 'summary') {
      let query = SpeechSession.find({ userId }).sort({ createdAt: 1 });
      if (view === 'compact') {
        query = query.select('createdAt language overallScore paceScore clarityScore energyScore');
      } else {
        query = query.select('-audioPath').populate('challengeId').populate('resourceId');
      }
      sessions = await query.lean();
    }

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
    logError('stats_query_failed', error);
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
