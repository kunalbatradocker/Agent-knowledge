const express = require('express');
const neo4jService = require('../services/neo4jService');
const graphRAGService = require('../services/graphRAGService');
const driver = require('../config/neo4j');
const { checkConnection: checkRedisConnection } = require('../config/redis');
const { QUERY } = require('../config/constants');
const { optionalTenantContext, requireTenantContext } = require('../middleware/tenantContext');
const { requireMember, requireManager } = require('../middleware/auth');

const router = express.Router();

// Helper to convert Neo4j values to native JS
function convertNeo4jValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low !== 'undefined') return value.low;
  if (Array.isArray(value)) return value.map(convertNeo4jValue);
  if (value.properties) return convertNeo4jValue(value.properties);
  if (typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertNeo4jValue(v);
    }
    return result;
  }
  return value;
}

// Get graph data for visualization (workspace-scoped)
router.get('/data', optionalTenantContext, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || QUERY.GRAPH_DEFAULT_LIMIT;
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id || null;
    const graphData = await neo4jService.getGraphData(limit, workspaceId);
    res.json(graphData);
  } catch (error) {
    console.error('Error fetching graph data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch graph data',
      message: error.message
    });
  }
});

// Get comprehensive graph statistics (workspace-scoped)
router.get('/stats', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id || null;

    // Get stats from Graph RAG service (includes both vector store and graph)
    const ragStats = await graphRAGService.getStats();
    
    // Get additional graph details
    let graphDetails = {
      nodesByLabel: [],
      relationshipsByType: []
    };

    try {
      await driver.getServerInfo();
      const session = neo4jService.getSession();

      try {
        // Build workspace filter for stats queries
        const wsMatch = workspaceId
          ? 'WHERE n.workspace_id = $workspaceId'
          : '';
        const wsRelMatch = workspaceId
          ? 'WHERE startNode(r).workspace_id = $workspaceId OR endNode(r).workspace_id = $workspaceId'
          : '';
        const params = {};
        if (workspaceId) params.workspaceId = workspaceId;

        // Get node counts by label (workspace-scoped)
        const nodeLabelsResult = await session.run(`
          MATCH (n)
          ${wsMatch}
          WITH labels(n) AS nodeLabels, n
          UNWIND nodeLabels AS label
          WITH label, count(DISTINCT n) AS count
          WHERE count > 0
          RETURN label, count
          ORDER BY count DESC
        `, params);
        
        graphDetails.nodesByLabel = nodeLabelsResult.records.map(r => ({
          label: r.get('label'),
          count: neo4jService.toNumber(r.get('count'))
        }));

        // Get relationship counts by type (workspace-scoped)
        const relTypesResult = await session.run(`
          MATCH (a)-[r]->(b)
          ${workspaceId ? 'WHERE a.workspace_id = $workspaceId OR b.workspace_id = $workspaceId' : ''}
          WITH type(r) AS relationshipType, count(r) AS count
          WHERE count > 0
          RETURN relationshipType, count
          ORDER BY count DESC
        `, params);
        
        graphDetails.relationshipsByType = relTypesResult.records.map(r => ({
          type: r.get('relationshipType'),
          count: neo4jService.toNumber(r.get('count'))
        }));
      } finally {
        await session.close();
      }
    } catch (e) {
      console.log('Could not get detailed stats:', e.message);
    }

    res.json({
      ...ragStats,
      graphDetails
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
});

// Check Neo4j connection status
router.get('/connection', async (_req, res) => {
  try {
    const neo4jStatus = await neo4jService.checkConnection();
    const redisStatus = await checkRedisConnection();
    
    // Set cache headers to reduce polling load
    // Cache for 30 seconds since connection status doesn't change frequently
    res.set({
      'Cache-Control': 'private, max-age=30, must-revalidate',
      'ETag': `"connection-${neo4jStatus.connected}-${redisStatus.connected}"`
    });
    
    res.json({
      ...neo4jStatus,
      redis: redisStatus
    });
  } catch (error) {
    console.error('Error checking connection:', error);
    res.status(500).json({
      connected: false,
      message: 'Error checking connections',
      error: error.message
    });
  }
});

// Check Redis connection status specifically
router.get('/redis-status', async (_req, res) => {
  try {
    const status = await checkRedisConnection();
    res.json(status);
  } catch (error) {
    console.error('Error checking Redis:', error);
    res.status(500).json({
      connected: false,
      message: 'Error checking Redis connection',
      error: error.message
    });
  }
});

// Clear data from the database (workspace-scoped: Neo4j and Redis)
router.delete('/clear', requireManager, requireTenantContext, async (req, res) => {
  const { workspace_id: workspaceId, tenant_id: tenantId } = req.tenantContext;

  const results = {
    neo4j: { cleared: false, details: {} },
    redis: { cleared: false }
  };

  // Clear Neo4j (workspace-scoped only)
  try {
    await driver.getServerInfo();
    const session = neo4jService.getSession();

    try {
      // Helper to safely convert Neo4j integers
      const toNum = (val) => {
        if (val === null || val === undefined) return 0;
        if (typeof val === 'number') return val;
        if (typeof val === 'bigint') return Number(val);
        if (val.toNumber) return val.toNumber();
        if (val.low !== undefined) return val.low; // Neo4j Integer object
        return Number(val) || 0;
      };

      // First, get counts of what we're about to delete (workspace-scoped)
      const countResult = await session.run(`
        MATCH (n)
        WHERE n.workspace_id = $workspaceId
        WITH labels(n) AS labels, count(*) AS cnt
        UNWIND labels AS label
        RETURN label, sum(cnt) AS nodeCount
        ORDER BY nodeCount DESC
      `, { workspaceId });
      
      const nodeCounts = {};
      for (const record of countResult.records) {
        nodeCounts[record.get('label')] = toNum(record.get('nodeCount'));
      }
      
      // Get total before delete (workspace-scoped)
      const totalBefore = await session.run(
        'MATCH (n) WHERE n.workspace_id = $workspaceId RETURN count(n) as total',
        { workspaceId }
      );
      const totalNodes = toNum(totalBefore.records[0]?.get('total'));
      
      // Get relationship count (workspace-scoped)
      const relBefore = await session.run(
        'MATCH (n)-[r]->() WHERE n.workspace_id = $workspaceId RETURN count(r) as total',
        { workspaceId }
      );
      const totalRels = toNum(relBefore.records[0]?.get('total'));
      
      // Delete only data nodes belonging to this workspace (preserve Tenant/Workspace/Folder structure)
      await session.run(
        'MATCH (n) WHERE n.workspace_id = $workspaceId AND NOT (n:Tenant OR n:Workspace OR n:Folder) DETACH DELETE n',
        { workspaceId }
      );
      
      // Verify deletion
      const afterCount = await session.run(
        'MATCH (n) WHERE n.workspace_id = $workspaceId RETURN count(n) as total',
        { workspaceId }
      );
      const remaining = toNum(afterCount.records[0]?.get('total'));
      
      results.neo4j = { 
        cleared: remaining === 0, 
        nodesDeleted: totalNodes,
        relationshipsDeleted: totalRels,
        nodesByLabel: nodeCounts,
        remaining: remaining,
        workspaceId
      };
      
      console.log(`🗑️ Cleared Neo4j data for workspace: ${workspaceId}`);
      console.log(`   Deleted ${totalNodes} nodes, ${totalRels} relationships`);
      if (Object.keys(nodeCounts).length > 0) {
        console.log('   By label:', nodeCounts);
      }
      if (remaining > 0) {
        console.log(`   ⚠️ ${remaining} nodes could not be deleted`);
      }
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error clearing Neo4j:', error);
    results.neo4j = { cleared: false, error: error.message };
  }

  // Clear Redis vector store (workspace-scoped)
  try {
    const vectorStoreService = require('../services/vectorStoreService');
    // Get doc IDs for this workspace from Redis
    const redisService = require('../services/redisService');
    const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
    let deletedDocs = 0;
    for (const docId of docIds) {
      try {
        await vectorStoreService.deleteDocument(docId);
        await redisService.del(`doc:${docId}`);
        deletedDocs++;
      } catch (e) { /* ignore individual failures */ }
    }
    // Clear the workspace docs set
    await redisService.del(`workspace:${workspaceId}:docs`);
    results.redis = { cleared: true, documentsDeleted: deletedDocs };
  } catch (error) {
    console.error('Error clearing Redis:', error);
    results.redis = { cleared: false, error: error.message };
  }

  const allCleared = results.neo4j.cleared && results.redis.cleared;
  
  res.json({
    success: allCleared,
    message: allCleared 
      ? `All data cleared for workspace ${workspaceId}` 
      : 'Partial clear - check results for details',
    results
  });
});

/**
 * Clean up orphaned nodes (workspace-scoped)
 */
router.post('/cleanup', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId || req.tenantContext?.workspace_id || null;
    const session = neo4jService.getSession();
    const stats = { orphanedConcepts: 0, orphanedRelationships: 0 };
    const wsFilter = workspaceId ? 'AND c.workspace_id = $workspaceId' : '';
    const wsChunkFilter = workspaceId ? 'AND ch.workspace_id = $workspaceId' : '';
    const params = {};
    if (workspaceId) params.workspaceId = workspaceId;
    
    try {
      // Delete concepts not linked to any chunk (workspace-scoped)
      const conceptsResult = await session.run(`
        MATCH (c)
        WHERE c.concept_id IS NOT NULL
          AND NOT (c)-[:MENTIONED_IN]->(:Chunk)
          ${wsFilter}
        DETACH DELETE c
        RETURN count(c) as deleted
      `, params);
      stats.orphanedConcepts = neo4jService.toNumber(conceptsResult.records[0].get('deleted'));
      
      // Delete chunks not linked to any document (workspace-scoped)
      const chunksResult = await session.run(`
        MATCH (ch:Chunk)
        WHERE NOT (ch)-[:PART_OF]->(:Document)
          ${wsChunkFilter}
        DETACH DELETE ch
        RETURN count(ch) as deleted
      `, params);
      stats.orphanedChunks = neo4jService.toNumber(chunksResult.records[0].get('deleted'));
      
      console.log(`🧹 Cleanup complete${workspaceId ? ` for workspace ${workspaceId}` : ''}:`, stats);
      
      res.json({
        success: true,
        message: 'Cleanup complete',
        stats,
        workspaceId
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Repair missing relationships for search to work
 * - Creates MENTIONED_IN relationships for entities without them
 * - Creates CONTAINS_DOCUMENT relationships from Workspace to Document
 */
router.post('/repair-relationships', optionalTenantContext, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    const effectiveWorkspaceId = workspaceId || req.tenantContext?.workspace_id || null;
    const session = neo4jService.getSession();
    const stats = { 
      mentionedInCreated: 0, 
      workspaceLinksCreated: 0,
      entitiesWithoutMentions: 0 
    };
    
    try {
      console.log('🔧 Starting relationship repair...');
      
      // 1. Find entities without MENTIONED_IN relationships
      const orphanedEntitiesResult = await session.run(`
        MATCH (c)
        WHERE c.concept_id IS NOT NULL
          AND NOT (c)-[:MENTIONED_IN]->(:Chunk)
        RETURN c.concept_id as conceptId, c.label as label, c.source_document as sourceDoc, c.source as source
        LIMIT 100
      `);
      
      stats.entitiesWithoutMentions = orphanedEntitiesResult.records.length;
      console.log(`   Found ${stats.entitiesWithoutMentions} entities without MENTIONED_IN relationships`);
      
      // 2. Try to link entities to chunks based on source_document
      for (const record of orphanedEntitiesResult.records) {
        const conceptId = record.get('conceptId');
        const sourceDoc = record.get('sourceDoc');
        const source = record.get('source');
        
        // Extract document ID from source if available
        let docId = sourceDoc;
        if (!docId && source) {
          // Try to extract from source like "extraction:job-id"
          const match = source.match(/extraction:([a-f0-9-]+)/);
          if (match) {
            // Look up job to get document ID
            // For now, skip this complex case
          }
        }
        
        if (docId) {
          // Find a chunk from this document and link
          const linkResult = await session.run(`
            MATCH (c) WHERE c.concept_id = $conceptId
            MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
            WHERE d.doc_id = $docId
            WITH c, ch
            ORDER BY ch.order
            LIMIT 1
            MERGE (c)-[r:MENTIONED_IN]->(ch)
            ON CREATE SET r.created_at = datetime(), r.repaired = true
            RETURN count(r) as created
          `, { conceptId, docId });
          
          if (linkResult.records[0]?.get('created') > 0) {
            stats.mentionedInCreated++;
          }
        }
      }
      
      // 3. Ensure all documents are linked to their workspace
      if (effectiveWorkspaceId) {
        const workspaceLinkResult = await session.run(`
          MATCH (w:Workspace {workspace_id: $workspaceId})
          MATCH (d:Document)
          WHERE d.workspace_id = $workspaceId
            AND NOT (w)-[:CONTAINS_DOCUMENT]->(d)
          MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
          RETURN count(d) as linked
        `, { workspaceId: effectiveWorkspaceId });
        
        stats.workspaceLinksCreated = neo4jService.toNumber(
          workspaceLinkResult.records[0]?.get('linked') || 0
        );
      } else {
        // Link all documents to their respective workspaces
        const allWorkspaceLinkResult = await session.run(`
          MATCH (d:Document)
          WHERE d.workspace_id IS NOT NULL
          MATCH (w:Workspace {workspace_id: d.workspace_id})
          WHERE NOT (w)-[:CONTAINS_DOCUMENT]->(d)
          MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
          RETURN count(d) as linked
        `);
        
        stats.workspaceLinksCreated = neo4jService.toNumber(
          allWorkspaceLinkResult.records[0]?.get('linked') || 0
        );
      }
      
      console.log('🔧 Repair complete:', stats);
      
      res.json({
        success: true,
        message: 'Relationship repair complete',
        stats
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Repair error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/schema - Get Neo4j schema for NL-to-Cypher (workspace-scoped)
router.get('/schema', optionalTenantContext, async (req, res) => {
  try {
    const schema = await neo4jService.getSchema();
    res.json({
      success: true,
      schema,
      formatted: neo4jService.formatSchemaForLLM(schema)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/graph/query
 * Hybrid semantic query: Neo4j graph first → Redis evidence second → grounded response
 * This is the primary query endpoint for agents and apps
 */
router.post('/query', optionalTenantContext, requireMember, async (req, res) => {
  const { question, workspaceId: bodyWorkspaceId, tenantId: bodyTenantId, includeEvidence = true, topK = 5 } = req.body;
  
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }

  const workspaceId = bodyWorkspaceId || req.tenantContext?.workspace_id;
  const tenantId = bodyTenantId || req.tenantContext?.tenant_id;

  try {
    // Step 1: Graph query — generate Cypher and execute
    const cypher = await graphRAGService.generateCypher(question, workspaceId);
    let graphResults = [];
    let executedCypher = cypher;

    if (cypher) {
      try {
        graphResults = await graphRAGService.executeCypherQuery(cypher);
      } catch (execError) {
        // Cypher failed, continue with evidence-only
        console.warn('Graph query failed, falling back to evidence:', execError.message);
      }
    }

    // Step 2: Evidence retrieval — semantic search in Redis vectors
    let evidenceChunks = [];
    if (includeEvidence && tenantId && workspaceId) {
      try {
        const vectorStoreService = require('../services/vectorStoreService');
        evidenceChunks = await vectorStoreService.semanticSearch(question, topK, {
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
      } catch (evidenceError) {
        console.warn('Evidence search failed:', evidenceError.message);
      }
    }

    res.json({
      success: true,
      query: question,
      cypher: executedCypher,
      graphResults: graphResults.slice(0, 50),
      graphResultCount: graphResults.length,
      evidence: evidenceChunks.map(c => ({
        chunkId: c.chunkId,
        text: c.text,
        documentId: c.documentId,
        documentName: c.documentName,
        similarity: c.similarity,
        page: c.startPage
      })),
      evidenceCount: evidenceChunks.length
    });
  } catch (error) {
    console.error('[POST /graph/query] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/nl-to-cypher - Generate Cypher from natural language
router.post('/nl-to-cypher', optionalTenantContext, async (req, res) => {
  const { question, execute = false } = req.body;
  
  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }
  
  try {
    const cypher = await graphRAGService.generateCypher(question, req.tenantContext?.workspace_id);
    
    if (!cypher) {
      return res.status(400).json({ error: 'Could not generate Cypher query' });
    }
    
    const response = { success: true, cypher };
    
    if (execute) {
      try {
        response.results = await graphRAGService.executeCypherQuery(cypher);
        response.resultCount = response.results.length;
      } catch (execError) {
        response.executionError = execError.message;
      }
    }
    
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/cypher - Execute Cypher query (workspace-scoped)
router.post('/cypher', optionalTenantContext, async (req, res) => {
  const { query, params = {} } = req.body;
  const workspaceId = req.tenantContext?.workspace_id || null;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }
  
  // Block destructive operations
  const upperQuery = query.toUpperCase();
  if (upperQuery.includes('DELETE') || upperQuery.includes('DROP') || upperQuery.includes('REMOVE')) {
    return res.status(403).json({ error: 'Destructive operations not allowed' });
  }
  
  // Inject workspace_id into params so users can reference it
  if (workspaceId) {
    params.workspaceId = workspaceId;
  }
  
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    const records = result.records.map(record => {
      const obj = {};
      record.keys.forEach(key => {
        const value = record.get(key);
        obj[key] = convertNeo4jValue(value);
      });
      return obj;
    });
    
    // Filter results to only include nodes from this workspace
    const filteredRecords = workspaceId
      ? records.filter(record => {
          // Check if any value in the record has a mismatched workspace_id
          for (const val of Object.values(record)) {
            if (val && typeof val === 'object' && val.workspace_id && val.workspace_id !== workspaceId) {
              return false;
            }
          }
          return true;
        })
      : records;
    
    res.json({
      success: true,
      records: filteredRecords,
      summary: {
        resultCount: filteredRecords.length,
        availableAfter: result.summary.resultAvailableAfter?.toNumber?.() || 0,
        consumedAfter: result.summary.resultConsumedAfter?.toNumber?.() || 0
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
