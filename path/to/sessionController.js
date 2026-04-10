// sessionController.js

const User = require('../models/User');
const Session = require('../models/Session');

// Function to get user history
async function getUserHistory(req, res) {
    try {
        const userId = req.params.userId;
        const history = await Session.find({ user: userId })
            .populate('challengeId')  // populate for challengeId
            .populate('resourceId'); // populate for resourceId
        res.status(200).json(history);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user history', error });
    }
}

// Function to get user stats
async function getUserStats(req, res) {
    try {
        const userId = req.params.userId;
        const stats = await Session.find({ user: userId })
            .populate('challengeId')  // ensure populate is used
            .populate('resourceId'); // ensure populate is used
        res.status(200).json(stats);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user stats', error });
    }
}

// Function to get admin recent sessions
async function getAdminRecentSessions(req, res) {
    try {
        const sessions = await Session.find()  // Fetch all sessions
            .populate('challengeId')  // ensure populate is used
            .populate('resourceId'); // ensure populate is used
        res.status(200).json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching recent sessions', error });
    }
}

module.exports = {
    getUserHistory,
    getUserStats,
    getAdminRecentSessions
};