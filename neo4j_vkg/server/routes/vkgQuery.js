/**
 * VKG Query Routes
 * Natural language queries against federated databases via Trino.
 * 
 * NOTE: Per-user Bedrock tokens are handled automatically by the
 * injectUserLLMToken middleware (via AsyncLocalStorage). No manual
 * token lookup needed — same pattern as schemaAnalysisService.
 */

const express = require('express');
const router = express.Router();
const vkgQueryService = require('../services/vkgQueryService');
const vkgOntologyService = require('../services/vkgOntologyService');
const tenantService = require('../services/tenantService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager } = require('../middleware/auth');
const logger = require('../utils/logger');

// Helper: extract tenant/workspace from request context
function getContext(req) {
  return {
    tenantId: req.tenantContext?.tenant_id || req.query.tenantId || req.query.tenant_id || req.body?.tenantId || 'default',
    workspaceId: req.tenantContext?.workspace_id || req.query.workspaceId || req.query.workspace_id || req.body?.workspaceId || 'default'
  };
}

/**
 * Resolve workspace name from workspace ID.
 * VKG uses workspace name (slugified) in graph IRIs for readability,
 * while keeping workspace ID for cache keys and internal lookups.
 */
async function resolveWorkspaceName(workspaceId) {
  if (!workspaceId || workspaceId === 'default') return 'default';
  try {
    const ws = await tenantService.getWorkspace(workspaceId);
    if (ws?.name) {
      return ws.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || workspaceId;
    }
  } catch (e) {
    logger.warn(`[VKG] Could not resolve workspace name for ${workspaceId}: ${e.message}`);
  }
  return workspaceId;
}

// Apply tenant context to all routes
router.use(optionalTenantContext);

/**
 * POST /api/vkg/query
 * Execute a natural language query against federated databases
 */
router.post('/query', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const { question } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const workspaceName = await resolveWorkspaceName(workspaceId);
    logger.info(`[VKG] Query from tenant ${tenantId}, workspace ${workspaceName}: "${question.substring(0, 80)}..."`);
    console.log(`[VKG] Query context: tenant=${tenantId}, workspace=${workspaceId} (${workspaceName}), header-ws=${req.headers['x-workspace-id']}, body-ws=${req.body?.workspaceId}`);
    const result = await vkgQueryService.query(question.trim(), tenantId, workspaceId, { workspaceName });
    res.json(result);
  } catch (err) {
    logger.error(`[VKG] Query route error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vkg/ontology/generate
 * Generate VKG ontology from connected Trino catalogs
 */
router.post('/ontology/generate', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const options = req.body || {};

    const workspaceName = await resolveWorkspaceName(workspaceId);
    logger.info(`[VKG] Generating ontology for tenant ${tenantId}, workspace ${workspaceName} (${workspaceId})`);
    console.log(`[VKG] Generate ontology context: tenant=${tenantId}, workspace=${workspaceId} (${workspaceName}), header-ws=${req.headers['x-workspace-id']}, body-ws=${req.body?.workspaceId}`);

    const result = await vkgOntologyService.generateFromCatalogs(tenantId, workspaceId, { ...options, workspaceName });
    res.json(result);
  } catch (err) {
    logger.error(`[VKG] Ontology generation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vkg/ontology/save
 * Save a reviewed/edited ontology to GraphDB
 */
router.post('/ontology/save', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const { turtle, name, baseUri } = req.body;

    if (!turtle) {
      return res.status(400).json({ error: 'Missing turtle content' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Missing ontology name' });
    }

    const workspaceName = await resolveWorkspaceName(workspaceId);
    logger.info(`[VKG] Saving reviewed ontology "${name}" for tenant ${tenantId}, workspace ${workspaceName} (${workspaceId})`);
    console.log(`[VKG] Save ontology context: tenant=${tenantId}, workspace=${workspaceId} (${workspaceName}), header-ws=${req.headers['x-workspace-id']}, body-ws=${req.body?.workspaceId}`);
    const result = await vkgOntologyService.saveOntology(tenantId, workspaceId, turtle, { name, baseUri, workspaceName });
    res.json(result);
  } catch (err) {
    logger.error(`[VKG] Ontology save error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/vkg/ontology/mappings
 * Get current VKG mapping annotations
 */
router.get('/ontology/mappings', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const workspaceName = await resolveWorkspaceName(workspaceId);
    const mappings = await vkgOntologyService.getMappingAnnotations(tenantId, workspaceId, workspaceName);
    res.json(mappings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/vkg/ontology/drift
 * Check for schema drift between Trino catalogs and stored ontology
 */
router.get('/ontology/drift', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const workspaceName = await resolveWorkspaceName(workspaceId);
    const drift = await vkgOntologyService.detectSchemaDrift(tenantId, workspaceId, workspaceName);
    res.json(drift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vkg/ontology/refresh
 * Refresh VKG ontology from current Trino schemas
 */
router.post('/ontology/refresh', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const options = req.body || {};
    const workspaceName = await resolveWorkspaceName(workspaceId);

    await vkgOntologyService.invalidateCache(tenantId, workspaceId);
    const result = await vkgOntologyService.generateFromCatalogs(tenantId, workspaceId, { ...options, workspaceName });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
