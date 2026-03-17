const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); 
const FormData = require('form-data'); 
require('dotenv').config();

const User = require('./models/User');
const SpeechSession = require('./models/SpeechSession'); 

// MULTER CONFIG
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); 
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

const app = express();
app.use(cors());
app.use(express.json()); 

// MONGODB CONNECTION
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB!'))
  .catch((err) => console.error('MongoDB connection error:', err));

// ==========================================
// AUTHENTICATION ROUTES 
// ==========================================

app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, username, email, password } = req.body;
    
    const existingEmail = await User.findOne({ email });
    if (existingEmail) return res.status(400).json({ message: 'Email already in use!' });

    const existingUsername = await User.findOne({ username });
    if (existingUsername) return res.status(400).json({ message: 'Username is already taken!' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      firstName,
      lastName,
      username,
      email,
      password: hashedPassword,
      status: 'Active'
    });

    await newUser.save();
    res.status(201).json({ message: 'Account created successfully!' });
  } catch (error) {
    console.error('Sign Up Error:', error);
    res.status(500).json({ message: 'Server error during sign up' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: 'Invalid email or password' });

    if (user.status === 'Banned') {
      return res.status(403).json({ 
        message: 'Your account has been suspended. Please contact the administrator.' 
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid email or password' });

    const token = jwt.sign(
      { userId: user._id, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: '30d' }
    );

    res.status(200).json({
      message: 'Login successful!',
      token: token,
      user: { 
        id: user._id, 
        firstName: user.firstName, 
        lastName: user.lastName, 
        username: user.username, 
        email: user.email, 
        role: user.role 
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error during login' });
  }
});

// ==========================================
// ADMIN MANAGEMENT ROUTES 
// ==========================================

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().select('-password'); 
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: "Server error fetching users" });
  }
});

app.patch('/api/users/:id/status', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    user.status = user.status === 'Banned' ? 'Active' : 'Banned';
    await user.save();
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Error updating status" });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// USER PROFILE & SESSIONS
// ==========================================

app.get('/api/user/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.put('/api/user/:userId', async (req, res) => {
  try {
    const { firstName, lastName, username } = req.body;
    
    const currentUser = await User.findById(req.params.userId);
    if (!currentUser) return res.status(404).json({ message: "User not found" });

    const isChangingName = 
      (firstName && firstName !== currentUser.firstName) || 
      (lastName && lastName !== currentUser.lastName);

    if (isChangingName && currentUser.lastProfileUpdate) {
      const daysSinceLastUpdate = (Date.now() - currentUser.lastProfileUpdate.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceLastUpdate < 30) {
        const daysLeft = Math.ceil(30 - daysSinceLastUpdate);
        return res.status(400).json({ 
          message: `You can only change your First/Last name once every 30 days. Please wait ${daysLeft} more days.` 
        });
      }
    }

    if (username && username !== currentUser.username) {
      const usernameExists = await User.findOne({ username, _id: { $ne: req.params.userId } });
      if (usernameExists) return res.status(400).json({ message: "Username is already taken by another user." });
    }

    const updateData = { firstName, lastName, username };
    
    if (isChangingName) {
      updateData.lastProfileUpdate = new Date();
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.userId, 
      updateData, 
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({ message: "Profile updated successfully!", user: updatedUser });
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ message: "Error updating profile" });
  }
});

// ==========================================
// AUDIO UPLOAD ROUTE 
// ==========================================

/* // ---------------------------------------------------------------------
// FINAL PRODUCTION AI ROUTE (UNCOMMENT THIS WHEN FASTAPI IS READY)
// ---------------------------------------------------------------------
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const { userId, language } = req.body; 
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });

    const formData = new FormData();
    formData.append('audio', fs.createReadStream(req.file.path)); 
    formData.append('language', language || 'English'); 

    let aiScores;
    try {
      const fastApiResponse = await axios.post('http://127.0.0.1:8000/analyze', formData, {
        headers: { ...formData.getHeaders() }
      });
      aiScores = fastApiResponse.data; 
    } catch (aiError) {
      console.error("FastAPI Connection Error:", aiError.message);
      return res.status(503).json({ message: "AI Evaluation Engine offline." });
    }

    const newSession = new SpeechSession({ 
      userId: userId, 
      language: language || 'English',
      audioPath: req.file.path,
      paceScore: aiScores.paceScore || 0,
      clarityScore: aiScores.clarityScore || 0,
      energyScore: aiScores.energyScore || 0,
      overallScore: aiScores.overallScore || 0,
      transcription: aiScores.transcription || "No transcription available."
    });
    
    await newSession.save();
    res.status(200).json({ message: "Audio analyzed successfully!", sessionId: newSession._id, scores: aiScores });
  } catch (error) {
    console.error('Audio Upload/AI Error:', error);
    res.status(500).json({ message: "Internal server error during audio processing." });
  }
});
*/

// ---------------------------------------------------------------------
// ACTIVE LOCAL ROUTE (Works right now without AI)
// ---------------------------------------------------------------------
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const { userId } = req.body; 
    
    if (!req.file) return res.status(400).json({ message: "No file uploaded!" });

    // Simply save the audio file to the database so the app can proceed
    const newSession = new SpeechSession({ 
      userId: userId, 
      audioPath: req.file.path 
      // Scores will automatically default to 0 based on our schema
    });
    
    await newSession.save();

    res.status(200).json({ 
      message: "Audio uploaded locally!", 
      sessionId: newSession._id 
    });

  } catch (error) {
    console.error('Audio Upload Error:', error);
    res.status(500).json({ message: "Error saving audio locally" });
  }
});


// ==========================================
// ANALYTICS & GLOBAL STATS
// ==========================================

app.get('/api/sessions/:userId', async (req, res) => {
  try {
    const sessions = await SpeechSession.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.status(200).json(sessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching history" });
  }
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const sessions = await SpeechSession.find({ userId }).sort({ createdAt: 1 });
    const stats = await SpeechSession.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { 
          _id: "$userId", 
          totalSessions: { $sum: 1 }, 
          avgOverall: { $avg: "$overallScore" },
          avgPace: { $avg: "$paceScore" }, 
          avgClarity: { $avg: "$clarityScore" }, 
          avgEnergy: { $avg: "$energyScore" } 
        } 
      }
    ]);
    res.status(200).json({ sessions, overallStats: stats[0] || null });
  } catch (error) {
    res.status(500).json({ message: "Error calculating stats" });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalSessions = await SpeechSession.countDocuments();
    const globalStats = await SpeechSession.aggregate([{ $group: { _id: null, avgOverall: { $avg: "$overallScore" } } }]);
    res.status(200).json({ totalUsers, totalSessions, avgAppScore: Math.round(globalStats[0]?.avgOverall || 0) });
  } catch (error) {
    res.status(500).json({ message: "Error fetching stats" });
  }
});

app.get('/api/admin/recent-sessions', async (req, res) => {
  try {
    const recentSessions = await SpeechSession.find().sort({ createdAt: -1 }).limit(50);
    res.status(200).json(recentSessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching recent sessions" });
  }
});

// SERVER INIT
app.get('/', (req, res) => res.send('iSpeak API is running!'));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));