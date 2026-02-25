const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis client
const client = createClient({
  url: redisUrl
});

// Handle connection events
client.on('error', (err) => {
  console.warn('⚠️  Redis Client Error:', err.message);
});

client.on('connect', () => {
  console.log('✅ Connected to Redis');
});

client.on('ready', () => {
  console.log('   Redis client ready');
});

// Connect to Redis
async function connectRedis() {
  try {
    if (!client.isOpen) {
      await client.connect();
      console.log(`✅ Connected to Redis at ${redisUrl.replace(/\/\/.*:.*@/, '//***:***@')}`);
    }
    return true;
  } catch (error) {
    console.warn('⚠️  Could not connect to Redis:', error.message);
    console.warn('   Troubleshooting:');
    console.warn('   1. Check if Redis is running: redis-cli ping');
    console.warn(`   2. Verify REDIS_URL in .env: ${redisUrl}`);
    console.warn('   3. For Docker: docker ps | grep redis');
    console.warn('   4. For local: redis-server (or brew services start redis)');
    return false;
  }
}

// Check connection status
async function checkConnection() {
  try {
    if (!client.isOpen) {
      await connectRedis();
    }
    await client.ping();
    return {
      connected: true,
      message: 'Connected to Redis',
      url: redisUrl.replace(/\/\/.*:.*@/, '//***:***@') // Hide credentials
    };
  } catch (error) {
    return {
      connected: false,
      message: 'Not connected to Redis',
      error: error.message,
      url: redisUrl.replace(/\/\/.*:.*@/, '//***:***@')
    };
  }
}

// Initialize connection with retry
let redisConnectionAttempted = false;
async function initializeRedis() {
  if (redisConnectionAttempted) return;
  redisConnectionAttempted = true;
  
  // Try immediately
  const connected = await connectRedis();
  
  // If failed, retry after 2 seconds (Redis might be starting)
  if (!connected) {
    setTimeout(async () => {
      console.log('\n🔄 Retrying Redis connection...');
      await connectRedis();
    }, 2000);
  }
}

initializeRedis();

module.exports = {
  client,
  connectRedis,
  checkConnection
};

