/**
 * Tenant Service
 * Manages multi-tenant structure: Tenants → Workspaces → Folders
 * 
 * Storage Architecture:
 * - PRIMARY: Redis (tenant, workspace, folder metadata, ontology assignments)
 * - SECONDARY: Neo4j (graph relationships for querying)
 * 
 * Redis is the source of truth. Neo4j nodes are created for graph traversal.
 */

const { v4: uuidv4 } = require('uuid');
const driver = require('../config/neo4j');
const { client: redisClient } = require('../config/redis');

// Redis key prefixes
const REDIS_KEYS = {
  TENANT: 'tenant:',
  WORKSPACE: 'workspace:',
  FOLDER: 'folder:',
  TENANT_LIST: 'tenants:all',
  WORKSPACE_LIST: 'workspaces:tenant:',
  FOLDER_LIST: 'folders:workspace:',
  FOLDER_CHILDREN: 'folders:parent:',
  ONTOLOGY: 'ontology:',
  ONTOLOGY_VERSION: 'ontology_version:',
  FOLDER_ONTOLOGY: 'folder:ontology:'
};

class TenantService {
  /**
   * Get a Neo4j session
   */
  getSession() {
    const database = driver.getDatabase();
    return driver.session({ database });
  }

  /**
   * Helper to convert Neo4j integer to JavaScript number
   */
  toNumber(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low !== 'undefined') return value.low;
    return parseInt(value, 10) || 0;
  }


  // ============================================================
  // TENANT OPERATIONS (Redis Primary)
  // ============================================================

  /**
   * Create a new tenant
   * Stores in Redis (primary), syncs to Neo4j (secondary)
   */
  async createTenant(tenantData) {
    const tenantId = tenantData.tenant_id || uuidv4();
    const now = new Date().toISOString();
    
    const tenant = {
      tenant_id: tenantId,
      uri: `tenant://${tenantId}`,
      name: tenantData.name,
      status: tenantData.status || 'active',
      created_at: tenantData.created_at || now,
      updated_at: now
    };

    // PRIMARY: Save to Redis
    await redisClient.hSet(`${REDIS_KEYS.TENANT}${tenantId}`, tenant);
    await redisClient.sAdd(REDIS_KEYS.TENANT_LIST, tenantId);

    // SECONDARY: Sync to Neo4j for graph queries
    await this.syncTenantToNeo4j(tenant);

    console.log(`✅ Tenant created: ${tenant.name} (${tenantId})`);
    return tenant;
  }

  /**
   * Get tenant by ID (from Redis)
   */
  async getTenant(tenantId) {
    const data = await redisClient.hGetAll(`${REDIS_KEYS.TENANT}${tenantId}`);
    if (!data || !data.tenant_id) return null;
    
    // Get workspace count
    const workspaceIds = await redisClient.sMembers(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`);
    data.workspaceCount = workspaceIds.length;
    
    return data;
  }

  /**
   * Get all tenants (from Redis)
   */
  async getAllTenants() {
    const tenantIds = await redisClient.sMembers(REDIS_KEYS.TENANT_LIST);
    const tenants = [];
    
    for (const tenantId of tenantIds) {
      const tenant = await this.getTenant(tenantId);
      if (tenant) tenants.push(tenant);
    }
    
    return tenants.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  /**
   * Update tenant
   */
  async updateTenant(tenantId, updates) {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
    
    const updated = {
      ...tenant,
      ...updates,
      updated_at: new Date().toISOString()
    };
    delete updated.workspaceCount; // Don't store computed field
    
    await redisClient.hSet(`${REDIS_KEYS.TENANT}${tenantId}`, updated);
    await this.syncTenantToNeo4j(updated);
    
    return updated;
  }


  /**
   * Delete tenant
   * Checks for content, removes from Redis and Neo4j
   */
  async deleteTenant(tenantId, options = {}) {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) return { success: false, error: 'Tenant not found' };
    
    // Get workspaces
    const workspaceIds = await redisClient.sMembers(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`);
    
    // Check for content
    let folderCount = 0;
    let documentCount = 0;
    for (const wsId of workspaceIds) {
      const ws = await this.getWorkspace(wsId);
      if (ws) {
        folderCount += ws.folderCount || 0;
        documentCount += ws.documentCount || 0;
      }
    }
    
    if ((workspaceIds.length > 0 || folderCount > 0 || documentCount > 0) && !options.cascade) {
      return {
        success: false,
        error: `Cannot delete tenant: contains ${workspaceIds.length} workspace(s), ${folderCount} folder(s), ${documentCount} document(s). Use cascade=true.`,
        workspaceCount: workspaceIds.length,
        folderCount,
        documentCount
      };
    }
    
    // Cascade delete workspaces
    if (options.cascade) {
      for (const wsId of workspaceIds) {
        await this.deleteWorkspace(wsId, { cascade: true, tenantId });
      }
    }
    
    // Remove from Redis
    await redisClient.del(`${REDIS_KEYS.TENANT}${tenantId}`);
    await redisClient.sRem(REDIS_KEYS.TENANT_LIST, tenantId);
    await redisClient.del(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`);
    
    // Remove from Neo4j
    const session = this.getSession();
    try {
      await session.run('MATCH (t:Tenant {tenant_id: $id}) DETACH DELETE t', { id: tenantId });
    } finally {
      await session.close();
    }
    
    return { success: true, deleted: 1 };
  }


  // ============================================================
  // WORKSPACE OPERATIONS (Redis Primary)
  // ============================================================

  /**
   * Create a workspace under a tenant
   */
  async createWorkspace(tenantId, workspaceData) {
    // Verify tenant exists
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
    
    const workspaceId = workspaceData.workspace_id || uuidv4();
    const now = new Date().toISOString();
    
    const workspace = {
      workspace_id: workspaceId,
      tenant_id: tenantId,
      uri: `workspace://${workspaceId}`,
      name: workspaceData.name,
      description: workspaceData.description || '',
      status: workspaceData.status || 'active',
      created_at: workspaceData.created_at || now,
      updated_at: now
    };

    // PRIMARY: Save to Redis
    await redisClient.hSet(`${REDIS_KEYS.WORKSPACE}${workspaceId}`, workspace);
    await redisClient.sAdd(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`, workspaceId);

    // SECONDARY: Sync to Neo4j
    await this.syncWorkspaceToNeo4j(workspace, tenantId);

    console.log(`✅ Workspace created: ${workspace.name} (${workspaceId}) in tenant ${tenantId}`);
    return workspace;
  }

  /**
   * Get workspace by ID (from Redis)
   */
  async getWorkspace(workspaceId) {
    const data = await redisClient.hGetAll(`${REDIS_KEYS.WORKSPACE}${workspaceId}`);
    if (!data || !data.workspace_id) return null;
    
    // Get folder count
    const folderIds = await redisClient.sMembers(`${REDIS_KEYS.FOLDER_LIST}${workspaceId}`);
    data.folderCount = folderIds.length;
    
    // Get document count from Neo4j (documents are graph-only)
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (w:Workspace {workspace_id: $id})-[:CONTAINS_DOCUMENT]->(d:Document)
        RETURN count(d) as count
      `, { id: workspaceId });
      data.documentCount = this.toNumber(result.records[0]?.get('count')) || 0;
    } catch (e) {
      data.documentCount = 0;
    } finally {
      await session.close();
    }
    
    return data;
  }


  /**
   * Get all workspaces for a tenant (from Redis)
   */
  async getWorkspacesForTenant(tenantId) {
    const workspaceIds = await redisClient.sMembers(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`);
    const workspaces = [];
    
    for (const wsId of workspaceIds) {
      const ws = await this.getWorkspace(wsId);
      if (ws) workspaces.push(ws);
    }
    
    return workspaces.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  /**
   * Update workspace
   */
  async updateWorkspace(workspaceId, updates) {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    
    const updated = {
      ...workspace,
      ...updates,
      updated_at: new Date().toISOString()
    };
    delete updated.folderCount;
    delete updated.documentCount;
    
    await redisClient.hSet(`${REDIS_KEYS.WORKSPACE}${workspaceId}`, updated);
    await this.syncWorkspaceToNeo4j(updated, workspace.tenant_id);
    
    return updated;
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(workspaceId, options = {}) {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) return { success: false, error: 'Workspace not found' };
    
    const folderCount = workspace.folderCount || 0;
    const documentCount = workspace.documentCount || 0;
    
    if ((folderCount > 0 || documentCount > 0) && !options.cascade) {
      return {
        success: false,
        error: `Cannot delete workspace: contains ${folderCount} folder(s) and ${documentCount} document(s). Use cascade=true.`,
        folderCount,
        documentCount
      };
    }
    
    // Cascade delete folders
    if (options.cascade) {
      const folderIds = await redisClient.sMembers(`${REDIS_KEYS.FOLDER_LIST}${workspaceId}`);
      for (const folderId of folderIds) {
        await this.deleteFolder(folderId, { cascade: true });
      }
    }
    
    // Remove from Redis
    const tenantId = options.tenantId || workspace.tenant_id;
    await redisClient.del(`${REDIS_KEYS.WORKSPACE}${workspaceId}`);
    await redisClient.del(`${REDIS_KEYS.FOLDER_LIST}${workspaceId}`);
    if (tenantId) {
      await redisClient.sRem(`${REDIS_KEYS.WORKSPACE_LIST}${tenantId}`, workspaceId);
    }
    
    // Remove from Neo4j (including documents if cascade)
    const session = this.getSession();
    try {
      if (options.cascade) {
        await session.run(`
          MATCH (w:Workspace {workspace_id: $id})-[:CONTAINS_DOCUMENT]->(d:Document)
          OPTIONAL MATCH (d)<-[:PART_OF]-(ch:Chunk)
          DETACH DELETE ch, d
        `, { id: workspaceId });
        await session.run(`
          MATCH (w:Workspace {workspace_id: $id})-[:CONTAINS_FOLDER]->(f:Folder)
          DETACH DELETE f
        `, { id: workspaceId });
      }
      await session.run('MATCH (w:Workspace {workspace_id: $id}) DETACH DELETE w', { id: workspaceId });
    } finally {
      await session.close();
    }
    
    return { success: true, deleted: 1 };
  }


  // ============================================================
  // FOLDER OPERATIONS (Redis Primary)
  // ============================================================

  /**
   * Create a folder
   */
  async createFolder(folderData) {
    const folderId = folderData.folder_id || uuidv4();
    const now = new Date().toISOString();
    
    const folder = {
      folder_id: folderId,
      uri: `folder://${folderId}`,
      name: folderData.name,
      description: folderData.description || '',
      folder_type: folderData.folder_type || '',
      workspace_id: folderData.workspace_id || '',
      parent_folder_id: folderData.parent_folder_id || '',
      ontology_id: folderData.ontology_id || '',
      created_at: folderData.created_at || now,
      updated_at: now
    };

    // PRIMARY: Save to Redis
    await redisClient.hSet(`${REDIS_KEYS.FOLDER}${folderId}`, folder);
    
    if (folder.workspace_id) {
      await redisClient.sAdd(`${REDIS_KEYS.FOLDER_LIST}${folder.workspace_id}`, folderId);
    }
    if (folder.parent_folder_id) {
      await redisClient.sAdd(`${REDIS_KEYS.FOLDER_CHILDREN}${folder.parent_folder_id}`, folderId);
    }

    // SECONDARY: Sync to Neo4j
    await this.syncFolderToNeo4j(folder);

    console.log(`✅ Folder created: ${folder.name} (${folderId})`);
    return folder;
  }

  /**
   * Get folder by ID (from Redis)
   */
  async getFolder(folderId) {
    const data = await redisClient.hGetAll(`${REDIS_KEYS.FOLDER}${folderId}`);
    if (!data || !data.folder_id) return null;
    
    // Get child folder count
    const childIds = await redisClient.sMembers(`${REDIS_KEYS.FOLDER_CHILDREN}${folderId}`);
    data.subfolderCount = childIds.length;
    
    return data;
  }

  /**
   * Get all folders for a workspace (from Redis)
   */
  async getFoldersForWorkspace(workspaceId) {
    const folderIds = await redisClient.sMembers(`${REDIS_KEYS.FOLDER_LIST}${workspaceId}`);
    const folders = [];
    
    for (const folderId of folderIds) {
      const folder = await this.getFolder(folderId);
      if (folder) folders.push(folder);
    }
    
    return folders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }


  /**
   * Update folder
   */
  async updateFolder(folderId, updates) {
    const folder = await this.getFolder(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);
    
    const updated = {
      ...folder,
      ...updates,
      updated_at: new Date().toISOString()
    };
    delete updated.subfolderCount;
    
    await redisClient.hSet(`${REDIS_KEYS.FOLDER}${folderId}`, updated);
    await this.syncFolderToNeo4j(updated);
    
    return updated;
  }

  /**
   * Delete folder
   */
  async deleteFolder(folderId, options = {}) {
    const folder = await this.getFolder(folderId);
    if (!folder) return { success: false, error: 'Folder not found' };
    
    // Cascade delete child folders
    if (options.cascade) {
      const childIds = await redisClient.sMembers(`${REDIS_KEYS.FOLDER_CHILDREN}${folderId}`);
      for (const childId of childIds) {
        await this.deleteFolder(childId, { cascade: true });
      }
    }
    
    // Remove from Redis
    await redisClient.del(`${REDIS_KEYS.FOLDER}${folderId}`);
    await redisClient.del(`${REDIS_KEYS.FOLDER_CHILDREN}${folderId}`);
    
    if (folder.workspace_id) {
      await redisClient.sRem(`${REDIS_KEYS.FOLDER_LIST}${folder.workspace_id}`, folderId);
    }
    if (folder.parent_folder_id) {
      await redisClient.sRem(`${REDIS_KEYS.FOLDER_CHILDREN}${folder.parent_folder_id}`, folderId);
    }
    
    // Remove from Neo4j
    const session = this.getSession();
    try {
      await session.run('MATCH (f:Folder {folder_id: $id}) DETACH DELETE f', { id: folderId });
    } finally {
      await session.close();
    }
    
    return { success: true, deleted: 1 };
  }

  /**
   * Link ontology to folder (stored in Redis)
   */
  async linkOntologyToFolder(folderId, ontologyId) {
    const folder = await this.getFolder(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);
    
    folder.ontology_id = ontologyId;
    folder.updated_at = new Date().toISOString();
    
    await redisClient.hSet(`${REDIS_KEYS.FOLDER}${folderId}`, folder);
    await redisClient.set(`${REDIS_KEYS.FOLDER_ONTOLOGY}${folderId}`, ontologyId);
    
    // Sync to Neo4j
    await this.syncFolderToNeo4j(folder);
    
    return { folder, ontology_id: ontologyId };
  }

  /**
   * Get effective ontology for folder (checks parents)
   */
  async getEffectiveOntologyForFolder(folderId) {
    let currentId = folderId;
    
    while (currentId) {
      const folder = await this.getFolder(currentId);
      if (!folder) break;
      
      if (folder.ontology_id) {
        return { folder_id: currentId, ontology_id: folder.ontology_id };
      }
      
      currentId = folder.parent_folder_id;
    }
    
    return null;
  }


  // ============================================================
  // NEO4J SYNC OPERATIONS (Secondary)
  // ============================================================

  /**
   * Sync tenant to Neo4j
   */
  async syncTenantToNeo4j(tenant) {
    const session = this.getSession();
    try {
      await session.run(`
        MERGE (t:Tenant {tenant_id: $tenant_id})
        SET t.uri = $uri,
            t.name = $name,
            t.status = $status,
            t.created_at = datetime($created_at),
            t.updated_at = datetime($updated_at)
      `, tenant);
    } catch (error) {
      console.warn('⚠️ Could not sync tenant to Neo4j:', error.message);
    } finally {
      await session.close();
    }
  }

  /**
   * Sync workspace to Neo4j
   */
  async syncWorkspaceToNeo4j(workspace, tenantId) {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (t:Tenant {tenant_id: $tenant_id})
        MERGE (w:Workspace {workspace_id: $workspace_id})
        SET w.uri = $uri,
            w.name = $name,
            w.description = $description,
            w.status = $status,
            w.created_at = datetime($created_at),
            w.updated_at = datetime($updated_at)
        MERGE (t)-[:OWNS]->(w)
      `, { ...workspace, tenant_id: tenantId });
    } catch (error) {
      console.warn('⚠️ Could not sync workspace to Neo4j:', error.message);
    } finally {
      await session.close();
    }
  }

  /**
   * Sync folder to Neo4j
   */
  async syncFolderToNeo4j(folder) {
    const session = this.getSession();
    try {
      // Create folder node
      await session.run(`
        MERGE (f:Folder {folder_id: $folder_id})
        SET f.uri = $uri,
            f.name = $name,
            f.description = $description,
            f.folder_type = $folder_type,
            f.workspace_id = $workspace_id,
            f.ontology_id = $ontology_id,
            f.created_at = datetime($created_at),
            f.updated_at = datetime($updated_at)
      `, folder);
      
      // Link to workspace if specified
      if (folder.workspace_id && !folder.parent_folder_id) {
        await session.run(`
          MATCH (w:Workspace {workspace_id: $workspace_id})
          MATCH (f:Folder {folder_id: $folder_id})
          MERGE (w)-[:CONTAINS_FOLDER]->(f)
        `, { workspace_id: folder.workspace_id, folder_id: folder.folder_id });
      }
      
      // Link to parent folder if specified
      if (folder.parent_folder_id) {
        await session.run(`
          MATCH (parent:Folder {folder_id: $parent_id})
          MATCH (f:Folder {folder_id: $folder_id})
          MERGE (parent)-[:CONTAINS]->(f)
        `, { parent_id: folder.parent_folder_id, folder_id: folder.folder_id });
      }
    } catch (error) {
      console.warn('⚠️ Could not sync folder to Neo4j:', error.message);
    } finally {
      await session.close();
    }
  }


  // ============================================================
  // SYNC & RECOVERY OPERATIONS
  // ============================================================

  /**
   * Sync all data from Redis to Neo4j
   * Use this to rebuild Neo4j graph from Redis primary data
   */
  async syncAllToNeo4j() {
    const results = { tenants: 0, workspaces: 0, folders: 0 };
    
    // Sync tenants
    const tenants = await this.getAllTenants();
    for (const tenant of tenants) {
      await this.syncTenantToNeo4j(tenant);
      results.tenants++;
      
      // Sync workspaces
      const workspaces = await this.getWorkspacesForTenant(tenant.tenant_id);
      for (const ws of workspaces) {
        await this.syncWorkspaceToNeo4j(ws, tenant.tenant_id);
        results.workspaces++;
        
        // Sync folders
        const folders = await this.getFoldersForWorkspace(ws.workspace_id);
        for (const folder of folders) {
          await this.syncFolderToNeo4j(folder);
          results.folders++;
        }
      }
    }
    
    console.log(`✅ Synced to Neo4j: ${results.tenants} tenants, ${results.workspaces} workspaces, ${results.folders} folders`);
    return { success: true, ...results };
  }

  /**
   * Validate workspace access
   */
  async validateWorkspaceAccess(tenantId, workspaceId) {
    const workspace = await this.getWorkspace(workspaceId);
    return workspace && workspace.tenant_id === tenantId;
  }

  /**
   * Get or create default tenant and workspace
   */
  async getOrCreateDefaultTenantWorkspace() {
    const DEFAULT_TENANT_ID = 'default';
    const DEFAULT_WORKSPACE_ID = 'default';

    let tenant = await this.getTenant(DEFAULT_TENANT_ID);
    if (!tenant) {
      tenant = await this.createTenant({
        tenant_id: DEFAULT_TENANT_ID,
        name: 'Default Tenant',
        status: 'active',
        is_default: true
      });
    } else if (!tenant.is_default) {
      // Mark existing tenant as default
      await redisClient.hSet(`${REDIS_KEYS.TENANT}${DEFAULT_TENANT_ID}`, 'is_default', 'true');
      tenant.is_default = true;
    }

    const workspaces = await this.getWorkspacesForTenant(DEFAULT_TENANT_ID);
    let workspace = workspaces.find(w => w.workspace_id === DEFAULT_WORKSPACE_ID);
    
    if (!workspace) {
      workspace = await this.createWorkspace(DEFAULT_TENANT_ID, {
        workspace_id: DEFAULT_WORKSPACE_ID,
        name: 'Default Workspace',
        description: 'Default workspace for documents',
        status: 'active',
        is_default: true
      });
    } else if (!workspace.is_default) {
      // Mark existing workspace as default
      await redisClient.hSet(`${REDIS_KEYS.WORKSPACE}${DEFAULT_WORKSPACE_ID}`, 'is_default', 'true');
      workspace.is_default = true;
    }

    return { tenant, workspace };
  }

  // Deprecated - kept for backward compatibility
  async linkOntologyToWorkspace(workspaceId, versionId) {
    console.warn('⚠️ linkOntologyToWorkspace is deprecated. Use linkOntologyToFolder instead.');
    return { workspace_id: workspaceId, version_id: versionId };
  }

  async createOntologyVersion(ontologyData, versionData) {
    // Store in Redis
    const ontologyId = ontologyData.ontology_id || uuidv4();
    const versionId = versionData.version_id || uuidv4();
    
    await redisClient.hSet(`${REDIS_KEYS.ONTOLOGY}${ontologyId}`, {
      ontology_id: ontologyId,
      name: ontologyData.name || '',
      description: ontologyData.description || '',
      domain: ontologyData.domain || 'general'
    });
    
    await redisClient.hSet(`${REDIS_KEYS.ONTOLOGY_VERSION}${versionId}`, {
      version_id: versionId,
      ontology_id: ontologyId,
      version: versionData.version || '1.0',
      source_uri: versionData.source_uri || ''
    });
    
    return {
      ontology: { ontology_id: ontologyId, ...ontologyData },
      version: { version_id: versionId, ...versionData }
    };
  }
}

module.exports = new TenantService();
