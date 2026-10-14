const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('node:crypto');
const resourceController = require('../controllers/resourceController');
const { authenticate, authorizeRoles } = require('../middleware/auth');
const { storage } = require('../services/storageService');

router.use(authenticate);

// Multer config for reference audio uploads
// R2 returns an OS scratch directory; local mode keeps its established directory.
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, storage.getUploadDirectory('reference_audio'));
  },
  filename: (req, file, cb) => {
    cb(null, `ref_${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
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
  limits: { fileSize: 25 * 1024 * 1024 }
});

const uploadReferenceAudio = (req, res, next) => {
  upload.single('referenceAudio')(req, res, (error) => {
    if (error) {
      const invalid = error instanceof multer.MulterError || error.message === 'Unsupported audio file type';
      return res.status(invalid ? 400 : 503).json({ message: invalid ? error.message : 'Unable to store reference audio. Please try again.' });
    }
    return next();
  });
};

// Define the routes
router.get('/resources', resourceController.getAllResources);
router.get('/admin/resources/:id/reference-audio', authorizeRoles('admin', 'validator'), resourceController.getReferenceAudio);
router.post('/admin/resources', authorizeRoles('admin', 'validator'), uploadReferenceAudio, resourceController.createResource);
router.patch('/admin/resources/reorder', authorizeRoles('admin', 'validator'), resourceController.reorderResources);
router.put('/admin/resources/:id', authorizeRoles('admin', 'validator'), uploadReferenceAudio, resourceController.updateResource);
router.delete('/admin/resources/:id', authorizeRoles('admin', 'validator'), resourceController.deleteResource);

module.exports = router;
