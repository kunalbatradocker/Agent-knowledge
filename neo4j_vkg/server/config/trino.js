/**
 * Trino Configuration & Client
 * Manages connection to Trino coordinator for federated SQL execution.
 * Uses Trino REST API (/v1/statement) for query submission and polling.
 */

const logger = require('../utils/logger');

class TrinoClient {
  constructor() {
    this.baseUrl = process.env.TRINO_URL || 'http://localhost:8080';
    this.user = process.env.TRINO_USER || 'trino';
    this.maxPollAttempts = 120;
    this.pollIntervalMs = 500;
  }

  /**
   * Check if Trino coordinator is reachable
   */
  async checkConnection() {
    try {
      const res = await fetch(`${this.baseUrl}/v1/info`, {
        headers: { 'X-Trino-User': this.user }
      });
      if (!res.ok) throw new Error(`Trino returned ${res.status}`);
      const info = await res.json();
      const version = typeof info.nodeVersion === 'string' ? info.nodeVersion : (info.nodeVersion?.version || JSON.stringify(info.nodeVersion));
      const uptime = typeof info.uptime === 'string' ? info.uptime : (info.uptime?.toString?.() || JSON.stringify(info.uptime));
      return { connected: true, version, uptime };
    } catch (err) {
      logger.warn(`Trino connection check failed: ${err.message}`);
      return { connected: false, error: err.message };
    }
  }

  /**
   * Execute a SQL query on Trino and return all results.
   * Uses the Trino REST API polling pattern:
   *   1. POST /v1/statement → get nextUri
   *   2. GET nextUri repeatedly until data or error
   */
  async executeSQL(sql, catalog = null, schema = null) {
    const startTime = Date.now();
    const headers = {
      'X-Trino-User': this.user,
      'Content-Type': 'text/plain'
    };
    if (catalog) headers['X-Trino-Catalog'] = catalog;
    if (schema) headers['X-Trino-Schema'] = schema;

    // Submit query
    const submitRes = await fetch(`${this.baseUrl}/v1/statement`, {
      method: 'POST',
      headers,
      body: sql
    });

    if (!submitRes.ok) {
      const text = await submitRes.text();
      throw new Error(`Trino query submission failed (${submitRes.status}): ${text}`);
    }

    let result = await submitRes.json();
    const columns = [];
    const rows = [];

    // Poll for results
    let attempts = 0;
    while (result.nextUri && attempts < this.maxPollAttempts) {
      await this._sleep(this.pollIntervalMs);
      const pollRes = await fetch(result.nextUri, {
        headers: { 'X-Trino-User': this.user }
      });
      if (!pollRes.ok) {
        const text = await pollRes.text();
        throw new Error(`Trino poll failed (${pollRes.status}): ${text}`);
      }
      result = await pollRes.json();

      // Capture columns on first appearance
      if (result.columns && columns.length === 0) {
        columns.push(...result.columns.map(c => ({ name: c.name, type: c.type })));
      }

      // Accumulate data rows
      if (result.data) {
        rows.push(...result.data);
      }

      // Check for error
      if (result.error) {
        throw new Error(`Trino query error: ${result.error.message} (code: ${result.error.errorCode})`);
      }

      attempts++;
    }

    if (attempts >= this.maxPollAttempts) {
      throw new Error('Trino query timed out waiting for results');
    }

    const durationMs = Date.now() - startTime;
    return { columns, rows, rowCount: rows.length, durationMs, sql };
  }

  /**
   * Introspect a catalog: list all schemas
   */
  async listSchemas(catalog) {
    const result = await this.executeSQL(`SHOW SCHEMAS FROM "${catalog}"`);
    return result.rows.map(r => r[0]).filter(s => s !== 'information_schema');
  }

  /**
   * Introspect a catalog.schema: list all tables
   */
  async listTables(catalog, schema) {
    const result = await this.executeSQL(`SHOW TABLES FROM "${catalog}"."${schema}"`);
    return result.rows.map(r => r[0]);
  }

  /**
   * Describe a table: get columns with types
   */
  async describeTable(catalog, schema, table) {
    const result = await this.executeSQL(`DESCRIBE "${catalog}"."${schema}"."${table}"`);
    return result.rows.map(r => ({
      name: r[0],
      type: r[1],
      extra: r[2] || '',
      comment: r[3] || ''
    }));
  }

  /**
   * Full schema introspection for a catalog.schema
   * Returns tables with columns, attempting to detect PKs and FKs from naming conventions
   */
  async introspectSchema(catalog, schema) {
      const tableNames = await this.listTables(catalog, schema);

      // Describe all tables in PARALLEL (was sequential)
      const tableResults = await Promise.all(
        tableNames.map(async (tableName) => {
          const columns = await this.describeTable(catalog, schema, tableName);
          return {
            catalog,
            schema,
            name: tableName,
            fullName: `${catalog}.${schema}.${tableName}`,
            columns: columns.map(c => ({
              name: c.name,
              type: c.type,
              isPrimaryKey: c.name === 'id' || c.name.endsWith('_id') && c.name === `${tableName.replace(/s$/, '')}_id`,
              isForeignKey: c.name.endsWith('_id') && c.name !== `${tableName.replace(/s$/, '')}_id`
            }))
          };
        })
      );

      // Infer relationships from FK naming conventions
      const relationships = [];
      for (const table of tableResults) {
        for (const col of table.columns) {
          if (col.isForeignKey) {
            const refTableName = col.name.replace(/_id$/, '') + 's';
            const refTable = tableResults.find(t => t.name === refTableName) ||
                             tableResults.find(t => t.name === col.name.replace(/_id$/, ''));
            if (refTable) {
              relationships.push({
                fromTable: table.fullName,
                fromColumn: col.name,
                toTable: refTable.fullName,
                toColumn: col.name,
                type: 'foreign_key'
              });
            }
          }
        }
      }

      return { catalog, schema, tables: tableResults, relationships, introspectedAt: new Date().toISOString() };
    }


  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
const trinoClient = new TrinoClient();
module.exports = trinoClient;
