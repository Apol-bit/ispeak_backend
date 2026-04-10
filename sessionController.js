// Updated sessionController.js

const User = require('../models/User');
const Session = require('../models/Session');

// Removed duplicate getUserHistory function

// Revised getUserHistory function
async function getUserHistory(req, res) {
    try {
        const userId = req.params.userId;
        const userSessions = await Session.find({ userId })
            .populate('userId')  // Consistent populate call
            .populate('anotherField')  // Add other necessary populate calls consistently
            .exec();

        const stats = {
            totalSessions: userSessions.length,
            // Other stats can be added here
        };

        res.status(200).json({ userSessions, stats });
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving user history', error });
    }
}

// Other functions in sessionController.js

module.exports = { getUserHistory };