const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate, authorizeRoles, requireSelfOrRoles } = require('../middleware/auth');

router.use(authenticate);

// Admin Management
router.get('/users', authorizeRoles('admin'), userController.getAllUsers);
router.patch('/users/:id/status', authorizeRoles('admin'), userController.toggleUserStatus);
router.put('/users/:id/archive', authorizeRoles('admin'), userController.archiveUser);
router.put('/users/:id/unarchive', authorizeRoles('admin'), userController.unarchiveUser);
router.delete('/users/:id', authorizeRoles('admin'), userController.deleteUser);

// Profiles
router.get('/user/:userId', requireSelfOrRoles({ roles: ['admin'] }), userController.getUserProfile);
router.put('/user/:userId', requireSelfOrRoles({ roles: ['admin'] }), userController.updateUserProfile);
router.patch(
  '/users/:id/demographics',
  requireSelfOrRoles({ param: 'id', roles: ['admin'] }),
  userController.saveDemographics
);

module.exports = router;
