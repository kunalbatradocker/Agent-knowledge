/**
 * VKG Background Job Processors
 * Handles schema introspection, ontology generation, and schema drift detection.
 */

const { Worker } = require('bullmq');
const { QUEUE_NAMES } = require('../../config/queue');
const logger = require('../../utils/logger');

let _workers = {};

function getProcessors() {
  if (_workers.introspection) return _workers;

  const Redis = require('ioredis');
  const redisUrl = process.env.REDIS_URL;
  let connectionOpts;

  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      connectionOpts = {
        host: url.hostname || 'localhost',
        port: parseInt(url.port) || 6379,
        password: url.password || process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      };
    } catch {
      connectionOpts = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      };
    }
  } else {
    connectionOpts = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };
  }

  const connection = new Redis(connectionOpts);

  // Schema Introspection Worker
  _workers.introspection = new Worker(
    QUEUE_NAMES.VKG_SCHEMA_INTROSPECTION,
    async (job) => {
      const { tenantId, catalogName, workspaceId } = job.data;
      logger.info(`[VKG Worker] Introspecting schema for catalog ${catalogName}, tenant ${tenantId}`);

      const trinoCatalogService = require('../trinoCatalogService');
      const schema = await trinoCatalogService.introspectCatalog(tenantId, catalogName, null, workspaceId);
      await job.updateProgress(100);

      logger.info(`[VKG Worker] Introspection complete: ${schema.tables?.length || 0} tables`);
      return { success: true, tableCount: schema.tables?.length || 0 };
    },
    { connection, concurrency: 2 }
  );

  // Ontology Generation Worker
  _workers.ontologyGeneration = new Worker(
    QUEUE_NAMES.VKG_ONTOLOGY_GENERATION,
    async (job) => {
      const { tenantId, workspaceId, options } = job.data;
      logger.info(`[VKG Worker] Generating ontology for tenant ${tenantId}, workspace ${workspaceId}`);

      const vkgOntologyService = require('../vkgOntologyService');
      const result = await vkgOntologyService.generateFromCatalogs(tenantId, workspaceId, options || {});
      await job.updateProgress(100);

      logger.info(`[VKG Worker] Ontology generation complete`);
      return { success: true, ...result };
    },
    { connection, concurrency: 1 }
  );

  // Schema Drift Check Worker
  _workers.schemaDriftCheck = new Worker(
    QUEUE_NAMES.VKG_SCHEMA_DRIFT_CHECK,
    async (job) => {
      const { tenantId, workspaceId } = job.data;
      logger.info(`[VKG Worker] Checking schema drift for tenant ${tenantId}, workspace ${workspaceId}`);

      const vkgOntologyService = require('../vkgOntologyService');
      const drift = await vkgOntologyService.detectSchemaDrift(tenantId, workspaceId);
      await job.updateProgress(100);

      const hasDrift = drift.drifts?.length > 0;
      if (hasDrift) {
        logger.warn(`[VKG Worker] Schema drift detected: ${drift.drifts.length} changes`);
      } else {
        logger.info(`[VKG Worker] No schema drift detected`);
      }
      return { success: true, hasDrift, driftCount: drift.drifts?.length || 0 };
    },
    { connection, concurrency: 1 }
  );

  // Event handlers for all workers
  for (const [name, worker] of Object.entries(_workers)) {
    worker.on('completed', (job) => {
      logger.info(`[VKG Worker] ${name} job ${job.id} completed`);
    });
    worker.on('failed', (job, err) => {
      logger.error(`[VKG Worker] ${name} job ${job?.id} failed: ${err.message}`);
    });
  }

  console.log('✅ VKG workers started (introspection, ontology generation, schema drift)');
  return _workers;
}

async function closeAll() {
  const promises = Object.values(_workers).map(w => w.close());
  await Promise.all(promises);
  _workers = {};
}

module.exports = { getProcessors, closeAll };
