/**
 * Entity Identity Routes
 * Merge, split, and identity governance operations
 */

const express = require('express');
const router = express.Router();
const entityIdentityService = require('../services/entityIdentityService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager } = require('../middleware/auth');

/**
 * POST /api/identity/merge
 * Merge two entities into one
 */
router.post('/merge', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const { source_entity_id, target_entity_id, reason } = req.body;
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.body.tenant_id || req.tenantContext?.tenant_id;
    const performedBy = req.body.performed_by || req.tenantContext?.user_id || 'anonymous';

    if (!source_entity_id || !target_entity_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'source_entity_id and target_entity_id are required' 
      });
    }

    const result = await entityIdentityService.mergeEntities(source_entity_id, target_entity_id, {
      reason,
      performedBy,
      workspaceId,
      tenantId
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error merging entities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/identity/split
 * Split one entity into multiple
 */
router.post('/split', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const { source_entity_id, split_definitions, reason, delete_source } = req.body;
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.body.tenant_id || req.tenantContext?.tenant_id;
    const performedBy = req.body.performed_by || req.tenantContext?.user_id || 'anonymous';

    if (!source_entity_id || !split_definitions || !Array.isArray(split_definitions)) {
      return res.status(400).json({ 
        success: false, 
        error: 'source_entity_id and split_definitions array are required' 
      });
    }

    const result = await entityIdentityService.splitEntity(source_entity_id, split_definitions, {
      reason,
      performedBy,
      workspaceId,
      tenantId,
      deleteSource: delete_source !== false
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error splitting entity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/duplicates
 * Find potential duplicate entities
 */
router.get('/duplicates', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const className = req.query.class;
    const threshold = parseFloat(req.query.threshold) || 0.8;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const duplicates = await entityIdentityService.findDuplicates(workspaceId, className, {
      threshold
    });

    res.json({ success: true, duplicates, count: duplicates.length });
  } catch (error) {
    console.error('Error finding duplicates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/:entityId/aliases
 * Get all aliases for an entity
 */
router.get('/:entityId/aliases', async (req, res) => {
  try {
    const aliases = await entityIdentityService.getAliases(req.params.entityId);
    res.json({ success: true, entity_id: req.params.entityId, aliases });
  } catch (error) {
    console.error('Error fetching aliases:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/resolve/:id
 * Resolve an ID to its canonical form
 */
router.get('/resolve/:id', async (req, res) => {
  try {
    const canonicalId = await entityIdentityService.resolveId(req.params.id);
    res.json({ 
      success: true, 
      input_id: req.params.id, 
      canonical_id: canonicalId,
      is_alias: canonicalId !== req.params.id
    });
  } catch (error) {
    console.error('Error resolving ID:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/identity/generate-id
 * Generate a deterministic canonical ID
 */
router.post('/generate-id', (req, res) => {
  try {
    const { class_name, identity_keys } = req.body;

    if (!class_name) {
      return res.status(400).json({ success: false, error: 'class_name is required' });
    }

    const canonicalId = entityIdentityService.generateCanonicalId(class_name, identity_keys || {});
    res.json({ success: true, canonical_id: canonicalId });
  } catch (error) {
    console.error('Error generating ID:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/changes
 * Get identity change history
 */
router.get('/changes', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const changes = await entityIdentityService.getChangeHistory(workspaceId, { limit, offset });
    res.json({ success: true, changes, count: changes.length });
  } catch (error) {
    console.error('Error fetching change history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/changes/:changeId
 * Get a specific change record
 */
router.get('/changes/:changeId', async (req, res) => {
  try {
    const change = await entityIdentityService.getChange(req.params.changeId);
    if (!change) {
      return res.status(404).json({ success: false, error: 'Change not found' });
    }
    res.json({ success: true, change });
  } catch (error) {
    console.error('Error fetching change:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
