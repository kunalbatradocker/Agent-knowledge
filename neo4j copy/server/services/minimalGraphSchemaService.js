/**
 * Minimal Neo4j Schema for GraphDB Sync
 * Only creates constraints/indexes needed for synced instance data
 */

const neo4jService = require('./neo4jService');
const logger = require('../utils/logger');

class MinimalGraphSchemaService {
  constructor() {
    this.initialized = false;
  }

  getSession() {
    return neo4jService.getSession();
  }

  /**
   * Initialize minimal Neo4j schema for synced data only
   */
  async initializeSchema() {
    if (this.initialized) {
      console.log('Minimal schema already initialized');
      return { success: true, message: 'Schema already initialized' };
    }

    const session = this.getSession();
    const results = {
      constraints: [],
      indexes: [],
      errors: []
    };

    try {
      console.log('\n' + '='.repeat(60));
      console.log('🔧 INITIALIZING MINIMAL NEO4J SCHEMA (GraphDB Sync Only)');
      console.log('='.repeat(60));

      // Only create constraints for synced data
      await this.createMinimalConstraints(session, results);

      // Only create indexes for synced data
      await this.createMinimalIndexes(session, results);

      this.initialized = true;

      console.log('\n✅ Minimal schema initialization complete!');
      console.log(`   Constraints created: ${results.constraints.length}`);
      console.log(`   Indexes created: ${results.indexes.length}`);
      console.log('='.repeat(60));

      return {
        success: true,
        constraints: results.constraints,
        indexes: results.indexes,
        errors: results.errors
      };

    } catch (error) {
      logger.error('Schema initialization failed:', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Create minimal constraints for synced instance data
   */
  async createMinimalConstraints(session, results) {
    console.log('\n📋 Creating minimal constraints...');

    const constraints = [
      // Essential: Prevent duplicate entities during sync
      {
        name: 'entity_uri_unique',
        query: `CREATE CONSTRAINT entity_uri_unique IF NOT EXISTS
                FOR (n:Entity)
                REQUIRE n.uri IS UNIQUE`
      },
      // Document URI must be unique
      {
        name: 'document_uri_unique',
        query: `CREATE CONSTRAINT document_uri_unique IF NOT EXISTS
                FOR (d:Document)
                REQUIRE d.uri IS UNIQUE`
      },
      // Chunk URI must be unique
      {
        name: 'chunk_uri_unique',
        query: `CREATE CONSTRAINT chunk_uri_unique IF NOT EXISTS
                FOR (ch:Chunk)
                REQUIRE ch.uri IS UNIQUE`
      },
      // Tenant/Workspace for multi-tenancy
      {
        name: 'tenant_id_unique',
        query: `CREATE CONSTRAINT tenant_id_unique IF NOT EXISTS
                FOR (t:Tenant)
                REQUIRE t.tenant_id IS UNIQUE`
      },
      {
        name: 'workspace_id_unique',
        query: `CREATE CONSTRAINT workspace_id_unique IF NOT EXISTS
                FOR (w:Workspace)
                REQUIRE w.workspace_id IS UNIQUE`
      },
      // Folder uniqueness
      {
        name: 'folder_id_unique',
        query: `CREATE CONSTRAINT folder_id_unique IF NOT EXISTS
                FOR (f:Folder)
                REQUIRE f.folder_id IS UNIQUE`
      }
    ];

    for (const constraint of constraints) {
      try {
        await session.run(constraint.query);
        results.constraints.push(constraint.name);
        console.log(`   ✅ ${constraint.name}`);
      } catch (error) {
        if (error.message.includes('already exists') || error.message.includes('equivalent')) {
          console.log(`   ⏭️  ${constraint.name} (already exists)`);
          results.constraints.push(constraint.name);
        } else {
          console.log(`   ⚠️  ${constraint.name}: ${error.message}`);
          results.errors.push({ constraint: constraint.name, error: error.message });
        }
      }
    }
  }

  /**
   * Create minimal indexes for synced instance data
   */
  async createMinimalIndexes(session, results) {
    console.log('\n📇 Creating minimal indexes...');

    const indexes = [
      // Document indexes
      {
        name: 'document_doc_id',
        query: `CREATE INDEX document_doc_id IF NOT EXISTS
                FOR (d:Document)
                ON (d.doc_id)`
      },
      {
        name: 'document_tenant_workspace',
        query: `CREATE INDEX document_tenant_workspace IF NOT EXISTS
                FOR (d:Document)
                ON (d.tenant_id, d.workspace_id)`
      },
      // Chunk indexes
      {
        name: 'chunk_tenant_workspace',
        query: `CREATE INDEX chunk_tenant_workspace IF NOT EXISTS
                FOR (ch:Chunk)
                ON (ch.tenant_id, ch.workspace_id)`
      },
      // Assertion indexes for reification pattern
      {
        name: 'assertion_id_index',
        query: `CREATE INDEX assertion_id_index IF NOT EXISTS
                FOR (a:Assertion)
                ON (a.assertion_id)`
      },
      {
        name: 'assertion_tenant',
        query: `CREATE INDEX assertion_tenant IF NOT EXISTS
                FOR (a:Assertion)
                ON (a.tenant_id, a.workspace_id)`
      },
      // EvidenceChunk indexes
      {
        name: 'evidence_chunk_id',
        query: `CREATE INDEX evidence_chunk_id IF NOT EXISTS
                FOR (ec:EvidenceChunk)
                ON (ec.chunk_id)`
      },
      {
        name: 'evidence_text_hash',
        query: `CREATE INDEX evidence_text_hash IF NOT EXISTS
                FOR (ec:EvidenceChunk)
                ON (ec.text_hash)`
      },
      {
        name: 'evidence_tenant',
        query: `CREATE INDEX evidence_tenant IF NOT EXISTS
                FOR (ec:EvidenceChunk)
                ON (ec.tenant_id, ec.workspace_id)`
      },
      // URI index for fast lookups during sync
      {
        name: 'node_uri_index',
        query: `CREATE INDEX node_uri_index IF NOT EXISTS
                FOR (n)
                ON (n.uri)`
      },
      // Label index for synced entities
      {
        name: 'entity_label',
        query: `CREATE INDEX entity_label IF NOT EXISTS
                FOR (n)
                ON (n.label)`
      },
      // Canonical ID index for entity lookups
      {
        name: 'canonical_id_index',
        query: `CREATE INDEX canonical_id_index IF NOT EXISTS
                FOR (n)
                ON (n.canonical_id)`
      }
    ];

    for (const index of indexes) {
      try {
        await session.run(index.query);
        results.indexes.push(index.name);
        console.log(`   ✅ ${index.name}`);
      } catch (error) {
        if (error.message.includes('already exists') || error.message.includes('equivalent')) {
          console.log(`   ⏭️  ${index.name} (already exists)`);
          results.indexes.push(index.name);
        } else {
          console.log(`   ⚠️  ${index.name}: ${error.message}`);
          results.errors.push({ index: index.name, error: error.message });
        }
      }
    }
  }
}

module.exports = new MinimalGraphSchemaService();
