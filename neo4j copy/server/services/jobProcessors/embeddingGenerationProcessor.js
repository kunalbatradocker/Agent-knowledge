/**
 * Embedding Generation Job Processor
 * Generates embeddings for document chunks
 */

const embeddingService = require('../embeddingService');
const vectorStoreService = require('../vectorStoreService');
const chunkClassificationService = require('../chunkClassificationService');
const { Worker } = require('bullmq');
const queueConfig = require('../../config/queue');

class EmbeddingGenerationProcessor {
  constructor() {
    this.worker = new Worker(
      queueConfig.QUEUE_NAMES.EMBEDDING_GENERATION,
      async (job) => {
        return await this.process(job);
      },
      {
        connection: queueConfig.redisConnection,
        concurrency: 3, // Process 3 embedding jobs concurrently
        limiter: {
          max: 10, // Max 10 embeddings per second
          duration: 1000
        }
      }
    );

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.worker.on('completed', (job) => {
      console.log(`✅ Embedding generation job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`❌ Embedding generation job ${job.id} failed:`, err.message);
    });

    this.worker.on('progress', (job, progress) => {
      console.log(`📊 Embedding generation job ${job.id} progress:`, progress);
    });
  }

  async process(job) {
    const {
      chunks,
      docId,
      documentName,
      docType,
      tenantId,
      workspaceId
    } = job.data;

    try {
      if (!chunks || chunks.length === 0) {
        return { success: true, embeddingsGenerated: 0 };
      }

      await job.updateProgress({ stage: 'classifying', progress: 10 });

      // Classify chunks
      const classifiedChunks = await chunkClassificationService.classifyChunks(chunks, {
        doc_type: docType,
        tenant_id: tenantId,
        workspace_id: workspaceId
      });

      await job.updateProgress({ stage: 'generating', progress: 30 });

      // Generate embeddings for all chunks
      const texts = classifiedChunks.map(chunk => chunk.text);
      const embeddings = await embeddingService.generateEmbeddings(texts);

      await job.updateProgress({ stage: 'storing', progress: 70 });

      // Store chunks and embeddings in vector store
      const enrichedChunks = classifiedChunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index],
        embedding_model: embeddingService.getModelName(),
        tenant_id: tenantId,
        workspace_id: workspaceId,
        doc_type: docType,
        language: 'en'
      }));

      // Store chunks and embeddings in vector store
      for (let i = 0; i < enrichedChunks.length; i++) {
        await vectorStoreService.storeChunk(enrichedChunks[i], embeddings[i]);
      }

      await job.updateProgress({ stage: 'complete', progress: 100 });

      return {
        success: true,
        embeddingsGenerated: embeddings.length,
        chunks: enrichedChunks
      };
    } catch (error) {
      console.error('Embedding generation error:', error);
      throw new Error(`Embedding generation failed: ${error.message}`);
    }
  }

  async close() {
    await this.worker.close();
  }
}

// Export singleton instance
let processorInstance = null;

function getProcessor() {
  if (!processorInstance) {
    processorInstance = new EmbeddingGenerationProcessor();
  }
  return processorInstance;
}

module.exports = { getProcessor, EmbeddingGenerationProcessor };

