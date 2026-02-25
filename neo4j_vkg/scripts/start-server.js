#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

// Load environment variables from .env file
const envPath = path.join(__dirname, '../.env');
const result = require('dotenv').config({ path: envPath });

if (result.error) {
  console.warn(`⚠️  Warning: Could not load .env file from ${envPath}`);
  console.warn(`   Error: ${result.error.message}`);
} else {
  console.log(`✅ Loaded environment from ${envPath}`);
}

const PORT = process.env.PORT || process.env.SERVER_PORT || 5002;
console.log(`   PORT=${PORT} (from ${process.env.PORT ? '.env' : 'default'})`);
console.log(`   NEO4J_DATABASE=${process.env.NEO4J_DATABASE || 'neo4j (default)'}`);
console.log('');

// Kill any process using the port
try {
  console.log(`Checking port ${PORT}...`);
  const pids = execSync(`lsof -ti:${PORT}`, { encoding: 'utf-8' }).trim();
  if (pids) {
    console.log(`Found process(es) on port ${PORT}, killing...`);
    execSync(`kill -9 ${pids}`, { stdio: 'inherit' });
    // Wait a moment for the port to be released
    require('child_process').execSync('sleep 1');
    console.log(`Port ${PORT} cleared.`);
  } else {
    console.log(`Port ${PORT} is free.`);
  }
} catch (error) {
  // No process found on the port, which is fine
  console.log(`Port ${PORT} is free.`);
}

// Start the server
console.log('Starting server...');
require(path.join(__dirname, '../server/index.js'));

