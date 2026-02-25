/**
 * Entity Routes
 * API endpoints for entity (graph node instance) operations
 * 
 * TERMINOLOGY:
 * - Class = Ontology type definition (managed in /api/ontology)
 * - Entity = Instance/Node in the graph (managed here)
 * 
 * All endpoints require tenant and workspace context
 */

const express = require('express');
const router = express.Router();
const entityService = require('../services/entityService');
const { QUERY } = require('../config/constants');

/**
 * GET /api/entities
 * List entities with cursor-based pagination
 * 
 * Query parameters:
 * - tenantId (required) - Tenant ID
 * - workspaceId (required) - Workspace ID
 * - class (optional) - Filter by entity class
 * - search (optional) - Search term for name/identifier
 * - limit (optional) - Page size, default 50, max 100
 * - cursor (optional) - Pagination cursor
 * 
 * Response:
 * {
 *   "items": [...],
 *   "nextCursor": "opaque_cursor",
 *   "totalEstimate": 1234
 * }
 */
router.get('/', async (req, res) => {
  try {
    const {
      tenantId,
      workspaceId,
      class: entityClass,
      search,
      limit,
      cursor
    } = req.query;

    // Validate required params
    if (!tenantId) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'tenantId is required'
      });
    }

    if (!workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'workspaceId is required'
      });
    }

    const result = await entityService.listEntities({
      tenantId,
      workspaceId,
      class: entityClass,
      search,
      limit: limit ? parseInt(limit, 10) : QUERY.DEFAULT_LIMIT,
      cursor
    });

    res.json(result);

  } catch (error) {
    // Use logger for cleaner output
    const logger = require('../utils/logger');
    logger.error(`[GET /entities] ${error.message}`);
    
    // Check for Neo4j connection errors
    if (error.message?.includes('Could not perform discovery') || 
        error.message?.includes('Connection refused') ||
        error.code === 'ServiceUnavailable') {
      return res.status(503).json({
        error: 'Database unavailable',
        message: 'Neo4j database is not available. Please ensure Neo4j is running.'
      });
    }
    
    res.status(500).json({
      error: 'Failed to list entities',
      message: error.message
    });
  }
});

/**
 * GET /api/entities/classes
 * Get available entity classes in a workspace
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
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

    const classes = await entityService.getAvailableClasses(tenantId, workspaceId);

    res.json({
      classes,
      total: classes.reduce((sum, c) => sum + c.count, 0)
    });

  } catch (error) {
    console.error('[GET /entities/classes] Error:', error.message);
    console.error('[GET /entities/classes] Stack:', error.stack);
    
    // Check for Neo4j connection errors
    if (error.message?.includes('Could not perform discovery') || 
        error.message?.includes('Connection refused') ||
        error.code === 'ServiceUnavailable') {
      return res.status(503).json({
        error: 'Database unavailable',
        message: 'Neo4j database is not available. Please ensure Neo4j is running.'
      });
    }
    
    res.status(500).json({
      error: 'Failed to get entity classes',
      message: error.message
    });
  }
});

/**
 * GET /api/entities/:entityId
 * Get entity detail
 * 
 * Path parameters:
 * - entityId - Entity ID in format "Class::identifier"
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
 * 
 * Response:
 * {
 *   "entityId": "Customer::C123",
 *   "class": "Customer",
 *   "displayName": "Jane Doe",
 *   "canonicalId": "C123",
 *   "attributes": {...},
 *   "provenance": {...},
 *   "relationships": [...],
 *   "evidence": [...]
 * }
 */
router.get('/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    // Decode entityId (may be URL encoded)
    const decodedEntityId = decodeURIComponent(entityId);

    const entity = await entityService.getEntityDetail(decodedEntityId, {
      tenantId,
      workspaceId
    });

    if (!entity) {
      return res.status(404).json({
        error: 'Entity not found',
        message: `No entity found with ID: ${decodedEntityId}`
      });
    }

    res.json(entity);

  } catch (error) {
    console.error('[GET /entities/:entityId] Error:', error);
    res.status(500).json({
      error: 'Failed to get entity detail',
      message: error.message
    });
  }
});

/**
 * GET /api/entities/:entityId/relationships
 * Get entity relationships (expandable, paginated)
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
 * - type (optional) - Filter by relationship type
 * - direction (optional) - 'incoming', 'outgoing', or 'both' (default)
 * - limit (optional) - Page size, default 20
 */
router.get('/:entityId/relationships', async (req, res) => {
  try {
    const { entityId } = req.params;
    const {
      tenantId,
      workspaceId,
      type: relationshipType,
      direction,
      limit
    } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedEntityId = decodeURIComponent(entityId);

    const result = await entityService.getEntityRelationships(decodedEntityId, {
      tenantId,
      workspaceId,
      relationshipType,
      direction,
      limit: limit ? parseInt(limit, 10) : QUERY.RELATIONSHIP_DEFAULT_LIMIT
    });

    res.json(result);

  } catch (error) {
    console.error('[GET /entities/:entityId/relationships] Error:', error);
    res.status(500).json({
      error: 'Failed to get entity relationships',
      message: error.message
    });
  }
});

/**
 * GET /api/entities/:entityId/graph
 * Get contextual graph for visualization
 * Starts from ONE entity, limited traversal depth
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
 * - depth (optional) - Traversal depth, 1-2 (default 1)
 * - relationshipTypes (optional) - Comma-separated list of relationship types to include
 * - limit (optional) - Max nodes to return, default 50
 */
router.get('/:entityId/graph', async (req, res) => {
  try {
    const { entityId } = req.params;
    const {
      tenantId,
      workspaceId,
      depth,
      relationshipTypes,
      limit
    } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedEntityId = decodeURIComponent(entityId);

    // Parse relationship types if provided
    const relTypes = relationshipTypes 
      ? relationshipTypes.split(',').map(t => t.trim())
      : null;

    const result = await entityService.getEntityGraph(decodedEntityId, {
      tenantId,
      workspaceId,
      depth: depth ? parseInt(depth, 10) : QUERY.DEFAULT_LIMIT,
      relationshipTypes: relTypes,
      limit: limit ? parseInt(limit, 10) : QUERY.ENTITY_GRAPH_DEFAULT_LIMIT
    });

    res.json(result);

  } catch (error) {
    console.error('[GET /entities/:entityId/graph] Error:', error);
    res.status(500).json({
      error: 'Failed to get entity graph',
      message: error.message
    });
  }
});

/**
 * GET /api/entities/:entityId/assertions
 * Get assertions (reified relationships) for an entity
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
 * - limit (optional) - default 20
 */
router.get('/:entityId/assertions', async (req, res) => {
  try {
    const { entityId } = req.params;
    const { tenantId, workspaceId, limit } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedEntityId = decodeURIComponent(entityId);
    const { className, identifier } = entityService.parseEntityId(decodedEntityId);
    const maxResults = limit ? parseInt(limit, 10) : 20;

    const session = require('../services/neo4jService').getSession();
    try {
      const result = await session.run(`
        MATCH (n)
        WHERE (n.concept_id = $identifier OR n.name = $identifier OR n.label = $identifier)
          AND n.tenant_id = $tenantId AND n.workspace_id = $workspaceId
          AND $className IN labels(n)
        WITH n LIMIT 1
        OPTIONAL MATCH (n)-[:ASSERTS]->(a:Assertion)-[:TARGET]->(target)
        OPTIONAL MATCH (a)-[:EVIDENCED_BY]->(ec:EvidenceChunk)
        RETURN a {
          .assertion_id, .predicate, .confidence, .claim_status,
          .method, .extracted_at, .quote,
          target_id: target.canonical_id,
          target_name: target.display_name,
          target_class: labels(target)[0],
          evidence: collect(DISTINCT ec {
            .chunk_id, .doc_id, .page, .quote, .span_start, .span_end
          })
        } AS assertion
        ORDER BY a.confidence DESC
        LIMIT $maxResults
      `, { identifier, tenantId, workspaceId, className, maxResults: maxResults });

      const assertions = result.records
        .map(r => r.get('assertion'))
        .filter(a => a && a.assertion_id);

      res.json({ assertions, total: assertions.length });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('[GET /entities/:entityId/assertions] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/entities/:entityId
 * Update entity properties
 * 
 * Body:
 * - properties: Object with properties to update
 * 
 * Query parameters:
 * - tenantId (required)
 * - workspaceId (required)
 */
router.patch('/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const { tenantId, workspaceId } = req.query;
    const { properties } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    if (!properties || typeof properties !== 'object') {
      return res.status(400).json({
        error: 'Invalid request body',
        message: 'properties object is required'
      });
    }

    const decodedEntityId = decodeURIComponent(entityId);

    const result = await entityService.updateEntity(decodedEntityId, {
      tenantId,
      workspaceId,
      properties
    });

    if (!result) {
      return res.status(404).json({
        error: 'Entity not found',
        message: `No entity found with ID: ${decodedEntityId}`
      });
    }

    res.json({
      success: true,
      message: 'Entity updated successfully',
      entity: result
    });

  } catch (error) {
    console.error('[PATCH /entities/:entityId] Error:', error);
    res.status(500).json({
      error: 'Failed to update entity',
      message: error.message
    });
  }
});

module.exports = router;
