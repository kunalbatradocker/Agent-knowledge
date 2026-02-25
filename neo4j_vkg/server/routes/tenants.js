/**
 * Tenant Management Routes
 * API endpoints for managing tenants, workspaces, and ontology bindings
 */

const express = require('express');
const tenantService = require('../services/tenantService');
const { requireAdmin, requireManager, requireAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// TENANT ENDPOINTS
// ============================================================

/**
 * GET /api/tenants
 * Get all tenants
 */
router.get('/', async (req, res) => {
  try {
    const tenants = await tenantService.getAllTenants();
    res.json({ success: true, tenants });
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tenants/:id
 * Get a specific tenant with its workspaces
 */
router.get('/:id', async (req, res) => {
  try {
    const tenant = await tenantService.getTenant(req.params.id);
    
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    
    res.json({ success: true, tenant });
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tenants
 * Create a new tenant
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, tenant_id, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Tenant name is required' });
    }
    
    const tenant = await tenantService.createTenant({
      name,
      tenant_id,
      status
    });
    
    res.json({ success: true, tenant });
  } catch (error) {
    console.error('Error creating tenant:', error);
    // Check for Neo4j connection errors
    if (error.code === 'ServiceUnavailable' || error.message?.includes('connect')) {
      return res.status(503).json({ 
        success: false, 
        error: 'Database unavailable. Please ensure Neo4j is running.' 
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/tenants/:id
 * Update a tenant
 */
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, status } = req.body;
    
    const tenant = await tenantService.updateTenant(req.params.id, {
      name,
      status
    });
    
    res.json({ success: true, tenant });
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/tenants/:id
 * Delete a tenant
 * Returns error if tenant has workspaces/folders/documents (unless cascade=true)
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { cascade } = req.query;
    
    const result = await tenantService.deleteTenant(req.params.id, {
      cascade: cascade === 'true'
    });
    
    if (!result.success) {
      return res.status(400).json({ 
        success: false, 
        error: result.error,
        workspaceCount: result.workspaceCount,
        folderCount: result.folderCount,
        documentCount: result.documentCount
      });
    }
    
    res.json({ success: true, message: 'Tenant deleted' });
  } catch (error) {
    console.error('Error deleting tenant:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// WORKSPACE ENDPOINTS
// ============================================================

/**
 * GET /api/tenants/:tenantId/workspaces
 * Get all workspaces for a tenant (filtered by user's workspace access)
 */
router.get('/:tenantId/workspaces', requireAuth, async (req, res) => {
  try {
    let workspaces = await tenantService.getWorkspacesForTenant(req.params.tenantId);

    // Filter by user's allowed workspaces (unless admin or empty = all access)
    if (req.user.role !== 'admin') {
      const userWorkspaces = req.user.workspaces || [];
      if (userWorkspaces.length > 0) {
        workspaces = workspaces.filter(w => userWorkspaces.includes(w.workspace_id));
      }
    }

    res.json({ success: true, workspaces });
  } catch (error) {
    console.error('Error fetching workspaces:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tenants/:tenantId/workspaces/:workspaceId
 * Get a specific workspace
 */
router.get('/:tenantId/workspaces/:workspaceId', async (req, res) => {
  try {
    // Validate workspace belongs to tenant
    const isValid = await tenantService.validateWorkspaceAccess(
      req.params.tenantId,
      req.params.workspaceId
    );
    
    if (!isValid) {
      return res.status(404).json({ error: 'Workspace not found in this tenant' });
    }
    
    const workspace = await tenantService.getWorkspace(req.params.workspaceId);
    
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    
    res.json({ success: true, workspace });
  } catch (error) {
    console.error('Error fetching workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tenants/:tenantId/workspaces
 * Create a new workspace under a tenant
 */
router.post('/:tenantId/workspaces', requireAdmin, async (req, res) => {
  try {
    const { name, description, default_industry, workspace_id, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }
    
    const workspace = await tenantService.createWorkspace(req.params.tenantId, {
      name,
      description,
      default_industry,
      workspace_id,
      status
    });
    
    res.json({ success: true, workspace });
  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/tenants/:tenantId/workspaces/:workspaceId
 * Update a workspace
 */
router.put('/:tenantId/workspaces/:workspaceId', requireAdmin, async (req, res) => {
  try {
    // Validate workspace belongs to tenant
    const isValid = await tenantService.validateWorkspaceAccess(
      req.params.tenantId,
      req.params.workspaceId
    );
    
    if (!isValid) {
      return res.status(404).json({ error: 'Workspace not found in this tenant' });
    }
    
    const { name, description, default_industry, status } = req.body;
    
    const workspace = await tenantService.updateWorkspace(req.params.workspaceId, {
      name,
      description,
      default_industry,
      status
    });
    
    res.json({ success: true, workspace });
  } catch (error) {
    console.error('Error updating workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/tenants/:tenantId/workspaces/:workspaceId
 * Delete a workspace
 * Returns error if workspace has folders/documents (unless cascade=true)
 */
router.delete('/:tenantId/workspaces/:workspaceId', requireAdmin, async (req, res) => {
  try {
    // Validate workspace belongs to tenant
    const isValid = await tenantService.validateWorkspaceAccess(
      req.params.tenantId,
      req.params.workspaceId
    );
    
    if (!isValid) {
      return res.status(404).json({ error: 'Workspace not found in this tenant' });
    }
    
    const { cascade } = req.query;
    
    const result = await tenantService.deleteWorkspace(req.params.workspaceId, {
      cascade: cascade === 'true'
    });
    
    if (!result.success) {
      return res.status(400).json({ 
        success: false, 
        error: result.error,
        folderCount: result.folderCount,
        documentCount: result.documentCount
      });
    }
    
    res.json({ success: true, message: 'Workspace deleted' });
  } catch (error) {
    console.error('Error deleting workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ONTOLOGY BINDING ENDPOINTS (Folder-level - preferred)
// ============================================================

/**
 * POST /api/tenants/:tenantId/folders/:folderId/ontology
 * Link an ontology version to a folder (folder-level binding - preferred)
 */
router.post('/:tenantId/folders/:folderId/ontology', requireManager, async (req, res) => {
  try {
    const { version_id } = req.body;
    
    if (!version_id) {
      return res.status(400).json({ error: 'version_id is required' });
    }
    
    const result = await tenantService.linkOntologyToFolder(
      req.params.folderId,
      version_id
    );
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error linking ontology to folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tenants/:tenantId/folders/:folderId/ontology
 * Get effective ontology for a folder (inherits from parent folders)
 */
router.get('/:tenantId/folders/:folderId/ontology', async (req, res) => {
  try {
    const result = await tenantService.getEffectiveOntologyForFolder(req.params.folderId);
    
    if (!result) {
      return res.json({ success: true, ontology: null, message: 'No ontology assigned to this folder or its parents' });
    }
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error getting folder ontology:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// WORKSPACE ONTOLOGY ENDPOINTS (Deprecated - use folder-level)
// ============================================================

/**
 * @deprecated Use folder-level ontology binding instead
 * POST /api/tenants/:tenantId/workspaces/:workspaceId/ontology
 * Link an ontology version to a workspace (workspace-wide default)
 */
router.post('/:tenantId/workspaces/:workspaceId/ontology', requireManager, async (req, res) => {
  try {
    const { version_id } = req.body;
    
    if (!version_id) {
      return res.status(400).json({ error: 'version_id is required' });
    }
    
    // Validate workspace belongs to tenant
    const isValid = await tenantService.validateWorkspaceAccess(
      req.params.tenantId,
      req.params.workspaceId
    );
    
    if (!isValid) {
      return res.status(404).json({ error: 'Workspace not found in this tenant' });
    }
    
    console.warn('⚠️ Workspace-level ontology binding is deprecated. Use folder-level binding instead.');
    
    const result = await tenantService.linkOntologyToWorkspace(
      req.params.workspaceId,
      version_id
    );
    
    res.json({ success: true, ...result, warning: 'Workspace-level ontology binding is deprecated. Use folder-level binding instead.' });
  } catch (error) {
    console.error('Error linking ontology to workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tenants/:tenantId/workspaces/:workspaceId/ontology-versions
 * Create a new ontology version and optionally link to workspace
 */
router.post('/:tenantId/workspaces/:workspaceId/ontology-versions', requireManager, async (req, res) => {
  try {
    const { ontology, version, linkToWorkspace } = req.body;
    
    if (!ontology || !ontology.name) {
      return res.status(400).json({ error: 'ontology.name is required' });
    }
    
    // Validate workspace belongs to tenant
    const isValid = await tenantService.validateWorkspaceAccess(
      req.params.tenantId,
      req.params.workspaceId
    );
    
    if (!isValid) {
      return res.status(404).json({ error: 'Workspace not found in this tenant' });
    }
    
    // Create ontology and version
    const result = await tenantService.createOntologyVersion(ontology, version || {});
    
    // Optionally link to workspace
    if (linkToWorkspace !== false) {
      await tenantService.linkOntologyToWorkspace(
        req.params.workspaceId,
        result.version.version_id
      );
    }
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating ontology version:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// MIGRATION ENDPOINT
// ============================================================

/**
 * POST /api/tenants/migrate/default
 * Get or create default tenant and workspace for migration
 */
router.post('/migrate/default', requireAdmin, async (_req, res) => {
  try {
    const result = await tenantService.getOrCreateDefaultTenantWorkspace();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating default tenant/workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tenants/restore-from-redis
 * Restore tenants and workspaces from Redis backup to Neo4j
 * Use this if Neo4j is cleared and you need to recreate the tenant structure
 */
router.post('/restore-from-redis', requireAdmin, async (_req, res) => {
  try {
    const result = await tenantService.syncAllToNeo4j();
    
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    
    res.json({ 
      success: true, 
      message: `Synced ${result.tenants} tenant(s), ${result.workspaces} workspace(s), ${result.folders} folder(s) to Neo4j`,
      ...result 
    });
  } catch (error) {
    console.error('Error syncing to Neo4j:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tenants/sync-to-neo4j
 * Sync all tenant/workspace/folder data from Redis (primary) to Neo4j (secondary)
 */
router.post('/sync-to-neo4j', requireAdmin, async (_req, res) => {
  try {
    const result = await tenantService.syncAllToNeo4j();
    res.json({ 
      success: true, 
      message: `Synced ${result.tenants} tenant(s), ${result.workspaces} workspace(s), ${result.folders} folder(s) to Neo4j`,
      ...result 
    });
  } catch (error) {
    console.error('Error syncing to Neo4j:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
