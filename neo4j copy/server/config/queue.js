/**
 * BullMQ Queue Configuration
 * Sets up Redis connection and queue instances
 * 
 * NOTE: BullMQ requires ioredis, but we create the connection lazily
 * to avoid conflicts with the main redis client
 */

const { Queue } = require('bullmq');

// Lazy-loaded Redis connection for BullMQ
let _redisConnection = null;

function getRedisConnection() {
  if (!_redisConnection) {
    const Redis = require('ioredis');
    
    // Parse REDIS_URL if available (e.g., redis://redis:6379 in Docker)
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
          enableReadyCheck: false,
          lazyConnect: true
        };
      } catch (e) {
        // Fallback if URL parsing fails
        connectionOpts = {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: true
        };
      }
    } else {
      connectionOpts = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true
      };
    }
    
    _redisConnection = new Redis(connectionOpts);
    
    _redisConnection.on('error', (err) => {
      console.warn('BullMQ Redis connection error:', err.message);
    });
  }
  return _redisConnection;
}

// Queue names
const QUEUE_NAMES = {
  DOCUMENT_PROCESSING: 'document-processing',
  EMBEDDING_GENERATION: 'embedding-generation',
  GRAPH_CREATION: 'graph-creation',
  CSV_PROCESSING: 'csv-processing',
  COMMIT_PROCESSING: 'commit-processing',
  VKG_SCHEMA_INTROSPECTION: 'vkg-schema-introspection',
  VKG_ONTOLOGY_GENERATION: 'vkg-ontology-generation',
  VKG_SCHEMA_DRIFT_CHECK: 'vkg-schema-drift-check'
};

// Lazy-loaded queue instances
let _queues = null;

function getQueues() {
  if (!_queues) {
    const connection = getRedisConnection();
    
    _queues = {
      documentProcessing: new Queue(QUEUE_NAMES.DOCUMENT_PROCESSING, {
        connection: connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: {
            age: 24 * 3600,
            count: 1000
          },
          removeOnFail: {
            age: 7 * 24 * 3600
          }
        }
      }),

      embeddingGeneration: new Queue(QUEUE_NAMES.EMBEDDING_GENERATION, {
        connection: connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: {
            age: 24 * 3600,
            count: 1000
          }
        }
      }),

      graphCreation: new Queue(QUEUE_NAMES.GRAPH_CREATION, {
        connection: connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: {
            age: 24 * 3600,
            count: 1000
          }
        }
      }),

      csvProcessing: new Queue(QUEUE_NAMES.CSV_PROCESSING, {
        connection: connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: {
            age: 24 * 3600,
            count: 1000
          }
        }
      }),

      commitProcessing: new Queue(QUEUE_NAMES.COMMIT_PROCESSING, {
        connection: connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 3000
          },
          removeOnComplete: {
            age: 24 * 3600,
            count: 500
          },
          removeOnFail: {
            age: 7 * 24 * 3600
          }
        }
      }),

      vkgSchemaIntrospection: new Queue(QUEUE_NAMES.VKG_SCHEMA_INTROSPECTION, {
        connection: connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 24 * 3600, count: 200 },
          removeOnFail: { age: 7 * 24 * 3600 }
        }
      }),

      vkgOntologyGeneration: new Queue(QUEUE_NAMES.VKG_ONTOLOGY_GENERATION, {
        connection: connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 24 * 3600, count: 200 },
          removeOnFail: { age: 7 * 24 * 3600 }
        }
      }),

      vkgSchemaDriftCheck: new Queue(QUEUE_NAMES.VKG_SCHEMA_DRIFT_CHECK, {
        connection: connection,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: { age: 24 * 3600, count: 100 },
          removeOnFail: { age: 3 * 24 * 3600 }
        }
      })
    };
  }
  return _queues;
}

// Helper to get queue by name
function getQueue(queueName) {
  const queues = getQueues();
  switch (queueName) {
    case QUEUE_NAMES.DOCUMENT_PROCESSING:
      return queues.documentProcessing;
    case QUEUE_NAMES.EMBEDDING_GENERATION:
      return queues.embeddingGeneration;
    case QUEUE_NAMES.GRAPH_CREATION:
      return queues.graphCreation;
    case QUEUE_NAMES.CSV_PROCESSING:
      return queues.csvProcessing;
    case QUEUE_NAMES.COMMIT_PROCESSING:
      return queues.commitProcessing;
    case QUEUE_NAMES.VKG_SCHEMA_INTROSPECTION:
      return queues.vkgSchemaIntrospection;
    case QUEUE_NAMES.VKG_ONTOLOGY_GENERATION:
      return queues.vkgOntologyGeneration;
    case QUEUE_NAMES.VKG_SCHEMA_DRIFT_CHECK:
      return queues.vkgSchemaDriftCheck;
    default:
      throw new Error(`Unknown queue: ${queueName}`);
  }
}

// Helper to get job status
async function getJobStatus(queueName, jobId) {
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);
  
  if (!job) {
    return { status: 'not_found' };
  }

  const state = await job.getState();
  const progress = job.progress || {};
  
  return {
    id: job.id,
    status: state,
    progress: progress,
    data: job.data,
    result: job.returnvalue,
    error: job.failedReason,
    createdAt: new Date(job.timestamp),
    processedAt: job.processedOn ? new Date(job.processedOn) : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn) : null
  };
}

// Export lazy-loaded queues
module.exports = {
  get queues() { return getQueues(); },
  QUEUE_NAMES,
  getQueue,
  getJobStatus,
  get redisConnection() { return getRedisConnection(); }
};

