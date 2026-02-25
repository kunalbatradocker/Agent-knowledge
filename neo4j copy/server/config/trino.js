/**
 * Trino Configuration & Client
 * Supports per-workspace Trino connections stored in Redis.
 * Falls back to env-configured default if no workspace config exists.
 *
 * Auth methods supported:
 *   - none:     X-Trino-User header only (default, no TLS required)
 *   - password: HTTP Basic Auth (username:password) — requires HTTPS on Trino
 *   - jwt:      Bearer token in Authorization header
 */

const https = require('https');
const logger = require('../utils/logger');

const REDIS_PREFIX = 'vkg:trino-config';

class TrinoClient {
  /**
   * @param {Object} config
   * @param {string} config.url        - Trino coordinator URL (http:// or https://)
   * @param {string} config.user       - Trino user (sent as X-Trino-User)
   * @param {string} config.authType   - 'none' | 'password' | 'jwt'
   * @param {string} [config.password] - For authType=password
   * @param {string} [config.jwtToken] - For authType=jwt
   * @param {boolean} [config.tlsSkipVerify] - Skip TLS certificate verification
   */
  constructor(config = {}) {
    this.baseUrl = config.url || process.env.TRINO_URL || 'http://localhost:8080';
    this.user = config.user || process.env.TRINO_USER || 'trino';
    this.authType = config.authType || 'none';
    this.password = config.password || '';
    this.jwtToken = config.jwtToken || '';
    this.tlsSkipVerify = config.tlsSkipVerify || false;
    this.maxPollAttempts = 120;
    this.pollIntervalMs = 500;

    // Build a custom fetch agent for TLS skip if needed
    this._agent = null;
    if (this.tlsSkipVerify && this.baseUrl.startsWith('https')) {
      this._agent = new https.Agent({ rejectUnauthorized: false });
    }
  }

  /** Build auth headers based on authType */
  _authHeaders() {
    const headers = { 'X-Trino-User': this.user };
    if (this.authType === 'password' && this.password) {
      const encoded = Buffer.from(`${this.user}:${this.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    } else if (this.authType === 'jwt' && this.jwtToken) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }
    return headers;
  }

  /** Wrapper around fetch that injects auth + TLS agent */
  async _fetch(url, options = {}) {
    const fetchOptions = {
      ...options,
      headers: { ...this._authHeaders(), ...options.headers },
    };
    if (this._agent) {
      fetchOptions.dispatcher = this._agent;
    }
    return fetch(url, fetchOptions);
  }

  async checkConnection() {
    try {
      const res = await this._fetch(`${this.baseUrl}/v1/info`);
      if (!res.ok) throw new Error(`Trino returned ${res.status}`);
      const info = await res.json();
      const version = typeof info.nodeVersion === 'string'
        ? info.nodeVersion
        : (info.nodeVersion?.version || JSON.stringify(info.nodeVersion));
      const uptime = typeof info.uptime === 'string'
        ? info.uptime
        : (info.uptime?.toString?.() || JSON.stringify(info.uptime));
      return { connected: true, version, uptime, url: this.baseUrl };
    } catch (err) {
      logger.warn(`Trino connection check failed (${this.baseUrl}): ${err.message}`);
      return { connected: false, error: err.message, url: this.baseUrl };
    }
  }

  async executeSQL(sql, catalog = null, schema = null) {
    const startTime = Date.now();
    const headers = { 'Content-Type': 'text/plain' };
    if (catalog) headers['X-Trino-Catalog'] = catalog;
    if (schema) headers['X-Trino-Schema'] = schema;

    const submitRes = await this._fetch(`${this.baseUrl}/v1/statement`, {
      method: 'POST', headers, body: sql
    });
    if (!submitRes.ok) {
      const text = await submitRes.text();
      throw new Error(`Trino query submission failed (${submitRes.status}): ${text}`);
    }

    let result = await submitRes.json();
    const columns = [];
    const rows = [];

    let attempts = 0;
    while (result.nextUri && attempts < this.maxPollAttempts) {
      await this._sleep(this.pollIntervalMs);
      const pollRes = await this._fetch(result.nextUri);
      if (!pollRes.ok) {
        const text = await pollRes.text();
        throw new Error(`Trino poll failed (${pollRes.status}): ${text}`);
      }
      result = await pollRes.json();

      if (result.columns && columns.length === 0) {
        columns.push(...result.columns.map(c => ({ name: c.name, type: c.type })));
      }
      if (result.data) rows.push(...result.data);
      if (result.error) {
        throw new Error(`Trino query error: ${result.error.message} (code: ${result.error.errorCode})`);
      }
      attempts++;
    }

    if (attempts >= this.maxPollAttempts) {
      throw new Error('Trino query timed out waiting for results');
    }

    return { columns, rows, rowCount: rows.length, durationMs: Date.now() - startTime, sql };
  }

  async listSchemas(catalog) {
    const result = await this.executeSQL(`SHOW SCHEMAS FROM "${catalog}"`);
    return result.rows.map(r => r[0]).filter(s => s !== 'information_schema');
  }

  async listTables(catalog, schema) {
    const result = await this.executeSQL(`SHOW TABLES FROM "${catalog}"."${schema}"`);
    return result.rows.map(r => r[0]);
  }

  async describeTable(catalog, schema, table) {
    const result = await this.executeSQL(`DESCRIBE "${catalog}"."${schema}"."${table}"`);
    return result.rows.map(r => ({ name: r[0], type: r[1], extra: r[2] || '', comment: r[3] || '' }));
  }

  async introspectSchema(catalog, schema) {
    const tableNames = await this.listTables(catalog, schema);
    const tableResults = await Promise.all(
      tableNames.map(async (tableName) => {
        const columns = await this.describeTable(catalog, schema, tableName);
        return {
          catalog, schema, name: tableName,
          fullName: `${catalog}.${schema}.${tableName}`,
          columns: columns.map(c => ({
            name: c.name, type: c.type,
            isPrimaryKey: c.name === 'id' || (c.name.endsWith('_id') && c.name === `${tableName.replace(/s$/, '')}_id`),
            isForeignKey: c.name.endsWith('_id') && c.name !== `${tableName.replace(/s$/, '')}_id`
          }))
        };
      })
    );

    const relationships = [];
    for (const table of tableResults) {
      for (const col of table.columns) {
        if (col.isForeignKey) {
          const refTableName = col.name.replace(/_id$/, '') + 's';
          const refTable = tableResults.find(t => t.name === refTableName) ||
                           tableResults.find(t => t.name === col.name.replace(/_id$/, ''));
          if (refTable) {
            relationships.push({
              fromTable: table.fullName, fromColumn: col.name,
              toTable: refTable.fullName, toColumn: col.name, type: 'foreign_key'
            });
          }
        }
      }
    }
    return { catalog, schema, tables: tableResults, relationships, introspectedAt: new Date().toISOString() };
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

/**
 * TrinoConnectionManager
 * Per-workspace Trino connections with Redis persistence.
 * Sensitive fields (password, jwtToken) are stored in Redis — not logged.
 */
class TrinoConnectionManager {
  constructor() {
    this._clients = new Map();
    this._defaultConfig = {
      url: process.env.TRINO_URL || 'http://localhost:8080',
      user: process.env.TRINO_USER || 'trino',
      authType: 'none',
    };
  }

  async getClient(workspaceId) {
    const wsKey = workspaceId || 'default';
    if (this._clients.has(wsKey)) {
      return this._clients.get(wsKey);
    }
    // Check Redis for workspace-specific config first
    try {
      const redisService = require('../services/redisService');
      const raw = await redisService.get(`${REDIS_PREFIX}:${wsKey}`);
      if (raw) {
        const config = JSON.parse(raw);
        if (config.url) {
          return this._getOrCreateClient(wsKey, config);
        }
      }
    } catch (e) {
      logger.warn(`Failed to load Trino config for workspace ${wsKey}: ${e.message}`);
    }
    // Fall back to env default
    return this._getOrCreateClient(wsKey, this._defaultConfig);
  }

  async setConnection(workspaceId, config) {
    const wsKey = workspaceId || 'default';
    const redisService = require('../services/redisService');
    const stored = {
      url: config.url,
      user: config.user || 'trino',
      authType: config.authType || 'none',
      password: config.password || '',
      jwtToken: config.jwtToken || '',
      tlsSkipVerify: config.tlsSkipVerify || false,
      updatedAt: new Date().toISOString()
    };
    await redisService.set(`${REDIS_PREFIX}:${wsKey}`, JSON.stringify(stored));
    this._clients.delete(wsKey);
    logger.info(`🔗 Trino connection saved for workspace ${wsKey}: ${stored.url} (auth: ${stored.authType})`);
    return { url: stored.url, user: stored.user, authType: stored.authType, tlsSkipVerify: stored.tlsSkipVerify, source: 'workspace' };
  }

  async getConnection(workspaceId) {
    const wsKey = workspaceId || 'default';
    try {
      const redisService = require('../services/redisService');
      const raw = await redisService.get(`${REDIS_PREFIX}:${wsKey}`);
      if (raw) {
        const config = JSON.parse(raw);
        return {
          url: config.url,
          user: config.user,
          authType: config.authType || 'none',
          tlsSkipVerify: config.tlsSkipVerify || false,
          hasPassword: !!config.password,
          hasJwtToken: !!config.jwtToken,
          source: 'workspace',
          updatedAt: config.updatedAt
        };
      }
    } catch (e) {
      logger.warn(`Failed to read Trino config for workspace ${wsKey}: ${e.message}`);
    }
    // No workspace config — return env default with source:'env'
    return { ...this._defaultConfig, source: 'env' };
  }

  async removeConnection(workspaceId) {
    const wsKey = workspaceId || 'default';
    const redisService = require('../services/redisService');
    await redisService.del(`${REDIS_PREFIX}:${wsKey}`);
    this._clients.delete(wsKey);
    logger.info(`🔗 Trino connection removed for workspace ${wsKey}`);
  }

  async testConnection(config) {
    const client = new TrinoClient(config);
    return client.checkConnection();
  }

  _getOrCreateClient(key, config) {
    if (!this._clients.has(key)) {
      this._clients.set(key, new TrinoClient(config));
    }
    return this._clients.get(key);
  }
}

const trinoManager = new TrinoConnectionManager();
const defaultClient = new TrinoClient({
  url: process.env.TRINO_URL || 'http://localhost:8080',
  user: process.env.TRINO_USER || 'trino'
});

module.exports = trinoManager;
module.exports.defaultClient = defaultClient;
module.exports.TrinoClient = TrinoClient;
