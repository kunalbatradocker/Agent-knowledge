/**
 * Job Service
 * Manages job creation, status tracking, and orchestration
 */

const { v4: uuidv4 } = require('uuid');

// Lazy load queues to prevent initialization issues
let _queues = null;
let _QUEUE_NAMES = null;
let _getJobStatus = null;

function getQueues() {
  if (!_queues) {
    const queueConfig = require('../config/queue');
    _queues = queueConfig.queues;
    _QUEUE_NAMES = queueConfig.QUEUE_NAMES;
    _getJobStatus = queueConfig.getJobStatus;
  }
  return { queues: _queues, QUEUE_NAMES: _QUEUE_NAMES, getJobStatus: _getJobStatus };
}

class JobService {
  /**
   * Enqueue a document processing job
   */
  async enqueueDocumentProcessing(jobData) {
    const { queues, QUEUE_NAMES } = getQueues();
    const job = await queues.documentProcessing.add(
      'process-document',
      {
        ...jobData,
        jobId: uuidv4()
      },
      {
        jobId: jobData.jobId || uuidv4(),
        priority: jobData.priority || 0
      }
    );

    return {
      jobId: job.id,
      queue: QUEUE_NAMES.DOCUMENT_PROCESSING,
      status: 'queued'
    };
  }

  /**
   * Enqueue an embedding generation job
   */
  async enqueueEmbeddingGeneration(jobData) {
    const { queues, QUEUE_NAMES } = getQueues();
    const job = await queues.embeddingGeneration.add(
      'generate-embeddings',
      jobData,
      {
        jobId: jobData.jobId || uuidv4(),
        priority: jobData.priority || 0
      }
    );

    return {
      jobId: job.id,
      queue: QUEUE_NAMES.EMBEDDING_GENERATION,
      status: 'queued'
    };
  }

  /**
   * Enqueue a graph creation job
   */
  async enqueueGraphCreation(jobData) {
    const { queues, QUEUE_NAMES } = getQueues();
    const job = await queues.graphCreation.add(
      'create-graph',
      jobData,
      {
        jobId: jobData.jobId || uuidv4(),
        priority: jobData.priority || 0
      }
    );

    return {
      jobId: job.id,
      queue: QUEUE_NAMES.GRAPH_CREATION,
      status: 'queued'
    };
  }

  /**
   * Enqueue a complete document processing pipeline
   * Returns job IDs for tracking
   */
  async enqueueDocumentPipeline(jobData) {
    const pipelineId = uuidv4();

    // Step 1: Document processing
    const docJob = await this.enqueueDocumentProcessing({
      ...jobData,
      jobId: `${pipelineId}-doc`,
      pipelineId: pipelineId
    });

    // Step 2: Embedding generation (depends on doc processing)
    const embeddingJob = await this.enqueueEmbeddingGeneration({
      ...jobData,
      jobId: `${pipelineId}-embedding`,
      pipelineId: pipelineId,
      dependsOn: docJob.jobId
    });

    // Step 3: Graph creation (depends on doc processing and embeddings)
    const graphJob = await this.enqueueGraphCreation({
      ...jobData,
      jobId: `${pipelineId}-graph`,
      pipelineId: pipelineId,
      dependsOn: [docJob.jobId, embeddingJob.jobId]
    });

    return {
      pipelineId: pipelineId,
      jobs: {
        documentProcessing: docJob,
        embeddingGeneration: embeddingJob,
        graphCreation: graphJob
      }
    };
  }

  /**
   * Get job status
   */
  async getJobStatus(queueName, jobId) {
    const { getJobStatus } = getQueues();
    return await getJobStatus(queueName, jobId);
  }

  /**
   * Get all jobs for a pipeline
   */
  async getPipelineStatus(pipelineId) {
    const { queues } = getQueues();
    // Get jobs from all queues that match the pipeline ID
    const [docJobs, embeddingJobs, graphJobs] = await Promise.all([
      queues.documentProcessing.getJobs(['completed', 'active', 'waiting', 'failed']),
      queues.embeddingGeneration.getJobs(['completed', 'active', 'waiting', 'failed']),
      queues.graphCreation.getJobs(['completed', 'active', 'waiting', 'failed'])
    ]);

    const allJobs = [...docJobs, ...embeddingJobs, ...graphJobs];
    const pipelineJobs = allJobs.filter(job => 
      job.data.pipelineId === pipelineId
    );

    const statuses = await Promise.all(
      pipelineJobs.map(async (job) => {
        const state = await job.getState();
        return {
          jobId: job.id,
          queue: job.queueName,
          status: state,
          progress: job.progress || {},
          data: job.data,
          result: job.returnvalue,
          error: job.failedReason,
          createdAt: new Date(job.timestamp),
          processedAt: job.processedOn ? new Date(job.processedOn) : null,
          finishedAt: job.finishedOn ? new Date(job.finishedOn) : null
        };
      })
    );

    return {
      pipelineId: pipelineId,
      jobs: statuses,
      overallStatus: this.calculateOverallStatus(statuses)
    };
  }

  /**
   * Calculate overall pipeline status
   */
  calculateOverallStatus(jobs) {
    if (jobs.length === 0) return 'unknown';
    
    const hasFailed = jobs.some(j => j.status === 'failed');
    if (hasFailed) return 'failed';

    const allCompleted = jobs.every(j => j.status === 'completed');
    if (allCompleted) return 'completed';

    const hasActive = jobs.some(j => j.status === 'active');
    if (hasActive) return 'processing';

    return 'queued';
  }

  /**
   * Cancel a job
   */
  async cancelJob(queueName, jobId) {
    const { queues } = getQueues();
    const queue = Object.values(queues).find(q => q.name === queueName);
    if (!queue) {
      throw new Error(`Queue not found: ${queueName}`);
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const state = await job.getState();
    if (state === 'active') {
      await job.moveToFailed(new Error('Job cancelled by user'), '0');
    } else {
      await job.remove();
    }
    
    return { success: true, jobId: jobId };
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    const { queues } = getQueues();
    const stats = {};

    for (const [name, queue] of Object.entries(queues)) {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount()
      ]);

      stats[name] = {
        waiting,
        active,
        completed,
        failed,
        total: waiting + active + completed + failed
      };
    }

    return stats;
  }
}

module.exports = new JobService();

