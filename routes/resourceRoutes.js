const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const resourceController = require('../controllers/resourceController');
const { authenticate, authorizeRoles } = require('../middleware/auth');
const { storage } = require('../services/storageService');

router.use(authenticate);

// Multer config for reference audio uploads
// TODO [CLOUD]: Replace diskStorage with memoryStorage + cloud upload middleware
//   when migrating to S3/GCS. The file buffer will be uploaded to the cloud
//   and the returned URL stored in the DB instead of a local path.
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, storage.getUploadDirectory('reference_audio'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `ref_${uniqueSuffix}${path.extname(file.originalname)}`);
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
    if (error) return res.status(400).json({ message: error.message });
    return next();
  });
};

// Define the routes
router.get('/resources', resourceController.getAllResources);
router.post('/admin/resources', authorizeRoles('admin', 'validator'), uploadReferenceAudio, resourceController.createResource);
router.put('/admin/resources/:id', authorizeRoles('admin', 'validator'), uploadReferenceAudio, resourceController.updateResource);
router.delete('/admin/resources/:id', authorizeRoles('admin', 'validator'), resourceController.deleteResource);

module.exports = router;
