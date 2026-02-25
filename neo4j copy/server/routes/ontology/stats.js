/**
 * Statistics and Schema Routes
 * Graph statistics and schema management
 */

const express = require('express');
const router = express.Router();

const neo4jService = require('../../services/neo4jService');
const graphSchemaService = require('../../services/graphSchemaService');
const owlOntologyService = require('../../services/owlOntologyService');
const jobService = require('../../services/jobService');
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { requireManager } = require('../../middleware/auth');

/**
 * GET /api/ontology/stats
 * Get graph statistics
 */
router.get('/', async (_req, res) => {
  try {
    const stats = await neo4jService.getGraphStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/storage-status
 * Get ontology storage status
 */
router.get('/storage-status', async (_req, res) => {
  try {
    const status = { connected: true, ontologies: 0 };
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Error getting storage status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/all
 * Get all ontologies (predefined + custom)
 * Returns flat array for backward compatibility
 */
router.get('/all', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;
    
    // Get flat array of all ontologies
    const ontologies = await owlOntologyService.listOntologies(tenantId, workspaceId);
    
    const storage = { connected: true, ontologies: ontologies.length };
    res.json({ success: true, ontologies, storage });
  } catch (error) {
    console.error('Error fetching all ontologies:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/:id
 * Get a specific ontology by ID
 */
router.get('/:id', optionalTenantContext, async (req, res, next) => {
  try {
    // Skip route parameters that look like other endpoints
    const skipIds = ['stats', 'all', 'templates', 'jobs', 'documents', 'folders', 
                     'entities', 'relationships', 'chunks', 'cleanup', 'schema',
                     'analyze', 'analysis', 'custom-ontology', 'custom-ontologies'];
    if (skipIds.includes(req.params.id)) {
      return next();
    }
    
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;
    
    const ontology = await owlOntologyService.getOntologyStructure(tenantId || 'default', workspaceId || 'default', req.params.id);
    if (!ontology) {
      return res.status(404).json({ success: false, error: 'Ontology not found' });
    }
    res.json({ success: true, ontology });
  } catch (error) {
    console.error('Error fetching ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/schema
 * Get schema status
 */
router.get('/schema', async (_req, res) => {
  try {
    const status = await graphSchemaService.getSchemaStatus();
    res.json({ success: true, schema: status });
  } catch (error) {
    console.error('Error fetching schema:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/schema/initialize
 * Initialize the Neo4j schema
 */
router.post('/schema/initialize', requireManager, async (_req, res) => {
  try {
    const result = await graphSchemaService.initializeSchema();
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error initializing schema:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/debug/keys
 * Debug endpoint: List all ontology keys in Redis
 */
router.get('/debug/keys', async (_req, res) => {
  try {
    const keys = { message: 'Ontologies are now stored in GraphDB, not Redis' };
    res.json({ success: true, ...keys });
  } catch (error) {
    console.error('Error listing keys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs/status/:queueName/:jobId
 * Get status of a specific job
 */
router.get('/jobs/status/:queueName/:jobId', async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    const status = await jobService.getJobStatus(queueName, jobId);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error fetching job status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs/pipeline/:pipelineId
 * Get status of all jobs in a pipeline
 */
router.get('/jobs/pipeline/:pipelineId', async (req, res) => {
  try {
    const { pipelineId } = req.params;
    const status = await jobService.getPipelineStatus(pipelineId);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error fetching pipeline status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs/stats
 * Get queue statistics
 */
router.get('/jobs/stats', async (_req, res) => {
  try {
    const stats = await jobService.getQueueStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching queue stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/jobs/:queueName/:jobId
 * Cancel a job
 */
router.delete('/jobs/:queueName/:jobId', requireManager, async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    const result = await jobService.cancelJob(queueName, jobId);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
