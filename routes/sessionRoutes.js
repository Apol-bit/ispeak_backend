const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const multer = require('multer');

// MULTER CONFIG
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Routes

//router.post('/upload-audio', upload.single('audio'), sessionController.uploadAudioAI);
router.post('/upload-audio', upload.single('audio'), sessionController.uploadAudioLocal);
router.get('/sessions/:userId', sessionController.getUserHistory);
router.get('/stats/:userId', sessionController.getUserStats);
router.get('/admin/stats', sessionController.getAdminGlobalStats);
router.get('/admin/recent-sessions', sessionController.getAdminRecentSessions);

module.exports = router;