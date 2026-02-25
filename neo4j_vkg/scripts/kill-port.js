#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PORT = process.env.PORT || process.env.SERVER_PORT || 5002;

try {
  console.log(`Killing processes on port ${PORT}...`);
  execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'inherit' });
  console.log(`Port ${PORT} cleared.`);
} catch (error) {
  console.log(`Port ${PORT} is already free.`);
}

