/**
 * Initialization Service
 * Handles startup tasks like creating default tenant/workspace,
 * initializing default ontologies, and setting up RBAC roles
 */

const tenantService = require('./tenantService');
const neo4jService = require('./neo4jService');
const extractionVersioningService = require('./extractionVersioningService');
const owlOntologyService = require('./owlOntologyService');

class InitializationService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the system on startup
   * - Creates default tenant/workspace if not exists
   * - Migrates orphaned documents to default workspace
   * - Initializes predefined ontologies
   * - Creates default RBAC roles
   */
  async initialize() {
    if (this.initialized) return;

    console.log('\n' + '='.repeat(60));
    console.log('🚀 SYSTEM INITIALIZATION');
    console.log('='.repeat(60));

    try {
      // Step 1: Create default tenant and workspace
      const { tenant, workspace } = await this.ensureDefaultTenantWorkspace();
      
      // Step 2: Migrate orphaned documents
      await this.migrateOrphanedDocuments(workspace.workspace_id);
      
      // Step 3: Sync to Neo4j
      await tenantService.syncAllToNeo4j();
      
      // Step 4: Initialize ontologies from GraphDB (not YAML files)
      await this.initializeOntologiesFromGraphDB();
      
      // Step 5: Initialize RBAC roles
      await this.initializeRoles();
      
      // Step 6: Initialize schema versioning
      await this.initializeSchemaVersioning();
      
      // Step 4: Initialize GraphDB → Neo4j sync (skip if disabled)
      if (process.env.SKIP_STARTUP_SYNC !== 'true') {
        console.log('🔄 Initializing GraphDB → Neo4j sync...');
        try {
          const { initializeSync } = require('../scripts/initializeSync');
          await initializeSync();
          console.log('✅ Initial sync completed');
        } catch (error) {
          console.warn('⚠️ Initial sync failed:', error.message);
        }
      } else {
        console.log('⏭️ Skipping startup sync (SKIP_STARTUP_SYNC=true)');
      }

      this.initialized = true;
      console.log('='.repeat(60));
      console.log('✅ INITIALIZATION COMPLETE');
      console.log('='.repeat(60) + '\n');
      
      return { tenant, workspace };
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Ensure default tenant and workspace exist
   */
  async ensureDefaultTenantWorkspace() {
    console.log('\n📋 Checking default tenant/workspace...');
    
    const { tenant, workspace } = await tenantService.getOrCreateDefaultTenantWorkspace();
    
    console.log(`   ✅ Tenant: ${tenant.name} (${tenant.tenant_id})`);
    console.log(`   ✅ Workspace: ${workspace.name} (${workspace.workspace_id})`);
    
    return { tenant, workspace };
  }

  /**
   * Migrate documents without workspace to default workspace
   */
  async migrateOrphanedDocuments(defaultWorkspaceId) {
    console.log('\n📋 Checking for orphaned documents...');
    
    const session = neo4jService.getSession();
    try {
      // Find documents without workspace_id
      const result = await session.run(`
        MATCH (d:Document)
        WHERE d.workspace_id IS NULL OR d.workspace_id = ''
        RETURN d.doc_id as doc_id, d.title as title
      `);
      
      const orphanedDocs = result.records.map(r => ({
        doc_id: r.get('doc_id'),
        title: r.get('title')
      }));
      
      if (orphanedDocs.length === 0) {
        console.log('   ✅ No orphaned documents found');
        return { migrated: 0 };
      }
      
      console.log(`   ⚠️ Found ${orphanedDocs.length} orphaned document(s)`);
      
      // Update documents with default workspace
      const updateResult = await session.run(`
        MATCH (d:Document)
        WHERE d.workspace_id IS NULL OR d.workspace_id = ''
        SET d.workspace_id = $workspaceId
        RETURN count(d) as count
      `, { workspaceId: defaultWorkspaceId });
      
      const migratedCount = updateResult.records[0]?.get('count')?.toNumber?.() || 
                           updateResult.records[0]?.get('count') || 0;
      
      // Create relationship to workspace
      await session.run(`
        MATCH (w:Workspace {workspace_id: $workspaceId})
        MATCH (d:Document {workspace_id: $workspaceId})
        WHERE NOT (w)-[:CONTAINS_DOCUMENT]->(d)
        MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
      `, { workspaceId: defaultWorkspaceId });
      
      console.log(`   ✅ Migrated ${migratedCount} document(s) to default workspace`);
      
      return { migrated: migratedCount, documents: orphanedDocs };
    } finally {
      await session.close();
    }
  }

  /**
   * Get initialization status
   */
  getStatus() {
    return {
      initialized: this.initialized
    };
  }

  /**
   * Initialize ontologies from GraphDB (loads from files if empty)
   */
  async initializeOntologiesFromGraphDB() {
    console.log('\n📦 Initializing ontologies from GraphDB...');
    
    try {
      await owlOntologyService.initialize();
      let ontologies = await owlOntologyService.listOntologies('default', 'default', 'all');
      
      // Seed global ontologies from .ttl files if GraphDB is empty
      if (ontologies.length === 0) {
        console.log('   📂 No ontologies found — loading defaults from files...');
        const ontologyDir = require('path').join(__dirname, '../data/owl-ontologies');
        await owlOntologyService.initializeFromFiles('default', 'default', ontologyDir, 'global');
        ontologies = await owlOntologyService.listOntologies('default', 'default', 'all');
      }

      if (ontologies.length > 0) {
        const names = ontologies.map(o => o.label || o.name || 'Unnamed').filter(Boolean);
        console.log(`   ✅ Loaded ${ontologies.length} ontologies: ${names.join(', ')}`);
      } else {
        console.log('   ℹ️  No ontologies found in GraphDB');
      }
      
      // Get available domains from ontologies
      const domains = [...new Set(ontologies.map((ont, index) => index))];
      console.log(`   📋 Available domains: ${domains.join(', ')}`);
      
      return { loaded: ontologies.length, domains, ontologies };
    } catch (error) {
      console.error('   ⚠️ GraphDB ontology initialization warning:', error.message);
      return { loaded: 0, error: error.message };
    }
  }

  /**
   * Initialize default RBAC roles
   * Uses the new role system from server/config/roles.js
   */
  async initializeRoles() {
    console.log('\n👥 Initializing RBAC roles...');
    
    try {
      const { ROLE_HIERARCHY, getPermissionsForRole } = require('../config/roles');
      
      // Just log the active role hierarchy — roles are defined in code, not Redis
      const roleSummary = ROLE_HIERARCHY.map(r => `${r}(${getPermissionsForRole(r).length} perms)`).join(', ');
      console.log(`   ✅ Role hierarchy: ${roleSummary}`);
      
      return { initialized: true, roles: ROLE_HIERARCHY };
    } catch (error) {
      console.error('   ⚠️ Role initialization warning:', error.message);
      return { initialized: false, error: error.message };
    }
  }

  /**
   * Initialize schema versioning system
   * Creates initial schema version if none exists
   */
  async initializeSchemaVersioning() {
    console.log('\n📐 Initializing schema versioning...');
    
    try {
      await extractionVersioningService.initialize();
      
      const currentVersion = await extractionVersioningService.getCurrentSchemaVersion();
      const history = await extractionVersioningService.getSchemaVersionHistory();
      
      if (history.length === 0) {
        // Create initial schema version
        const initialSchema = await this.buildCurrentSchemaFromNeo4j();
        await extractionVersioningService.saveSchemaVersion(initialSchema, {
          user_id: 'system',
          changes: ['Initial schema version created on startup']
        });
        console.log(`   ✅ Created initial schema version: 1.0.0`);
      } else {
        console.log(`   ✅ Schema versioning ready: ${currentVersion} (${history.length} versions)`);
      }
      
      // Get versioning stats
      const stats = await extractionVersioningService.getVersioningStats();
      if (stats.documents_with_versions > 0) {
        console.log(`   📊 Tracking ${stats.documents_with_versions} documents, ${stats.tracked_concepts} concepts`);
      }
      
      return { initialized: true, version: currentVersion };
    } catch (error) {
      console.error('   ⚠️ Schema versioning warning:', error.message);
      return { initialized: false, error: error.message };
    }
  }

  /**
   * Build current schema from Neo4j node labels and relationship types
   */
  async buildCurrentSchemaFromNeo4j() {
    const session = neo4jService.getSession();
    try {
      // Get all node labels
      const labelsResult = await session.run('CALL db.labels()');
      const nodeTypes = labelsResult.records.map(r => r.get(0));
      
      // Get all relationship types
      const relsResult = await session.run('CALL db.relationshipTypes()');
      const relationshipTypes = relsResult.records.map(r => r.get(0));
      
      return {
        nodeTypes: nodeTypes.filter(t => !['_Bloom_Perspective_', '_Bloom_Scene_'].includes(t)),
        relationshipTypes: relationshipTypes.filter(t => !t.startsWith('_'))
      };
    } finally {
      await session.close();
    }
  }
}

module.exports = new InitializationService();
