/**
 * Document Processing Job Processor
 * Handles document parsing, chunking, and initial processing
 */

const path = require('path');
const fs = require('fs');
const pdfParser = require('../pdfParser');
const csvParser = require('../csvParser');
const chunkingService = require('../chunkingService');
const { Worker } = require('bullmq');
const queueConfig = require('../../config/queue');

class DocumentProcessingProcessor {
  constructor() {
    this.worker = new Worker(
      queueConfig.QUEUE_NAMES.DOCUMENT_PROCESSING,
      async (job) => {
        return await this.process(job);
      },
      {
        connection: queueConfig.redisConnection,
        concurrency: 2, // Process 2 documents concurrently
        limiter: {
          max: 5, // Max 5 jobs per second
          duration: 1000
        }
      }
    );

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.worker.on('completed', (job) => {
      console.log(`✅ Document processing job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`❌ Document processing job ${job.id} failed:`, err.message);
    });

    this.worker.on('progress', (job, progress) => {
      console.log(`📊 Document processing job ${job.id} progress:`, progress);
    });
  }

  async process(job) {
    const {
      filePath,
      documentName,
      docId,
      docUri,
      docType,
      contentType,
      industry,
      tenantId,
      workspaceId,
      version,
      folderId,
      chunkingMethod,
      templateId,
      ontology,
      columnMapping,
      relationshipMapping,
      csvProcessingMode
    } = job.data;

    try {
      // Update job progress
      await job.updateProgress({ stage: 'extracting', progress: 10 });

      let extractedText = '';
      let pdfMetadata = null;
      let csvData = null;
      let numPages = 1;
      let pageBreaks = [];
      let pageTexts = [];

      // Step 1: Extract text based on file type
      if (docType === 'pdf') {
        const pdfData = await pdfParser.extractText(filePath);
        extractedText = pdfData.text;
        pdfMetadata = { 
          numPages: pdfData.numPages,
          pageBreaks: pdfData.pageBreaks || [],
          pageTexts: pdfData.pageTexts || []
        };
        numPages = pdfData.numPages || 1;
        pageBreaks = pdfData.pageBreaks || [];
        pageTexts = pdfData.pageTexts || [];
        console.log(`   ✅ Extracted ${extractedText.length.toLocaleString()} chars from ${numPages} pages`);
        if (pageBreaks.length > 0) {
          console.log(`   📄 Detected ${pageBreaks.length} page breaks`);
        }
      } else if (docType === 'csv') {
        csvData = await csvParser.parseFile(filePath, {
          hasHeader: true,
          delimiter: ','
        });
        // Generate text representation for AI extraction
        const headers = csvData.headers || Object.keys(csvData.rows?.[0] || {});
        const sampleSize = Math.min(10, (csvData.rows || []).length);
        let csvText = `CSV: ${documentName} (${csvData.rows?.length || 0} rows, ${headers.length} columns)\nColumns: ${headers.join(', ')}\n\n`;
        for (let i = 0; i < sampleSize; i++) {
          csvText += `Row ${i + 1}:\n`;
          headers.forEach(h => { csvText += `  ${h}: ${csvData.rows[i][h]}\n`; });
          csvText += '\n';
        }
        if ((csvData.rows || []).length > sampleSize) csvText += `... and ${csvData.rows.length - sampleSize} more rows\n`;
        extractedText = csvText;
        csvData.text = csvText;
        console.log(`   ✅ Parsed CSV with ${csvData.rowCount || csvData.rows?.length} rows and ${headers.length} columns`);
      } else if (docType === 'xlsx' || docType === 'xls') {
        const excelParser = require('../excelParser');
        const parsed = await excelParser.parse(filePath);
        const flat = excelParser.flattenSheets(parsed);
        csvData = { headers: flat.headers, rows: flat.rows, rowCount: flat.rowCount, text: parsed.text };
        extractedText = parsed.text;
        console.log(`   ✅ Parsed Excel: ${parsed.sheets.length} sheet(s), ${flat.rowCount} total rows`);
      } else {
        extractedText = fs.readFileSync(filePath, 'utf-8');
        console.log(`   ✅ Read ${extractedText.length.toLocaleString()} characters`);
      }

      await job.updateProgress({ stage: 'chunking', progress: 30 });

      // Step 2: Chunk the document (skip only for CSV in graph-only mode)
      const skipChunking = docType === 'csv' && csvProcessingMode !== 'text' && csvProcessingMode !== 'hybrid';
      let chunkedDoc = null;
      if (!skipChunking) {
        chunkedDoc = chunkingService.chunkDocumentWithMethod(extractedText, {
          id: docId,
          uri: docUri,
          name: documentName,
          source: 'upload',
          doc_type: docType,
          chunkingMethod: chunkingMethod,
          numPages: numPages,
          pageBreaks: pageBreaks,
          pageTexts: pageTexts
        });
        console.log(`   ✅ Created ${chunkedDoc.totalChunks} chunks (method: ${chunkingMethod})`);
      }

      await job.updateProgress({ stage: 'triggering_next', progress: 90 });

      // Trigger next jobs in pipeline
      const { queues } = require('../../config/queue');
      
      // If we have chunks, trigger embedding generation
      if (chunkedDoc && chunkedDoc.chunks && chunkedDoc.chunks.length > 0) {
        await queues.embeddingGeneration.add(
          'generate-embeddings',
          {
            chunks: chunkedDoc.chunks,
            docId,
            documentName,
            docType,
            tenantId,
            workspaceId,
            pipelineId: job.data.pipelineId
          },
          {
            jobId: `${job.data.pipelineId}-embedding`
          }
        );
      }

      // Trigger graph creation (always needed)
      await queues.graphCreation.add(
        'create-graph',
        {
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
          chunks: chunkedDoc?.chunks || [],
          csvData,
          extractedText,
          ontology,
          columnMapping,
          relationshipMapping,
          pipelineId: job.data.pipelineId
        },
        {
          jobId: `${job.data.pipelineId}-graph`
        }
      );

      await job.updateProgress({ stage: 'complete', progress: 100 });

      // Return processed data
      return {
        success: true,
        extractedText,
        pdfMetadata,
        csvData,
        chunkedDoc,
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
        numPages
      };
    } catch (error) {
      console.error('Document processing error:', error);
      throw new Error(`Document processing failed: ${error.message}`);
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
    processorInstance = new DocumentProcessingProcessor();
  }
  return processorInstance;
}

module.exports = { getProcessor, DocumentProcessingProcessor };

