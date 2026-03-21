const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Admin Management
router.get('/users', userController.getAllUsers);
router.patch('/users/:id/status', userController.toggleUserStatus);
router.delete('/users/:id', userController.deleteUser);

// Profiles
router.get('/user/:userId', userController.getUserProfile);
router.put('/user/:userId', userController.updateUserProfile);

module.exports = router;