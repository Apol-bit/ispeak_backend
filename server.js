const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const User = require('./models/User');
const SpeechSession = require('./models/SpeechSession'); 
const jwt = require('jsonwebtoken'); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();


//Automatically create the uploads folder if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Created uploads folder');
}

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

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB!'))
  .catch((err) => console.error('MongoDB connection error:', err));


app.post('/api/signup', async (req, res) => 
  {
  try {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already in use!' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name,
      email,
      password: hashedPassword,
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
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

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
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

app.get('/', (req, res) => {
  res.send('iSpeak API is running!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

app.get('/api/users', async (req, res) => {
  try 
  {
    const users = await User.find().select('-password'); 
    res.status(200).json(users);
  } catch (error)
  {
    console.error(error);
    res.status(500).json({ message: "Server error fetching users" });
  }
});

app.post('/api/save-session', async (req, res) => {
  try {
    const { userId, wpmScore, fillerWordCount, energyScore, transcription } = req.body;
    const existingUser = await User.findById(userId);
    if (!existingUser) {
      return res.status(404).json({ message: "Security Alert: User not found! Cannot save score." });
    }

    const newSession = new SpeechSession({
      user: userId,
      wpmScore,
      fillerWordCount,
      energyScore,
      transcription
    });

    await newSession.save();

    res.status(201).json({ message: "Speech session saved successfully!", session: newSession });
  } catch (error) {
    res.status(500).json({ message: "Error saving session", error: error.message });
  }
});

app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const { userId } = req.body; 

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded!" });
    }

    const newSession = new SpeechSession({
      userId: userId,
      audioPath: req.file.path, 
    });

    await newSession.save();

    res.status(200).json({ 
      message: "Audio caught and linked to database!", 
      sessionId: newSession._id,
      filePath: newSession.audioPath 
    });
  } catch (error) {
    res.status(500).json({ message: "Error linking audio to database", error: error.message });
  }
});

app.get('/api/sessions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const sessions = await SpeechSession.find({ userId: userId }).sort({ createdAt: -1 });

    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ message: "No sessions found for this user." });
    }

    res.status(200).json(sessions);
  } catch (error) {
    res.status(500).json({ message: "Error fetching history", error: error.message });
  }
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const mongoose = require('mongoose');

    const stats = await SpeechSession.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },

      {
        $group: {
          _id: "$userId",
          totalSessions: { $sum: 1 },
          avgWPM: { $avg: "$wpmScore" },
          avgEnergy: { $avg: "$energyScore" },
          totalFillers: { $sum: "$fillerWordCount" }
        }
      }
    ]);

    if (stats.length === 0) {
      return res.status(404).json({ message: "No data found for this user." });
    }

    res.status(200).json(stats[0]);
  } catch (error) {
    res.status(500).json({ message: "Error calculating stats", error: error.message });
  }
});

app.post('/api/analyze-audio', upload.single('audio'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const aiScores = await runYourAiModel(filePath); 

    fs.unlink(filePath, (err) => {
      if (err) {
        console.error("Warning: Could not delete audio file:", err);
      } else {
        console.log("Audio file deleted successfully to save server space.");
      }
    });

    res.status(200).json({ message: "Analysis complete", scores: aiScores });

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});