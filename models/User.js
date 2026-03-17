const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  username: {
    type: String,
    required: true,
    unique: true, 
  },
  email: {
    type: String,
    required: true,
    unique: true, 
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['user', 'admin'], 
    default: 'user'          
  },
  status: {
    type: String,
    enum: ['Active', 'Banned'],
    default: 'Active'
  },
  lastProfileUpdate: {
    type: Date,
    default: null
  }
}, 
{ 
  timestamps: true 
});

module.exports = mongoose.model('User', userSchema);