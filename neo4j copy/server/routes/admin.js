/**
 * Admin routes for database management
 * Separate CRUD and cleanup for GraphDB and Neo4j
 */
const express = require('express');
const router = express.Router();
const graphDBStore = require('../services/graphDBStore');
const neo4jService = require('../services/neo4jService');
const logger = require('../utils/logger');
const { optionalTenantContext } = require('../middleware/tenantContext');

// Apply optional tenant context to all admin routes
router.use(optionalTenantContext);

// ============ GraphDB Routes ============

/**
 * GET /api/admin/graphdb/stats
 * Workspace-scoped: only returns graphs belonging to the current workspace
 */
router.get('/graphdb/stats', async (req, res) => {
  try {
    const tenantId = req.tenantContext?.tenant_id || 'default';
    const workspaceId = req.tenantContext?.workspace_id || 'default';

    const baseUrl = process.env.GRAPHDB_URL || 'http://localhost:7200';
    const repo = process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1';
    const url = `${baseUrl}/repositories/${repo}`;

    const runQuery = async (sparql) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'application/sparql-results+json' },
        body: sparql
      });
      if (!response.ok) throw new Error(`SPARQL failed: ${response.status}`);
      return response.json();
    };

    // Get all named graphs with triple counts
    const graphsRes = await runQuery(`SELECT DISTINCT ?g (COUNT(*) as ?triples) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`);
    const allGraphs = graphsRes?.results?.bindings || [];

    // Filter graphs belonging to this workspace:
    // Workspace data:    .../tenant/{tenantId}/workspace/{workspaceId}/data
    // Workspace schema:  .../tenant/{tenantId}/workspace/{workspaceId}/schema/...
    // Workspace audit:   .../tenant/{tenantId}/workspace/{workspaceId}/audit
    // Tenant ontologies: .../tenant/{tenantId}/ontology/...
    // Global ontologies: .../global/ontology/...
    const wsPrefix = `/tenant/${tenantId}/workspace/${workspaceId}/`;
    const tenantOntPrefix = `/tenant/${tenantId}/ontology/`;

    const wsGraphs = allGraphs.filter(g => {
      const name = g.g?.value || '';
      return name.includes(wsPrefix) || name.includes(tenantOntPrefix) || name.includes('/global/ontology/');
    });

    let totalTriples = 0;
    wsGraphs.forEach(g => { totalTriples += parseInt(g.triples?.value || 0); });

    const ontologyGraphs = wsGraphs.filter(g => g.g?.value?.includes('/ontology/'));
    const dataGraphs = wsGraphs.filter(g => g.g?.value?.includes('/data'));

    res.json({
      totalTriples,
      totalGraphs: wsGraphs.length,
      ontologies: ontologyGraphs.length,
      dataGraphs: dataGraphs.length,
      graphs: wsGraphs.map(g => ({
        name: g.g?.value,
        triples: parseInt(g.triples?.value || 0)
      })),
      workspaceId,
      tenantId
    });
  } catch (error) {
    logger.error('GraphDB stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/graphdb/browse
 */
router.get('/graphdb/browse', async (req, res) => {
  try {
    const { type = 'all', limit = 100 } = req.query;
    
    let query;
    if (type === 'ontologies') {
      query = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?uri ?label ?graph WHERE {
          GRAPH ?graph { ?uri a owl:Ontology . OPTIONAL { ?uri rdfs:label ?label } }
        } LIMIT ${limit}
      `;
    } else if (type === 'entities') {
      query = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        SELECT DISTINCT ?uri ?type ?label WHERE {
          GRAPH ?g {
            ?uri a ?type .
            OPTIONAL { ?uri rdfs:label ?label }
          }
          FILTER(CONTAINS(STR(?g), "/data"))
        } LIMIT ${limit}
      `;
    } else {
      query = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?uri ?type ?label WHERE {
          ?uri a ?type .
          OPTIONAL { ?uri rdfs:label ?label }
        } LIMIT ${limit}
      `;
    }
    
    const result = await graphDBStore.executeSPARQL('default', 'default', query, 'all');
    const data = (result?.results?.bindings || []).map(b => ({
      uri: b.uri?.value,
      type: b.type?.value?.split('#').pop() || b.type?.value?.split('/').pop(),
      label: b.label?.value,
      graph: b.graph?.value
    }));
    
    res.json({ success: true, data });
  } catch (error) {
    logger.error('GraphDB browse error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/graphdb/delete
 */
router.post('/graphdb/delete', async (req, res) => {
  try {
    const { uris } = req.body;
    if (!uris || !Array.isArray(uris)) {
      return res.status(400).json({ success: false, error: 'uris array required' });
    }
    
    let deleted = 0;
    for (const uri of uris) {
      const deleteQuery = `DELETE WHERE { <${uri}> ?p ?o }`;
      await graphDBStore.executeSPARQL('default', 'default', deleteQuery, 'all', 'update');
      deleted++;
    }
    
    res.json({ success: true, deleted });
  } catch (error) {
    logger.error('GraphDB delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/graphdb/cleanup
 */
router.post('/graphdb/cleanup', async (req, res) => {
  try {
    const { type, tenantId = 'default', workspaceId = 'default' } = req.body;
    
    let message = '';
    let cleared = 0;
    
    const baseUrl = process.env.GRAPHDB_URL || 'http://localhost:7200';
    const repoName = process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1';
    
    // Helper to clear a specific graph by IRI
    const clearGraphByIRI = async (graphIRI) => {
      const url = `${baseUrl}/repositories/${repoName}/statements`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: `CLEAR GRAPH <${graphIRI}>`
      });
      return response.ok;
    };

    // Workspace graph prefix for filtering
    const wsPrefix = `/tenant/${tenantId}/workspace/${workspaceId}/`;
    const tenantOntPrefix = `/tenant/${tenantId}/ontology/`;
    
    if (type === 'data') {
      await graphDBStore.clearGraph(tenantId, workspaceId, 'data');
      message = 'Data graphs cleared';
    } else if (type === 'audit') {
      const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
      if (await clearGraphByIRI(auditGraphIRI)) cleared++;
      message = cleared ? 'Audit graph cleared' : 'No audit graph found';
    } else if (type === 'ontologies') {
      // Only clear ontology graphs belonging to this workspace/tenant (not global)
      const query = `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s a <http://www.w3.org/2002/07/owl#Ontology> } }`;
      const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, query, 'all');
      for (const b of result?.results?.bindings || []) {
        const g = b.g?.value;
        if (g && !g.includes('/graphs/global/') && (g.includes(wsPrefix) || g.includes(tenantOntPrefix))) {
          if (await clearGraphByIRI(g)) cleared++;
        }
      }
      message = `Cleared ${cleared} workspace ontology graphs (global ontologies preserved)`;
    } else if (type === 'all') {
      // Only clear graphs belonging to this workspace (not global ontologies or other workspaces)
      const listQuery = `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }`;
      const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, listQuery, 'all');
      for (const b of result?.results?.bindings || []) {
        const g = b.g?.value;
        if (g && !g.includes('/graphs/global/') && (g.includes(wsPrefix) || g.includes(tenantOntPrefix))) {
          if (await clearGraphByIRI(g)) cleared++;
        }
      }
      message = `Cleared ${cleared} workspace graphs (global ontologies and other workspaces preserved)`;
    }
    
    res.json({ success: true, message });
  } catch (error) {
    logger.error('GraphDB cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ LLM Monitoring ============

router.get('/llm/status', (req, res) => {
  const llmService = require('../services/llmService');
  const status = llmService.getStatus();
  // Add token expiry info
  const LLMService = require('../services/llmService').constructor;
  const tokenInfo = LLMService.parseTokenExpiry
    ? LLMService.parseTokenExpiry(llmService.bedrockApiKey)
    : { expiresAt: null, remainingSeconds: null, expired: false };
  res.json({ ...status, tokenInfo });
});

router.post('/llm/cancel-queued', (req, res) => {
  const llmService = require('../services/llmService');
  const cancelled = llmService.cancelQueued();
  res.json({ success: true, cancelled });
});

/**
 * GET /api/admin/llm/token-status
 * Get Bedrock token expiry info (server default + per-user if stored)
 */
router.get('/llm/token-status', async (req, res) => {
  const LLMService = require('../services/llmService');
  const tokenStore = require('../utils/tokenEncryption');
  const serverToken = LLMService.bedrockApiKey;
  const serverInfo = LLMService.constructor.parseTokenExpiry(serverToken);

  const userId = req.headers['x-user-id'] || 'default';
  let userInfo = null;
  try {
    const userToken = await tokenStore.getToken(userId);
    if (userToken) {
      userInfo = LLMService.constructor.parseTokenExpiry(userToken);
      userInfo.hasToken = true;
    }
  } catch (e) { /* Redis unavailable */ }

  res.json({
    provider: LLMService.provider,
    model: LLMService.model,
    server: {
      hasToken: !!serverToken,
      ...serverInfo
    },
    user: userInfo || { hasToken: false }
  });
});

/**
 * POST /api/admin/llm/token
 * Set a per-user Bedrock bearer token (encrypted at rest in Redis)
 */
router.post('/llm/token', async (req, res) => {
  const { token } = req.body;
  const userId = req.headers['x-user-id'] || 'default';

  if (!token) {
    return res.status(400).json({ success: false, error: 'token is required' });
  }

  const LLMService = require('../services/llmService');
  const tokenStore = require('../utils/tokenEncryption');
  const info = LLMService.constructor.parseTokenExpiry(token);

  try {
    const ttl = info.remainingSeconds && info.remainingSeconds > 0 ? info.remainingSeconds : 43200;
    await tokenStore.storeToken(userId, token, ttl);
  } catch (e) {
    console.warn('Could not store user token in Redis:', e.message);
  }

  if (userId === 'default' || !LLMService.bedrockApiKey) {
    LLMService.setBedrockToken(token);
  }

  res.json({
    success: true,
    tokenInfo: info,
    message: info.expired ? 'Token stored but appears expired' : `Token stored, expires in ${Math.floor((info.remainingSeconds || 0) / 3600)}h ${Math.floor(((info.remainingSeconds || 0) % 3600) / 60)}m`
  });
});

/**
 * DELETE /api/admin/llm/token
 * Remove per-user Bedrock token
 */
router.delete('/llm/token', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  try {
    const tokenStore = require('../utils/tokenEncryption');
    await tokenStore.deleteToken(userId);
  } catch (e) { /* ok */ }
  res.json({ success: true });
});

// ============ Redis Routes ============

router.get('/redis/stats', async (req, res) => {
  try {
    const workspaceId = req.tenantContext?.workspace_id || null;
    const vectorStoreService = require('../services/vectorStoreService');
    const { client, connectRedis } = require('../config/redis');
    const redisService = require('../services/redisService');
    await connectRedis();

    // Global memory / key stats (always useful)
    const totalKeys = await client.dbSize();
    const info = await client.info('memory');
    const memMatch = info.match(/used_memory_human:(\S+)/);
    const memoryUsed = memMatch ? memMatch[1] : '—';
    
    if (workspaceId) {
      // Workspace-scoped stats
      const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
      
      // Count chunks (vectors) for workspace documents using the doc:chunks sets
      let totalChunks = 0;
      for (const docId of docIds) {
        try {
          const chunkCount = await client.sCard(`doc:${docId}:chunks`);
          totalChunks += chunkCount;
        } catch { /* skip */ }
      }
      
      // Count conversations that belong to this workspace
      // Conversations are keyed "conv:{uuid}" with workspace_id stored inside the JSON
      let convCount = 0;
      let cursor = '0';
      do {
        const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'conv:*', 'COUNT', '200']);
        cursor = result[0];
        for (const key of result[1]) {
          try {
            const data = await client.get(key);
            if (data) {
              const conv = JSON.parse(data);
              if (conv.workspace_id === workspaceId) convCount++;
            }
          } catch { /* skip malformed */ }
        }
      } while (cursor !== '0');
      
      // Count staged docs for this workspace
      let stagedCount = 0;
      cursor = '0';
      do {
        const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'staged:*', 'COUNT', '200']);
        cursor = result[0];
        for (const key of result[1]) {
          try {
            const data = await client.get(key);
            if (data) {
              const staged = JSON.parse(data);
              if (staged.workspace_id === workspaceId) stagedCount++;
            }
          } catch { /* skip */ }
        }
      } while (cursor !== '0');
      
      res.json({
        totalVectors: totalChunks,
        totalChunks,
        totalDocuments: docIds.length,
        totalConversations: convCount,
        stagedDocuments: stagedCount,
        totalKeys,
        memoryUsed,
        workspaceId
      });
    } else {
      // Global stats (no workspace filter)
      const vsStats = await vectorStoreService.getStats();
      
      let convCount = 0;
      let cursor = '0';
      do {
        const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'conv:*', 'COUNT', '200']);
        cursor = result[0];
        convCount += result[1].length;
      } while (cursor !== '0');
      
      res.json({
        totalVectors: vsStats.totalVectors,
        totalChunks: vsStats.totalChunks,
        totalDocuments: vsStats.totalDocuments,
        totalConversations: convCount,
        totalKeys,
        memoryUsed,
        indexStatus: vsStats.indexStatus
      });
    }
  } catch (error) {
    logger.error('Redis stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/redis/cleanup', async (req, res) => {
  try {
    const { type, workspaceId: bodyWsId } = req.body;
    const workspaceId = bodyWsId || req.tenantContext?.workspace_id || null;
    const vectorStoreService = require('../services/vectorStoreService');
    const { client, connectRedis } = require('../config/redis');
    const redisService = require('../services/redisService');
    await connectRedis();
    let deleted = 0;
    
    if (workspaceId) {
      // Workspace-scoped cleanup
      const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
      
      if (type === 'vectors' || type === 'chunks' || type === 'all') {
        for (const docId of docIds) {
          try { await vectorStoreService.deleteDocument(docId); deleted++; } catch {}
        }
      }
      if (type === 'conversations' || type === 'all') {
        // Conversations are keyed "conv:{uuid}" — filter by workspace_id inside JSON
        let cursor = '0';
        do {
          const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'conv:*', 'COUNT', '200']);
          cursor = result[0];
          const toDelete = [];
          for (const key of result[1]) {
            try {
              const data = await client.get(key);
              if (data) {
                const conv = JSON.parse(data);
                if (conv.workspace_id === workspaceId) toDelete.push(key);
              }
            } catch { /* skip */ }
          }
          if (toDelete.length > 0) { await client.del(toDelete); deleted += toDelete.length; }
        } while (cursor !== '0');
      }
      if (type === 'all') {
        // Delete doc metadata for workspace docs
        for (const docId of docIds) {
          try { await client.del(`doc:${docId}`); deleted++; } catch {}
        }
        // Delete staged/extraction data for workspace
        const dataPatterns = [`staged:${workspaceId}:*`, `staged-extraction:${workspaceId}:*`, `extraction:${workspaceId}:*`];
        for (const pattern of dataPatterns) {
          let cursor = '0';
          do {
            const result = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
            cursor = result[0];
            if (result[1].length > 0) { await client.del(result[1]); deleted += result[1].length; }
          } while (cursor !== '0');
        }
        // Clear workspace doc index
        await client.del(`workspace:${workspaceId}:docs`);
      }
      res.json({ success: true, message: `Deleted ${deleted} keys for workspace ${workspaceId}` });
    } else {
      // Global cleanup (original behavior)
      const PROTECTED_PREFIXES = [/^user:/, /^user_emails$/, /^auth:/, /^tenant:/, /^tenants:/, /^workspace:(?!.*:docs$)/, /^folder:/, /^folders:/, /^ontology_registry:/, /^settings:/, /^bedrock_token:/, /^audit:/];

      if (type === 'vectors' || type === 'chunks' || type === 'all') {
        const result = await vectorStoreService.clearAll();
        deleted += result.keysDeleted || 0;
      }
      if (type === 'conversations' || type === 'all') {
        let cursor = '0';
        do {
          const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'conv:*', 'COUNT', '200']);
          cursor = result[0];
          if (result[1].length > 0) { await client.del(result[1]); deleted += result[1].length; }
        } while (cursor !== '0');
      }
      if (type === 'all') {
        const dataPatterns = ['doc:*', 'workspace:*:docs', 'staged:*', 'staged-extraction:*', 'extraction:*', 'doc_extraction:*'];
        for (const pattern of dataPatterns) {
          let cursor = '0';
          do {
            const result = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
            cursor = result[0];
            const keys = result[1].filter(k => !PROTECTED_PREFIXES.some(p => k.match(p)));
            if (keys.length > 0) { await client.del(keys); deleted += keys.length; }
          } while (cursor !== '0');
        }
      }
      res.json({ success: true, message: `Deleted ${deleted} keys (config and auth preserved)` });
    }
  } catch (error) {
    logger.error('Redis cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ Neo4j Routes ============

/**
 * GET /api/admin/neo4j/stats (workspace-scoped when context provided)
 */
router.get('/neo4j/stats', async (req, res) => {
  try {
    const workspaceId = req.tenantContext?.workspace_id || null;
    const wsFilter = workspaceId ? 'WHERE n.workspace_id = $workspaceId' : '';
    const wsRelFilter = workspaceId ? 'WHERE a.workspace_id = $workspaceId OR b.workspace_id = $workspaceId' : '';
    const params = {};
    if (workspaceId) params.workspaceId = workspaceId;

    const session = neo4jService.getSession();
    try {
      const nodesRes = await session.run(`MATCH (n) ${wsFilter} RETURN count(n) as count`, params);
      const relsRes = await session.run(`MATCH (a)-[r]->(b) ${wsRelFilter} RETURN count(r) as count`, params);
      const labelsRes = await session.run('CALL db.labels() YIELD label RETURN collect(label) as labels');
      const relTypesRes = await session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) as types');
      
      res.json({
        totalNodes: neo4jService.toNumber(nodesRes.records[0]?.get('count')),
        totalRelationships: neo4jService.toNumber(relsRes.records[0]?.get('count')),
        labels: labelsRes.records[0]?.get('labels') || [],
        relationshipTypes: relTypesRes.records[0]?.get('types') || [],
        workspaceId
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/neo4j/browse (workspace-scoped when context provided)
 */
router.get('/neo4j/browse', async (req, res) => {
  try {
    const { type = 'all', limit = 100 } = req.query;
    const workspaceId = req.tenantContext?.workspace_id || null;
    const wsFilter = workspaceId ? 'AND n.workspace_id = $workspaceId' : '';
    const params = {};
    if (workspaceId) params.workspaceId = workspaceId;

    const session = neo4jService.getSession();
    
    try {
      let query;
      if (type === 'entities') {
        query = `MATCH (n) WHERE n.uri IS NOT NULL ${wsFilter} RETURN n, labels(n) as labels LIMIT ${parseInt(limit)}`;
      } else {
        query = `MATCH (n) WHERE true ${wsFilter} RETURN n, labels(n) as labels LIMIT ${parseInt(limit)}`;
      }
      
      const result = await session.run(query, params);
      const data = result.records.map(r => {
        const node = r.get('n').properties;
        return {
          id: node.uri || node.id || r.get('n').identity.toString(),
          uri: node.uri,
          labels: r.get('labels'),
          name: node.name || node.label || node.title,
          ...node
        };
      });
      
      res.json({ success: true, data });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j browse error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/neo4j/delete (workspace-scoped)
 */
router.post('/neo4j/delete', async (req, res) => {
  try {
    const { uris } = req.body;
    const workspaceId = req.tenantContext?.workspace_id || null;
    
    if (!uris || !Array.isArray(uris)) {
      return res.status(400).json({ success: false, error: 'uris array required' });
    }
    
    const session = neo4jService.getSession();
    try {
      // Only delete nodes that belong to the requesting workspace
      const wsFilter = workspaceId ? 'AND n.workspace_id = $workspaceId' : '';
      const params = { uris };
      if (workspaceId) params.workspaceId = workspaceId;

      const result = await session.run(
        `MATCH (n) WHERE n.uri IN $uris ${wsFilter} DETACH DELETE n RETURN count(n) as deleted`,
        params
      );
      const deleted = result.records[0]?.get('deleted')?.toNumber?.() || 0;
      res.json({ success: true, deleted });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/neo4j/query
 */
router.post('/neo4j/query', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, error: 'query required' });
    }
    
    // Safety check - only allow read queries
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery.startsWith('match') && !lowerQuery.startsWith('call') && !lowerQuery.startsWith('return')) {
      return res.status(400).json({ success: false, error: 'Only read queries (MATCH, CALL, RETURN) allowed' });
    }
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(query);
      const records = result.records.map(r => {
        const obj = {};
        r.keys.forEach(key => {
          const val = r.get(key);
          obj[key] = val?.properties || val?.toNumber?.() || val;
        });
        return obj;
      });
      res.json({ success: true, records, count: records.length });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/neo4j/cleanup
 * Clear workspace data from Neo4j (preserves Tenant/Workspace/Folder structure nodes)
 */
router.post('/neo4j/cleanup', async (req, res) => {
  try {
    const { type } = req.body;
    const workspaceId = req.tenantContext?.workspace_id || null;
    const session = neo4jService.getSession();
    
    try {
      let result;
      let message = '';
      const wsFilter = workspaceId ? 'WHERE n.workspace_id = $workspaceId' : 'WHERE true';
      const params = workspaceId ? { workspaceId } : {};
      // Never delete structural nodes (Tenant, Workspace, Folder)
      const structureGuard = 'AND NOT (n:Tenant OR n:Workspace OR n:Folder)';
      
      if (type === 'entities') {
        result = await session.run(
          `MATCH (n) ${wsFilter} AND n.uri IS NOT NULL ${structureGuard} DETACH DELETE n RETURN count(n) as deleted`,
          params
        );
        message = `Deleted ${result.records[0]?.get('deleted')?.toNumber?.() || 0} entities`;
      } else if (type === 'relationships') {
        const q = workspaceId
          ? 'MATCH (a)-[r]->(b) WHERE (a.workspace_id = $workspaceId OR b.workspace_id = $workspaceId) AND NOT (a:Tenant OR a:Workspace OR a:Folder OR b:Tenant OR b:Workspace OR b:Folder) DELETE r RETURN count(r) as deleted'
          : 'MATCH (a)-[r]->(b) WHERE NOT (a:Tenant OR a:Workspace OR a:Folder OR b:Tenant OR b:Workspace OR b:Folder) DELETE r RETURN count(r) as deleted';
        result = await session.run(q, params);
        message = `Deleted ${result.records[0]?.get('deleted')?.toNumber?.() || 0} relationships`;
      } else if (type === 'all') {
        result = await session.run(
          `MATCH (n) ${wsFilter} ${structureGuard} DETACH DELETE n RETURN count(n) as deleted`,
          params
        );
        message = `Deleted ${result.records[0]?.get('deleted')?.toNumber?.() || 0} data nodes (structure preserved)`;
      }
      
      res.json({ success: true, message });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/graphdb/discover-schema
 * Discover classes and properties actually used in data (not in ontology)
 */
router.get('/graphdb/discover-schema', async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default' } = req.query;
    
    // Find all classes (rdf:type values) in data
    const classesQuery = `
      SELECT DISTINCT ?class (COUNT(?s) as ?count) WHERE {
        ?s a ?class .
        FILTER(!STRSTARTS(STR(?class), "http://www.w3.org/"))
      }
      GROUP BY ?class ORDER BY DESC(?count)
    `;
    
    // Find all predicates used in data
    const predicatesQuery = `
      SELECT DISTINCT ?predicate (COUNT(*) as ?count) WHERE {
        ?s ?predicate ?o .
        FILTER(?predicate != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
        FILTER(!STRSTARTS(STR(?predicate), "http://www.w3.org/"))
      }
      GROUP BY ?predicate ORDER BY DESC(?count)
    `;
    
    const [classesRes, predicatesRes] = await Promise.all([
      graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'all'),
      graphDBStore.executeSPARQL(tenantId, workspaceId, predicatesQuery, 'all')
    ]);
    
    const classes = (classesRes?.results?.bindings || []).map(b => ({
      iri: b.class?.value,
      label: b.class?.value?.split(/[#/]/).pop(),
      instanceCount: parseInt(b.count?.value || 0)
    }));
    
    const predicates = (predicatesRes?.results?.bindings || []).map(b => ({
      iri: b.predicate?.value,
      label: b.predicate?.value?.split(/[#/]/).pop(),
      usageCount: parseInt(b.count?.value || 0)
    }));
    
    res.json({ success: true, classes, predicates });
  } catch (error) {
    logger.error('Schema discovery error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/neo4j/cleanup-schema
 * Remove unused constraints and indexes from Neo4j
 */
router.post('/neo4j/cleanup-schema', async (req, res) => {
  try {
    const session = neo4jService.getSession();
    const dropped = { constraints: [], indexes: [] };
    
    try {
      // Get all constraints
      const constraintsResult = await session.run('SHOW CONSTRAINTS');
      for (const record of constraintsResult.records) {
        const name = record.get('name');
        // Keep only essential constraints
        const keep = ['doc_uri_unique', 'chunk_uri_unique', 'folder_id_unique', 'workspace_id_unique'];
        if (!keep.includes(name)) {
          try {
            await session.run(`DROP CONSTRAINT ${name} IF EXISTS`);
            dropped.constraints.push(name);
          } catch (e) { /* ignore */ }
        }
      }
      
      // Get all indexes
      const indexesResult = await session.run('SHOW INDEXES');
      for (const record of indexesResult.records) {
        const name = record.get('name');
        const type = record.get('type');
        // Skip constraint-backing indexes and keep essential ones
        if (type === 'RANGE' || type === 'FULLTEXT') {
          const keep = ['document_doc_id', 'document_workspace', 'chunk_order', 'folder_workspace'];
          if (!keep.includes(name) && !name.includes('constraint')) {
            try {
              await session.run(`DROP INDEX ${name} IF EXISTS`);
              dropped.indexes.push(name);
            } catch (e) { /* ignore */ }
          }
        }
      }
      
      res.json({ 
        success: true, 
        message: `Dropped ${dropped.constraints.length} constraints, ${dropped.indexes.length} indexes`,
        dropped 
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Schema cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// (Redis stats and cleanup routes are defined above — no duplicates)

/**
 * DELETE /api/admin/workspace/:workspaceId/purge
 * Fully delete a workspace and ALL its data across every database.
 * This is the nuclear option — removes GraphDB graphs, Neo4j nodes, Redis vectors/chunks/docs/conversations.
 */
router.delete('/workspace/:workspaceId/purge', async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const tenantId = req.query.tenantId || req.tenantContext?.tenant_id || 'default';

    // Protect default workspace
    if (workspaceId === 'default') {
      return res.status(403).json({ success: false, error: 'Cannot delete the default workspace. Use "Clear Data" to remove content instead.' });
    }
    const results = { neo4j: null, graphdb: null, redis: null, tenant: null };

    // 1. Clear GraphDB workspace graphs (data + audit, preserve global ontologies)
    try {
      await graphDBStore.clearWorkspaceData(tenantId, workspaceId);
      results.graphdb = { cleared: true };
    } catch (e) {
      results.graphdb = { cleared: false, error: e.message };
    }

    // 2. Clear Neo4j workspace-scoped data nodes + documents + chunks
    try {
      const session = neo4jService.getSession();
      try {
        const r = await session.run(
          'MATCH (n) WHERE n.workspace_id = $workspaceId AND NOT (n:Tenant) DETACH DELETE n RETURN count(n) as deleted',
          { workspaceId }
        );
        results.neo4j = { cleared: true, nodesDeleted: r.records[0]?.get('deleted')?.toNumber?.() || 0 };
      } finally {
        await session.close();
      }
    } catch (e) {
      results.neo4j = { cleared: false, error: e.message };
    }

    // 3. Clear Redis workspace data (vectors, docs, conversations, staged, jobs)
    try {
      const { client: redisClient, connectRedis } = require('../config/redis');
      await connectRedis();
      let deleted = 0;

      // Vectors/chunks for docs in this workspace
      const vectorStoreService = require('../services/vectorStoreService');
      const redisService = require('../services/redisService');
      const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
      for (const docId of docIds) {
        try { await vectorStoreService.deleteDocument(docId); deleted++; } catch {}
        try { await redisClient.del(`doc:${docId}`); deleted++; } catch {}
      }
      await redisClient.del(`workspace:${workspaceId}:docs`);

      // Ontology jobs for this workspace
      const jobSetKey = `ontology_jobs:workspace:${workspaceId}`;
      const jobIds = await redisClient.sMembers(jobSetKey);
      for (const jid of jobIds) {
        try { await redisClient.del(`ontology_job:${jid}`); deleted++; } catch {}
        // Also remove from global job index
        try { await redisClient.sRem('ontology_jobs:all', jid); } catch {}
      }
      if (jobIds.length) await redisClient.del(jobSetKey);

      // Clean up conversations for this workspace
      let cursor = '0';
      do {
        const result = await redisClient.sendCommand(['SCAN', cursor, 'MATCH', `conv:${workspaceId}:*`, 'COUNT', '200']);
        cursor = result[0];
        if (result[1].length > 0) { await redisClient.del(result[1]); deleted += result[1].length; }
      } while (cursor !== '0');

      results.redis = { cleared: true, keysDeleted: deleted };
    } catch (e) {
      results.redis = { cleared: false, error: e.message };
    }

    // 4. Clean up uploaded files on disk for this workspace
    try {
      const uploadsDir = require('path').join(__dirname, '../../uploads', workspaceId);
      if (require('fs').existsSync(uploadsDir)) {
        require('fs').rmSync(uploadsDir, { recursive: true, force: true });
        results.files = { cleared: true };
      } else {
        results.files = { cleared: true, message: 'No upload directory found' };
      }
    } catch (e) {
      results.files = { cleared: false, error: e.message };
    }

    // 5. Delete workspace from tenant service (Redis + Neo4j structure nodes)
    try {
      const tenantService = require('../services/tenantService');
      await tenantService.deleteWorkspace(workspaceId, { cascade: true, tenantId });
      results.tenant = { deleted: true };
    } catch (e) {
      results.tenant = { deleted: false, error: e.message };
    }

    const allOk = Object.values(results).every(r => r?.cleared !== false && r?.deleted !== false);
    res.json({
      success: allOk,
      message: allOk ? `Workspace ${workspaceId} fully purged from all databases` : 'Partial purge — check results',
      results
    });
  } catch (error) {
    logger.error('Workspace purge error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/admin/tenant/:tenantId/purge
 * Fully delete a tenant and ALL its workspaces + data across every database.
 */
router.delete('/tenant/:tenantId/purge', async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Protect default tenant
    if (tenantId === 'default') {
      return res.status(403).json({ success: false, error: 'Cannot delete the default tenant.' });
    }

    const tenantService = require('../services/tenantService');
    const { client: redisClient, connectRedis } = require('../config/redis');
    await connectRedis();

    // Get all workspaces for this tenant (correct Redis key: workspaces:tenant:{id})
    const workspaceIds = await redisClient.sMembers(`workspaces:tenant:${tenantId}`);
    const workspaceResults = {};

    // Purge each workspace
    for (const wsId of workspaceIds) {
      try {
        // GraphDB
        try { await graphDBStore.clearWorkspaceData(tenantId, wsId); } catch {}

        // Neo4j data nodes
        const session = neo4jService.getSession();
        try {
          await session.run(
            'MATCH (n) WHERE n.workspace_id = $wsId AND NOT (n:Tenant) DETACH DELETE n',
            { wsId }
          );
        } finally { await session.close(); }

        // Redis workspace data
        const redisService = require('../services/redisService');
        const vectorStoreService = require('../services/vectorStoreService');
        const docIds = await redisService.sMembers(`workspace:${wsId}:docs`);
        for (const docId of docIds) {
          try { await vectorStoreService.deleteDocument(docId); } catch {}
          try { await redisClient.del(`doc:${docId}`); } catch {}
        }
        await redisClient.del(`workspace:${wsId}:docs`);

        const jobSetKey = `ontology_jobs:workspace:${wsId}`;
        const jobIds = await redisClient.sMembers(jobSetKey);
        for (const jid of jobIds) {
          try { await redisClient.del(`ontology_job:${jid}`); } catch {}
          try { await redisClient.sRem('ontology_jobs:all', jid); } catch {}
        }
        if (jobIds.length) await redisClient.del(jobSetKey);

        // Clean up conversations for this workspace
        let convCursor = '0';
        do {
          const result = await redisClient.sendCommand(['SCAN', convCursor, 'MATCH', `conv:${wsId}:*`, 'COUNT', '200']);
          convCursor = result[0];
          if (result[1].length > 0) { await redisClient.del(result[1]); }
        } while (convCursor !== '0');

        // Clean up uploaded files on disk
        try {
          const uploadsDir = require('path').join(__dirname, '../../uploads', wsId);
          if (require('fs').existsSync(uploadsDir)) {
            require('fs').rmSync(uploadsDir, { recursive: true, force: true });
          }
        } catch {}

        workspaceResults[wsId] = { purged: true };
      } catch (e) {
        workspaceResults[wsId] = { purged: false, error: e.message };
      }
    }

    // Delete tenant itself (cascade deletes workspace structure nodes)
    await tenantService.deleteTenant(tenantId, { cascade: true });

    res.json({
      success: true,
      message: `Tenant ${tenantId} and ${workspaceIds.length} workspace(s) fully purged`,
      workspaces: workspaceResults
    });
  } catch (error) {
    logger.error('Tenant purge error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
