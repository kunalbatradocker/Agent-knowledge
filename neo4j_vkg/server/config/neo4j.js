const neo4j = require('neo4j-driver');
const path = require('path');

// Ensure dotenv is loaded (in case this module is required before server/index.js)
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Read config - these will now have the correct values from .env
let uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'password';

// Fix common URI protocol issues
if (uri.startsWith('neo4j://')) {
  console.warn('⚠️  Converting neo4j:// URI to bolt:// (driver requires bolt://)');
  uri = uri.replace('neo4j://', 'bolt://');
}
if (uri.startsWith('neo4j+s://')) {
  console.warn('⚠️  Converting neo4j+s:// URI to bolt+s:// (driver requires bolt+s://)');
  uri = uri.replace('neo4j+s://', 'bolt+s://');
}

// Create driver with connection pool settings
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
  maxConnectionPoolSize: 50,
  connectionAcquisitionTimeout: 2 * 60 * 1000, // 2 minutes
  disableLosslessIntegers: true
});

// Getter function for database name (reads env var at call time, not module load time)
driver.getDatabase = () => process.env.NEO4J_DATABASE || 'neo4j';

// For backward compatibility, also set as property (but getter is preferred)
Object.defineProperty(driver, 'database', {
  get: () => process.env.NEO4J_DATABASE || 'neo4j'
});

// Test connection (non-blocking - don't fail server startup if Neo4j is down)
async function testNeo4jConnection() {
  try {
    const serverInfo = await driver.getServerInfo();
    const database = driver.getDatabase();
    console.log(`✅ Connected to Neo4j`);
    console.log(`   URI: ${uri}`);
    console.log(`   Database: ${database}`);
    console.log(`   Server: ${serverInfo.agent || 'Neo4j'}`);
    return true;
  } catch (error) {
    const database = driver.getDatabase();
    console.warn('⚠️  Warning: Could not connect to Neo4j database.');
    console.warn(`   Error: ${error.message}`);
    console.warn('   The server will start, but graph operations will fail until Neo4j is available.');
    console.warn('   Troubleshooting:');
    console.warn('   1. Check if Neo4j is running: neo4j status (or check Docker/process)');
    console.warn('   2. Verify connection settings in .env:');
    console.warn(`      NEO4J_URI=${uri}`);
    console.warn(`      NEO4J_USER=${user}`);
    console.warn(`      NEO4J_DATABASE=${database}`);
    console.warn('   3. Test connection manually: cypher-shell -a ' + uri.replace('bolt://', 'neo4j://'));
    return false;
  }
}

// Test connection with retry
let connectionTestAttempted = false;
async function testConnectionWithRetry() {
  if (connectionTestAttempted) return;
  connectionTestAttempted = true;
  
  // Try immediately
  const connected = await testNeo4jConnection();
  
  // If failed, retry after 2 seconds (Neo4j might be starting)
  if (!connected) {
    setTimeout(async () => {
      console.log('\n🔄 Retrying Neo4j connection...');
      await testNeo4jConnection();
    }, 2000);
  }
}

testConnectionWithRetry();

// Close driver on process termination
process.on('exit', () => {
  try {
    driver.close();
  } catch (error) {
    // Ignore errors on shutdown
  }
});

process.on('SIGINT', () => {
  try {
    driver.close();
  } catch (error) {
    // Ignore errors on shutdown
  }
});

process.on('SIGTERM', () => {
  try {
    driver.close();
  } catch (error) {
    // Ignore errors on shutdown
  }
});

module.exports = driver;

