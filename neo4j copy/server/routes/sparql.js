/**
 * SPARQL Endpoint
 * Provides SPARQL query interface for RDF data via GraphDB
 */

const express = require('express');
const router = express.Router();
const graphDBStore = require('../services/graphDBStore');
const logger = require('../utils/logger');
const { requireMember, requireManager } = require('../middleware/auth');
const { queryLimiter } = require('../middleware/rateLimiter');

// In-memory query history (per session - would use Redis in production)
const queryHistory = new Map();
const MAX_HISTORY = 50;

/**
 * Store query in history
 */
const storeQueryHistory = (sessionId, query, result, executionTime) => {
  if (!sessionId) return;
  
  const history = queryHistory.get(sessionId) || [];
  history.unshift({
    id: Date.now().toString(),
    query,
    timestamp: new Date().toISOString(),
    executionTime,
    resultCount: result?.results?.bindings?.length || 0,
    success: !result?.error
  });
  
  // Keep only last N queries
  queryHistory.set(sessionId, history.slice(0, MAX_HISTORY));
};

/**
 * GET /api/sparql/history
 * Get query history for session
 */
router.get('/history', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || 'default';
  const history = queryHistory.get(sessionId) || [];
  res.json({ queries: history });
});

/**
 * DELETE /api/sparql/history
 * Clear query history for session
 */
router.delete('/history', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || 'default';
  queryHistory.delete(sessionId);
  res.json({ success: true });
});

/**
 * POST /api/sparql/query-versioned
 * Execute SPARQL query with ontology version awareness
 */
router.post('/query-versioned', queryLimiter, requireMember, async (req, res) => {
  try {
    const { query, tenantId = 'default', workspaceId = 'default' } = req.body;

    if (!query) {
      return res.status(400).json({
        error: 'Missing query parameter'
      });
    }

    const result = await graphDBStore.queryWithOntologyVersion(tenantId, workspaceId, query);
    
    res.json({
      success: true,
      results: result.results,
      head: result.head
    });

  } catch (error) {
    logger.error('[POST /sparql/query-versioned] Error:', error);
    res.status(500).json({
      error: 'Query execution failed',
      message: error.message
    });
  }
});

/**
 * POST /api/sparql/query
 * Execute SPARQL SELECT query via GraphDB
 * 
 * Body:
 * - query: SPARQL query string
 * - tenantId: Tenant ID
 * - workspaceId: Workspace ID
 */
router.post('/query', queryLimiter, requireMember, async (req, res) => {
  const startTime = Date.now();
  try {
    const { query, tenantId, workspaceId } = req.body;
    const sessionId = req.headers['x-session-id'] || 'default';

    if (!query || !tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'query, tenantId, and workspaceId are required'
      });
    }

    // Execute SPARQL query via GraphDB
    const results = await graphDBStore.executeSPARQL(tenantId, workspaceId, query);
    const executionTime = Date.now() - startTime;

    // Store in history
    storeQueryHistory(sessionId, query, results, executionTime);

    res.json({
      success: true,
      results,
      executionTime
    });

  } catch (error) {
    logger.error('[POST /sparql/query] Error:', error);
    const executionTime = Date.now() - startTime;
    const sessionId = req.headers['x-session-id'] || 'default';
    storeQueryHistory(sessionId, req.body?.query, { error: error.message }, executionTime);
    
    res.status(500).json({
      error: 'SPARQL query failed',
      message: error.message
    });
  }
});

/**
 * POST /api/sparql/pattern
 * Simple triple pattern matching via GraphDB
 * 
 * Body:
 * - subject: Subject IRI or null
 * - predicate: Predicate IRI or null
 * - object: Object IRI/literal or null
 * - tenantId: Tenant ID
 * - workspaceId: Workspace ID
 * - limit: Max results (default: 100)
 */
router.post('/pattern', requireMember, async (req, res) => {
  try {
    const { 
      subject, 
      predicate, 
      object, 
      tenantId, 
      workspaceId,
      limit = 100 
    } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const quads = await graphDBStore.getQuads(
      tenantId, 
      workspaceId, 
      subject, 
      predicate, 
      object
    );

    // Convert quads to JSON
    const results = quads.slice(0, limit).map(q => ({
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: q.object.termType === 'Literal' 
        ? { value: q.object.value, type: 'literal', datatype: q.object.datatype?.value }
        : { value: q.object.value, type: 'uri' }
    }));

    res.json({
      results,
      total: quads.length,
      limited: quads.length > limit
    });

  } catch (error) {
    logger.error('[POST /sparql/pattern] Error:', error);
    res.status(500).json({
      error: 'Pattern matching failed',
      message: error.message
    });
  }
});

/**
 * POST /api/sparql/reason
 * Trigger reasoning for a workspace (GraphDB handles automatically)
 * 
 * Body:
 * - tenantId: Tenant ID
 * - workspaceId: Workspace ID
 */
router.post('/reason', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const result = await graphDBStore.triggerReasoning(tenantId, workspaceId);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('[POST /sparql/reason] Error:', error);
    res.status(500).json({
      error: 'Reasoning failed',
      message: error.message
    });
  }
});

/**
 * GET /api/sparql/classes
 * Get all OWL classes via GraphDB
 */
router.get('/classes', async (req, res) => {
  try {
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const classes = await graphDBStore.getClasses(tenantId, workspaceId);

    res.json({
      classes,
      total: classes.length
    });

  } catch (error) {
    logger.error('[GET /sparql/classes] Error:', error);
    res.status(500).json({
      error: 'Failed to get classes',
      message: error.message
    });
  }
});

/**
 * GET /api/sparql/properties
 * Get all OWL properties via GraphDB
 */
router.get('/properties', async (req, res) => {
  try {
    const { tenantId, workspaceId, type = 'all' } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    let properties = [];

    if (type === 'object' || type === 'all') {
      const objProps = await graphDBStore.getObjectProperties(tenantId, workspaceId);
      properties.push(...objProps);
    }

    if (type === 'data' || type === 'all') {
      const dataProps = await graphDBStore.getDataProperties(tenantId, workspaceId);
      properties.push(...dataProps);
    }

    res.json({
      properties,
      total: properties.length
    });

  } catch (error) {
    logger.error('[GET /sparql/properties] Error:', error);
    res.status(500).json({
      error: 'Failed to get properties',
      message: error.message
    });
  }
});

module.exports = router;
