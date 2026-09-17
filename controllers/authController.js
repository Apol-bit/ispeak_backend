const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMS_VERSION = process.env.TERMS_VERSION || '1.0';

function exactCaseInsensitive(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

function createToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      issuer: process.env.JWT_ISSUER || 'ispeak-api',
      audience: process.env.JWT_AUDIENCE || 'ispeak-clients',
    }
  );
}

function publicUser(user) {
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    role: user.role,
  };
}

exports.signup = async (req, res) => {
  try {
    const { firstName, lastName, username, email, password, acceptTerms, termsVersion } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedUsername = String(username || '').trim().toLowerCase();
    const cleanFirstName = String(firstName || '').trim();
    const cleanLastName = String(lastName || '').trim();

    if (!cleanFirstName || !cleanLastName || !normalizedUsername || !normalizedEmail || !password) {
      return res.status(400).json({ message: 'All account fields are required' });
    }
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (acceptTerms !== true || termsVersion !== TERMS_VERSION) {
      return res.status(400).json({ message: 'You must accept the current terms and conditions' });
    }
    
    const existingEmail = await User.findOne({ email: exactCaseInsensitive(normalizedEmail) });
    if (existingEmail) return res.status(400).json({ message: 'Email already in use!' });

    const existingUsername = await User.findOne({ username: exactCaseInsensitive(normalizedUsername) });
    if (existingUsername) return res.status(400).json({ message: 'Username is already taken!' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      firstName: cleanFirstName,
      lastName: cleanLastName,
      username: normalizedUsername,
      email: normalizedEmail,
      password: hashedPassword,
      status: 'Active',
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    });
    await newUser.save();
    const token = createToken(newUser);
    
    res.status(201).json({ 
      message: 'Account created successfully!', 
      token,
      userId: newUser._id,
      user: publicUser(newUser),
    });
  } catch (error) {
    console.error('Sign Up Error:', error);
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'Email or username is already in use' });
    }
    res.status(500).json({ message: 'Server error during sign up' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    const user = await User.findOne({ email: exactCaseInsensitive(normalizedEmail) });

    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (user.status === 'Banned') {
      return res.status(403).json({ message: 'Your account has been suspended. Please contact the administrator.' });
    }

    if (user.isArchived) {
      return res.status(403).json({ message: "This account has been archived. Please contact support." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid email or password' });

    const token = createToken(user);

    res.status(200).json({
      message: 'Login successful!', token,
      user: publicUser(user),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error during login' });
  }
};

exports.me = async (req, res) => {
  res.status(200).json({ user: publicUser(req.auth.user) });
};
