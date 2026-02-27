/**
 * Trino Catalog Service
 * Manages dynamic registration of external databases as Trino catalogs.
 * Each catalog maps to one external database, namespaced per tenant.
 */

const fs = require('fs');
const path = require('path');
const trinoManager = require('../config/trino');
const redisService = require('./redisService');
const logger = require('../utils/logger');

const CATALOG_PATH = process.env.TRINO_CATALOG_PATH && process.env.TRINO_CATALOG_PATH !== '/etc/trino/catalog'
  ? process.env.TRINO_CATALOG_PATH
  : path.join(__dirname, '../../trino/catalog');
const REDIS_PREFIX = 'vkg:catalogs';

// Supported Trino connector types and their .properties templates
const CONNECTOR_TEMPLATES = {
  postgresql: (cfg) => [
    'connector.name=postgresql',
    `connection-url=jdbc:postgresql://${cfg.host}:${cfg.port || 5432}/${cfg.database}`,
    `connection-user=${cfg.user}`,
    `connection-password=${cfg.password}`
  ],
  mysql: (cfg) => [
    'connector.name=mysql',
    `connection-url=jdbc:mysql://${cfg.host}:${cfg.port || 3306}`,
    `connection-user=${cfg.user}`,
    `connection-password=${cfg.password}`
  ],
  mariadb: (cfg) => [
    'connector.name=mariadb',
    `connection-url=jdbc:mariadb://${cfg.host}:${cfg.port || 3306}`,
    `connection-user=${cfg.user}`,
    `connection-password=${cfg.password}`
  ],
  sqlserver: (cfg) => [
    'connector.name=sqlserver',
    `connection-url=jdbc:sqlserver://${cfg.host}:${cfg.port || 1433};database=${cfg.database}`,
    `connection-user=${cfg.user}`,
    `connection-password=${cfg.password}`
  ],
  clickhouse: (cfg) => [
    'connector.name=clickhouse',
    `connection-url=jdbc:clickhouse://${cfg.host}:${cfg.port || 8123}/`,
    `connection-user=${cfg.user || 'default'}`,
    `connection-password=${cfg.password || ''}`
  ],
  oracle: (cfg) => [
    'connector.name=oracle',
    `connection-url=jdbc:oracle:thin:@${cfg.host}:${cfg.port || 1521}/${cfg.database}`,
    `connection-user=${cfg.user}`,
    `connection-password=${cfg.password}`
  ]
};

class TrinoCatalogService {
  constructor() {
    // Ensure catalog directory exists (non-fatal — catalog management is optional)
    try {
      if (!fs.existsSync(CATALOG_PATH)) {
        fs.mkdirSync(CATALOG_PATH, { recursive: true });
        logger.info(`📁 Created Trino catalog directory: ${CATALOG_PATH}`);
      }
    } catch (err) {
      logger.warn(`⚠️ Could not create Trino catalog directory (${CATALOG_PATH}): ${err.message}. Catalog file management will be unavailable.`);
    }
    logger.info('🔗 TrinoCatalogService initialized');
  }

  /**
   * Get the tenant-namespaced catalog name
   */
  _catalogName(tenantId, name) {
    return `t${tenantId}_${name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }

  _redisKey(tenantId, workspaceId) {
    const wsKey = workspaceId || 'default';
    return `${REDIS_PREFIX}:${tenantId}:${wsKey}`;
  }

  /**
   * Register a new external database as a Trino catalog
   */
  async registerCatalog(tenantId, config, workspaceId = null) {
    const { name, connector, host, port, database, schema, user, password } = config;

    if (!name || !connector || !host || !user) {
      throw new Error('Missing required fields: name, connector, host, user');
    }
    if (!CONNECTOR_TEMPLATES[connector]) {
      throw new Error(`Unsupported connector type: ${connector}. Supported: ${Object.keys(CONNECTOR_TEMPLATES).join(', ')}`);
    }

    const catalogName = this._catalogName(tenantId, name);
    const rKey = this._redisKey(tenantId, workspaceId);

    // Generate .properties content
    // If running in Docker, localhost won't work — use host.docker.internal
    const effectiveHost = (host === 'localhost' || host === '127.0.0.1') ? (process.env.TRINO_DOCKER_HOST || 'host.docker.internal') : host;
    const template = CONNECTOR_TEMPLATES[connector];
    const propsContent = template({ host: effectiveHost, port, database, user, password }).join('\n') + '\n';

    // Write catalog file
    const filePath = path.join(CATALOG_PATH, `${catalogName}.properties`);
    try {
      fs.writeFileSync(filePath, propsContent, 'utf8');
      logger.info(`📁 Wrote Trino catalog file: ${filePath}`);
    } catch (err) {
      logger.error(`Failed to write catalog file: ${err.message}`);
      throw new Error(`Failed to write catalog configuration: ${err.message}`);
    }

    // Store metadata in Redis
    const metadata = {
      name,
      catalogName,
      connector,
      host,
      port: port || this._defaultPort(connector),
      database: database || '',
      schema: schema || this._defaultSchema(connector),
      user,
      status: 'pending',
      registeredAt: new Date().toISOString()
    };

    const client = redisService;
    await client.hSet(rKey, catalogName, JSON.stringify(metadata));

    // Test connectivity (only if Trino is reachable)
    try {
      const trinoClient = await trinoManager.getClient(workspaceId);
      const trinoHealth = await trinoClient.checkConnection();
      if (trinoHealth.connected) {
        await this.testCatalog(tenantId, catalogName, workspaceId);
        metadata.status = 'active';
      } else {
        metadata.status = 'registered';
        metadata.error = 'Trino not running — catalog saved, will activate when Trino starts';
        logger.info(`Catalog ${catalogName} registered (Trino offline, will activate later)`);
      }
      await client.hSet(rKey, catalogName, JSON.stringify(metadata));
    } catch (err) {
      metadata.status = 'registered';
      metadata.error = err.message;
      await client.hSet(rKey, catalogName, JSON.stringify(metadata));
      logger.warn(`Catalog ${catalogName} registered but connectivity test failed: ${err.message}`);
    }

    return metadata;
  }

  /**
   * Remove a catalog
   */
  async removeCatalog(tenantId, catalogName, workspaceId = null) {
    // Resolve: check if it exists as-is in Redis, else try namespaced
    const catalogs = await this.listCatalogs(tenantId, workspaceId);
    const meta = catalogs.find(c => c.catalogName === catalogName);
    const fullName = meta ? meta.catalogName : (catalogName.startsWith('t') ? catalogName : this._catalogName(tenantId, catalogName));

    // Remove .properties file
    const filePath = path.join(CATALOG_PATH, `${fullName}.properties`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn(`Could not remove catalog file: ${err.message}`);
    }

    // Remove from Redis
    await redisService.hDel(this._redisKey(tenantId, workspaceId), fullName);

    return { removed: fullName };
  }

  /**
   * List all catalogs for a tenant
   */
  async listCatalogs(tenantId, workspaceId = null) {
    const rKey = this._redisKey(tenantId, workspaceId);
    let raw = await redisService.hGetAll(rKey);

    // If no catalogs found under workspace-specific key, also check 'default' keys
    // This handles catalogs registered before proper tenant/workspace was set up
    if (!raw || Object.keys(raw).length === 0) {
      const fallbackKeys = [];
      if (tenantId !== 'default' && workspaceId && workspaceId !== 'default') {
        fallbackKeys.push(this._redisKey('default', workspaceId));
        fallbackKeys.push(this._redisKey(tenantId, 'default'));
        fallbackKeys.push(this._redisKey('default', 'default'));
      } else if (tenantId !== 'default') {
        fallbackKeys.push(this._redisKey('default', workspaceId));
      } else if (workspaceId && workspaceId !== 'default') {
        fallbackKeys.push(this._redisKey(tenantId, 'default'));
      }
      for (const fk of fallbackKeys) {
        const fallbackRaw = await redisService.hGetAll(fk);
        if (fallbackRaw && Object.keys(fallbackRaw).length > 0) {
          logger.info(`[TrinoCatalog] listCatalogs: key=${rKey} empty, found catalogs at fallback key=${fk}`);
          raw = fallbackRaw;
          break;
        }
      }
    }

    if (!raw || Object.keys(raw).length === 0) {
      logger.info(`[TrinoCatalog] listCatalogs: key=${rKey} → empty (no fallbacks found)`);
      return [];
    }

    const catalogs = Object.entries(raw).map(([key, val]) => {
      try { return JSON.parse(val); } catch { return { catalogName: key, status: 'unknown' }; }
    });
    logger.info(`[TrinoCatalog] listCatalogs: key=${rKey} → ${catalogs.length} catalog(s): [${catalogs.map(c => c.catalogName).join(', ')}]`);
    return catalogs;
  }

  /**
   * Test catalog connectivity via Trino
   */
  async testCatalog(tenantId, catalogName, workspaceId = null) {
    // Resolve: check if catalogName exists as-is in Redis, else try namespaced
    const catalogs = await this.listCatalogs(tenantId, workspaceId);
    let meta = catalogs.find(c => c.catalogName === catalogName);
    const fullName = meta ? meta.catalogName : (catalogName.startsWith('t') ? catalogName : this._catalogName(tenantId, catalogName));
    const rKey = this._redisKey(tenantId, workspaceId);

    // Check if Trino is reachable first
    const trinoClient = await trinoManager.getClient(workspaceId);
    const health = await trinoClient.checkConnection();
    if (!health.connected) {
      return { success: false, catalogName: fullName, error: 'Trino coordinator is not running' };
    }

    try {
      const result = await trinoClient.executeSQL(`SELECT 1`, fullName);
      // Update status to active in Redis
      const raw = await redisService.hGet(rKey, fullName);
      if (raw) {
        try {
          const m = JSON.parse(raw);
          m.status = 'active';
          delete m.error;
          await redisService.hSet(rKey, fullName, JSON.stringify(m));
        } catch { /* ignore parse errors */ }
      }
      return { success: true, catalogName: fullName, latencyMs: result.durationMs };
    } catch (err) {
      throw new Error(`Catalog ${fullName} connectivity test failed: ${err.message}`);
    }
  }

  /**
   * Introspect a catalog's schema via Trino
   */
  async introspectCatalog(tenantId, catalogName, _preloadedCatalogs = null, workspaceId = null) {
      const catalogs = _preloadedCatalogs || await this.listCatalogs(tenantId, workspaceId);
      let meta = catalogs.find(c => c.catalogName === catalogName);
      let fullName = catalogName;

      if (!meta) {
        fullName = catalogName.startsWith('t') ? catalogName : this._catalogName(tenantId, catalogName);
        meta = catalogs.find(c => c.catalogName === fullName);
      } else {
        fullName = meta.catalogName;
      }

      const schemaName = meta?.schema || 'public';

      try {
        const trinoClient = await trinoManager.getClient(workspaceId);
        return await trinoClient.introspectSchema(fullName, schemaName);
      } catch (err) {
        if (err.message.includes('does not exist')) {
          throw new Error(`Catalog '${fullName}' is registered but not loaded in Trino. Trino needs a restart to pick up new catalog files. Original error: ${err.message}`);
        }
        throw err;
      }
    }


  /**
   * Introspect multiple catalogs at once (for ontology generation)
   */
  async introspectAllCatalogs(tenantId, workspaceId = null) {
      // Pre-check Trino health once (not per-catalog)
      const trinoClient = await trinoManager.getClient(workspaceId);
      const health = await trinoClient.checkConnection();
      if (!health.connected) {
        throw new Error('Trino coordinator is not running. Start Trino to introspect catalogs.');
      }

      // Load catalog list once from Redis
      const catalogs = await this.listCatalogs(tenantId, workspaceId);
      const eligibleCatalogs = catalogs.filter(c => c.status !== 'removed');

      if (eligibleCatalogs.length === 0) return [];

      // Introspect all catalogs in PARALLEL (was sequential)
      const results = await Promise.all(
        eligibleCatalogs.map(async (cat) => {
          try {
            return await this.introspectCatalog(tenantId, cat.catalogName, catalogs, workspaceId);
          } catch (err) {
            logger.warn(`Failed to introspect catalog ${cat.catalogName}: ${err.message}`);
            return { catalog: cat.catalogName, error: err.message, tables: [] };
          }
        })
      );

      return results;
    }


  _defaultPort(connector) {
    const ports = { postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, clickhouse: 8123, oracle: 1521 };
    return ports[connector] || 5432;
  }

  _defaultSchema(connector) {
    const schemas = { postgresql: 'public', mysql: '', mariadb: '', sqlserver: 'dbo', clickhouse: 'default', oracle: '' };
    return schemas[connector] || 'public';
  }

  /**
   * Discover pre-existing catalogs from Trino and sync them into Redis.
   * This handles catalogs created outside the app (e.g. via docker-compose).
   */
  async discoverCatalogs(tenantId, workspaceId = null) {
    logger.info(`[TrinoCatalog] discoverCatalogs: tenant=${tenantId}, workspace=${workspaceId}, redisKey=${this._redisKey(tenantId, workspaceId)}`);
    const trinoClient = await trinoManager.getClient(workspaceId);
    const health = await trinoClient.checkConnection();
    if (!health.connected) {
      throw new Error('Trino coordinator is not running');
    }

    // System/internal catalogs to skip
    const SKIP_CATALOGS = new Set(['system', 'jmx', 'memory', 'tpcds', 'tpch']);

    const result = await trinoClient.executeSQL('SHOW CATALOGS');
    const trinoCatalogs = result.rows.map(r => r[0]).filter(c => !SKIP_CATALOGS.has(c));

    const existing = await this.listCatalogs(tenantId, workspaceId);
    const existingNames = new Set(existing.map(c => c.catalogName));

    const discovered = [];
    for (const catName of trinoCatalogs) {
      if (existingNames.has(catName)) continue;

      // Detect connector type from catalog name or by querying
      const connector = Object.keys(CONNECTOR_TEMPLATES).includes(catName) ? catName : 'postgresql';

      // Try to find default schema
      let defaultSchema = this._defaultSchema(connector);
      try {
        const schemas = await trinoClient.listSchemas(catName);
        if (schemas.includes('public')) defaultSchema = 'public';
        else if (schemas.includes('payments_db')) defaultSchema = 'payments_db';
        else if (schemas.includes('commerce_db')) defaultSchema = 'commerce_db';
        else if (schemas.includes('analytics_db')) defaultSchema = 'analytics_db';
        else if (schemas.length > 0) defaultSchema = schemas[0];
      } catch { /* use default */ }

      const metadata = {
        name: catName,
        catalogName: catName,
        connector,
        host: 'docker',
        port: this._defaultPort(connector),
        database: '',
        schema: defaultSchema,
        user: 'trino',
        status: 'active',
        source: 'discovered',
        registeredAt: new Date().toISOString()
      };

      await redisService.hSet(this._redisKey(tenantId, workspaceId), catName, JSON.stringify(metadata));
      discovered.push(metadata);
      logger.info(`🔍 Discovered Trino catalog: ${catName} (schema: ${defaultSchema})`);
    }

    return { discovered, total: trinoCatalogs.length, new: discovered.length };
  }

}

module.exports = new TrinoCatalogService();
