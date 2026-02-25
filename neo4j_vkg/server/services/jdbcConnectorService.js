/**
 * External JDBC Database Connector Service
 * Connects to external databases (PostgreSQL, MySQL, etc.) and imports data
 */

const logger = require('../utils/logger');

class JDBCConnectorService {
  constructor() {
    this.connections = new Map();
    this.drivers = {
      postgresql: { port: 5432, module: 'pg' },
      mysql: { port: 3306, module: 'mysql2' },
      mariadb: { port: 3306, module: 'mysql2' },
      mssql: { port: 1433, module: 'mssql' },
      sqlite: { port: null, module: 'better-sqlite3' }
    };
  }

  async testConnection(params) {
    const { type, host, port, database, username, password, filePath } = params;
    
    try {
      const driver = this.drivers[type];
      if (!driver) throw new Error(`Unsupported database type: ${type}`);

      let client;
      
      if (type === 'postgresql') {
        const { Pool } = require('pg');
        client = new Pool({ host, port: port || 5432, database, user: username, password, max: 1 });
        const res = await client.query('SELECT version()');
        await client.end();
        return { success: true, version: res.rows[0].version, type };
      }
      
      if (type === 'mysql' || type === 'mariadb') {
        const mysql = require('mysql2/promise');
        client = await mysql.createConnection({ host, port: port || 3306, database, user: username, password });
        const [rows] = await client.query('SELECT VERSION() as version');
        await client.end();
        return { success: true, version: rows[0].version, type };
      }

      if (type === 'sqlite') {
        const Database = require('better-sqlite3');
        client = new Database(filePath || database, { readonly: true });
        const version = client.prepare('SELECT sqlite_version()').get();
        client.close();
        return { success: true, version: version['sqlite_version()'], type };
      }

      throw new Error(`Driver not implemented for: ${type}`);
    } catch (error) {
      logger.error(`Connection test failed for ${type}:`, error.message);
      return { success: false, error: error.message, type };
    }
  }

  async connect(connectionId, params) {
    const { type, host, port, database, username, password, filePath } = params;
    
    try {
      let client;
      
      if (type === 'postgresql') {
        const { Pool } = require('pg');
        client = new Pool({ host, port: port || 5432, database, user: username, password });
      } else if (type === 'mysql' || type === 'mariadb') {
        const mysql = require('mysql2/promise');
        client = await mysql.createPool({ host, port: port || 3306, database, user: username, password });
      } else if (type === 'sqlite') {
        const Database = require('better-sqlite3');
        client = new Database(filePath || database);
      } else {
        throw new Error(`Unsupported type: ${type}`);
      }

      this.connections.set(connectionId, { client, type, params });
      return { connectionId, status: 'connected' };
    } catch (error) {
      throw new Error(`Connection failed: ${error.message}`);
    }
  }

  async disconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    try {
      if (conn.type === 'postgresql') await conn.client.end();
      else if (conn.type === 'mysql' || conn.type === 'mariadb') await conn.client.end();
      else if (conn.type === 'sqlite') conn.client.close();
    } catch (e) {
      logger.warn(`Error closing connection ${connectionId}:`, e.message);
    }
    
    this.connections.delete(connectionId);
  }

  async analyzeSchema(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    const { client, type } = conn;
    const tables = [];

    if (type === 'postgresql') {
      const tablesRes = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      
      for (const row of tablesRes.rows) {
        const tableName = row.table_name;
        const columnsRes = await client.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns WHERE table_name = $1
        `, [tableName]);
        
        const pkRes = await client.query(`
          SELECT a.attname FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary
        `, [tableName]);
        
        const fkRes = await client.query(`
          SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
        `, [tableName]);

        tables.push({
          name: tableName,
          columns: columnsRes.rows.map(c => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === 'YES',
            primaryKey: pkRes.rows.some(pk => pk.attname === c.column_name)
          })),
          primaryKey: pkRes.rows.map(pk => pk.attname),
          foreignKeys: fkRes.rows.map(fk => ({
            column: fk.column_name,
            referencedTable: fk.foreign_table,
            referencedColumn: fk.foreign_column
          }))
        });
      }
    } else if (type === 'mysql' || type === 'mariadb') {
      const [tablesRes] = await client.query('SHOW TABLES');
      const tableKey = Object.keys(tablesRes[0] || {})[0];
      
      for (const row of tablesRes) {
        const tableName = row[tableKey];
        const [columnsRes] = await client.query(`DESCRIBE \`${tableName}\``);
        const [fkRes] = await client.query(`
          SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        `, [tableName]);

        tables.push({
          name: tableName,
          columns: columnsRes.map(c => ({
            name: c.Field,
            type: c.Type,
            nullable: c.Null === 'YES',
            primaryKey: c.Key === 'PRI'
          })),
          primaryKey: columnsRes.filter(c => c.Key === 'PRI').map(c => c.Field),
          foreignKeys: fkRes.map(fk => ({
            column: fk.COLUMN_NAME,
            referencedTable: fk.REFERENCED_TABLE_NAME,
            referencedColumn: fk.REFERENCED_COLUMN_NAME
          }))
        });
      }
    } else if (type === 'sqlite') {
      const tablesRes = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      
      for (const row of tablesRes) {
        const tableName = row.name;
        const columnsRes = client.prepare(`PRAGMA table_info("${tableName}")`).all();
        const fkRes = client.prepare(`PRAGMA foreign_key_list("${tableName}")`).all();

        tables.push({
          name: tableName,
          columns: columnsRes.map(c => ({
            name: c.name,
            type: c.type,
            nullable: c.notnull === 0,
            primaryKey: c.pk === 1
          })),
          primaryKey: columnsRes.filter(c => c.pk === 1).map(c => c.name),
          foreignKeys: fkRes.map(fk => ({
            column: fk.from,
            referencedTable: fk.table,
            referencedColumn: fk.to
          }))
        });
      }
    }

    // Detect relationships
    const relationships = [];
    for (const table of tables) {
      for (const fk of table.foreignKeys) {
        const isManyToMany = table.primaryKey.length > 1 && 
          table.primaryKey.every(pk => table.foreignKeys.some(f => f.column === pk));
        
        relationships.push({
          type: isManyToMany ? 'many_to_many' : 'one_to_many',
          fromTable: table.name,
          toTable: fk.referencedTable,
          foreignKey: fk.column,
          throughTable: isManyToMany ? table.name : null
        });
      }
    }

    return { tables, relationships, analyzedAt: new Date().toISOString() };
  }

  async importData(connectionId, tableName, options = {}) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    const { client, type } = conn;
    const { limit = 1000, offset = 0 } = options;
    let rows = [];

    if (type === 'postgresql') {
      const res = await client.query(`SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`, [limit, offset]);
      rows = res.rows;
    } else if (type === 'mysql' || type === 'mariadb') {
      const [res] = await client.query(`SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`, [limit, offset]);
      rows = res;
    } else if (type === 'sqlite') {
      rows = client.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(limit, offset);
    }

    return rows;
  }

  async importToKnowledgeGraph(connectionId, schema, ontologyMapping, graphDBStore, tenantId, workspaceId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    let totalImported = 0;
    const batchSize = 500;

    for (const tableMapping of ontologyMapping.tables) {
      const { tableName, classUri, propertyMappings } = tableMapping;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const rows = await this.importData(connectionId, tableName, { limit: batchSize, offset });
        if (rows.length === 0) {
          hasMore = false;
          break;
        }

        const triples = [];
        for (const row of rows) {
          const pkValue = schema.tables.find(t => t.name === tableName)?.primaryKey
            .map(pk => row[pk]).join('_') || offset;
          const entityUri = `http://purplefabric.ai/data/${tableName}/${encodeURIComponent(pkValue)}`;

          triples.push(`<${entityUri}> a <${classUri}> .`);

          for (const propMap of propertyMappings) {
            const value = row[propMap.column];
            if (value !== null && value !== undefined) {
              if (propMap.isObjectProperty && propMap.targetClass) {
                const targetUri = `http://purplefabric.ai/data/${propMap.targetTable}/${encodeURIComponent(value)}`;
                triples.push(`<${entityUri}> <${propMap.propertyUri}> <${targetUri}> .`);
              } else {
                const escaped = String(value).replace(/"/g, '\\"').replace(/\n/g, '\\n');
                triples.push(`<${entityUri}> <${propMap.propertyUri}> "${escaped}" .`);
              }
            }
          }
        }

        if (triples.length > 0) {
          const turtle = triples.join('\n');
          await graphDBStore.importTurtle(tenantId, workspaceId, turtle, null, 'data');
          totalImported += rows.length;
        }

        offset += batchSize;
        hasMore = rows.length === batchSize;
      }
    }

    return { imported: totalImported };
  }
}

module.exports = new JDBCConnectorService();
