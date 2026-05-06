const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Log incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ROUTE IMPORTS
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const sessionRoutes = require('./routes/sessionRoutes');
const resourceRoutes = require('./routes/resourceRoutes');

// MOUNT ROUTES
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', sessionRoutes);
app.use('/api', resourceRoutes);

// MONGODB CONNECTION & SERVER INIT
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Successfully connected to MongoDB!');
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => console.log(`Server is running on http://0.0.0.0:${PORT}`)); 
  })
  .catch((err) => console.error('MongoDB connection error:', err));

app.get('/', (req, res) => res.send('iSpeak API is running!'));