const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { createAnalysisAdmission } = require('../middleware/analysisAdmission');
const { authenticate, authorizeRoles, requireSelfOrRoles } = require('../middleware/auth');
const { storage } = require('../services/storageService');

router.use(authenticate);

// MULTER CONFIG
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, storage.getUploadDirectory('recordings')),
  filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage: multerStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio file type'), false);
    }
  },
  // Match Python V2's default request limit so oversized files fail at the gateway.
  limits: { fileSize: 25 * 1024 * 1024 }
});

const uploadAudio = (req, res, next) => {
  upload.single('audio')(req, res, (error) => {
    if (error) {
      req.releaseAnalysis?.();
      const invalid = error instanceof multer.MulterError || error.message === 'Unsupported audio file type';
      return res.status(invalid ? 400 : 500).json({ message: invalid ? error.message : 'Unable to store the recording. Please try again.' });
    }
    next();
  });
};

// Routes
router.post(
  '/upload-audio',
  createAnalysisAdmission(),
  uploadAudio,
  sessionController.uploadAudioAI
);
//router.post('/upload-audio', upload.single('audio'), sessionController.uploadAudioLocal);
router.get('/sessions/:userId', requireSelfOrRoles(), sessionController.getUserHistory);
router.get('/stats/:userId', requireSelfOrRoles(), sessionController.getUserStats);

// Admin Routes
router.get('/admin/stats', authorizeRoles('admin'), sessionController.getAdminGlobalStats);
router.get('/admin/recent-sessions', authorizeRoles('admin'), sessionController.getAdminRecentSessions);
router.get('/admin/ai-logs', authorizeRoles('admin', 'validator'), sessionController.getAdminRecentSessions);

module.exports = router;
