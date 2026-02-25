/**
 * Cleanup Routes
 * Data cleanup and maintenance operations
 */

const express = require('express');
const router = express.Router();

const neo4jService = require('../../services/neo4jService');
const vectorStoreService = require('../../services/vectorStoreService');
const ontologyJobService = require('../../services/ontologyJobService');
const graphDBStore = require('../../services/graphDBStore');

/**
 * POST /api/ontology/cleanup-orphans
 * Clean up orphan Document nodes (workspace-scoped)
 */
router.post('/orphans', async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId || req.query.workspace_id || null;
    console.log(`🧹 Cleaning up ORPHAN DOCUMENTS${workspaceId ? ` for workspace ${workspaceId}` : ''}`);
    
    const session = neo4jService.getSession();
    const results = { orphanDocuments: 0, invalidDocuments: 0 };
    const wsFilter = workspaceId ? 'AND d.workspace_id = $workspaceId' : '';
    const params = {};
    if (workspaceId) params.workspaceId = workspaceId;
    
    try {
      // Delete Document nodes without chunks (workspace-scoped)
      const orphanResult = await session.run(`
        MATCH (d:Document)
        WHERE NOT EXISTS { MATCH (:Chunk)-[:PART_OF]->(d) }
        ${wsFilter}
        DETACH DELETE d RETURN count(d) as deleted
      `, params);
      results.orphanDocuments = neo4jService.toNumber(orphanResult.records[0].get('deleted'));
      
      // Delete Document nodes without doc_id (workspace-scoped)
      const invalidResult = await session.run(`
        MATCH (d:Document)
        WHERE (d.doc_id IS NULL OR d.doc_id = '')
        ${wsFilter}
        DETACH DELETE d RETURN count(d) as deleted
      `, params);
      results.invalidDocuments = neo4jService.toNumber(invalidResult.records[0].get('deleted'));
      
      const total = results.orphanDocuments + results.invalidDocuments;
      
      res.json({
        success: true,
        message: total > 0 ? `Cleaned up ${total} orphan/invalid documents` : 'No orphan documents found',
        results
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error cleaning up orphans:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/cleanup-jobs
 * Clean up old ontology processing jobs from Redis
 */
router.post('/jobs', async (req, res) => {
  try {
    const { workspaceId, force } = req.body;
    
    console.log('🧹 Cleaning up ONTOLOGY JOBS');
    
    if (workspaceId) {
      // Clean up jobs for specific workspace
      const result = await ontologyJobService.cleanupWorkspaceJobs(workspaceId);
      res.json({
        success: true,
        message: `Cleaned up ${result.deletedCount} jobs for workspace ${workspaceId}`,
        ...result
      });
    } else if (force) {
      // Force cleanup of all old jobs
      await ontologyJobService.cleanupOldJobs();
      const stats = await ontologyJobService.getJobStats();
      res.json({
        success: true,
        message: 'Forced cleanup completed',
        stats
      });
    } else {
      // Normal cleanup (respects retention periods)
      await ontologyJobService.cleanupOldJobs();
      const stats = await ontologyJobService.getJobStats();
      res.json({
        success: true,
        message: 'Job cleanup completed',
        stats
      });
    }
  } catch (error) {
    console.error('Error cleaning up jobs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/cleanup
 * Clean up/delete data from the knowledge graph (workspace-scoped)
 */
router.post('/', async (req, res) => {
  try {
    const { documents, chunks, entities, relationships, all } = req.body;
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] || null;
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'] || null;

    if (!workspaceId || !tenantId) {
      return res.status(400).json({ 
        success: false, 
        error: 'tenantId and workspaceId are required for cleanup operations' 
      });
    }
    
    console.log(`🗑️ Cleanup request for workspace: ${workspaceId}`);
    
    const session = neo4jService.getSession();
    const results = {
      documentsDeleted: 0,
      chunksDeleted: 0,
      entitiesDeleted: 0,
      relationshipsDeleted: 0
    };
    
    try {
      const systemLabels = ['Document', 'Chunk', 'Folder', 'Provenance', 'Source', 'MergeRecord', 'DataConnector', 'SchemaVersion', 'Role', 'User', 'Workspace', 'Tenant'];
      
      if (all) {
        // Clear Redis for this workspace
        try {
          const redisService = require('../../services/redisService');
          const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
          for (const docId of docIds) {
            try {
              await vectorStoreService.deleteDocument(docId);
              await redisService.del(`doc:${docId}`);
            } catch (e) { /* ignore */ }
          }
          await redisService.del(`workspace:${workspaceId}:docs`);
          results.redisClear = { cleared: true, documentsDeleted: docIds.length };
        } catch (e) {
          console.warn('Could not clear Redis:', e.message);
        }
        
        // Delete all nodes for this workspace
        let moreNodes = true;
        while (moreNodes) {
          const nodeResult = await session.run(`
            MATCH (n) WHERE n.workspace_id = $workspaceId
            WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) as deleted
          `, { workspaceId });
          const deleted = neo4jService.toNumber(nodeResult.records[0].get('deleted'));
          results.documentsDeleted += deleted;
          moreNodes = deleted > 0;
        }
      } else {
        // Selective deletion (workspace-scoped)
        if (relationships) {
          const relResult = await session.run(`
            MATCH (a)-[r]->(b)
            WHERE (a.workspace_id = $workspaceId OR b.workspace_id = $workspaceId)
              AND NOT type(r) IN ['PART_OF', 'CONTAINS', 'HAS_VERSION', 'OWNS', 'CHILD_OF', 'IN_FOLDER', 'CONTAINS_FOLDER']
            WITH r LIMIT 50000 DELETE r RETURN count(r) as deleted
          `, { workspaceId });
          results.relationshipsDeleted = neo4jService.toNumber(relResult.records[0].get('deleted'));
        }
        
        if (entities) {
          let moreEntities = true;
          while (moreEntities) {
            const entityResult = await session.run(`
              MATCH (n)
              WHERE n.workspace_id = $workspaceId
                AND NOT any(label IN labels(n) WHERE label IN $systemLabels)
              WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) as deleted
            `, { systemLabels, workspaceId });
            const deleted = neo4jService.toNumber(entityResult.records[0].get('deleted'));
            results.entitiesDeleted += deleted;
            moreEntities = deleted > 0;
          }
        }
        
        if (chunks) {
          let moreChunks = true;
          while (moreChunks) {
            const chunkResult = await session.run(`
              MATCH (c:Chunk) WHERE c.workspace_id = $workspaceId
              WITH c LIMIT 10000 DETACH DELETE c RETURN count(c) as deleted
            `, { workspaceId });
            const deleted = neo4jService.toNumber(chunkResult.records[0].get('deleted'));
            results.chunksDeleted += deleted;
            moreChunks = deleted > 0;
          }
        }
        
        if (documents) {
          // Get doc IDs for Redis cleanup (workspace-scoped)
          const docIdsResult = await session.run(
            `MATCH (d:Document) WHERE d.workspace_id = $workspaceId RETURN collect(d.doc_id) as docIds`,
            { workspaceId }
          );
          const docIds = docIdsResult.records[0]?.get('docIds') || [];
          
          // Delete from Neo4j (workspace-scoped)
          const docResult = await session.run(`
            MATCH (d:Document) WHERE d.workspace_id = $workspaceId
            OPTIONAL MATCH (c:Chunk)-[:PART_OF]->(d)
            WITH d, collect(c) as chunks
            UNWIND chunks + [d] as node
            DETACH DELETE node
            RETURN count(DISTINCT d) as docsDeleted
          `, { workspaceId });
          results.documentsDeleted = neo4jService.toNumber(docResult.records[0].get('docsDeleted'));
          
          // Delete from Redis
          let redisDeleted = 0;
          for (const docId of docIds) {
            if (docId) {
              try {
                await vectorStoreService.deleteDocument(docId);
                redisDeleted++;
              } catch (_e) { /* ignore */ }
            }
          }
          results.redisDocuments = redisDeleted;
          
          // Delete from GraphDB data graph
          try {
            const dataGraphIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
            
            const clearUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(dataGraphIRI)}`;
            const response = await fetch(clearUrl, { method: 'DELETE' });
            results.graphdbData = response.ok;
            if (response.ok) {
              console.log(`🗑️ Cleared GraphDB data graph: ${dataGraphIRI}`);
            }
          } catch (e) {
            console.warn('GraphDB data cleanup error:', e.message);
          }
        }
      }
      
      // If clearing all, also clear GraphDB data
      if (all) {
        try {
          const dataGraphIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
          
          const clearUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(dataGraphIRI)}`;
          const response = await fetch(clearUrl, { method: 'DELETE' });
          results.graphdbData = response.ok;
          if (response.ok) {
            console.log(`🗑️ Cleared GraphDB data graph: ${dataGraphIRI}`);
          }
        } catch (e) {
          console.warn('GraphDB cleanup error:', e.message);
        }
      }
      
      // Build summary
      const parts = [];
/**
 * POST /api/ontology/cleanup/workspace-all
 * Clear all workspace ontologies and data
 */
router.post('/workspace-all', async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default' } = req.body;
    
    console.log(`🧹 Clearing all workspace data for ${tenantId}:${workspaceId}`);
    
    const result = await graphDBStore.clearWorkspaceData(tenantId, workspaceId);
    
    res.json({
      success: true,
      message: `Cleared ${result.clearedGraphs} workspace graphs`,
      result
    });
  } catch (error) {
    console.error('Workspace cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/cleanup/workspace-duplicates
 * Clean up duplicate workspace ontologies (keep only latest)
 */
router.post('/workspace-duplicates', async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default' } = req.body;
    
    console.log(`🧹 Cleaning workspace ontology duplicates for ${tenantId}:${workspaceId}`);
    
    const result = await graphDBStore.cleanupWorkspaceDuplicates(tenantId, workspaceId);
    
    res.json({
      success: true,
      message: `Cleaned up ${result.removedCount} duplicate workspace ontologies`,
      result
    });
  } catch (error) {
    console.error('Workspace cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/cleanup-graphdb-data
 * Clear data graphs in GraphDB (preserve ontologies)
 */
router.post('/graphdb-data', async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default' } = req.body;
    
    console.log(`🧹 Clearing GraphDB data for ${tenantId}:${workspaceId}`);
    
    const result = await graphDBStore.clearDataGraphs(tenantId, workspaceId);
    
    res.json({
      success: true,
      message: `Cleared ${result.clearedGraphs} data graphs from GraphDB`,
      result
    });
  } catch (error) {
    console.error('GraphDB cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

      if (results.documentsDeleted > 0) parts.push(`${results.documentsDeleted} documents`);
      if (results.chunksDeleted > 0) parts.push(`${results.chunksDeleted} chunks`);
      if (results.entitiesDeleted > 0) parts.push(`${results.entitiesDeleted} entities`);
      if (results.relationshipsDeleted > 0) parts.push(`${results.relationshipsDeleted} relationships`);
      
      res.json({
        success: true,
        message: parts.length > 0 ? `Deleted: ${parts.join(', ')}` : 'No data was deleted',
        results
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
