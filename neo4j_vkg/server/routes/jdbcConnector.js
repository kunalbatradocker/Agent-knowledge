/**
 * External Database Connector Routes
 */

const express = require('express');
const router = express.Router();
const jdbcConnectorService = require('../services/jdbcConnectorService');
const graphDBStore = require('../services/graphDBStore');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { v4: uuidv4 } = require('uuid');

// Test database connection
router.post('/test', async (req, res) => {
  try {
    const result = await jdbcConnectorService.testConnection(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Establish connection
router.post('/connect', async (req, res) => {
  try {
    const connectionId = uuidv4();
    const result = await jdbcConnectorService.connect(connectionId, req.body);
    res.json({ connectionId, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect
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
