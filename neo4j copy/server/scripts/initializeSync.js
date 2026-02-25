/**
 * Initialize GraphDB to Neo4j Sync
 * Run initial sync on server startup
 */

const graphDBNeo4jSyncService = require('../services/graphDBNeo4jSyncService');
const logger = require('../utils/logger');

async function initializeSync() {
  try {
    logger.info('🔄 Initializing GraphDB → Neo4j sync on startup');
    
    // Run initial sync (incremental — only adds/updates, no clear)
    await graphDBNeo4jSyncService.syncAll('default', 'default', { mode: 'incremental' });
    
    logger.info('✅ Initial GraphDB → Neo4j sync completed');
    
  } catch (error) {
    logger.warn('⚠️ Initial sync failed, will retry on next operation:', error.message);
  }
}

module.exports = { initializeSync };
