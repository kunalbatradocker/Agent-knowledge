/**
 * Commit Processing Worker
 * Handles document commit jobs via BullMQ instead of in-process background execution.
 * This moves the heavy commit work (triple generation, GraphDB writes, embedding)
 * out of the API process and into the worker process.
 */

const { Worker } = require('bullmq');
const { QUEUE_NAMES } = require('../../config/queue');
const logger = require('../../utils/logger');

let _worker = null;

function getProcessor() {
  if (_worker) return _worker;

  const Redis = require('ioredis');
  const redisUrl = process.env.REDIS_URL;
  let connectionOpts;

  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      connectionOpts = {
        host: url.hostname || 'localhost',
        port: parseInt(url.port) || 6379,
        password: url.password || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      };
    } catch (e) {
      connectionOpts = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      };
    }
  } else {
    connectionOpts = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };
  }

  const connection = new Redis(connectionOpts);

  _worker = new Worker(
    QUEUE_NAMES.COMMIT_PROCESSING,
    async (job) => {
      const { jobId, docId, staged, options } = job.data;
      logger.info(`[CommitWorker] Processing commit for job ${jobId}, doc ${docId}`);

      // Dynamically require to avoid circular deps and ensure fresh state
      const { processCommitInBackground } = require('../../routes/ontology/commitHelper');

      await job.updateProgress(10);
      await processCommitInBackground(jobId, docId, staged, options);
      await job.updateProgress(100);

      logger.info(`[CommitWorker] Commit complete for job ${jobId}`);
      return { success: true, jobId, docId };
    },
    {
      connection,
      concurrency: 2, // Process up to 2 commits in parallel
      limiter: {
        max: 5,
        duration: 60000 // Max 5 commits per minute
      }
    }
  );

  _worker.on('completed', (job) => {
    logger.info(`[CommitWorker] Job ${job.id} completed`);
  });

  _worker.on('failed', (job, err) => {
    logger.error(`[CommitWorker] Job ${job?.id} failed: ${err.message}`);
  });

  console.log('✅ Commit processing worker started');
  return _worker;
}

module.exports = { getProcessor };
