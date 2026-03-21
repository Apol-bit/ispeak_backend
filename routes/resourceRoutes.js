const express = require('express');
const router = express.Router();
const resourceController = require('../controllers/resourceController');

// Define the routes
router.get('/resources', resourceController.getAllResources);
router.post('/admin/resources', resourceController.createResource);
router.put('/admin/resources/:id', resourceController.updateResource);
router.delete('/admin/resources/:id', resourceController.deleteResource);

module.exports = router;