const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const multer = require('multer');
const path = require('path');
const { authenticate, authorizeRoles, requireSelfOrRoles } = require('../middleware/auth');
const { storage } = require('../services/storageService');

router.use(authenticate);

// MULTER CONFIG
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, storage.getUploadDirectory('recordings')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
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
      return res.status(400).json({ message: error.message });
    }
    next();
  });
};

// Routes
router.post(
  '/upload-audio',
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
