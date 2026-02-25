/**
 * Cleanup Script: Remove Ontology Keys from Redis
 * 
 * Run this script to remove all ontology-related keys from Redis.
 * Ontologies are now stored as YAML files only.
 * 
 * Usage: node scripts/cleanup-ontology-redis.js
 */

const { client, connectRedis } = require('../server/config/redis');

const ONTOLOGY_KEY_PATTERNS = [
  'ontology:pack:*',
  'ontology:version:*',
  'ontology:pack_versions:*',
  'ontology:active:*',
  'ontology:packs',
  'ontology:predefined:*',
  'ontology:custom:*'
];

async function cleanupOntologyKeys() {
  console.log('🧹 Ontology Redis Cleanup Script');
  console.log('='.repeat(50));
  console.log('');
  console.log('This script removes all ontology-related keys from Redis.');
  console.log('Ontologies are now stored as YAML files in server/data/ontologies/');
  console.log('');

  try {
    await connectRedis();
    console.log('✅ Connected to Redis');
    console.log('');

    let totalDeleted = 0;

    for (const pattern of ONTOLOGY_KEY_PATTERNS) {
      console.log(`🔍 Scanning for: ${pattern}`);
      
      const keys = await client.keys(pattern);
      
      if (keys.length === 0) {
        console.log(`   No keys found`);
        continue;
      }

      console.log(`   Found ${keys.length} key(s):`);
      for (const key of keys) {
        console.log(`      - ${key}`);
      }

      // Delete the keys
      if (keys.length > 0) {
        await client.del(keys);
        totalDeleted += keys.length;
        console.log(`   ✅ Deleted ${keys.length} key(s)`);
      }
      console.log('');
    }

    console.log('='.repeat(50));
    console.log(`✅ Cleanup complete! Deleted ${totalDeleted} key(s)`);
    console.log('');
    console.log('Ontologies are now managed via YAML files:');
    console.log('  - System: server/data/ontologies/*.yaml');
    console.log('  - Workspace: server/data/ontologies/workspaces/{id}/*.yaml');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.quit();
    process.exit(0);
  }
}

cleanupOntologyKeys();
