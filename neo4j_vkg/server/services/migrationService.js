/**
 * Migration Service
 * Handles migration of existing data to the new multi-tenant model
 * Creates relationships between existing entities and tenant/workspace nodes
 */

const driver = require('../config/neo4j');
const tenantService = require('./tenantService');

class MigrationService {
  /**
   * Get a session with the configured database
   */
  getSession() {
    const database = driver.getDatabase();
    return driver.session({ database });
  }

  /**
   * Run full migration to multi-tenant model
   * This is idempotent - safe to run multiple times
   */
  async migrateToMultiTenant(options = {}) {
    const results = {
      tenant: null,
      workspace: null,
      documentsLinked: 0,
      foldersLinked: 0,
      orphanedDocuments: 0,
      orphanedFolders: 0,
      errors: []
    };

    console.log('\n' + '='.repeat(60));
    console.log('🔄 MIGRATING TO MULTI-TENANT MODEL');
    console.log('='.repeat(60));

    try {
      // Step 1: Create default tenant and workspace
      console.log('\n📦 Step 1: Creating default tenant and workspace...');
      const { tenant, workspace } = await tenantService.getOrCreateDefaultTenantWorkspace();
      results.tenant = tenant;
      results.workspace = workspace;
      console.log(`   ✅ Tenant: ${tenant.name} (${tenant.tenant_id})`);
      console.log(`   ✅ Workspace: ${workspace.name} (${workspace.workspace_id})`);

      // Step 2: Link orphaned folders to workspace
      console.log('\n📁 Step 2: Linking orphaned folders to workspace...');
      const folderResult = await this.linkOrphanedFoldersToWorkspace(workspace.workspace_id);
      results.foldersLinked = folderResult.linked;
      results.orphanedFolders = folderResult.orphaned;
      console.log(`   ✅ Linked ${folderResult.linked} folders`);
      if (folderResult.orphaned > 0) {
        console.log(`   ⚠️  ${folderResult.orphaned} folders still orphaned (may have custom tenant_id)`);
      }

      // Step 3: Link orphaned documents to workspace
      console.log('\n📄 Step 3: Linking orphaned documents to workspace...');
      const docResult = await this.linkOrphanedDocumentsToWorkspace(workspace.workspace_id);
      results.documentsLinked = docResult.linked;
      results.orphanedDocuments = docResult.orphaned;
      console.log(`   ✅ Linked ${docResult.linked} documents`);
      if (docResult.orphaned > 0) {
        console.log(`   ⚠️  ${docResult.orphaned} documents still orphaned (may have custom tenant_id)`);
      }

      // Step 4: Update property-based tenant/workspace IDs
      console.log('\n🔧 Step 4: Updating property-based IDs...');
      const propResult = await this.updatePropertyBasedIds(
        tenant.tenant_id,
        workspace.workspace_id
      );
      console.log(`   ✅ Updated ${propResult.documents} documents`);
      console.log(`   ✅ Updated ${propResult.folders} folders`);
      console.log(`   ✅ Updated ${propResult.chunks} chunks`);

      // Step 5: Create workspace-folder relationships
      console.log('\n🔗 Step 5: Creating workspace-folder relationships...');
      const wfResult = await this.createWorkspaceFolderRelationships(workspace.workspace_id);
      console.log(`   ✅ Created ${wfResult.created} CONTAINS_FOLDER relationships`);

      // Step 6: Create workspace-document relationships for documents not in folders
      console.log('\n🔗 Step 6: Creating workspace-document relationships...');
      const wdResult = await this.createWorkspaceDocumentRelationships(workspace.workspace_id);
      console.log(`   ✅ Created ${wdResult.created} CONTAINS_DOCUMENT relationships`);

      console.log('\n' + '='.repeat(60));
      console.log('✅ MIGRATION COMPLETE');
      console.log('='.repeat(60) + '\n');

      return {
        success: true,
        ...results
      };
    } catch (error) {
      console.error('\n❌ Migration error:', error);
      results.errors.push(error.message);
      return {
        success: false,
        ...results
      };
    }
  }

  /**
   * Link folders without workspace relationships to default workspace
   */
  async linkOrphanedFoldersToWorkspace(workspaceId) {
    const session = this.getSession();

    try {
      // Find folders not linked to any workspace
      const countQuery = `
        MATCH (f:Folder)
        WHERE NOT (f)<-[:CONTAINS_FOLDER]-(:Workspace)
        RETURN count(f) as total
      `;
      const countResult = await session.run(countQuery);
      const total = countResult.records[0]?.get('total').toNumber() || 0;

      if (total === 0) {
        return { linked: 0, orphaned: 0 };
      }

      // Link folders that have null/empty tenant_id or match 'default'
      const linkQuery = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (f:Folder)
        WHERE NOT (f)<-[:CONTAINS_FOLDER]-(:Workspace)
          AND (f.tenant_id IS NULL OR f.tenant_id = '' OR f.tenant_id = 'default')
        MERGE (w)-[:CONTAINS_FOLDER]->(f)
        RETURN count(f) as linked
      `;
      const linkResult = await session.run(linkQuery, { workspace_id: workspaceId });
      const linked = linkResult.records[0]?.get('linked').toNumber() || 0;

      return { linked, orphaned: total - linked };
    } finally {
      await session.close();
    }
  }

  /**
   * Link documents without workspace relationships to default workspace
   */
  async linkOrphanedDocumentsToWorkspace(workspaceId) {
    const session = this.getSession();

    try {
      // Find documents not linked to any workspace (directly or via folder)
      const countQuery = `
        MATCH (d:Document)
        WHERE NOT (d)<-[:CONTAINS_DOCUMENT]-(:Workspace)
          AND NOT (d)<-[:CONTAINS]-(:Folder)<-[:CONTAINS_FOLDER]-(:Workspace)
        RETURN count(d) as total
      `;
      const countResult = await session.run(countQuery);
      const total = countResult.records[0]?.get('total').toNumber() || 0;

      if (total === 0) {
        return { linked: 0, orphaned: 0 };
      }

      // Link documents that have null/empty tenant_id or match 'default'
      const linkQuery = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (d:Document)
        WHERE NOT (d)<-[:CONTAINS_DOCUMENT]-(:Workspace)
          AND NOT (d)<-[:CONTAINS]-(:Folder)<-[:CONTAINS_FOLDER]-(:Workspace)
          AND (d.tenant_id IS NULL OR d.tenant_id = '' OR d.tenant_id = 'default')
        MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
        RETURN count(d) as linked
      `;
      const linkResult = await session.run(linkQuery, { workspace_id: workspaceId });
      const linked = linkResult.records[0]?.get('linked').toNumber() || 0;

      return { linked, orphaned: total - linked };
    } finally {
      await session.close();
    }
  }

  /**
   * Update property-based tenant_id and workspace_id on existing nodes
   */
  async updatePropertyBasedIds(tenantId, workspaceId) {
    const session = this.getSession();
    const results = { documents: 0, folders: 0, chunks: 0 };

    try {
      // Update documents
      const docQuery = `
        MATCH (d:Document)
        WHERE d.tenant_id IS NULL OR d.tenant_id = ''
        SET d.tenant_id = $tenant_id, d.workspace_id = $workspace_id
        RETURN count(d) as updated
      `;
      const docResult = await session.run(docQuery, { tenant_id: tenantId, workspace_id: workspaceId });
      results.documents = docResult.records[0]?.get('updated').toNumber() || 0;

      // Update folders
      const folderQuery = `
        MATCH (f:Folder)
        WHERE f.tenant_id IS NULL OR f.tenant_id = ''
        SET f.tenant_id = $tenant_id, f.workspace_id = $workspace_id
        RETURN count(f) as updated
      `;
      const folderResult = await session.run(folderQuery, { tenant_id: tenantId, workspace_id: workspaceId });
      results.folders = folderResult.records[0]?.get('updated').toNumber() || 0;

      // Update chunks
      const chunkQuery = `
        MATCH (ch:Chunk)
        WHERE ch.tenant_id IS NULL OR ch.tenant_id = ''
        SET ch.tenant_id = $tenant_id, ch.workspace_id = $workspace_id
        RETURN count(ch) as updated
      `;
      const chunkResult = await session.run(chunkQuery, { tenant_id: tenantId, workspace_id: workspaceId });
      results.chunks = chunkResult.records[0]?.get('updated').toNumber() || 0;

      return results;
    } finally {
      await session.close();
    }
  }

  /**
   * Create CONTAINS_FOLDER relationships from workspace to root folders
   */
  async createWorkspaceFolderRelationships(workspaceId) {
    const session = this.getSession();

    try {
      // Link root folders (folders not contained by other folders) to workspace
      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (f:Folder)
        WHERE NOT (f)<-[:CONTAINS]-(:Folder)
          AND NOT (f)<-[:CONTAINS_FOLDER]-(w)
          AND (f.workspace_id = $workspace_id OR f.workspace_id IS NULL OR f.workspace_id = '')
        MERGE (w)-[:CONTAINS_FOLDER]->(f)
        RETURN count(f) as created
      `;
      const result = await session.run(query, { workspace_id: workspaceId });
      const created = result.records[0]?.get('created').toNumber() || 0;

      return { created };
    } finally {
      await session.close();
    }
  }

  /**
   * Create CONTAINS_DOCUMENT relationships for documents not in folders
   */
  async createWorkspaceDocumentRelationships(workspaceId) {
    const session = this.getSession();

    try {
      // Link documents not in any folder directly to workspace
      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (d:Document)
        WHERE NOT (d)<-[:CONTAINS]-(:Folder)
          AND NOT (d)<-[:CONTAINS_DOCUMENT]-(w)
          AND (d.workspace_id = $workspace_id OR d.workspace_id IS NULL OR d.workspace_id = '')
        MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
        RETURN count(d) as created
      `;
      const result = await session.run(query, { workspace_id: workspaceId });
      const created = result.records[0]?.get('created').toNumber() || 0;

      return { created };
    } finally {
      await session.close();
    }
  }

  /**
   * Get migration status - check what needs to be migrated
   */
  async getMigrationStatus() {
    const session = this.getSession();

    try {
      const status = {
        hasTenants: false,
        hasWorkspaces: false,
        orphanedDocuments: 0,
        orphanedFolders: 0,
        documentsWithoutTenantId: 0,
        foldersWithoutTenantId: 0,
        chunksWithoutTenantId: 0
      };

      // Check for tenants
      const tenantResult = await session.run('MATCH (t:Tenant) RETURN count(t) as count');
      status.hasTenants = (tenantResult.records[0]?.get('count').toNumber() || 0) > 0;

      // Check for workspaces
      const wsResult = await session.run('MATCH (w:Workspace) RETURN count(w) as count');
      status.hasWorkspaces = (wsResult.records[0]?.get('count').toNumber() || 0) > 0;

      // Count orphaned documents (not linked to workspace)
      const orphanDocResult = await session.run(`
        MATCH (d:Document)
        WHERE NOT (d)<-[:CONTAINS_DOCUMENT]-(:Workspace)
          AND NOT (d)<-[:CONTAINS]-(:Folder)<-[:CONTAINS_FOLDER]-(:Workspace)
        RETURN count(d) as count
      `);
      status.orphanedDocuments = orphanDocResult.records[0]?.get('count').toNumber() || 0;

      // Count orphaned folders
      const orphanFolderResult = await session.run(`
        MATCH (f:Folder)
        WHERE NOT (f)<-[:CONTAINS_FOLDER]-(:Workspace)
        RETURN count(f) as count
      `);
      status.orphanedFolders = orphanFolderResult.records[0]?.get('count').toNumber() || 0;

      // Count documents without tenant_id property
      const docNoTenantResult = await session.run(`
        MATCH (d:Document)
        WHERE d.tenant_id IS NULL OR d.tenant_id = ''
        RETURN count(d) as count
      `);
      status.documentsWithoutTenantId = docNoTenantResult.records[0]?.get('count').toNumber() || 0;

      // Count folders without tenant_id property
      const folderNoTenantResult = await session.run(`
        MATCH (f:Folder)
        WHERE f.tenant_id IS NULL OR f.tenant_id = ''
        RETURN count(f) as count
      `);
      status.foldersWithoutTenantId = folderNoTenantResult.records[0]?.get('count').toNumber() || 0;

      // Count chunks without tenant_id property
      const chunkNoTenantResult = await session.run(`
        MATCH (ch:Chunk)
        WHERE ch.tenant_id IS NULL OR ch.tenant_id = ''
        RETURN count(ch) as count
      `);
      status.chunksWithoutTenantId = chunkNoTenantResult.records[0]?.get('count').toNumber() || 0;

      // Determine if migration is needed
      status.migrationNeeded = !status.hasTenants || 
                               !status.hasWorkspaces || 
                               status.orphanedDocuments > 0 || 
                               status.orphanedFolders > 0 ||
                               status.documentsWithoutTenantId > 0;

      return status;
    } finally {
      await session.close();
    }
  }

  /**
   * Migrate a specific tenant's data from property-based to relationship-based
   */
  async migrateTenantData(tenantId, workspaceId) {
    const session = this.getSession();

    try {
      // Ensure tenant and workspace exist
      let tenant = await tenantService.getTenant(tenantId);
      if (!tenant) {
        tenant = await tenantService.createTenant({
          tenant_id: tenantId,
          name: `Tenant ${tenantId}`,
          status: 'active'
        });
      }

      let workspace = await tenantService.getWorkspace(workspaceId);
      if (!workspace) {
        workspace = await tenantService.createWorkspace(tenantId, {
          workspace_id: workspaceId,
          name: `Workspace ${workspaceId}`,
          status: 'active'
        });
      }

      // Link folders with matching tenant_id
      const folderQuery = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (f:Folder {tenant_id: $tenant_id})
        WHERE NOT (f)<-[:CONTAINS_FOLDER]-(w)
          AND NOT (f)<-[:CONTAINS]-(:Folder)
        MERGE (w)-[:CONTAINS_FOLDER]->(f)
        RETURN count(f) as linked
      `;
      const folderResult = await session.run(folderQuery, { 
        workspace_id: workspaceId, 
        tenant_id: tenantId 
      });

      // Link documents with matching tenant_id
      const docQuery = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (d:Document {tenant_id: $tenant_id})
        WHERE NOT (d)<-[:CONTAINS_DOCUMENT]-(w)
          AND NOT (d)<-[:CONTAINS]-(:Folder)
        MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
        RETURN count(d) as linked
      `;
      const docResult = await session.run(docQuery, { 
        workspace_id: workspaceId, 
        tenant_id: tenantId 
      });

      return {
        tenant,
        workspace,
        foldersLinked: folderResult.records[0]?.get('linked').toNumber() || 0,
        documentsLinked: docResult.records[0]?.get('linked').toNumber() || 0
      };
    } finally {
      await session.close();
    }
  }
}

module.exports = new MigrationService();
