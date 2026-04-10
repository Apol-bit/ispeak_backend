const User = require('../models/User');


// Archive a User
exports.archiveUser = async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Find user and set isArchived to true
    const updatedUser = await User.findByIdAndUpdate(
      userId, 
      { 
        isArchived: true, 
        archivedAt: new Date() 
      },
      { new: true } // Returns the updated document
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "User successfully archived", user: updatedUser });
  } catch (error) {
    console.error("Archive Error:", error);
    res.status(500).json({ message: "Server error while archiving user" });
  }
};

// Unarchive (Restore) a User
exports.unarchiveUser = async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Find user and set isArchived to false, clear the archived date, and ensure they are Active
    const updatedUser = await User.findByIdAndUpdate(
      userId, 
      { 
        isArchived: false, 
        archivedAt: null,
        status: 'Active' 
      },
      { new: true } 
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "User successfully restored", user: updatedUser });
  } catch (error) {
    console.error("Unarchive Error:", error);
    res.status(500).json({ message: "Server error while restoring user" });
  }
};

// Admin Management
exports.getAllUsers = async (req, res) => {
  try {
    // FIX: Change { isArchived: false } to { isArchived: { $ne: true } }
    const activeUsers = await User.find({ isArchived: { $ne: true } }).select('-password');
    const archivedUsers = await User.find({ isArchived: true }).select('-password');

    res.status(200).json({ activeUsers, archivedUsers });
  } catch (error) {
    res.status(500).json({ message: "Error fetching users" });
  }
};

exports.toggleUserStatus = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    user.status = user.status === 'Banned' ? 'Active' : 'Banned';
    await user.save();
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Error updating status" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// User Profile
exports.getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateUserProfile = async (req, res) => {
  try {
    const { firstName, lastName, username } = req.body;
    const currentUser = await User.findById(req.params.userId);
    if (!currentUser) return res.status(404).json({ message: "User not found" });

    const isChangingName = (firstName && firstName !== currentUser.firstName) || (lastName && lastName !== currentUser.lastName);

    if (isChangingName && currentUser.lastProfileUpdate) {
      const daysSinceLastUpdate = (Date.now() - currentUser.lastProfileUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLastUpdate < 30) {
        return res.status(400).json({ message: `You can only change your First/Last name once every 30 days.` });
      }
    }

    if (username && username !== currentUser.username) {
      const usernameExists = await User.findOne({ username, _id: { $ne: req.params.userId } });
      if (usernameExists) return res.status(400).json({ message: "Username is already taken by another user." });
    }

    const updateData = { firstName, lastName, username };
    if (isChangingName) updateData.lastProfileUpdate = new Date();

    const updatedUser = await User.findByIdAndUpdate(req.params.userId, updateData, { new: true, runValidators: true }).select('-password');
    res.status(200).json({ message: "Profile updated successfully!", user: updatedUser });
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ message: "Error updating profile" });
  }
};