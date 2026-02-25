/**
 * Folder Management Routes
 * Handles folder creation, organization, and ontology linking
 * Updated for multi-tenant model with workspace context
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const folderService = require('../services/folderService');
const { requireTenantContext, optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager } = require('../middleware/auth');

const router = express.Router();

// Require tenant context on all folder routes — folders must be workspace-scoped
router.use(requireTenantContext);

/**
 * GET /api/folders
 * Get all folders filtered by tenant/workspace (required)
 */
router.get('/', async (req, res) => {
  try {
    const filters = {
      tenant_id: req.tenantContext.tenant_id,
      workspace_id: req.tenantContext.workspace_id
    };
    
    const folders = await folderService.getAllFolders(filters);
    res.json({ success: true, folders });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/folders/tree
 * Get folder tree structure (workspace-scoped)
 */
router.get('/tree', async (req, res) => {
  try {
    const filters = {
      tenant_id: req.tenantContext.tenant_id,
      workspace_id: req.tenantContext.workspace_id
    };
    
    const folders = await folderService.getFolderTree(filters);
    res.json({ success: true, folders });
  } catch (error) {
    console.error('Error fetching folder tree:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/folders/:id
 * Get a specific folder with its documents and subfolders
 * Validates folder belongs to the requesting workspace
 */
router.get('/:id', async (req, res) => {
  try {
    const folder = await folderService.getFolder(req.params.id);
    
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    // Verify folder belongs to this workspace
    if (folder.workspace_id && folder.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Error fetching folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/folders
 * Create a new folder (workspace-scoped)
 */
router.post('/', requireManager, async (req, res) => {
  try {
    const { name, description, parent_folder_id, folder_type } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    
    const folder = await folderService.createFolder({
      name,
      description,
      parent_folder_id,
      tenant_id: req.tenantContext.tenant_id,
      workspace_id: req.tenantContext.workspace_id,
      folder_type
    });
    
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/folders/:id
 * Update a folder (validates workspace ownership)
 */
router.put('/:id', requireManager, async (req, res) => {
  try {
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { name, description } = req.body;
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    
    const folder = await folderService.updateFolder(req.params.id, updates);
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Error updating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/folders/:id
 * Delete a folder (validates workspace ownership)
 */
router.delete('/:id', requireManager, async (req, res) => {
  try {
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { moveToParent } = req.query;
    
    await folderService.deleteFolder(req.params.id, {
      moveToParent: moveToParent === 'true'
    });
    
    res.json({ success: true, message: 'Folder deleted' });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/folders/:id/documents
 * Add a document to a folder (validates workspace ownership)
 */
router.post('/:id/documents', async (req, res) => {
  try {
    const { document_uri } = req.body;
    
    if (!document_uri) {
      return res.status(400).json({ error: 'document_uri is required' });
    }
    
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    const result = await folderService.addDocumentToFolder(document_uri, req.params.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error adding document to folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/folders/:id/documents/:documentUri
 * Remove a document from a folder (validates workspace ownership)
 */
router.delete('/:id/documents/:documentUri', requireManager, async (req, res) => {
  try {
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const documentUri = decodeURIComponent(req.params.documentUri);
    await folderService.removeDocumentFromFolder(documentUri, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing document from folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/folders/:id/ontology
 * Link an ontology to a folder (validates workspace ownership)
 */
router.post('/:id/ontology', async (req, res) => {
  try {
    const { ontology_id } = req.body;
    
    if (!ontology_id) {
      return res.status(400).json({ error: 'ontology_id is required' });
    }
    
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    const folder = await folderService.linkOntologyToFolder(req.params.id, ontology_id);
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Error linking ontology to folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/folders/:id/ontology
 * Get the ontology for a folder (inherits from parent if not set)
 */
router.get('/:id/ontology', async (req, res) => {
  try {
    // Verify folder belongs to this workspace
    const existing = await folderService.getFolder(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (existing.workspace_id && existing.workspace_id !== req.tenantContext.workspace_id) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const ontologyId = await folderService.getFolderOntology(req.params.id);
    res.json({ success: true, ontology_id: ontologyId });
  } catch (error) {
    console.error('Error getting folder ontology:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

