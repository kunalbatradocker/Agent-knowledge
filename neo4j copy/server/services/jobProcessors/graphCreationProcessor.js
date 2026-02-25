/**
 * Graph Creation Job Processor
 * Creates nodes and relationships in Neo4j
 */

const neo4jService = require('../neo4jService');
const conceptExtractionService = require('../conceptExtractionService');
const csvToGraphService = require('../csvToGraphService');
const { Worker } = require('bullmq');
const queueConfig = require('../../config/queue');

class GraphCreationProcessor {
  constructor() {
    this.worker = new Worker(
      queueConfig.QUEUE_NAMES.GRAPH_CREATION,
      async (job) => {
        return await this.process(job);
      },
      {
        connection: queueConfig.redisConnection,
        concurrency: 2, // Process 2 graph creation jobs concurrently
        limiter: {
          max: 3, // Max 3 jobs per second
          duration: 1000
        }
      }
    );

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.worker.on('completed', (job) => {
      console.log(`✅ Graph creation job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`❌ Graph creation job ${job.id} failed:`, err.message);
    });

    this.worker.on('progress', (job, progress) => {
      console.log(`📊 Graph creation job ${job.id} progress:`, progress);
    });
  }

  async process(job) {
    const {
      docId,
      docUri,
      documentName,
      docType,
      contentType,
      industry,
      tenantId,
      workspaceId,
      version,
      folderId,
      templateId,
      chunks,
      csvData,
      extractedText,
      ontology,
      columnMapping,
      relationshipMapping,
      csvProcessingMode
    } = job.data;

    try {
      await job.updateProgress({ stage: 'creating_document', progress: 10 });

      // Step 1: Create Document node
      await neo4jService.createDocument({
        doc_id: docId,
        uri: docUri,
        title: documentName,
        source: 'upload',
        doc_type: docType,
        content_type: contentType,
        industry: industry,
        language: 'en',
        tenant_id: tenantId,
        workspace_id: workspaceId,
        version: version,
        folder_id: folderId,
        ingested_at: new Date().toISOString()
      });

      let result = {
        nodesCreated: 0,
        relationshipsCreated: 0,
        chunksCreated: 0
      };

      await job.updateProgress({ stage: 'processing', progress: 20 });

      // Step 2: Process based on document type
      const useAI = csvProcessingMode === 'text' || csvProcessingMode === 'hybrid';
      const useGraph = csvProcessingMode !== 'text';

      if (docType === 'csv' && csvData && !useAI) {
        // CSV graph-only mode — rule-based graph conversion, no AI
        let graphResult;
        
        if (ontology && (ontology.classes?.length > 0 || ontology.entityTypes?.length > 0)) {
          console.log(`   📊 Using ontology-aware CSV processing`);
          graphResult = csvToGraphService.convertWithOntology(
            csvData,
            ontology,
            columnMapping || {},
            relationshipMapping || []
          );
        } else {
          graphResult = csvToGraphService.convertToGraph(csvData, {
            industry: industry
          });
        }

        if (graphResult.nodes.length > 0) {
          await neo4jService.createConcepts(graphResult.nodes, {
            industry: industry
          });
          result.nodesCreated = graphResult.nodes.length;
        }

        if (graphResult.relationships.length > 0) {
          await neo4jService.createConceptRelations(graphResult.relationships);
          result.relationshipsCreated = graphResult.relationships.length;
        }

        // Create CSV chunk
        const csvChunk = {
          uri: `${docUri}#csv`,
          chunk_id: require('uuid').v4(),
          text: `CSV data from ${documentName} with ${csvData.rowCount} rows`,
          order: 0,
          vector_key: `${docId}_csv`,
          tenant_id: tenantId,
          workspace_id: workspaceId,
          doc_type: docType,
          language: 'en'
        };
        await neo4jService.createChunks([csvChunk], docUri);
        result.chunksCreated = 1;

      } else if (chunks && chunks.length > 0) {
        // Text / Excel / CSV-with-AI — AI-powered extraction
        await job.updateProgress({ stage: 'creating_chunks', progress: 30 });

        // For tabular data with hybrid/graph mode, also do rule-based graph conversion
        if (csvData && useGraph) {
          console.log(`   📊 Tabular: running rule-based graph conversion`);
          let graphResult;
          if (ontology && (ontology.classes?.length > 0 || ontology.entityTypes?.length > 0)) {
            graphResult = csvToGraphService.convertWithOntology(csvData, ontology, columnMapping || {}, relationshipMapping || []);
          } else {
            graphResult = csvToGraphService.convertToGraph(csvData, { industry });
          }
          if (graphResult.nodes.length > 0) {
            await neo4jService.createConcepts(graphResult.nodes, { industry });
            result.nodesCreated += graphResult.nodes.length;
          }
          if (graphResult.relationships.length > 0) {
            await neo4jService.createConceptRelations(graphResult.relationships);
            result.relationshipsCreated += graphResult.relationships.length;
          }
          console.log(`   📊 Excel tabular: ${graphResult.nodes.length} nodes, ${graphResult.relationships.length} rels`);
        }

        // Create Chunk nodes
        const enrichedChunks = chunks.map(chunk => ({
          ...chunk,
          tenant_id: tenantId,
          workspace_id: workspaceId,
          doc_type: docType,
          language: 'en'
        }));

        await neo4jService.createChunks(enrichedChunks, docUri);
        result.chunksCreated = enrichedChunks.length;

        await job.updateProgress({ stage: 'extracting_concepts', progress: 50 });

        // Extract concepts using LLM
        const ontologyTemplate = require('../ontologyTemplateService').getTemplate(templateId || 'auto');
        const context = {
          doc_id: docId,
          doc_uri: docUri,
          doc_type: docType,
          industry: industry,
          ontologyTemplate: ontologyTemplate
        };

        const extraction = await conceptExtractionService.extractConceptsFromChunks(
          enrichedChunks,
          context
        );

        await job.updateProgress({ stage: 'creating_concepts', progress: 70 });

        // Create concepts
        if (extraction.concepts.length > 0) {
          await neo4jService.createConcepts(extraction.concepts, {
            industry: industry
          });
          result.nodesCreated = extraction.concepts.length;
        }

        // Create relationships
        if (extraction.relations.length > 0) {
          await neo4jService.createConceptRelations(extraction.relations);
          result.relationshipsCreated = extraction.relations.length;
        }

        // Create mentions
        if (extraction.mentions.length > 0) {
          await neo4jService.createConceptMentions(extraction.mentions);
        }
      }

      await job.updateProgress({ stage: 'complete', progress: 100 });

      return {
        success: true,
        ...result
      };
    } catch (error) {
      console.error('Graph creation error:', error);
      throw new Error(`Graph creation failed: ${error.message}`);
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
    processorInstance = new GraphCreationProcessor();
  }
  return processorInstance;
}

module.exports = { getProcessor, GraphCreationProcessor };

