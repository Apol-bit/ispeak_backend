const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: 
  {
    type: String,
    required: true,
  },
  email: 
  {
    type: String,
    required: true,
    unique: true, //Prevents duplicate accounts
  },
  password: 
  {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['user', 'admin'], 
    default: 'user'          
  }
}, 
{ 
  timestamps: true //Automatically adds 'createdAt' and 'updatedAt'
});

module.exports = mongoose.model('User', userSchema);