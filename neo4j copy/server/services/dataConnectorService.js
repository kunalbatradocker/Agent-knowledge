/**
 * Data Connector Service
 * Multi-source data ingestion framework for CSV, JSON, SQL, and APIs
 * Enterprise-grade data integration comparable to Palantir/C3 AI
 */

const neo4jService = require('./neo4jService');
const lineageService = require('./lineageService');
const driver = require('../config/neo4j');
const neo4j = require('neo4j-driver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

class DataConnectorService {
  constructor() {
    this.connectors = new Map();
    this.syncJobs = new Map();
    
    // Supported connector types
    this.connectorTypes = {
      CSV: 'csv',
      JSON: 'json',
      EXCEL: 'excel',
      POSTGRESQL: 'postgresql',
      MYSQL: 'mysql',
      REST_API: 'rest_api',
      WEBHOOK: 'webhook'
    };
  }

  /**
   * Register a new data connector
   */
  async registerConnector(config) {
    const connectorId = config.id || uuidv4();
    
    const connector = {
      id: connectorId,
      name: config.name,
      type: config.type,
      config: config.connectionConfig || {},
      mapping: config.mapping || {},
      schedule: config.schedule || null,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastSync: null,
      syncCount: 0,
      errorCount: 0
    };

    // Validate connector config
    this.validateConnectorConfig(connector);
    
    // Store connector
    this.connectors.set(connectorId, connector);
    await this.persistConnector(connector);

    return connector;
  }

  /**
   * Validate connector configuration
   */
  validateConnectorConfig(connector) {
    const requiredFields = {
      csv: ['filePath'],
      json: ['filePath', 'rootPath'],
      excel: ['filePath', 'sheetName'],
      postgresql: ['host', 'port', 'database', 'user'],
      mysql: ['host', 'port', 'database', 'user'],
      rest_api: ['baseUrl', 'endpoint'],
      webhook: ['secret']
    };

    const required = requiredFields[connector.type] || [];
    const missing = required.filter(f => !connector.config[f]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required config fields for ${connector.type}: ${missing.join(', ')}`);
    }

    // Validate mapping
    if (!connector.mapping.entityType) {
      throw new Error('Mapping must specify entityType');
    }
  }

  /**
   * Parse CSV file and import to graph
   */
  async importCSV(connectorId, options = {}) {
    const connector = this.connectors.get(connectorId);
    if (!connector || connector.type !== 'csv') {
      throw new Error('Invalid CSV connector');
    }

    const { filePath } = connector.config;
    const { mapping } = connector;
    const { dryRun = false, batchSize = 100 } = options;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const rows = this.parseCSV(content);
      
      if (rows.length === 0) {
        return { success: true, imported: 0, message: 'No data to import' };
      }

      const headers = rows[0];
      const dataRows = rows.slice(1);
      
      const results = {
        total: dataRows.length,
        imported: 0,
        skipped: 0,
        errors: [],
        entities: []
      };

      // Process in batches
      for (let i = 0; i < dataRows.length; i += batchSize) {
        const batch = dataRows.slice(i, i + batchSize);
        
        for (const row of batch) {
          try {
            const entity = this.mapRowToEntity(headers, row, mapping);
            
            if (dryRun) {
              results.entities.push(entity);
              results.imported++;
            } else {
              await this.createEntityFromData(entity, {
                sourceConnector: connectorId,
                sourceType: 'csv',
                sourceFile: filePath,
                rowIndex: i + batch.indexOf(row) + 1
              });
              results.imported++;
            }
          } catch (error) {
            results.errors.push({
              row: i + batch.indexOf(row) + 1,
              error: error.message
            });
            results.skipped++;
          }
        }
      }

      // Update connector stats
      connector.lastSync = new Date().toISOString();
      connector.syncCount++;
      await this.persistConnector(connector);

      return results;
    } catch (error) {
      connector.errorCount++;
      await this.persistConnector(connector);
      throw error;
    }
  }

  /**
   * Parse CSV content into rows
   */
  parseCSV(content, delimiter = ',') {
    const rows = [];
    const lines = content.split(/\r?\n/);
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const row = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === delimiter && !inQuotes) {
          row.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      row.push(current.trim());
      rows.push(row);
    }
    
    return rows;
  }

  /**
   * Map a data row to an entity object
   */
  mapRowToEntity(headers, row, mapping) {
    const entity = {
      type: mapping.entityType,
      properties: {}
    };

    // Apply field mappings
    for (const [targetField, sourceConfig] of Object.entries(mapping.fields || {})) {
      let value;
      
      if (typeof sourceConfig === 'string') {
        // Simple column name mapping
        const colIndex = headers.indexOf(sourceConfig);
        value = colIndex >= 0 ? row[colIndex] : null;
      } else if (typeof sourceConfig === 'object') {
        // Complex mapping with transformations
        const colIndex = headers.indexOf(sourceConfig.column);
        value = colIndex >= 0 ? row[colIndex] : sourceConfig.default;
        
        // Apply transformations
        if (value && sourceConfig.transform) {
          value = this.applyTransform(value, sourceConfig.transform);
        }
      }
      
      if (value !== null && value !== undefined && value !== '') {
        if (targetField === 'label') {
          entity.label = value;
        } else {
          entity.properties[targetField] = value;
        }
      }
    }

    // Generate label if not mapped
    if (!entity.label && mapping.labelTemplate) {
      entity.label = this.applyTemplate(mapping.labelTemplate, entity.properties, headers, row);
    }

    // Generate URI
    entity.uri = mapping.uriTemplate 
      ? this.applyTemplate(mapping.uriTemplate, entity.properties, headers, row)
      : `data://${mapping.entityType.toLowerCase()}/${uuidv4()}`;

    return entity;
  }

  /**
   * Apply transformation to a value
   */
  applyTransform(value, transform) {
    switch (transform) {
      case 'uppercase':
        return String(value).toUpperCase();
      case 'lowercase':
        return String(value).toLowerCase();
      case 'trim':
        return String(value).trim();
      case 'number':
        return parseFloat(value) || 0;
      case 'integer':
        return parseInt(value, 10) || 0;
      case 'boolean':
        return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
      case 'date':
        return new Date(value).toISOString();
      case 'capitalize':
        return String(value).charAt(0).toUpperCase() + String(value).slice(1).toLowerCase();
      default:
        return value;
    }
  }

  /**
   * Apply template string with values
   */
  applyTemplate(template, properties, headers = [], row = []) {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      if (properties[key] !== undefined) {
        return properties[key];
      }
      const colIndex = headers.indexOf(key);
      if (colIndex >= 0 && row[colIndex]) {
        return row[colIndex];
      }
      return match;
    });
  }

  /**
   * Import JSON data to graph
   */
  async importJSON(connectorId, options = {}) {
    const connector = this.connectors.get(connectorId);
    if (!connector || connector.type !== 'json') {
      throw new Error('Invalid JSON connector');
    }

    const { filePath, rootPath } = connector.config;
    const { mapping } = connector;
    const { dryRun = false } = options;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      // Navigate to root path if specified
      let items = data;
      if (rootPath) {
        items = this.getNestedValue(data, rootPath);
      }
      
      if (!Array.isArray(items)) {
        items = [items];
      }

      const results = {
        total: items.length,
        imported: 0,
        skipped: 0,
        errors: [],
        entities: []
      };

      for (let i = 0; i < items.length; i++) {
        try {
          const entity = this.mapJSONToEntity(items[i], mapping);
          
          if (dryRun) {
            results.entities.push(entity);
            results.imported++;
          } else {
            await this.createEntityFromData(entity, {
              sourceConnector: connectorId,
              sourceType: 'json',
              sourceFile: filePath,
              itemIndex: i
            });
            results.imported++;
          }
        } catch (error) {
          results.errors.push({ index: i, error: error.message });
          results.skipped++;
        }
      }

      connector.lastSync = new Date().toISOString();
      connector.syncCount++;
      await this.persistConnector(connector);

      return results;
    } catch (error) {
      connector.errorCount++;
      await this.persistConnector(connector);
      throw error;
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }

  /**
   * Map JSON object to entity
   */
  mapJSONToEntity(item, mapping) {
    const entity = {
      type: mapping.entityType,
      properties: {}
    };

    for (const [targetField, sourcePath] of Object.entries(mapping.fields || {})) {
      let value;
      
      if (typeof sourcePath === 'string') {
        value = this.getNestedValue(item, sourcePath);
      } else if (typeof sourcePath === 'object') {
        value = this.getNestedValue(item, sourcePath.path);
        if (value && sourcePath.transform) {
          value = this.applyTransform(value, sourcePath.transform);
        }
        if (value === null || value === undefined) {
          value = sourcePath.default;
        }
      }
      
      if (value !== null && value !== undefined) {
        if (targetField === 'label') {
          entity.label = value;
        } else {
          entity.properties[targetField] = value;
        }
      }
    }

    // Generate URI
    entity.uri = mapping.uriTemplate 
      ? this.applyJSONTemplate(mapping.uriTemplate, item, entity.properties)
      : `data://${mapping.entityType.toLowerCase()}/${uuidv4()}`;

    return entity;
  }

  /**
   * Apply template with JSON values
   */
  applyJSONTemplate(template, item, properties) {
    return template.replace(/\{([^}]+)\}/g, (match, path) => {
      const value = this.getNestedValue(item, path) || properties[path];
      return value !== undefined ? value : match;
    });
  }

  /**
   * Create entity in Neo4j from mapped data
   */
  async createEntityFromData(entity, lineageInfo) {
    const session = neo4jService.getSession();
    
    try {
      const sanitizedType = neo4jService.sanitizeLabelName(entity.type);
      
      // Build properties object
      const props = {
        uri: entity.uri,
        label: entity.label || entity.properties.name || 'Unnamed',
        type: sanitizedType,
        created_at: new Date().toISOString(),
        source_connector: lineageInfo.sourceConnector,
        source_type: lineageInfo.sourceType,
        ...entity.properties
      };

      // Create node with dynamic label
      const query = `
        MERGE (e:\`${sanitizedType}\` {uri: $uri})
        ON CREATE SET e = $props
        ON MATCH SET e += $props, e.updated_at = datetime()
        RETURN e
      `;

      const result = await session.run(query, { uri: entity.uri, props });
      
      // Record lineage
      if (lineageInfo) {
        await lineageService.recordProvenance({
          entityUri: entity.uri,
          sourceType: lineageInfo.sourceType,
          sourceId: lineageInfo.sourceConnector,
          sourceFile: lineageInfo.sourceFile,
          sourceLocation: lineageInfo.rowIndex || lineageInfo.itemIndex,
          extractedAt: new Date().toISOString(),
          confidence: 1.0 // Direct import = high confidence
        });
      }

      return result.records[0]?.get('e').properties;
    } finally {
      await session.close();
    }
  }

  /**
   * Create relationships from data
   */
  async createRelationshipsFromData(relationships, connectorId) {
    const session = neo4jService.getSession();
    const results = { created: 0, errors: [] };

    try {
      for (const rel of relationships) {
        try {
          const query = `
            MATCH (source {uri: $sourceUri})
            MATCH (target {uri: $targetUri})
            MERGE (source)-[r:\`${rel.type || 'RELATED_TO'}\`]->(target)
            SET r.predicate = $predicate,
                r.source_connector = $connectorId,
                r.created_at = datetime()
            RETURN r
          `;

          await session.run(query, {
            sourceUri: rel.sourceUri,
            targetUri: rel.targetUri,
            predicate: rel.predicate || rel.type,
            connectorId
          });
          
          results.created++;
        } catch (error) {
          results.errors.push({
            source: rel.sourceUri,
            target: rel.targetUri,
            error: error.message
          });
        }
      }

      return results;
    } finally {
      await session.close();
    }
  }

  /**
   * Persist connector configuration
   */
  async persistConnector(connector) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MERGE (c:DataConnector {id: $id})
        SET c.name = $name,
            c.type = $type,
            c.config = $config,
            c.mapping = $mapping,
            c.schedule = $schedule,
            c.status = $status,
            c.createdAt = $createdAt,
            c.lastSync = $lastSync,
            c.syncCount = $syncCount,
            c.errorCount = $errorCount
        RETURN c
      `;

      await session.run(query, {
        id: connector.id,
        name: connector.name,
        type: connector.type,
        config: JSON.stringify(connector.config),
        mapping: JSON.stringify(connector.mapping),
        schedule: connector.schedule,
        status: connector.status,
        createdAt: connector.createdAt,
        lastSync: connector.lastSync,
        syncCount: neo4j.int(connector.syncCount),
        errorCount: neo4j.int(connector.errorCount)
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Load all connectors from storage
   */
  async loadConnectors() {
    const session = neo4jService.getSession();
    
    try {
      const query = `MATCH (c:DataConnector) RETURN c`;
      const result = await session.run(query);
      
      for (const record of result.records) {
        const props = record.get('c').properties;
        const connector = {
          ...props,
          config: JSON.parse(props.config || '{}'),
          mapping: JSON.parse(props.mapping || '{}'),
          syncCount: neo4jService.toNumber(props.syncCount),
          errorCount: neo4jService.toNumber(props.errorCount)
        };
        this.connectors.set(connector.id, connector);
      }
      
      return Array.from(this.connectors.values());
    } finally {
      await session.close();
    }
  }

  /**
   * Get all registered connectors
   */
  getConnectors() {
    return Array.from(this.connectors.values());
  }

  /**
   * Get connector by ID
   */
  getConnector(id) {
    return this.connectors.get(id);
  }

  /**
   * Delete a connector
   */
  async deleteConnector(id) {
    const session = neo4jService.getSession();
    
    try {
      await session.run('MATCH (c:DataConnector {id: $id}) DELETE c', { id });
      this.connectors.delete(id);
      return { success: true };
    } finally {
      await session.close();
    }
  }

  /**
   * Test connector configuration
   */
  async testConnector(connectorId) {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      throw new Error('Connector not found');
    }

    try {
      switch (connector.type) {
        case 'csv':
        case 'json':
        case 'excel':
          await fs.access(connector.config.filePath);
          return { success: true, message: 'File accessible' };
          
        case 'postgresql':
        case 'mysql':
          // Would need actual DB client to test
          return { success: true, message: 'Configuration valid (connection test requires DB client)' };
          
        case 'rest_api':
          // Would need fetch to test
          return { success: true, message: 'Configuration valid (connection test requires HTTP client)' };
          
        default:
          return { success: false, message: 'Unknown connector type' };
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

module.exports = new DataConnectorService();
