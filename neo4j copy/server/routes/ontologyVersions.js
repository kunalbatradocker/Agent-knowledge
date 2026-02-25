/**
 * Ontology Versioning Routes
 * API endpoints for ontology version management, branching, and tagging
 */

const express = require('express');
const router = express.Router();
const ontologyVersioningService = require('../services/ontologyVersioningService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager } = require('../middleware/auth');

router.use(optionalTenantContext);

// ============================================================
// VERSION MANAGEMENT
// ============================================================

/**
 * POST /api/ontology-versions/:ontologyId/versions
 * Create a new version of an ontology
 */
router.post('/:ontologyId/versions', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { description, branch, tag, parent_version } = req.body;
    
    const version = await ontologyVersioningService.createVersion(ontologyId, {
      description,
      branch: branch || 'main',
      tag,
      parent_version,
      user_id: req.headers['x-user-id'] || 'anonymous',
      tenant_id: req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default',
      workspace_id: req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default'
    });
    
    res.json({ success: true, version });
  } catch (error) {
    console.error('Error creating ontology version:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology-versions/:ontologyId/versions
 * Get version history for an ontology
 */
router.get('/:ontologyId/versions', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { limit, branch } = req.query;
    
    const versions = await ontologyVersioningService.getVersionHistory(ontologyId, {
      limit: parseInt(limit) || 50,
      branch
    });
    
    const currentVersion = await ontologyVersioningService.getCurrentVersion(ontologyId);
    
    res.json({
      success: true,
      ontology_id: ontologyId,
      current_version: currentVersion,
      total_versions: versions.length,
      versions
    });
  } catch (error) {
    console.error('Error getting version history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology-versions/:ontologyId/versions/:versionId
 * Get specific version data
 */
router.get('/:ontologyId/versions/:versionId', async (req, res) => {
  try {
    const { ontologyId, versionId } = req.params;
    
    const meta = await ontologyVersioningService.getVersionMeta(ontologyId, versionId);
    const data = await ontologyVersioningService.getVersionData(ontologyId, versionId);
    
    if (!meta || !data) {
      return res.status(404).json({ success: false, error: 'Version not found' });
    }
    
    res.json({ success: true, meta, data });
  } catch (error) {
    console.error('Error getting version:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology-versions/:ontologyId/rollback
 * Rollback ontology to a previous version
 */
router.post('/:ontologyId/rollback', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { version_id, reason, create_backup = true } = req.body;
    
    if (!version_id) {
      return res.status(400).json({ success: false, error: 'version_id is required' });
    }
    
    const result = await ontologyVersioningService.rollbackToVersion(ontologyId, version_id, {
      user_id: req.headers['x-user-id'] || 'anonymous',
      reason,
      create_backup
    });
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error rolling back ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology-versions/:ontologyId/compare
 * Compare two ontology versions
 */
router.get('/:ontologyId/compare', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { v1, v2 } = req.query;
    
    if (!v1 || !v2) {
      return res.status(400).json({ success: false, error: 'v1 and v2 query params required' });
    }
    
    const comparison = await ontologyVersioningService.compareVersions(ontologyId, v1, v2);
    
    res.json({ success: true, ...comparison });
  } catch (error) {
    console.error('Error comparing versions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// BRANCHING
// ============================================================

/**
 * GET /api/ontology-versions/:ontologyId/branches
 * Get all branches for an ontology
 */
router.get('/:ontologyId/branches', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    
    const branches = await ontologyVersioningService.getBranches(ontologyId);
    
    res.json({ success: true, ontology_id: ontologyId, branches });
  } catch (error) {
    console.error('Error getting branches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology-versions/:ontologyId/branches
 * Create a new branch
 */
router.post('/:ontologyId/branches', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { branch_name, from_version, description } = req.body;
    
    if (!branch_name) {
      return res.status(400).json({ success: false, error: 'branch_name is required' });
    }
    
    const branch = await ontologyVersioningService.createBranch(ontologyId, branch_name, from_version, {
      user_id: req.headers['x-user-id'] || 'anonymous',
      description
    });
    
    res.json({ success: true, branch });
  } catch (error) {
    console.error('Error creating branch:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology-versions/:ontologyId/branches/:branchName/switch
 * Switch to a different branch
 */
router.post('/:ontologyId/branches/:branchName/switch', requireManager, async (req, res) => {
  try {
    const { ontologyId, branchName } = req.params;
    
    const result = await ontologyVersioningService.switchBranch(ontologyId, branchName, {
      user_id: req.headers['x-user-id'] || 'anonymous'
    });
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error switching branch:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// TAGGING
// ============================================================

/**
 * GET /api/ontology-versions/:ontologyId/tags
 * Get all tags for an ontology
 */
router.get('/:ontologyId/tags', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    
    const tags = await ontologyVersioningService.getTags(ontologyId);
    
    res.json({ success: true, ontology_id: ontologyId, tags });
  } catch (error) {
    console.error('Error getting tags:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology-versions/:ontologyId/tags
 * Create a new tag
 */
router.post('/:ontologyId/tags', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tag_name, version_id, description } = req.body;
    
    if (!tag_name) {
      return res.status(400).json({ success: false, error: 'tag_name is required' });
    }
    
    const tag = await ontologyVersioningService.createTag(ontologyId, tag_name, version_id, {
      user_id: req.headers['x-user-id'] || 'anonymous',
      description
    });
    
    res.json({ success: true, tag });
  } catch (error) {
    console.error('Error creating tag:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology-versions/:ontologyId/tags/:tagName
 * Delete a tag
 */
router.delete('/:ontologyId/tags/:tagName', requireManager, async (req, res) => {
  try {
    const { ontologyId, tagName } = req.params;
    
    const result = await ontologyVersioningService.deleteTag(ontologyId, tagName, {
      user_id: req.headers['x-user-id'] || 'anonymous'
    });
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error deleting tag:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * GET /api/ontology-versions/:ontologyId/audit
 * Get audit log for an ontology
 */
router.get('/:ontologyId/audit', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { limit } = req.query;
    
    const auditLog = await ontologyVersioningService.getAuditLog(ontologyId, parseInt(limit) || 50);
    
    res.json({ success: true, ontology_id: ontologyId, audit_log: auditLog });
  } catch (error) {
    console.error('Error getting audit log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
