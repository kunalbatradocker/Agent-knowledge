/**
 * Metrics Service
 * Health metrics and observability for the GraphRAG platform
 * 
 * Tracks:
 * - Extraction success/failure rates
 * - Entity creation counts
 * - Average confidence scores
 * - Ontology coverage
 * - Review queue sizes
 */

const { client: redisClient, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');
const ontologyPackService = require('./ontologyPackService');

// Redis key prefixes
const KEYS = {
  COUNTER: 'metrics:counter:',
  GAUGE: 'metrics:gauge:',
  TIMESERIES: 'metrics:ts:',
  DAILY: 'metrics:daily:'
};

// Metric names
const MetricName = {
  EXTRACTION_SUCCESS: 'extraction_success',
  EXTRACTION_FAILURE: 'extraction_failure',
  ENTITIES_CREATED: 'entities_created',
  RELATIONSHIPS_CREATED: 'relationships_created',
  AVG_CONFIDENCE: 'avg_confidence',
  REVIEW_QUEUE_SIZE: 'review_queue_size',
  DOCUMENTS_PROCESSED: 'documents_processed',
  VKG_QUERIES: 'vkg_queries',
  VKG_QUERY_FAILURES: 'vkg_query_failures',
  VKG_AVG_LATENCY_MS: 'vkg_avg_latency_ms',
  VKG_CATALOGS_REGISTERED: 'vkg_catalogs_registered',
  VKG_ONTOLOGY_GENERATIONS: 'vkg_ontology_generations',
  VKG_SCHEMA_DRIFTS_DETECTED: 'vkg_schema_drifts_detected'
};

class MetricsService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  /**
   * Increment a counter metric
   */
  async incrementCounter(metricName, workspaceId, amount = 1) {
    await this.initialize();
    const key = `${KEYS.COUNTER}${metricName}:${workspaceId || 'global'}`;
    await redisClient.incrBy(key, amount);

    // Also record in daily timeseries
    await this.recordDaily(metricName, workspaceId, amount);
  }

  /**
   * Set a gauge metric
   */
  async setGauge(metricName, workspaceId, value) {
    await this.initialize();
    const key = `${KEYS.GAUGE}${metricName}:${workspaceId || 'global'}`;
    await redisClient.set(key, value.toString());
  }

  /**
   * Get a counter value
   */
  async getCounter(metricName, workspaceId) {
    await this.initialize();
    const key = `${KEYS.COUNTER}${metricName}:${workspaceId || 'global'}`;
    const value = await redisClient.get(key);
    return parseInt(value) || 0;
  }

  /**
   * Get a gauge value
   */
  async getGauge(metricName, workspaceId) {
    await this.initialize();
    const key = `${KEYS.GAUGE}${metricName}:${workspaceId || 'global'}`;
    const value = await redisClient.get(key);
    return parseFloat(value) || 0;
  }

  /**
   * Record daily metric for timeseries
   */
  async recordDaily(metricName, workspaceId, value) {
    await this.initialize();
    const today = new Date().toISOString().split('T')[0];
    const key = `${KEYS.DAILY}${metricName}:${workspaceId || 'global'}:${today}`;
    await redisClient.incrByFloat(key, value);
    // Expire after 90 days
    await redisClient.expire(key, 90 * 24 * 60 * 60);
  }

  /**
   * Record extraction result
   */
  async recordExtraction(workspaceId, result) {
    const { success, entityCount = 0, relationshipCount = 0, avgConfidence = 0 } = result;

    if (success) {
      await this.incrementCounter(MetricName.EXTRACTION_SUCCESS, workspaceId);
      await this.incrementCounter(MetricName.ENTITIES_CREATED, workspaceId, entityCount);
      await this.incrementCounter(MetricName.RELATIONSHIPS_CREATED, workspaceId, relationshipCount);
    } else {
      await this.incrementCounter(MetricName.EXTRACTION_FAILURE, workspaceId);
    }

    await this.incrementCounter(MetricName.DOCUMENTS_PROCESSED, workspaceId);

    // Update average confidence (running average approximation)
    if (avgConfidence > 0) {
      const currentAvg = await this.getGauge(MetricName.AVG_CONFIDENCE, workspaceId);
      const newAvg = currentAvg > 0 ? (currentAvg + avgConfidence) / 2 : avgConfidence;
      await this.setGauge(MetricName.AVG_CONFIDENCE, workspaceId, newAvg);
    }
  }

  /**
   * Get health dashboard metrics
   */
  async getHealthMetrics(workspaceId) {
    await this.initialize();

    const successCount = await this.getCounter(MetricName.EXTRACTION_SUCCESS, workspaceId);
    const failureCount = await this.getCounter(MetricName.EXTRACTION_FAILURE, workspaceId);
    const entitiesCreated = await this.getCounter(MetricName.ENTITIES_CREATED, workspaceId);
    const relationshipsCreated = await this.getCounter(MetricName.RELATIONSHIPS_CREATED, workspaceId);
    const documentsProcessed = await this.getCounter(MetricName.DOCUMENTS_PROCESSED, workspaceId);
    const avgConfidence = await this.getGauge(MetricName.AVG_CONFIDENCE, workspaceId);

    const total = successCount + failureCount;
    const successRate = total > 0 ? successCount / total : 0;

    // Get graph stats from Neo4j
    const graphStats = await this.getGraphStats(workspaceId);

    // Get ontology coverage
    const coverage = await this.getOntologyCoverage(workspaceId);

    return {
      extraction: {
        success_rate: successRate,
        total_extractions: total,
        successful: successCount,
        failed: failureCount,
        documents_processed: documentsProcessed
      },
      entities: {
        total_created: entitiesCreated,
        current_count: graphStats.entities,
        avg_confidence: avgConfidence
      },
      relationships: {
        total_created: relationshipsCreated,
        current_count: graphStats.relationships
      },
      graph: graphStats,
      ontology_coverage: coverage,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get graph statistics from Neo4j
   */
  async getGraphStats(workspaceId) {
    const session = neo4jService.getSession();
    try {
      const query = workspaceId ? `
        MATCH (n)
        WHERE n.workspace_id = $workspaceId
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder AND NOT n:Workspace
        WITH count(n) as entities
        MATCH ()-[r]->()
        WHERE startNode(r).workspace_id = $workspaceId
        RETURN entities, count(r) as relationships
      ` : `
        MATCH (n)
        WHERE NOT n:Document AND NOT n:Chunk AND NOT n:Folder AND NOT n:Workspace
        WITH count(n) as entities
        MATCH ()-[r]->()
        RETURN entities, count(r) as relationships
      `;

      const result = await session.run(query, { workspaceId });
      const record = result.records[0];

      // Get document and chunk counts
      const docQuery = workspaceId ? `
        MATCH (d:Document) WHERE d.workspace_id = $workspaceId
        OPTIONAL MATCH (c:Chunk)-[:PART_OF]->(d)
        RETURN count(DISTINCT d) as documents, count(c) as chunks
      ` : `
        MATCH (d:Document)
        OPTIONAL MATCH (c:Chunk)-[:PART_OF]->(d)
        RETURN count(DISTINCT d) as documents, count(c) as chunks
      `;

      const docResult = await session.run(docQuery, { workspaceId });
      const docRecord = docResult.records[0];

      return {
        entities: neo4jService.toNumber(record?.get('entities')) || 0,
        relationships: neo4jService.toNumber(record?.get('relationships')) || 0,
        documents: neo4jService.toNumber(docRecord?.get('documents')) || 0,
        chunks: neo4jService.toNumber(docRecord?.get('chunks')) || 0
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get ontology coverage (% of classes with instances)
   */
  async getOntologyCoverage(workspaceId) {
    // Get active ontology classes
    const packs = await ontologyPackService.listPacks({ workspace_id: workspaceId });
    
    const allClasses = new Set();
    const usedClasses = new Set();

    for (const pack of packs) {
      const activeVersion = await ontologyPackService.getActiveVersion(pack.pack_id);
      if (activeVersion) {
        for (const cls of activeVersion.classes) {
          allClasses.add(cls.name);
        }
      }
    }

    if (allClasses.size === 0) {
      return {
        total_classes: 0,
        used_classes: 0,
        coverage_percent: 0,
        unused_classes: []
      };
    }

    // Check which classes have instances
    const session = neo4jService.getSession();
    try {
      for (const className of allClasses) {
        const sanitized = className.replace(/[^a-zA-Z0-9_]/g, '');
        if (!sanitized) continue;

        try {
          const result = await session.run(`
            MATCH (n:\`${sanitized}\`)
            WHERE n.workspace_id = $workspaceId OR $workspaceId IS NULL
            RETURN count(n) as count
            LIMIT 1
          `, { workspaceId });

          const count = neo4jService.toNumber(result.records[0]?.get('count'));
          if (count > 0) {
            usedClasses.add(className);
          }
        } catch (e) {
          // Class might not exist as label
        }
      }
    } finally {
      await session.close();
    }

    const unusedClasses = [...allClasses].filter(c => !usedClasses.has(c));

    return {
      total_classes: allClasses.size,
      used_classes: usedClasses.size,
      coverage_percent: allClasses.size > 0 ? (usedClasses.size / allClasses.size) * 100 : 0,
      unused_classes: unusedClasses
    };
  }

  /**
   * Get timeseries data for a metric
   */
  async getTimeseries(metricName, workspaceId, days = 30) {
    await this.initialize();

    const data = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const key = `${KEYS.DAILY}${metricName}:${workspaceId || 'global'}:${dateStr}`;
      const value = await redisClient.get(key);

      data.push({
        date: dateStr,
        value: parseFloat(value) || 0
      });
    }

    return data;
  }

  /**
   * Get all metrics for export
   */
  async exportMetrics(workspaceId) {
    const health = await this.getHealthMetrics(workspaceId);
    
    const timeseries = {
      extraction_success: await this.getTimeseries(MetricName.EXTRACTION_SUCCESS, workspaceId),
      extraction_failure: await this.getTimeseries(MetricName.EXTRACTION_FAILURE, workspaceId),
      entities_created: await this.getTimeseries(MetricName.ENTITIES_CREATED, workspaceId)
    };

    return {
      health,
      timeseries,
      exported_at: new Date().toISOString()
    };
  }

  /**
   * Reset metrics for a workspace (admin only)
   */
  async resetMetrics(workspaceId) {
    await this.initialize();

    const patterns = [
      `${KEYS.COUNTER}*:${workspaceId}`,
      `${KEYS.GAUGE}*:${workspaceId}`,
      `${KEYS.DAILY}*:${workspaceId}:*`
    ];

    let deleted = 0;
    for (const pattern of patterns) {
      // Use SCAN instead of KEYS
      let cursor = '0';
      do {
        const result = await redisClient.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
        cursor = result[0];
        for (const key of result[1]) {
          await redisClient.del(key);
          deleted++;
        }
      } while (cursor !== '0');
    }

    return { deleted, workspace_id: workspaceId };
  }
}

module.exports = new MetricsService();
module.exports.MetricName = MetricName;
