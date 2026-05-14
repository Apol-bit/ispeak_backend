const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const resourceController = require('../controllers/resourceController');

// Multer config for reference audio uploads
// TODO [CLOUD]: Replace diskStorage with memoryStorage + cloud upload middleware
//   when migrating to S3/GCS. The file buffer will be uploaded to the cloud
//   and the returned URL stored in the DB instead of a local path.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads', 'reference_audio'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `ref_${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio file type'), false);
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Define the routes
router.get('/resources', resourceController.getAllResources);
router.post('/admin/resources', upload.single('referenceAudio'), resourceController.createResource);
router.put('/admin/resources/:id', upload.single('referenceAudio'), resourceController.updateResource);
router.delete('/admin/resources/:id', resourceController.deleteResource);

module.exports = router;