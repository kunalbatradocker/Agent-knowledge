/**
 * Clear all Neo4j data
 */

const neo4jService = require('../server/services/neo4jService');

async function clearAllNeo4j() {
  const session = neo4jService.getSession();
  try {
    console.log('🗑️ Clearing all Neo4j data...');
    
    // Delete all nodes and relationships
    await session.run('MATCH (n) DETACH DELETE n');
    
    console.log('✅ All Neo4j data cleared');
    return { success: true, message: 'All Neo4j data cleared' };
    
  } catch (error) {
    console.error('❌ Error clearing Neo4j:', error);
    throw error;
  } finally {
    await session.close();
  }
}

// Run if called directly
if (require.main === module) {
  clearAllNeo4j()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { clearAllNeo4j };
