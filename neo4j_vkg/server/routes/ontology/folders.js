/**
 * Folder Management Routes
 * CRUD operations for folders in the knowledge graph
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const neo4jService = require('../../services/neo4jService');
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { requireManager } = require('../../middleware/auth');

/**
 * GET /api/ontology/folders
 * Get all folders
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    
    const session = neo4jService.getSession();
    try {
      // Build query with optional workspace filter
      // Note: Folder relationship is (f)-[:CONTAINS]->(d)
      let query = `
        MATCH (f:Folder)
        ${workspaceId ? 'WHERE f.workspace_id = $workspaceId OR f.workspace_id IS NULL' : ''}
        OPTIONAL MATCH (f)-[:CONTAINS]->(d:Document)
        WITH f, count(d) as docCount
        RETURN f, docCount ORDER BY f.name
      `;
      
      const result = await session.run(query, { workspaceId: workspaceId || null });
      
      const folders = result.records.map(r => ({
        ...r.get('f').properties,
        docCount: neo4jService.toNumber(r.get('docCount'))
      }));
      
      res.json({ success: true, folders });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/folders
 * Create a new folder
 */
router.post('/', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const { name, parentId, ontologyId, workspace_id } = req.body;
    const effectiveWorkspaceId = workspace_id || req.tenantContext?.workspace_id;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Folder name is required' });
    }
    
    const session = neo4jService.getSession();
    try {
      const folderId = uuidv4();
      let query;
      let params = { 
        folderId, name, 
        ontologyId: ontologyId || null,
        workspaceId: effectiveWorkspaceId || null,
        createdAt: new Date().toISOString() 
      };
      
      if (parentId) {
        // Nested folder - link to parent
        query = `
          MATCH (parent:Folder {folder_id: $parentId})
          CREATE (f:Folder {
            folder_id: $folderId, name: $name, ontology_id: $ontologyId,
            workspace_id: COALESCE($workspaceId, parent.workspace_id),
            created_at: $createdAt
          })
          CREATE (f)-[:CHILD_OF]->(parent)
          RETURN f
        `;
        params.parentId = parentId;
      } else if (effectiveWorkspaceId) {
        // Root folder with workspace
        const wsCheck = await session.run(
          'MATCH (w:Workspace {workspace_id: $workspaceId}) RETURN w',
          { workspaceId: effectiveWorkspaceId }
        );
        
        if (wsCheck.records.length === 0) {
          // Create without workspace relationship
          query = `
            CREATE (f:Folder {
              folder_id: $folderId, name: $name, ontology_id: $ontologyId,
              workspace_id: $workspaceId, created_at: $createdAt
            })
            RETURN f
          `;
        } else {
          query = `
            MATCH (w:Workspace {workspace_id: $workspaceId})
            CREATE (f:Folder {
              folder_id: $folderId, name: $name, ontology_id: $ontologyId,
              workspace_id: $workspaceId, created_at: $createdAt
            })
            CREATE (w)-[:CONTAINS_FOLDER]->(f)
            RETURN f
          `;
        }
      } else {
        // Legacy mode - no workspace
        query = `
          CREATE (f:Folder {
            folder_id: $folderId, name: $name, ontology_id: $ontologyId,
            created_at: $createdAt
          })
          RETURN f
        `;
      }
      
      const result = await session.run(query, params);
      
      if (result.records.length === 0) {
        return res.status(400).json({ success: false, error: 'Failed to create folder' });
      }
      
      res.json({ success: true, folder: result.records[0].get('f').properties });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/folders/:id
 * Update folder properties
 */
router.put('/:id', requireManager, async (req, res) => {
  try {
    const folderId = req.params.id;
    const { name, ontologyId } = req.body;
    
    const session = neo4jService.getSession();
    try {
      const updates = [];
      const params = { folderId };
      
      if (name !== undefined) {
        updates.push('f.name = $name');
        params.name = name;
      }
      if (ontologyId !== undefined) {
        updates.push('f.ontology_id = $ontologyId');
        params.ontologyId = ontologyId || null;
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'No updates provided' });
      }
      
      const result = await session.run(`
        MATCH (f:Folder {folder_id: $folderId})
        SET ${updates.join(', ')}
        RETURN f
      `, params);
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
      
      res.json({ success: true, folder: result.records[0].get('f').properties });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error updating folder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/folders/:id
 * Delete a folder
 */
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const folderId = req.params.id;
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (f:Folder {folder_id: $folderId})
        DETACH DELETE f RETURN count(f) as deleted
      `, { folderId });
      
      res.json({ success: true, deleted: neo4jService.toNumber(result.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
