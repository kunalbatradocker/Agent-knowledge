#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const clientPort = process.env.CLIENT_PORT || process.env.REACT_APP_PORT || 3000;
const serverPort = process.env.SERVER_PORT || process.env.PORT || 5002;

console.log(`Starting client on port ${clientPort}...`);
console.log(`API proxy target: http://localhost:${serverPort}`);

// Spawn the React app with the correct environment variables
// Note: PORT is used by React for the client port
// SERVER_PORT is used by setupProxy.js for the backend API port
const child = spawn('npm', ['start'], {
  cwd: path.join(__dirname, '../client'),
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    PORT: clientPort, // React dev server port
    SERVER_PORT: serverPort // Backend API port (used by proxy)
  }
});

child.on('error', (error) => {
  console.error('Failed to start client:', error);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code);
});

