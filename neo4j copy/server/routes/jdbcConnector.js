/**
 * External Database Connector Routes
 *
 * Two modes:
 *   1. Saved connections — workspace-scoped, persisted in Redis via DirectConnectionManager
 *      POST   /api/jdbc/connections          — save a new connection config
 *      GET    /api/jdbc/connections           — list saved connections for workspace
 *      PUT    /api/jdbc/connections/:id       — update a saved connection
 *      DELETE /api/jdbc/connections/:id       — remove a saved connection
 *      POST   /api/jdbc/connections/:id/test  — test a saved connection
 *
 *   2. Ephemeral connections — for ad-hoc import flows (connect → analyze → import → disconnect)
 *      POST   /api/jdbc/test                  — test connection params (no save)
 *      POST   /api/jdbc/connect               — open ephemeral connection
 *      DELETE /api/jdbc/:connectionId         — close ephemeral connection
 *      POST   /api/jdbc/:connectionId/analyze — analyze schema
 *      GET    /api/jdbc/:connectionId/tables/:tableName/preview — preview data
 *      POST   /api/jdbc/:connectionId/import  — import to knowledge graph
 */

const express = require('express');
const router = express.Router();
const jdbcConnectorService = require('../services/jdbcConnectorService');
const directConnectionManager = require('../config/directConnections');
const graphDBStore = require('../services/graphDBStore');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { v4: uuidv4 } = require('uuid');

// ─── Saved (workspace-scoped) connections ─────────────────────────

// List saved connections for a workspace
router.get('/connections', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || 'default';
    const connections = await directConnectionManager.listConnections(workspaceId);
    res.json({ connections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save a new connection
router.post('/connections', async (req, res) => {
  try {
    const { workspaceId, ...config } = req.body;
    const saved = await directConnectionManager.saveConnection(workspaceId || 'default', config);
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test connection params directly (no save) — must be before :id routes
router.post('/connections/test', async (req, res) => {
  try {
    const result = await directConnectionManager.testConnection(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ connected: false, error: error.message });
  }
});

// Update a saved connection
router.put('/connections/:id', async (req, res) => {
  try {
    const { workspaceId, ...updates } = req.body;
    const updated = await directConnectionManager.updateConnection(workspaceId || 'default', req.params.id, updates);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a saved connection
router.delete('/connections/:id', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || 'default';
    await directConnectionManager.removeConnection(workspaceId, req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test a saved connection
router.post('/connections/:id/test', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || req.body.workspaceId || 'default';
    const config = await directConnectionManager.getConnectionFull(workspaceId, req.params.id);
    if (!config) return res.status(404).json({ error: 'Connection not found' });
    const result = await directConnectionManager.testConnection(config);
    // Update status in Redis based on test result
    if (result.connected) {
      await directConnectionManager.updateConnection(workspaceId, req.params.id, { status: 'active' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ connected: false, error: error.message });
  }
});

// ─── Ephemeral connections (ad-hoc import flows) ──────────────────

// Test database connection (legacy)
router.post('/test', async (req, res) => {
  try {
    const result = await jdbcConnectorService.testConnection(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Establish ephemeral connection
router.post('/connect', async (req, res) => {
  try {
    const connectionId = uuidv4();
    const result = await jdbcConnectorService.connect(connectionId, req.body);
    res.json({ connectionId, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Disconnect ephemeral connection
router.delete('/:connectionId', async (req, res) => {
  try {
    await jdbcConnectorService.disconnect(req.params.connectionId);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analyze schema
router.post('/:connectionId/analyze', async (req, res) => {
  try {
    const schema = await jdbcConnectorService.analyzeSchema(req.params.connectionId);
    res.json({ schemaId: uuidv4(), ...schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get table data preview
router.get('/:connectionId/tables/:tableName/preview', async (req, res) => {
  try {
    const rows = await jdbcConnectorService.importData(
      req.params.connectionId, 
      req.params.tableName,
      { limit: parseInt(req.query.limit) || 50 }
    );
    res.json({ rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import data to knowledge graph
router.post('/:connectionId/import', optionalTenantContext, async (req, res) => {
  try {
    const { schema, ontologyMapping } = req.body;
    const tenantId = req.tenantId || 'default';
    const workspaceId = req.workspaceId || 'default';

    const result = await jdbcConnectorService.importToKnowledgeGraph(
      req.params.connectionId,
      schema,
      ontologyMapping,
      graphDBStore,
      tenantId,
      workspaceId
    );

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
