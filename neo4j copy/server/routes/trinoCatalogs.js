/**
 * Trino Catalog Management Routes
 * Register, test, introspect, and remove external database catalogs.
 * Supports per-workspace Trino connections.
 */

const express = require('express');
const router = express.Router();
const trinoCatalogService = require('../services/trinoCatalogService');
const trinoManager = require('../config/trino');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireAuth, requireManager } = require('../middleware/auth');
const logger = require('../utils/logger');

// Helper: extract tenantId and workspaceId from request context
function getContext(req) {
  return {
    tenantId: req.tenantContext?.tenant_id || req.query.tenantId || req.query.tenant_id || req.body?.tenantId || 'default',
    workspaceId: req.tenantContext?.workspace_id || req.query.workspaceId || req.query.workspace_id || req.body?.workspaceId || 'default'
  };
}

// Apply tenant context and auth to all routes
router.use(optionalTenantContext);

// ─── Trino Connection Management ────────────────────────────────────

/**
 * GET /api/trino/connection
 * Get the Trino connection config for the current workspace
 */
router.get('/connection', async (req, res) => {
  try {
    const { workspaceId } = getContext(req);
    const config = await trinoManager.getConnection(workspaceId);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/trino/connection
 * Set the Trino connection for the current workspace
 */
router.put('/connection', requireManager, async (req, res) => {
  try {
    const { workspaceId } = getContext(req);
    const { url, user, authType, password, jwtToken, tlsSkipVerify } = req.body;
    if (!url) return res.status(400).json({ error: 'Trino URL is required' });
    const result = await trinoManager.setConnection(workspaceId, {
      url, user: user || 'trino', authType: authType || 'none',
      password: password || '', jwtToken: jwtToken || '',
      tlsSkipVerify: !!tlsSkipVerify
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trino/connection
 * Remove workspace-specific Trino config (reverts to env default)
 */
router.delete('/connection', requireManager, async (req, res) => {
  try {
    const { workspaceId } = getContext(req);
    await trinoManager.removeConnection(workspaceId);
    const config = await trinoManager.getConnection(workspaceId);
    res.json({ success: true, ...config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/connection/test
 * Test a Trino connection without saving it
 */
router.post('/connection/test', async (req, res) => {
  try {
    const { url, user, authType, password, jwtToken, tlsSkipVerify } = req.body;
    if (!url) return res.status(400).json({ error: 'Trino URL is required' });
    const status = await trinoManager.testConnection({
      url, user: user || 'trino', authType: authType || 'none',
      password: password || '', jwtToken: jwtToken || '',
      tlsSkipVerify: !!tlsSkipVerify
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trino/health
 * Check Trino connectivity for the current workspace
 */
router.get('/health', async (req, res) => {
  try {
    const { workspaceId } = getContext(req);
    const client = await trinoManager.getClient(workspaceId);
    const status = await client.checkConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Catalog Management ─────────────────────────────────────────────

/**
 * POST /api/trino/catalogs/discover
 */
router.post('/catalogs/discover', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const result = await trinoCatalogService.discoverCatalogs(tenantId, workspaceId);
    res.json(result);
  } catch (err) {
    logger.error(`Failed to discover catalogs: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/catalogs
 */
router.post('/catalogs', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const body = req.body;
    const config = {
      ...body,
      connector: body.connector || body.type,
      user: body.user || body.username,
    };
    const result = await trinoCatalogService.registerCatalog(tenantId, config, workspaceId);
    res.status(201).json(result);
  } catch (err) {
    logger.error(`Failed to register catalog: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs
 */
router.get('/catalogs', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    logger.info(`[Trino] GET /catalogs — tenant=${tenantId}, workspace=${workspaceId}, headers=[t=${req.headers['x-tenant-id']}, w=${req.headers['x-workspace-id']}], query=[t=${req.query.tenantId}, w=${req.query.workspaceId}]`);
    const catalogs = await trinoCatalogService.listCatalogs(tenantId, workspaceId);
    logger.info(`[Trino] GET /catalogs — returning ${catalogs.length} catalog(s)`);
    res.json({ catalogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trino/catalogs/:name
 */
router.delete('/catalogs/:name', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const result = await trinoCatalogService.removeCatalog(tenantId, req.params.name, workspaceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/catalogs/:name/test
 */
router.post('/catalogs/:name/test', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const result = await trinoCatalogService.testCatalog(tenantId, req.params.name, workspaceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * GET /api/trino/catalogs/:name/schema
 */
router.get('/catalogs/:name/schema', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const schema = await trinoCatalogService.introspectCatalog(tenantId, req.params.name, null, workspaceId);
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs/:name/introspect
 */
router.get('/catalogs/:name/introspect', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const schema = await trinoCatalogService.introspectCatalog(tenantId, req.params.name, null, workspaceId);
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs/:name/test
 */
router.get('/catalogs/:name/test', async (req, res) => {
  try {
    const { tenantId, workspaceId } = getContext(req);
    const result = await trinoCatalogService.testCatalog(tenantId, req.params.name, workspaceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
});

module.exports = router;
