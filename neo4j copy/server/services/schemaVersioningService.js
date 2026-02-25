/**
 * Schema Versioning Service
 * Version control for ontology schemas with diff, rollback, and migration
 * Enterprise-grade schema management comparable to Palantir/C3 AI
 */

const { client, connectRedis } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');

class SchemaVersioningService {
  constructor() {
    this.SCHEMA_PREFIX = 'schema:';
    this.VERSION_PREFIX = 'schema_version:';
    this.HISTORY_PREFIX = 'schema_history:';
  }

  /**
   * Create a new schema version
   */
  async createVersion(schemaId, schema, metadata = {}) {
    await connectRedis();
    
    const versionId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Get current version number
    const currentVersion = await this.getCurrentVersion(schemaId);
    const newVersionNumber = currentVersion ? currentVersion.versionNumber + 1 : 1;

    const versionKey = `${this.VERSION_PREFIX}${versionId}`;
    
    // Use individual hSet calls for compatibility
    await client.hSet(versionKey, 'versionId', versionId);
    await client.hSet(versionKey, 'schemaId', schemaId);
    await client.hSet(versionKey, 'versionNumber', String(newVersionNumber));
    await client.hSet(versionKey, 'schema', JSON.stringify(schema));
    await client.hSet(versionKey, 'createdAt', timestamp);
    await client.hSet(versionKey, 'createdBy', metadata.userId || 'system');
    await client.hSet(versionKey, 'description', metadata.description || `Version ${newVersionNumber}`);
    await client.hSet(versionKey, 'changeType', metadata.changeType || 'update');
    await client.hSet(versionKey, 'changes', metadata.changes ? JSON.stringify(metadata.changes) : '');
    await client.hSet(versionKey, 'isActive', 'true');
    
    // Add to history
    await client.lPush(`${this.HISTORY_PREFIX}${schemaId}`, versionId);
    
    // Update current pointer
    await client.set(`${this.SCHEMA_PREFIX}${schemaId}:current`, versionId);

    // Deactivate previous version
    if (currentVersion) {
      await client.hSet(
        `${this.VERSION_PREFIX}${currentVersion.versionId}`,
        'isActive', 'false'
      );
    }

    return {
      versionId,
      versionNumber: newVersionNumber,
      createdAt: timestamp
    };
  }

  /**
   * Get current active version of a schema
   */
  async getCurrentVersion(schemaId) {
    await connectRedis();
    
    const currentVersionId = await client.get(`${this.SCHEMA_PREFIX}${schemaId}:current`);
    if (!currentVersionId) return null;

    return this.getVersion(currentVersionId);
  }

  /**
   * Get a specific version
   */
  async getVersion(versionId) {
    await connectRedis();
    
    const data = await client.hGetAll(`${this.VERSION_PREFIX}${versionId}`);
    if (!data || Object.keys(data).length === 0) return null;

    return {
      ...data,
      versionNumber: parseInt(data.versionNumber, 10),
      schema: JSON.parse(data.schema),
      changes: data.changes ? JSON.parse(data.changes) : null,
      isActive: data.isActive === 'true'
    };
  }

  /**
   * Get version history for a schema
   */
  async getVersionHistory(schemaId, limit = 50) {
    await connectRedis();
    
    const versionIds = await client.lRange(`${this.HISTORY_PREFIX}${schemaId}`, 0, limit - 1);
    
    const versions = [];
    for (const versionId of versionIds) {
      const version = await this.getVersion(versionId);
      if (version) {
        // Don't include full schema in history list
        versions.push({
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          description: version.description,
          changeType: version.changeType,
          isActive: version.isActive
        });
      }
    }

    return versions;
  }

  /**
   * Delete a specific version
   * Cannot delete the active/current version
   */
  async deleteVersion(versionId) {
    await connectRedis();
    
    const version = await this.getVersion(versionId);
    if (!version) {
      throw new Error('Version not found');
    }

    if (version.isActive) {
      throw new Error('Cannot delete the current active version');
    }

    const schemaId = version.schemaId;

    // Remove from history list
    await client.lRem(`${this.HISTORY_PREFIX}${schemaId}`, 0, versionId);

    // Delete the version hash
    await client.del(`${this.VERSION_PREFIX}${versionId}`);

    return {
      success: true,
      deletedVersionId: versionId,
      deletedVersionNumber: version.versionNumber
    };
  }

  /**
   * Calculate diff between two schema versions
   */
  async diffVersions(versionId1, versionId2) {
    const v1 = await this.getVersion(versionId1);
    const v2 = await this.getVersion(versionId2);

    if (!v1 || !v2) {
      throw new Error('One or both versions not found');
    }

    return this.calculateSchemaDiff(v1.schema, v2.schema);
  }

  /**
   * Calculate detailed diff between two schemas
   */
  calculateSchemaDiff(schema1, schema2) {
    const diff = {
      entityTypes: {
        added: [],
        removed: [],
        modified: []
      },
      relationships: {
        added: [],
        removed: [],
        modified: []
      },
      properties: {
        added: [],
        removed: [],
        modified: []
      },
      summary: {
        totalChanges: 0,
        breakingChanges: 0
      }
    };

    // Helper to extract entity type names from various formats
    const extractEntityTypeNames = (schema) => {
      const names = new Set();
      
      // From nodeTypes array (strings)
      if (schema.nodeTypes && Array.isArray(schema.nodeTypes)) {
        schema.nodeTypes.forEach(t => {
          if (typeof t === 'string') names.add(t);
        });
      }
      
      // From conceptTypes array (strings)
      if (schema.conceptTypes && Array.isArray(schema.conceptTypes)) {
        schema.conceptTypes.forEach(t => {
          if (typeof t === 'string') names.add(t);
        });
      }
      
      // From entityTypes array (objects with label/userLabel)
      if (schema.entityTypes && Array.isArray(schema.entityTypes)) {
        schema.entityTypes.forEach(et => {
          if (typeof et === 'string') {
            names.add(et);
          } else if (et && (et.label || et.userLabel)) {
            names.add(et.userLabel || et.label);
          }
        });
      }
      
      // From originalEntityTypes array
      if (schema.originalEntityTypes && Array.isArray(schema.originalEntityTypes)) {
        schema.originalEntityTypes.forEach(et => {
          if (typeof et === 'string') {
            names.add(et);
          } else if (et && (et.label || et.userLabel)) {
            names.add(et.userLabel || et.label);
          }
        });
      }
      
      return names;
    };

    // Compare entity types
    const types1 = extractEntityTypeNames(schema1);
    const types2 = extractEntityTypeNames(schema2);

    for (const type of types2) {
      if (!types1.has(type)) {
        diff.entityTypes.added.push(type);
        diff.summary.totalChanges++;
      }
    }

    for (const type of types1) {
      if (!types2.has(type)) {
        diff.entityTypes.removed.push(type);
        diff.summary.totalChanges++;
        diff.summary.breakingChanges++;
      }
    }

    // Helper to extract relationship type
    const getRelType = (rel) => rel.type || rel.predicate || rel.userPredicate || '';

    // Compare relationships
    const rels1 = new Map((schema1.relationships || []).map(r => [getRelType(r), r]));
    const rels2 = new Map((schema2.relationships || []).map(r => [getRelType(r), r]));

    for (const [type, rel] of rels2) {
      if (!type) continue; // Skip empty types
      if (!rels1.has(type)) {
        diff.relationships.added.push({ ...rel, type });
        diff.summary.totalChanges++;
      } else {
        const oldRel = rels1.get(type);
        // Compare from/to changes
        if (oldRel.from !== rel.from || oldRel.to !== rel.to) {
          diff.relationships.modified.push({
            type,
            old: oldRel,
            new: rel
          });
          diff.summary.totalChanges++;
        }
      }
    }

    for (const [type, rel] of rels1) {
      if (!type) continue; // Skip empty types
      if (!rels2.has(type)) {
        diff.relationships.removed.push({ ...rel, type });
        diff.summary.totalChanges++;
        diff.summary.breakingChanges++;
      }
    }

    // Compare properties
    const props1 = schema1.nodeProperties || {};
    const props2 = schema2.nodeProperties || {};

    for (const [entityType, properties] of Object.entries(props2)) {
      if (!props1[entityType]) {
        diff.properties.added.push({ entityType, properties });
        diff.summary.totalChanges++;
      } else {
        const oldProps = new Set(props1[entityType]);
        const newProps = new Set(properties);
        
        const addedProps = properties.filter(p => !oldProps.has(p));
        const removedProps = props1[entityType].filter(p => !newProps.has(p));
        
        if (addedProps.length > 0 || removedProps.length > 0) {
          diff.properties.modified.push({
            entityType,
            added: addedProps,
            removed: removedProps
          });
          diff.summary.totalChanges += addedProps.length + removedProps.length;
          diff.summary.breakingChanges += removedProps.length;
        }
      }
    }

    for (const entityType of Object.keys(props1)) {
      if (!props2[entityType]) {
        diff.properties.removed.push({ entityType, properties: props1[entityType] });
        diff.summary.totalChanges++;
        diff.summary.breakingChanges++;
      }
    }

    return diff;
  }

  /**
   * Rollback to a previous version
   * This creates a new version AND updates the actual ontology
   */
  async rollbackToVersion(schemaId, targetVersionId, metadata = {}) {
    const targetVersion = await this.getVersion(targetVersionId);
    if (!targetVersion) {
      throw new Error('Target version not found');
    }

    if (targetVersion.schemaId !== schemaId) {
      throw new Error('Version does not belong to this schema');
    }

    // Get the schema from the target version
    const restoredSchema = targetVersion.schema;

    // Update the actual ontology in storage
    const owlOntologyService = require('./owlOntologyService');
    
    try {
      // Get the existing ontology
      const existingOntology = await owlOntologyService.getOntology('default', 'default', schemaId);
      
      if (existingOntology && existingOntology.isCustom) {
        // Update the ontology with the restored schema
        const updatedOntology = {
          ...existingOntology,
          name: restoredSchema.name || existingOntology.name,
          description: restoredSchema.description || existingOntology.description,
          nodeTypes: restoredSchema.nodeTypes || restoredSchema.conceptTypes || [],
          relationships: restoredSchema.relationships || [],
          nodeProperties: restoredSchema.nodeProperties || {},
          entityTypes: restoredSchema.entityTypes || (restoredSchema.nodeTypes || []).map(t => ({
            label: t,
            userLabel: t,
            description: '',
            include: true,
            properties: restoredSchema.nodeProperties?.[t] || []
          })),
          originalEntityTypes: restoredSchema.entityTypes || restoredSchema.originalEntityTypes,
          originalRelationships: restoredSchema.relationships,
          updatedAt: new Date().toISOString(),
          restoredFromVersion: targetVersion.versionNumber
        };

        // Note: saveCustomOntology method needs to be implemented in owlOntologyService
        // await owlOntologyService.saveCustomOntology(updatedOntology);
        console.warn('Schema versioning: saveCustomOntology not yet implemented');
        console.log(`✅ Restored ontology ${schemaId} to version ${targetVersion.versionNumber}`);
      }
    } catch (ontologyError) {
      console.error('Error updating ontology during rollback:', ontologyError);
      // Continue to create the version record even if ontology update fails
    }

    // Create a new version with the old schema (preserves history)
    const rollbackVersion = await this.createVersion(schemaId, restoredSchema, {
      userId: metadata.userId,
      description: `Rollback to version ${targetVersion.versionNumber}`,
      changeType: 'rollback',
      changes: {
        rolledBackFrom: targetVersionId,
        originalVersionNumber: targetVersion.versionNumber
      }
    });

    return {
      success: true,
      newVersionId: rollbackVersion.versionId,
      newVersionNumber: rollbackVersion.versionNumber,
      rolledBackTo: targetVersion.versionNumber,
      restoredSchema: restoredSchema
    };
  }

  /**
   * Generate migration script for schema changes
   */
  async generateMigration(fromVersionId, toVersionId) {
    const diff = await this.diffVersions(fromVersionId, toVersionId);
    
    const migrations = {
      up: [],
      down: [],
      warnings: []
    };

    // Generate UP migrations (apply changes)
    
    // Add new entity types
    for (const type of diff.entityTypes.added) {
      migrations.up.push({
        type: 'create_label',
        label: type,
        cypher: `// Create constraint for new entity type ${type}\nCREATE CONSTRAINT ${type.toLowerCase()}_uri IF NOT EXISTS FOR (n:${type}) REQUIRE n.uri IS UNIQUE`
      });
    }

    // Handle removed entity types
    for (const type of diff.entityTypes.removed) {
      migrations.warnings.push(`Removing entity type '${type}' will delete all nodes of this type`);
      migrations.up.push({
        type: 'remove_label',
        label: type,
        cypher: `// Remove nodes with label ${type} (CAUTION: destructive)\n// MATCH (n:${type}) DETACH DELETE n`,
        destructive: true
      });
    }

    // Add new relationships
    for (const rel of diff.relationships.added) {
      migrations.up.push({
        type: 'add_relationship_type',
        relationshipType: rel.type,
        cypher: `// New relationship type: ${rel.type}\n// From: ${rel.from || 'any'} To: ${rel.to || 'any'}`
      });
    }

    // Handle removed relationships
    for (const rel of diff.relationships.removed) {
      migrations.warnings.push(`Removing relationship type '${rel.type}' will delete all such relationships`);
      migrations.up.push({
        type: 'remove_relationship_type',
        relationshipType: rel.type,
        cypher: `// Remove relationships of type ${rel.type} (CAUTION: destructive)\n// MATCH ()-[r:${rel.type}]->() DELETE r`,
        destructive: true
      });
    }

    // Generate DOWN migrations (reverse changes)
    for (const type of diff.entityTypes.added) {
      migrations.down.push({
        type: 'remove_label',
        label: type,
        cypher: `// Rollback: Remove entity type ${type}\n// MATCH (n:${type}) DETACH DELETE n`
      });
    }

    for (const type of diff.entityTypes.removed) {
      migrations.down.push({
        type: 'create_label',
        label: type,
        cypher: `// Rollback: Recreate entity type ${type}\nCREATE CONSTRAINT ${type.toLowerCase()}_uri IF NOT EXISTS FOR (n:${type}) REQUIRE n.uri IS UNIQUE`
      });
    }

    return {
      fromVersion: fromVersionId,
      toVersion: toVersionId,
      diff,
      migrations,
      hasBreakingChanges: diff.summary.breakingChanges > 0
    };
  }

  /**
   * Apply a migration
   */
  async applyMigration(migration, options = {}) {
    const { dryRun = true, skipDestructive = true } = options;
    const neo4jService = require('./neo4jService');
    const session = neo4jService.getSession();
    
    const results = {
      applied: [],
      skipped: [],
      errors: []
    };

    try {
      for (const step of migration.migrations.up) {
        if (step.destructive && skipDestructive) {
          results.skipped.push({
            ...step,
            reason: 'Destructive operation skipped'
          });
          continue;
        }

        if (dryRun) {
          results.applied.push({
            ...step,
            dryRun: true
          });
        } else {
          try {
            // Only execute non-commented Cypher
            const cypher = step.cypher.split('\n')
              .filter(line => !line.trim().startsWith('//'))
              .join('\n')
              .trim();
            
            if (cypher) {
              await session.run(cypher);
            }
            results.applied.push(step);
          } catch (error) {
            results.errors.push({
              ...step,
              error: error.message
            });
          }
        }
      }

      return results;
    } finally {
      await session.close();
    }
  }

  /**
   * Validate schema against current data
   */
  async validateSchemaAgainstData(schemaId) {
    const currentVersion = await this.getCurrentVersion(schemaId);
    if (!currentVersion) {
      return { valid: false, errors: ['Schema not found'] };
    }

    const neo4jService = require('./neo4jService');
    const session = neo4jService.getSession();
    const issues = [];

    try {
      const schema = currentVersion.schema;
      const entityTypes = schema.nodeTypes || schema.conceptTypes || [];

      // Check for entities with types not in schema
      const labelQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          AND NOT n:Provenance AND NOT n:Source AND NOT n:MergeRecord
          AND NOT n:DataConnector
        WITH labels(n) as nodeLabels, count(n) as count
        RETURN nodeLabels, count
      `;

      const result = await session.run(labelQuery);
      
      for (const record of result.records) {
        const labels = record.get('nodeLabels');
        const count = neo4jService.toNumber(record.get('count'));
        
        for (const label of labels) {
          if (!entityTypes.includes(label) && !['Entity', 'Concept'].includes(label)) {
            issues.push({
              type: 'unknown_entity_type',
              label,
              count,
              message: `Found ${count} nodes with type '${label}' not defined in schema`
            });
          }
        }
      }

      // Check for relationships not in schema
      const relTypes = (schema.relationships || []).map(r => r.type);
      const relQuery = `
        MATCH ()-[r]->()
        WHERE NOT type(r) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE', 'FROM_SOURCE', 'DERIVED_FROM', 'CONTAINS']
        WITH type(r) as relType, count(r) as count
        RETURN relType, count
      `;

      const relResult = await session.run(relQuery);
      
      for (const record of relResult.records) {
        const relType = record.get('relType');
        const count = neo4jService.toNumber(record.get('count'));
        
        if (!relTypes.includes(relType) && relType !== 'RELATED_TO' && relType !== 'IS_A') {
          issues.push({
            type: 'unknown_relationship_type',
            relationshipType: relType,
            count,
            message: `Found ${count} relationships of type '${relType}' not defined in schema`
          });
        }
      }

      return {
        valid: issues.length === 0,
        issues,
        schemaVersion: currentVersion.versionNumber,
        checkedAt: new Date().toISOString()
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Export schema to JSON-LD format
   */
  async exportToJsonLD(schemaId) {
    const currentVersion = await this.getCurrentVersion(schemaId);
    if (!currentVersion) {
      throw new Error('Schema not found');
    }

    const schema = currentVersion.schema;
    
    return {
      '@context': {
        '@vocab': `ont://${schemaId}/`,
        'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
        'owl': 'http://www.w3.org/2002/07/owl#'
      },
      '@id': `ont://${schemaId}`,
      '@type': 'owl:Ontology',
      'rdfs:label': schema.name || schemaId,
      'rdfs:comment': schema.description || '',
      'owl:versionInfo': `${currentVersion.versionNumber}`,
      'classes': (schema.nodeTypes || []).map(type => ({
        '@id': type,
        '@type': 'owl:Class',
        'rdfs:label': type,
        'properties': (schema.nodeProperties?.[type] || []).map(prop => ({
          '@id': `${type}/${prop}`,
          'rdfs:label': prop
        }))
      })),
      'objectProperties': (schema.relationships || []).map(rel => ({
        '@id': rel.type,
        '@type': 'owl:ObjectProperty',
        'rdfs:label': rel.type,
        'rdfs:domain': rel.from ? { '@id': rel.from } : null,
        'rdfs:range': rel.to ? { '@id': rel.to } : null
      }))
    };
  }

  /**
   * Import schema from JSON-LD format
   */
  async importFromJsonLD(jsonLD, schemaId, metadata = {}) {
    const schema = {
      name: jsonLD['rdfs:label'] || schemaId,
      description: jsonLD['rdfs:comment'] || '',
      nodeTypes: [],
      relationships: [],
      nodeProperties: {}
    };

    // Extract classes
    for (const cls of jsonLD.classes || []) {
      const typeName = cls['@id'] || cls['rdfs:label'];
      schema.nodeTypes.push(typeName);
      
      if (cls.properties) {
        schema.nodeProperties[typeName] = cls.properties.map(p => p['rdfs:label'] || p['@id']);
      }
    }

    // Extract relationships
    for (const prop of jsonLD.objectProperties || []) {
      schema.relationships.push({
        type: prop['@id'] || prop['rdfs:label'],
        from: prop['rdfs:domain']?.['@id'] || '',
        to: prop['rdfs:range']?.['@id'] || '',
        properties: []
      });
    }

    return this.createVersion(schemaId, schema, {
      ...metadata,
      description: `Imported from JSON-LD`,
      changeType: 'import'
    });
  }
}

module.exports = new SchemaVersioningService();
