/**
 * Graph Schema Service
 * Handles Neo4j schema initialization, constraints, and indexes
 */

const driver = require('../config/neo4j');

class GraphSchemaService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Get a session with the configured database
   */
  getSession() {
    const database = driver.getDatabase();
    return driver.session({ database });
  }

  /**
   * Initialize the Neo4j schema with all required constraints and indexes
   */
  async initializeSchema() {
    if (this.initialized) {
      console.log('Schema already initialized');
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
      console.log('🔧 INITIALIZING NEO4J GRAPH SCHEMA');
      console.log('='.repeat(60));

      // Create constraints
      await this.createConstraints(session, results);

      // Create indexes
      await this.createIndexes(session, results);

      this.initialized = true;

      console.log('\n✅ Schema initialization complete!');
      console.log(`   Constraints created: ${results.constraints.length}`);
      console.log(`   Indexes created: ${results.indexes.length}`);
      if (results.errors.length > 0) {
        console.log(`   Errors (may be duplicates): ${results.errors.length}`);
      }
      console.log('='.repeat(60) + '\n');

      return {
        success: true,
        message: 'Schema initialized successfully',
        ...results
      };
    } catch (error) {
      console.error('Error initializing schema:', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Create all required constraints
   */
  async createConstraints(session, results) {
    const constraints = [
      // Core document storage
      {
        name: 'doc_uri_unique',
        query: `CREATE CONSTRAINT doc_uri_unique IF NOT EXISTS
                FOR (d:Document) REQUIRE d.uri IS UNIQUE`
      },
      {
        name: 'chunk_uri_unique',
        query: `CREATE CONSTRAINT chunk_uri_unique IF NOT EXISTS
                FOR (ch:Chunk) REQUIRE ch.uri IS UNIQUE`
      },
      // Folder management
      {
        name: 'folder_id_unique',
        query: `CREATE CONSTRAINT folder_id_unique IF NOT EXISTS
                FOR (f:Folder) REQUIRE f.folder_id IS UNIQUE`
      },
      // Multi-tenancy (optional - only if using tenants)
      {
        name: 'workspace_id_unique',
        query: `CREATE CONSTRAINT workspace_id_unique IF NOT EXISTS
                FOR (w:Workspace) REQUIRE w.workspace_id IS UNIQUE`
      }
    ];

    console.log('\n📋 Creating constraints...');

    for (const constraint of constraints) {
      try {
        await session.run(constraint.query);
        console.log(`   ✅ ${constraint.name}`);
        results.constraints.push(constraint.name);
      } catch (error) {
        if (error.message.includes('already exists') || error.message.includes('equivalent')) {
          console.log(`   ⏭️  ${constraint.name} (already exists)`);
          results.constraints.push(constraint.name);
        } else {
          console.log(`   ❌ ${constraint.name}: ${error.message}`);
          results.errors.push({ constraint: constraint.name, error: error.message });
        }
      }
    }
  }

  /**
   * Create all required indexes
   */
  async createIndexes(session, results) {
    const indexes = [
      // Document lookups
      {
        name: 'document_doc_id',
        query: `CREATE INDEX document_doc_id IF NOT EXISTS
                FOR (d:Document) ON (d.doc_id)`
      },
      {
        name: 'document_workspace',
        query: `CREATE INDEX document_workspace IF NOT EXISTS
                FOR (d:Document) ON (d.workspace_id)`
      },
      // Chunk lookups
      {
        name: 'chunk_order',
        query: `CREATE INDEX chunk_order IF NOT EXISTS
                FOR (ch:Chunk) ON (ch.order)`
      },
      // Folder lookups
      {
        name: 'folder_workspace',
        query: `CREATE INDEX folder_workspace IF NOT EXISTS
                FOR (f:Folder) ON (f.workspace_id)`
      }
    ];

    console.log('\n📇 Creating indexes...');

    for (const index of indexes) {
      try {
        await session.run(index.query);
        console.log(`   ✅ ${index.name}`);
        results.indexes.push(index.name);
      } catch (error) {
        if (error.message.includes('already exists') || error.message.includes('equivalent')) {
          console.log(`   ⏭️  ${index.name} (already exists)`);
          results.indexes.push(index.name);
        } else {
          console.log(`   ❌ ${index.name}: ${error.message}`);
          results.errors.push({ index: index.name, error: error.message });
        }
      }
    }
  }

  /**
   * Get current schema status
   */
  async getSchemaStatus() {
    const session = this.getSession();

    try {
      // Get constraints
      const constraintsResult = await session.run('SHOW CONSTRAINTS');
      const constraints = constraintsResult.records.map(r => ({
        name: r.get('name'),
        type: r.get('type'),
        entityType: r.get('entityType'),
        labelsOrTypes: r.get('labelsOrTypes'),
        properties: r.get('properties')
      }));

      // Get indexes
      const indexesResult = await session.run('SHOW INDEXES');
      const indexes = indexesResult.records.map(r => ({
        name: r.get('name'),
        type: r.get('type'),
        entityType: r.get('entityType'),
        labelsOrTypes: r.get('labelsOrTypes'),
        properties: r.get('properties'),
        state: r.get('state')
      }));

      return {
        constraints,
        indexes,
        initialized: this.initialized
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Drop all schema elements (use with caution!)
   */
  async dropSchema() {
    const session = this.getSession();

    try {
      console.log('⚠️  Dropping all schema constraints and indexes...');

      // Get and drop all constraints
      const constraints = await session.run('SHOW CONSTRAINTS');
      for (const record of constraints.records) {
        const name = record.get('name');
        try {
          await session.run(`DROP CONSTRAINT ${name} IF EXISTS`);
          console.log(`   Dropped constraint: ${name}`);
        } catch (e) {
          console.log(`   Could not drop constraint ${name}: ${e.message}`);
        }
      }

      // Get and drop all indexes (except lookup indexes)
      const indexes = await session.run('SHOW INDEXES');
      for (const record of indexes.records) {
        const name = record.get('name');
        const type = record.get('type');
        if (type !== 'LOOKUP') {
          try {
            await session.run(`DROP INDEX ${name} IF EXISTS`);
            console.log(`   Dropped index: ${name}`);
          } catch (e) {
            console.log(`   Could not drop index ${name}: ${e.message}`);
          }
        }
      }

      this.initialized = false;
      return { success: true, message: 'Schema dropped' };
    } finally {
      await session.close();
    }
  }
}

module.exports = new GraphSchemaService();

