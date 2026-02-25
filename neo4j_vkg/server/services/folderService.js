/**
 * Folder Service
 * Manages folder structure and organization of documents
 * Updated for multi-tenant model with relationship-based workspace linking
 */

const { v4: uuidv4 } = require('uuid');
const neo4j = require('neo4j-driver');
const neo4jService = require('./neo4jService');

class FolderService {
  /**
   * Create a new folder
   * Now links to workspace via CONTAINS_FOLDER relationship
   * @param {Object} folderData - Folder properties
   * @param {string} folderData.name - Folder name (required)
   * @param {string} folderData.workspace_id - Workspace ID (required for new model)
   * @param {string} folderData.folder_type - Type of folder (e.g., 'contracts', 'policies')
   * @param {string} folderData.parent_folder_id - Parent folder ID for nested folders
   */
  async createFolder(folderData) {
    const session = neo4jService.getSession();
    
    try {
      const folderId = folderData.folder_id || uuidv4();
      const folderUri = folderData.uri || `folder://${folderId}`;
      
      // Build query based on whether this is a root folder or nested folder
      let query;
      let params = {
        uri: folderUri,
        folder_id: folderId,
        name: folderData.name,
        description: folderData.description || null,
        folder_type: folderData.folder_type || null,
        tenant_id: folderData.tenant_id || null,
        workspace_id: folderData.workspace_id || null,
        parent_folder_id: folderData.parent_folder_id || null,
        created_at: folderData.created_at || new Date().toISOString()
      };
      
      if (folderData.parent_folder_id) {
        // Nested folder - link to parent folder
        query = `
          MATCH (parent:Folder {folder_id: $parent_folder_id})
          MERGE (f:Folder {uri: $uri})
          ON CREATE SET
            f.folder_id = $folder_id,
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.tenant_id = $tenant_id,
            f.workspace_id = $workspace_id,
            f.created_at = datetime($created_at),
            f.updated_at = datetime()
          ON MATCH SET
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.updated_at = datetime()
          MERGE (parent)-[:CONTAINS]->(f)
          RETURN f
        `;
      } else if (folderData.workspace_id) {
        // Root folder - link to workspace via CONTAINS_FOLDER
        query = `
          MATCH (w:Workspace {workspace_id: $workspace_id})
          MERGE (f:Folder {uri: $uri})
          ON CREATE SET
            f.folder_id = $folder_id,
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.tenant_id = $tenant_id,
            f.workspace_id = $workspace_id,
            f.created_at = datetime($created_at),
            f.updated_at = datetime()
          ON MATCH SET
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.updated_at = datetime()
          MERGE (w)-[:CONTAINS_FOLDER]->(f)
          RETURN f
        `;
      } else {
        // Legacy mode - create folder without workspace relationship
        query = `
          MERGE (f:Folder {uri: $uri})
          ON CREATE SET
            f.folder_id = $folder_id,
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.tenant_id = $tenant_id,
            f.workspace_id = $workspace_id,
            f.created_at = datetime($created_at),
            f.updated_at = datetime()
          ON MATCH SET
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.updated_at = datetime()
          RETURN f
        `;
      }
      
      const result = await session.run(query, params);
      
      const folder = result.records[0]?.get('f');
      if (!folder) {
        throw new Error('Failed to create folder - workspace or parent folder not found');
      }
      
      return {
        folder_id: folderId,
        uri: folderUri,
        ...folder.properties
      };
    } finally {
      await session.close();
    }
  }
  
  /**
   * Get folder by ID
   */
  async getFolder(folderId) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (f:Folder {folder_id: $folder_id})
        OPTIONAL MATCH (f)-[:CONTAINS]->(doc:Document)
        OPTIONAL MATCH (f)-[:CONTAINS]->(subfolder:Folder)
        OPTIONAL MATCH (f)-[:USES_ONTOLOGY]->(ont:Ontology)
        RETURN f,
               collect(DISTINCT doc) as documents,
               collect(DISTINCT subfolder) as subfolders,
               collect(DISTINCT ont) as ontologies
      `;
      
      const result = await session.run(query, { folder_id: folderId });
      
      if (result.records.length === 0) {
        return null;
      }
      
      const record = result.records[0];
      const folder = record.get('f');
      const documents = record.get('documents').filter(d => d !== null);
      const subfolders = record.get('subfolders').filter(s => s !== null);
      const ontologies = record.get('ontologies').filter(o => o !== null);
      
      return {
        ...folder.properties,
        documents: documents.map(d => d.properties),
        subfolders: subfolders.map(s => s.properties),
        ontologies: ontologies.map(o => o.properties)
      };
    } finally {
      await session.close();
    }
  }
  
  /**
   * Get all folders (optionally filtered by tenant/workspace)
   * Updated to use relationship-based filtering when workspace_id is provided
   */
  async getAllFolders(filters = {}) {
    const session = neo4jService.getSession();
    
    try {
      let query;
      const params = {};
      
      if (filters.workspace_id) {
        // Use relationship-based filtering (preferred)
        params.workspace_id = filters.workspace_id;
        query = `
          MATCH (w:Workspace {workspace_id: $workspace_id})-[:CONTAINS_FOLDER]->(f:Folder)
          OPTIONAL MATCH (f)-[:CONTAINS]->(doc:Document)
          OPTIONAL MATCH (f)-[:CONTAINS]->(subfolder:Folder)
          OPTIONAL MATCH (f)-[:USES_ONTOLOGY]->(ov:OntologyVersion)<-[:HAS_VERSION]-(ont:Ontology)
          RETURN f,
                 count(DISTINCT doc) as docCount,
                 count(DISTINCT subfolder) as subfolderCount,
                 collect(DISTINCT ont)[0..1] as ontologies
          ORDER BY f.name
        `;
      } else {
        // Fallback to property-based filtering
        let whereClause = '';
        
        if (filters.tenant_id) {
          whereClause += ' WHERE f.tenant_id = $tenant_id';
          params.tenant_id = filters.tenant_id;
        }
        
        query = `
          MATCH (f:Folder)${whereClause}
          OPTIONAL MATCH (f)-[:CONTAINS]->(doc:Document)
          OPTIONAL MATCH (f)-[:CONTAINS]->(subfolder:Folder)
          OPTIONAL MATCH (f)-[:USES_ONTOLOGY]->(ov:OntologyVersion)<-[:HAS_VERSION]-(ont:Ontology)
          RETURN f,
                 count(DISTINCT doc) as docCount,
                 count(DISTINCT subfolder) as subfolderCount,
                 collect(DISTINCT ont)[0..1] as ontologies
          ORDER BY f.name
        `;
      }
      
      const result = await session.run(query, params);
      
      return result.records.map(record => {
        const folder = record.get('f');
        const ontologies = record.get('ontologies').filter(o => o !== null);
        
        return {
          ...folder.properties,
          docCount: record.get('docCount').toNumber(),
          subfolderCount: record.get('subfolderCount').toNumber(),
          ontologies: ontologies.map(o => o.properties)
        };
      });
    } finally {
      await session.close();
    }
  }
  
  /**
   * Get folder tree structure
   */
  async getFolderTree(filters = {}) {
    const session = neo4jService.getSession();
    
    try {
      let whereClause = '';
      const params = {};
      
      if (filters.tenant_id) {
        whereClause += ' WHERE f.tenant_id = $tenant_id';
        params.tenant_id = filters.tenant_id;
      }
      
      if (filters.workspace_id) {
        whereClause += whereClause ? ' AND f.workspace_id = $workspace_id' : ' WHERE f.workspace_id = $workspace_id';
        params.workspace_id = filters.workspace_id;
      }
      
      // Get root folders (no parent)
      const query = `
        MATCH (f:Folder)${whereClause}
        WHERE NOT (f)<-[:CONTAINS]-(:Folder)
        OPTIONAL MATCH path = (f)-[:CONTAINS*]->(child:Folder)
        OPTIONAL MATCH (f)-[:CONTAINS]->(doc:Document)
        OPTIONAL MATCH (f)-[:USES_ONTOLOGY]->(ont:Ontology)
        RETURN f,
               collect(DISTINCT doc) as documents,
               collect(DISTINCT ont) as ontologies
        ORDER BY f.name
      `;
      
      const result = await session.run(query, params);
      
      return result.records.map(record => {
        const folder = record.get('f');
        const documents = record.get('documents').filter(d => d !== null);
        const ontologies = record.get('ontologies').filter(o => o !== null);
        
        return {
          ...folder.properties,
          documents: documents.map(d => d.properties),
          ontologies: ontologies.map(o => o.properties)
        };
      });
    } finally {
      await session.close();
    }
  }
  
  /**
   * Update folder
   */
  async updateFolder(folderId, updates) {
    const session = neo4jService.getSession();
    
    try {
      const setClauses = [];
      const params = { folder_id: folderId };
      
      if (updates.name !== undefined) {
        setClauses.push('f.name = $name');
        params.name = updates.name;
      }
      
      if (updates.description !== undefined) {
        setClauses.push('f.description = $description');
        params.description = updates.description;
      }
      
      if (setClauses.length === 0) {
        return await this.getFolder(folderId);
      }
      
      setClauses.push('f.updated_at = datetime()');
      
      const query = `
        MATCH (f:Folder {folder_id: $folder_id})
        SET ${setClauses.join(', ')}
        RETURN f
      `;
      
      const result = await session.run(query, params);
      
      if (result.records.length === 0) {
        throw new Error(`Folder ${folderId} not found`);
      }
      
      const folder = result.records[0].get('f');
      return folder.properties;
    } finally {
      await session.close();
    }
  }
  
  /**
   * Delete folder (and optionally move documents to parent or root)
   */
  async deleteFolder(folderId, options = {}) {
    const session = neo4jService.getSession();
    
    try {
      // If moveToParent is true, move documents to parent folder
      if (options.moveToParent) {
        const moveQuery = `
          MATCH (f:Folder {folder_id: $folder_id})-[:CONTAINS]->(doc:Document)
          OPTIONAL MATCH (f)<-[:CONTAINS]-(parent:Folder)
          WITH f, doc, parent
          WHERE parent IS NOT NULL
          MERGE (parent)-[:CONTAINS]->(doc)
          DELETE (f)-[:CONTAINS]->(doc)
        `;
        await session.run(moveQuery, { folder_id: folderId });
      }
      
      // Delete folder and all relationships
      const deleteQuery = `
        MATCH (f:Folder {folder_id: $folder_id})
        DETACH DELETE f
      `;
      
      await session.run(deleteQuery, { folder_id: folderId });
      
      return { success: true };
    } finally {
      await session.close();
    }
  }
  
  /**
   * Add document to folder
   */
  async addDocumentToFolder(documentUri, folderId) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (d:Document {uri: $document_uri})
        MATCH (f:Folder {folder_id: $folder_id})
        MERGE (f)-[:CONTAINS]->(d)
        RETURN d, f
      `;
      
      const result = await session.run(query, {
        document_uri: documentUri,
        folder_id: folderId
      });
      
      if (result.records.length === 0) {
        throw new Error('Document or folder not found');
      }
      
      return {
        document: result.records[0].get('d').properties,
        folder: result.records[0].get('f').properties
      };
    } finally {
      await session.close();
    }
  }
  
  /**
   * Remove document from folder
   */
  async removeDocumentFromFolder(documentUri, folderId) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (f:Folder {folder_id: $folder_id})-[r:CONTAINS]->(d:Document {uri: $document_uri})
        DELETE r
        RETURN d, f
      `;
      
      const result = await session.run(query, {
        document_uri: documentUri,
        folder_id: folderId
      });
      
      return { success: true };
    } finally {
      await session.close();
    }
  }
  
  /**
   * Link ontology to folder
   */
  async linkOntologyToFolder(folderId, ontologyId) {
    const session = neo4jService.getSession();
    
    try {
      // First, check if ontology exists (could be in Redis or Neo4j)
      // For now, we'll store the ontology ID as a property
      const query = `
        MATCH (f:Folder {folder_id: $folder_id})
        SET f.ontology_id = $ontology_id,
            f.updated_at = datetime()
        RETURN f
      `;
      
      const result = await session.run(query, {
        folder_id: folderId,
        ontology_id: ontologyId
      });
      
      if (result.records.length === 0) {
        throw new Error(`Folder ${folderId} not found`);
      }
      
      return result.records[0].get('f').properties;
    } finally {
      await session.close();
    }
  }
  
  /**
   * Get ontology for folder (inherits from parent if not set)
   */
  async getFolderOntology(folderId) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (f:Folder {folder_id: $folder_id})
        OPTIONAL MATCH path = (f)<-[:CONTAINS*]-(parent:Folder)
        WITH f, parent
        ORDER BY length(path) DESC
        LIMIT 1
        WITH coalesce(parent, f) as folder
        RETURN folder.ontology_id as ontology_id
      `;
      
      const result = await session.run(query, { folder_id: folderId });
      
      if (result.records.length === 0) {
        return null;
      }
      
      return result.records[0].get('ontology_id');
    } finally {
      await session.close();
    }
  }
}

module.exports = new FolderService();

