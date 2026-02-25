/**
 * BullMQ Workers
 * Starts all job processors for async processing
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getProcessor: getDocumentProcessor } = require('../services/jobProcessors/documentProcessingProcessor');
const { getProcessor: getEmbeddingProcessor } = require('../services/jobProcessors/embeddingGenerationProcessor');
const { getProcessor: getGraphProcessor } = require('../services/jobProcessors/graphCreationProcessor');
const { getProcessor: getCommitProcessor } = require('../services/jobProcessors/commitProcessor');
const { getProcessors: getVKGProcessors, closeAll: closeVKGWorkers } = require('../services/jobProcessors/vkgProcessor');

console.log('🚀 Starting BullMQ Workers...\n');

// Initialize all processors
const documentProcessor = getDocumentProcessor();
const embeddingProcessor = getEmbeddingProcessor();
const graphProcessor = getGraphProcessor();
const commitProcessor = getCommitProcessor();
const vkgProcessors = getVKGProcessors();

console.log('✅ All workers started and ready to process jobs\n');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down workers...');
  await Promise.all([
    documentProcessor.close(),
    embeddingProcessor.close(),
    graphProcessor.close(),
    commitProcessor.close(),
    closeVKGWorkers()
  ]);
  console.log('✅ All workers stopped');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down workers...');
  await Promise.all([
    documentProcessor.close(),
    embeddingProcessor.close(),
    graphProcessor.close(),
    commitProcessor.close(),
    closeVKGWorkers()
  ]);
  console.log('✅ All workers stopped');
  process.exit(0);
});

