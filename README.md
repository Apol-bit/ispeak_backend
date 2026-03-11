# iSpeak Backend 🎙️

This is the Node.js backend for the **iSpeak** Public Speaking Assistant. It handles user authentication, session management, and audio file processing.

## Features
- **Authentication:** JWT-based Login & Sign-up.
- **Speech Sessions:** Stores WPM, Filler Word counts, and Energy scores in MongoDB.
- **Audio Uploads:** Handles `.m4a` files via Multer and stores them for AI analysis.

## 🛠️ Setup Instructions

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed.

### 2. Installation
Clone the repository and install dependencies:
```bash
npm install