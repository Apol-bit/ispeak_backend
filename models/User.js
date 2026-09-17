const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 40,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    maxlength: 254,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'validator'], 
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
  },

  age: {
    type: Number,
    default: null
  },
  gender: {
    type: String,
    default: null
  },
  gradeLevel: {
    type: String,
    default: null
  },
  initialLevel: {
    type: String,
    default: null
  },

  isArchived: { 
    type: Boolean, 
    default: false 
  },
  archivedAt: { 
    type: Date, 
    default: null 
  },
  termsAcceptedAt: {
    type: Date,
    default: null,
  },
  termsVersion: {
    type: String,
    default: null,
  },
},
  { timestamps: true });
module.exports = mongoose.model('User', userSchema);
