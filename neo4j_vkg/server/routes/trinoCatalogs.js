/**
 * Trino Catalog Management Routes
 * Register, test, introspect, and remove external database catalogs.
 */

const express = require('express');
const router = express.Router();
const trinoCatalogService = require('../services/trinoCatalogService');
const trinoClient = require('../config/trino');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireAuth, requireManager } = require('../middleware/auth');
const logger = require('../utils/logger');

// Helper: extract tenantId from request context
function getTenantId(req) {
  return req.tenantContext?.tenant_id || req.query.tenantId || req.query.tenant_id || req.body?.tenantId || 'default';
}

// Apply tenant context and auth to all routes
router.use(optionalTenantContext);

/**
 * GET /api/trino/health
 * Check Trino coordinator connectivity
 */
router.get('/health', async (req, res) => {
  try {
    const status = await trinoClient.checkConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/catalogs/discover
 * Discover pre-existing catalogs from Trino and sync into the app
 */
router.post('/catalogs/discover', requireManager, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await trinoCatalogService.discoverCatalogs(tenantId);
    res.json(result);
  } catch (err) {
    logger.error(`Failed to discover catalogs: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/catalogs
 * Register a new external database as a Trino catalog
 */
router.post('/catalogs', requireManager, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const body = req.body;
    // Normalize frontend field names (type→connector, username→user)
    const config = {
      ...body,
      connector: body.connector || body.type,
      user: body.user || body.username,
    };
    const result = await trinoCatalogService.registerCatalog(tenantId, config);
    res.status(201).json(result);
  } catch (err) {
    logger.error(`Failed to register catalog: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs
 * List all catalogs for the current tenant
 */
router.get('/catalogs', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const catalogs = await trinoCatalogService.listCatalogs(tenantId);
    res.json({ catalogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trino/catalogs/:name
 * Remove a catalog
 */
router.delete('/catalogs/:name', requireManager, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await trinoCatalogService.removeCatalog(tenantId, req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trino/catalogs/:name/test
 * Test catalog connectivity
 */
router.post('/catalogs/:name/test', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await trinoCatalogService.testCatalog(tenantId, req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * GET /api/trino/catalogs/:name/schema
 * Introspect a catalog's schema
 */
router.get('/catalogs/:name/schema', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const schema = await trinoCatalogService.introspectCatalog(tenantId, req.params.name);
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs/:name/introspect
 * Alias for schema introspection (used by frontend DataSourcesManager)
 */
router.get('/catalogs/:name/introspect', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const schema = await trinoCatalogService.introspectCatalog(tenantId, req.params.name);
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trino/catalogs/:name/test
 * Test catalog connectivity (GET alias for frontend)
 */
router.get('/catalogs/:name/test', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const result = await trinoCatalogService.testCatalog(tenantId, req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
});

module.exports = router;
