/**
 * Enterprise API Routes
 * Entity Resolution, Data Connectors, Lineage, Schema Versioning,
 * Activity Tracking, RBAC, and Graph Algorithms
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { requireAdmin } = require('../middleware/auth');

// Services
const entityResolutionService = require('../services/entityResolutionService');
const dataConnectorService = require('../services/dataConnectorService');
const lineageService = require('../services/lineageService');
const schemaVersioningService = require('../services/schemaVersioningService');
const activityTrackingService = require('../services/activityTrackingService');
const rbacService = require('../services/rbacService');
const graphAlgorithmsService = require('../services/graphAlgorithmsService');

// File upload config for data imports
const upload = multer({
  dest: 'uploads/imports/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ============================================================
// ENTITY RESOLUTION ENDPOINTS
// ============================================================

/**
 * Find duplicate entity candidates
 */
router.get('/entity-resolution/candidates', async (req, res) => {
  try {
    const { entityType, minScore, limit, includeResolved } = req.query;
    
    const candidates = await entityResolutionService.findDuplicateCandidates({
      entityType,
      minScore: minScore ? parseFloat(minScore) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      includeResolved: includeResolved === 'true'
    });

    res.json(candidates);
  } catch (error) {
    console.error('Entity resolution error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Merge two entities
 */
router.post('/entity-resolution/merge', async (req, res) => {
  try {
    const { sourceUri, targetUri, keepSource, mergeStrategy, userId } = req.body;
    
    if (!sourceUri || !targetUri) {
      return res.status(400).json({ error: 'sourceUri and targetUri required' });
    }

    const result = await entityResolutionService.mergeEntities(sourceUri, targetUri, {
      keepSource,
      mergeStrategy,
      userId
    });

    res.json(result);
  } catch (error) {
    console.error('Merge error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Auto-resolve duplicates
 */
router.post('/entity-resolution/auto-resolve', async (req, res) => {
  try {
    const { minScore, maxMerges, dryRun } = req.body;
    
    const result = await entityResolutionService.autoResolveDuplicates({
      minScore: minScore || 0.85,
      maxMerges: maxMerges || 50,
      dryRun: dryRun !== false
    });

    res.json(result);
  } catch (error) {
    console.error('Auto-resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get merge history for an entity
 */
router.get('/entity-resolution/history/:entityUri', async (req, res) => {
  try {
    const history = await entityResolutionService.getMergeHistory(
      decodeURIComponent(req.params.entityUri)
    );
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Undo a merge
 */
router.post('/entity-resolution/undo/:mergeId', async (req, res) => {
  try {
    const result = await entityResolutionService.undoMerge(req.params.mergeId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DATA CONNECTOR ENDPOINTS
// ============================================================

/**
 * Register a new data connector
 */
router.post('/connectors', async (req, res) => {
  try {
    const connector = await dataConnectorService.registerConnector(req.body);
    res.json(connector);
  } catch (error) {
    console.error('Connector registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all connectors
 */
router.get('/connectors', async (req, res) => {
  try {
    await dataConnectorService.loadConnectors();
    const connectors = dataConnectorService.getConnectors();
    res.json(connectors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get connector by ID
 */
router.get('/connectors/:id', async (req, res) => {
  try {
    const connector = dataConnectorService.getConnector(req.params.id);
    if (!connector) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    res.json(connector);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a connector
 */
router.delete('/connectors/:id', async (req, res) => {
  try {
    const result = await dataConnectorService.deleteConnector(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test connector configuration
 */
router.post('/connectors/:id/test', async (req, res) => {
  try {
    const result = await dataConnectorService.testConnector(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Import data from CSV
 */
router.post('/connectors/:id/import/csv', async (req, res) => {
  try {
    const { dryRun, batchSize } = req.body;
    const result = await dataConnectorService.importCSV(req.params.id, {
      dryRun: dryRun !== false,
      batchSize: batchSize || 100
    });
    res.json(result);
  } catch (error) {
    console.error('CSV import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Import data from JSON
 */
router.post('/connectors/:id/import/json', async (req, res) => {
  try {
    const { dryRun } = req.body;
    const result = await dataConnectorService.importJSON(req.params.id, {
      dryRun: dryRun !== false
    });
    res.json(result);
  } catch (error) {
    console.error('JSON import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload and import file
 */
router.post('/connectors/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { mapping, entityType, dryRun } = req.body;
    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Determine connector type
    let connectorType;
    if (fileExt === '.csv') connectorType = 'csv';
    else if (fileExt === '.json') connectorType = 'json';
    else {
      await fs.unlink(filePath);
      return res.status(400).json({ error: 'Unsupported file type. Use CSV or JSON.' });
    }

    // Parse mapping
    let parsedMapping;
    try {
      parsedMapping = typeof mapping === 'string' ? JSON.parse(mapping) : mapping;
    } catch (e) {
      parsedMapping = { entityType: entityType || 'Entity', fields: {} };
    }

    // Register temporary connector
    const connector = await dataConnectorService.registerConnector({
      name: `Import: ${req.file.originalname}`,
      type: connectorType,
      connectionConfig: { filePath, rootPath: parsedMapping.rootPath },
      mapping: parsedMapping
    });

    // Run import
    let result;
    if (connectorType === 'csv') {
      result = await dataConnectorService.importCSV(connector.id, { dryRun: dryRun === 'true' });
    } else {
      result = await dataConnectorService.importJSON(connector.id, { dryRun: dryRun === 'true' });
    }

    res.json({
      connectorId: connector.id,
      fileName: req.file.originalname,
      ...result
    });
  } catch (error) {
    console.error('File upload import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LINEAGE ENDPOINTS
// ============================================================

/**
 * Get entity lineage
 */
router.get('/lineage/:entityUri', async (req, res) => {
  try {
    const { depth } = req.query;
    const lineage = await lineageService.getEntityLineage(
      decodeURIComponent(req.params.entityUri),
      depth ? parseInt(depth, 10) : 3
    );
    
    if (!lineage) {
      return res.status(404).json({ error: 'Entity not found' });
    }
    
    res.json(lineage);
  } catch (error) {
    console.error('Lineage error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get impact analysis
 */
router.get('/lineage/:entityUri/impact', async (req, res) => {
  try {
    const impact = await lineageService.getImpactAnalysis(
      decodeURIComponent(req.params.entityUri)
    );
    
    if (!impact) {
      return res.status(404).json({ error: 'Entity not found' });
    }
    
    res.json(impact);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get lineage graph for visualization
 */
router.get('/lineage/:entityUri/graph', async (req, res) => {
  try {
    const { depth } = req.query;
    const graph = await lineageService.getLineageGraph(
      decodeURIComponent(req.params.entityUri),
      depth ? parseInt(depth, 10) : 2
    );
    res.json(graph);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validate entity provenance
 */
router.get('/lineage/:entityUri/validate', async (req, res) => {
  try {
    const validation = await lineageService.validateProvenance(
      decodeURIComponent(req.params.entityUri)
    );
    res.json(validation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Register a data source
 */
router.post('/sources', async (req, res) => {
  try {
    const source = await lineageService.registerSource(req.body);
    res.json(source);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all registered sources
 */
router.get('/sources', async (req, res) => {
  try {
    const sources = await lineageService.getSources();
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// SCHEMA VERSIONING ENDPOINTS
// ============================================================

/**
 * Create a new schema version
 */
router.post('/schema/:schemaId/versions', async (req, res) => {
  try {
    const { schema, description, userId } = req.body;
    
    const version = await schemaVersioningService.createVersion(
      req.params.schemaId,
      schema,
      { description, userId }
    );
    
    res.json(version);
  } catch (error) {
    console.error('Schema version error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get current schema version
 */
router.get('/schema/:schemaId/current', async (req, res) => {
  try {
    const version = await schemaVersioningService.getCurrentVersion(req.params.schemaId);
    
    if (!version) {
      return res.status(404).json({ error: 'Schema not found' });
    }
    
    res.json(version);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get schema version history
 */
router.get('/schema/:schemaId/history', async (req, res) => {
  try {
    const { limit } = req.query;
    const history = await schemaVersioningService.getVersionHistory(
      req.params.schemaId,
      limit ? parseInt(limit, 10) : 50
    );
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get specific version
 */
router.get('/schema/versions/:versionId', async (req, res) => {
  try {
    const version = await schemaVersioningService.getVersion(req.params.versionId);
    
    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    res.json(version);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Diff two versions
 */
router.get('/schema/diff', async (req, res) => {
  try {
    const { from, to } = req.query;
    
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to version IDs required' });
    }
    
    const diff = await schemaVersioningService.diffVersions(from, to);
    res.json(diff);
  } catch (error) {
    console.error('Diff error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Rollback to a version
 */
router.post('/schema/:schemaId/rollback', async (req, res) => {
  try {
    const { targetVersionId, userId } = req.body;
    
    if (!targetVersionId) {
      return res.status(400).json({ error: 'targetVersionId required' });
    }
    
    const result = await schemaVersioningService.rollbackToVersion(
      req.params.schemaId,
      targetVersionId,
      { userId }
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a version (cannot delete active version)
 */
router.delete('/schema/versions/:versionId', async (req, res) => {
  try {
    const result = await schemaVersioningService.deleteVersion(req.params.versionId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Generate migration
 */
router.get('/schema/migration', async (req, res) => {
  try {
    const { from, to } = req.query;
    
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to version IDs required' });
    }
    
    const migration = await schemaVersioningService.generateMigration(from, to);
    res.json(migration);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validate schema against data
 */
router.get('/schema/:schemaId/validate', async (req, res) => {
  try {
    const validation = await schemaVersioningService.validateSchemaAgainstData(
      req.params.schemaId
    );
    res.json(validation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Export schema to JSON-LD
 */
router.get('/schema/:schemaId/export/jsonld', async (req, res) => {
  try {
    const jsonld = await schemaVersioningService.exportToJsonLD(req.params.schemaId);
    res.json(jsonld);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ACTIVITY TRACKING ENDPOINTS
// ============================================================

/**
 * Record an activity
 */
router.post('/activity', async (req, res) => {
  try {
    const result = await activityTrackingService.recordActivity(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user activity
 */
router.get('/activity/user/:userId', async (req, res) => {
  try {
    const { limit } = req.query;
    const activity = await activityTrackingService.getUserActivity(
      req.params.userId,
      limit ? parseInt(limit, 10) : 50
    );
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get entity activity
 */
router.get('/activity/entity/:entityUri', async (req, res) => {
  try {
    const { limit } = req.query;
    const activity = await activityTrackingService.getEntityActivity(
      decodeURIComponent(req.params.entityUri),
      limit ? parseInt(limit, 10) : 50
    );
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get popular entities
 */
router.get('/activity/popular', async (req, res) => {
  try {
    const { limit } = req.query;
    const popular = await activityTrackingService.getTopPopularEntities(
      limit ? parseInt(limit, 10) : 20
    );
    res.json(popular);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get trending queries
 */
router.get('/activity/trending-queries', async (req, res) => {
  try {
    const { limit } = req.query;
    const trending = await activityTrackingService.getTrendingQueries(
      limit ? parseInt(limit, 10) : 10
    );
    res.json(trending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get analytics summary
 */
router.get('/activity/analytics', async (req, res) => {
  try {
    const { days } = req.query;
    const analytics = await activityTrackingService.getAnalyticsSummary(
      days ? parseInt(days, 10) : 7
    );
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get personalized boosts for entities
 */
router.post('/activity/personalized-boosts', async (req, res) => {
  try {
    const { userId, entityUris } = req.body;
    const boosts = await activityTrackingService.getPersonalizedBoosts(userId, entityUris);
    res.json(boosts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// RBAC ENDPOINTS (DEPRECATED — use server/config/roles.js system)
// These endpoints are preserved for backward compatibility but
// require admin access. The primary RBAC system is in
// server/config/roles.js + server/middleware/auth.js.
// ============================================================

/**
 * Initialize RBAC (create default roles)
 */
router.post('/rbac/initialize', requireAdmin, async (req, res) => {
  try {
    const result = await rbacService.initialize();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all roles
 */
router.get('/rbac/roles', async (req, res) => {
  try {
    const roles = await rbacService.getAllRoles();
    res.json(roles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a role
 */
router.post('/rbac/roles', requireAdmin, async (req, res) => {
  try {
    const { id, name, description, permissions, entityTypeRestrictions } = req.body;
    
    if (!id || !name) {
      return res.status(400).json({ error: 'id and name required' });
    }
    
    const role = await rbacService.createRole(id, {
      name,
      description,
      permissions,
      entityTypeRestrictions
    });
    
    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a role
 */
router.put('/rbac/roles/:roleId', requireAdmin, async (req, res) => {
  try {
    const role = await rbacService.updateRole(req.params.roleId, req.body);
    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a role
 */
router.delete('/rbac/roles/:roleId', requireAdmin, async (req, res) => {
  try {
    const result = await rbacService.deleteRole(req.params.roleId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Assign role to user
 */
router.post('/rbac/users/:userId/roles', requireAdmin, async (req, res) => {
  try {
    const { roleId } = req.body;
    
    if (!roleId) {
      return res.status(400).json({ error: 'roleId required' });
    }
    
    const result = await rbacService.assignRole(req.params.userId, roleId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Remove role from user
 */
router.delete('/rbac/users/:userId/roles/:roleId', requireAdmin, async (req, res) => {
  try {
    const result = await rbacService.removeRole(req.params.userId, req.params.roleId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's roles and permissions
 */
router.get('/rbac/users/:userId/permissions', async (req, res) => {
  try {
    const permissions = await rbacService.getUserPermissions(req.params.userId);
    res.json(permissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check if user has permission
 */
router.get('/rbac/users/:userId/check', async (req, res) => {
  try {
    const { permission } = req.query;
    
    if (!permission) {
      return res.status(400).json({ error: 'permission query param required' });
    }
    
    const hasPermission = await rbacService.hasPermission(req.params.userId, permission);
    res.json({ hasPermission });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Set entity ACL
 */
router.post('/rbac/entities/:entityUri/acl', requireAdmin, async (req, res) => {
  try {
    const acl = await rbacService.setEntityACL(
      decodeURIComponent(req.params.entityUri),
      req.body
    );
    res.json(acl);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get entity ACL
 */
router.get('/rbac/entities/:entityUri/acl', async (req, res) => {
  try {
    const acl = await rbacService.getEntityACL(
      decodeURIComponent(req.params.entityUri)
    );
    res.json(acl || { message: 'No ACL set for this entity' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get audit log
 */
router.get('/rbac/audit', async (req, res) => {
  try {
    const { limit } = req.query;
    const logs = await rbacService.getPermissionAuditLog(limit ? parseInt(limit, 10) : 100);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// GRAPH ALGORITHMS ENDPOINTS
// ============================================================

/**
 * Calculate PageRank
 */
router.post('/graph-algorithms/pagerank', async (req, res) => {
  try {
    const { iterations, dampingFactor, entityTypes, limit } = req.body;
    
    const result = await graphAlgorithmsService.calculatePageRank({
      iterations,
      dampingFactor,
      entityTypes,
      limit
    });
    
    res.json(result);
  } catch (error) {
    console.error('PageRank error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Calculate degree centrality
 */
router.post('/graph-algorithms/degree-centrality', async (req, res) => {
  try {
    const { entityTypes, limit } = req.body;
    
    const result = await graphAlgorithmsService.calculateDegreeCentrality({
      entityTypes,
      limit
    });
    
    res.json(result);
  } catch (error) {
    console.error('Degree centrality error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Calculate betweenness centrality
 */
router.post('/graph-algorithms/betweenness-centrality', async (req, res) => {
  try {
    const { entityTypes, sampleSize, limit } = req.body;
    
    const result = await graphAlgorithmsService.calculateBetweennessCentrality({
      entityTypes,
      sampleSize,
      limit
    });
    
    res.json(result);
  } catch (error) {
    console.error('Betweenness centrality error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Detect communities
 */
router.post('/graph-algorithms/communities', async (req, res) => {
  try {
    const { iterations, entityTypes } = req.body;
    
    const result = await graphAlgorithmsService.detectCommunities({
      iterations,
      entityTypes
    });
    
    res.json(result);
  } catch (error) {
    console.error('Community detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Find shortest path
 */
router.post('/graph-algorithms/shortest-path', async (req, res) => {
  try {
    const { sourceUri, targetUri, maxDepth } = req.body;
    
    if (!sourceUri || !targetUri) {
      return res.status(400).json({ error: 'sourceUri and targetUri required' });
    }
    
    const result = await graphAlgorithmsService.findShortestPath(sourceUri, targetUri, {
      maxDepth
    });
    
    res.json(result);
  } catch (error) {
    console.error('Shortest path error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Find all paths
 */
router.post('/graph-algorithms/all-paths', async (req, res) => {
  try {
    const { sourceUri, targetUri, maxDepth, limit } = req.body;
    
    if (!sourceUri || !targetUri) {
      return res.status(400).json({ error: 'sourceUri and targetUri required' });
    }
    
    const result = await graphAlgorithmsService.findAllPaths(sourceUri, targetUri, {
      maxDepth,
      limit
    });
    
    res.json(result);
  } catch (error) {
    console.error('All paths error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Find connected components
 */
router.post('/graph-algorithms/connected-components', async (req, res) => {
  try {
    const { entityTypes, minSize } = req.body;
    
    const result = await graphAlgorithmsService.findConnectedComponents({
      entityTypes,
      minSize
    });
    
    res.json(result);
  } catch (error) {
    console.error('Connected components error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get graph statistics
 */
router.get('/graph-algorithms/statistics', async (req, res) => {
  try {
    const stats = await graphAlgorithmsService.getGraphStatistics();
    res.json(stats);
  } catch (error) {
    console.error('Graph statistics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// MULTI-TENANT MIGRATION ENDPOINTS
// ============================================================

const migrationService = require('../services/migrationService');

/**
 * Get migration status
 */
router.get('/migration/status', async (req, res) => {
  try {
    const status = await migrationService.getMigrationStatus();
    res.json(status);
  } catch (error) {
    console.error('Migration status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Run full migration to multi-tenant model
 */
router.post('/migration/run', requireAdmin, async (req, res) => {
  try {
    const result = await migrationService.migrateToMultiTenant();
    res.json(result);
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Migrate specific tenant data
 */
router.post('/migration/tenant', requireAdmin, async (req, res) => {
  try {
    const { tenant_id, workspace_id } = req.body;
    
    if (!tenant_id || !workspace_id) {
      return res.status(400).json({ error: 'tenant_id and workspace_id required' });
    }
    
    const result = await migrationService.migrateTenantData(tenant_id, workspace_id);
    res.json(result);
  } catch (error) {
    console.error('Tenant migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
