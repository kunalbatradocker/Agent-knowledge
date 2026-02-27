/**
 * Upload Routes
 * Handles document upload and processing endpoints
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { upload, ensureSchemaInitialized } = require('./shared');

// Services
const pdfParser = require('../../services/pdfParser');
const csvParser = require('../../services/csvParser');
const llmService = require('../../services/llmService');
const neo4jService = require('../../services/neo4jService');
const chunkingService = require('../../services/chunkingService');
const embeddingService = require('../../services/embeddingService');
const vectorStoreService = require('../../services/vectorStoreService');
const conceptExtractionService = require('../../services/conceptExtractionService');
const graphSchemaService = require('../../services/graphSchemaService');
const ontologyTemplateService = require('../../services/ontologyTemplateService');
const owlOntologyService = require('../../services/owlOntologyService');
const jobService = require('../../services/jobService');
const ocrService = require('../../services/ocrService');

// Middleware
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { requireMember } = require('../../middleware/auth');
const { uploadLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

/**
 * POST /upload-async
 * Upload and process a document asynchronously using job queues
 */
router.post('/upload-async', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    await ensureSchemaInitialized();
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const {
      ontologyId,
      chunkingMethod = 'semantic',
      chunkSize = 1000,
      chunkOverlap = 200,
      schemaMode = 'constrained',
      csvProcessingMode = 'auto'
    } = req.body;

    // Get ontology if specified
    let ontology = null;
    if (ontologyId && ontologyId !== 'auto') {
      ontology = await ontologyTemplateService.getTemplate(ontologyId);
      if (!ontology) {
        ontology = await owlOntologyService.getOntologyStructure(tenantId || "default", workspaceId || "default", ontologyId);
      }
    }

    // Create pipeline job
    const pipelineId = uuidv4();
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const ext = path.extname(fileName).toLowerCase();

    // Queue the document processing job
    const job = await jobService.addJob('document-processing', {
      pipelineId,
      filePath,
      fileName,
      fileExtension: ext,
      ontology,
      ontologyId,
      chunkingMethod,
      chunkSize: parseInt(chunkSize),
      chunkOverlap: parseInt(chunkOverlap),
      schemaMode,
      csvProcessingMode
    });

    res.json({
      success: true,
      message: 'Document processing started',
      pipelineId,
      jobId: job.id,
      status: 'queued'
    });
  } catch (error) {
    console.error('Async upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /upload
 * Upload and process a document - stages for review, does NOT write directly to Neo4j
 * Use commit-staged endpoint after review to write to GraphDB, then sync to Neo4j
 */
router.post('/upload', uploadLimiter, upload.single('file'), optionalTenantContext, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const {
      chunkingMethod = 'semantic',
      chunkSize = 1000,
      chunkOverlap = 200
    } = req.body;
    
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] || 'default';

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const ext = path.extname(fileName).toLowerCase();
    const docId = uuidv4();
    const docUri = `doc://upload/${docId}`;

    // Parse document based on type
    let text = '';
    let csvData = null;

    if (ext === '.pdf') {
      const pdfResult = await pdfParser.parse(filePath);
      text = pdfResult.text;
    } else if (ext === '.csv') {
      const csvResult = await csvParser.parse(filePath);
      csvData = {
        headers: csvResult.headers,
        rows: csvResult.rows,
        rowCount: csvResult.rows?.length || 0
      };
      text = csvResult.text;
    } else if (ext === '.xlsx' || ext === '.xls') {
      const excelParser = require('../../services/excelParser');
      const parsed = await excelParser.parse(filePath);
      const flat = excelParser.flattenSheets(parsed);
      csvData = { headers: flat.headers, rows: flat.rows, rowCount: flat.rowCount };
      text = parsed.text;
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    // ── Chunk + Embed ──
    // Embeddings are generated at upload time so agents can query immediately.
    const chunks = await chunkingService.chunkText(text, {
      method: chunkingMethod,
      chunkSize: parseInt(chunkSize),
      chunkOverlap: parseInt(chunkOverlap)
    });

    const EMBED_PARALLEL = parseInt(process.env.EMBEDDING_PARALLELISM) || 10;
    let storedChunks = 0;
    const failedChunkIndices = [];
    for (let i = 0; i < chunks.length; i += EMBED_PARALLEL) {
      const batch = chunks.slice(i, i + EMBED_PARALLEL);
      const embedResults = await Promise.allSettled(batch.map(c => embeddingService.generateEmbedding(c.text)));
      await Promise.all(batch.map((chunk, j) => {
        if (embedResults[j].status === 'rejected') {
          failedChunkIndices.push(i + j);
          return Promise.resolve();
        }
        const chunkId = `${docId}_chunk_${i + j}`;
        return vectorStoreService.storeChunk({
          id: chunkId,
          text: chunk.text,
          documentId: docId,
          documentName: fileName,
          chunkIndex: i + j,
          startChar: chunk.startChar || 0,
          endChar: chunk.endChar || 0,
          start_page: chunk.start_page || chunk.metadata?.startPage || 0,
          end_page: chunk.end_page || chunk.metadata?.endPage || 0,
          section_title: chunk.section_title || '',
          heading_path: chunk.heading_path || '',
          tenant_id: tenantId,
          workspace_id: workspaceId,
          doc_type: ext.replace('.', ''),
          access_label: req.body.access_label || ''
        }, embedResults[j].value).then(() => { storedChunks++; }).catch(() => { failedChunkIndices.push(i + j); });
      }));
    }

    // Stage document for review (stored in Redis, not Neo4j)
    const redisService = require('../../services/redisService');

    // Create doc metadata — document is immediately queryable by agents
    const docMetadata = {
      uri: docUri,
      doc_id: docId,
      title: fileName,
      doc_type: ext.replace('.', ''),
      workspace_id: workspaceId,
      tenant_id: tenantId,
      folder_id: null,
      ontology_id: null,
      entity_count: 0,
      triple_count: 0,
      chunks_stored: storedChunks,
      embedding_failures: failedChunkIndices.length,
      status: 'uploaded',
      created_at: new Date().toISOString()
    };
    await redisService.set(`doc:${docId}`, JSON.stringify(docMetadata), 0);
    await redisService.sAdd(`workspace:${workspaceId}:docs`, docId);

    const staged = {
      type: csvData ? 'csv' : 'document',
      document: {
        doc_id: docId,
        uri: docUri,
        title: fileName,
        doc_type: ext.replace('.', ''),
        tenant_id: tenantId,
        workspace_id: workspaceId
      },
      csvData: csvData,
      chunks: chunks.map((c, i) => ({
        uri: `${docUri}#chunk=${i}`,
        chunk_id: `${docId}_chunk_${i}`,
        text: c.text,
        order: i,
        startChar: c.startChar || 0,
        endChar: c.endChar || 0,
        startPage: c.start_page || c.metadata?.startPage || 0,
        endPage: c.end_page || c.metadata?.endPage || 0
      })),
      headers: csvData?.headers,
      sampleRows: csvData?.rows?.slice(0, 5),
      rowCount: csvData?.rowCount,
      chunkCount: chunks.length,
      stagedAt: new Date().toISOString()
    };
    
    await redisService.set(`staged:${docId}`, JSON.stringify(staged), 0); // No TTL — cleaned up on doc delete

    // Cleanup uploaded file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: 'Document staged for review. Use commit-staged to write to GraphDB.',
      documentId: docId,
      documentUri: docUri,
      type: staged.type,
      chunksCreated: chunks.length,
      rowCount: csvData?.rowCount,
      staged: true
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /fm-upload
 * File Manager upload endpoint - stages document for review
 * Does NOT write directly to Neo4j - use commit-staged after review
 */
router.post('/fm-upload', uploadLimiter, upload.single('file'), optionalTenantContext, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const {
      folderId,
      chunkingMethod = 'semantic',
      chunkSize = 1000,
      chunkOverlap = 200
    } = req.body;
    
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] || 'default';

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const ext = path.extname(fileName).toLowerCase();
    const docId = uuidv4();
    const docUri = `doc://upload/${docId}`;

    // Parse document
    let text = '';
    let csvData = null;

    if (ext === '.pdf') {
      const pdfResult = await pdfParser.parse(filePath);
      text = pdfResult.text;
    } else if (ext === '.csv') {
      const csvResult = await csvParser.parse(filePath);
      csvData = {
        headers: csvResult.headers,
        rows: csvResult.rows,
        rowCount: csvResult.rows?.length || 0
      };
      text = csvResult.text;
    } else if (ext === '.xlsx' || ext === '.xls') {
      const excelParser = require('../../services/excelParser');
      const parsed = await excelParser.parse(filePath);
      const flat = excelParser.flattenSheets(parsed);
      csvData = { headers: flat.headers, rows: flat.rows, rowCount: flat.rowCount };
      text = parsed.text;
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    // Chunk the document
    const chunks = await chunkingService.chunkText(text, {
      method: chunkingMethod,
      chunkSize: parseInt(chunkSize),
      chunkOverlap: parseInt(chunkOverlap)
    });

    // ── Chunk + Embed ──
    // Embeddings are generated at upload time so agents can query immediately.
    const EMBED_PARALLEL = parseInt(process.env.EMBEDDING_PARALLELISM) || 10;
    let storedChunks = 0;
    const failedChunkIndices = [];
    for (let i = 0; i < chunks.length; i += EMBED_PARALLEL) {
      const batch = chunks.slice(i, i + EMBED_PARALLEL);
      const embedResults = await Promise.allSettled(batch.map(c => embeddingService.generateEmbedding(c.text)));
      await Promise.all(batch.map((chunk, j) => {
        if (embedResults[j].status === 'rejected') {
          failedChunkIndices.push(i + j);
          return Promise.resolve();
        }
        const chunkId = `${docId}_chunk_${i + j}`;
        return vectorStoreService.storeChunk({
          id: chunkId,
          text: chunk.text,
          documentId: docId,
          documentName: fileName,
          chunkIndex: i + j,
          startChar: chunk.startChar || 0,
          endChar: chunk.endChar || 0,
          start_page: chunk.start_page || chunk.metadata?.startPage || 0,
          end_page: chunk.end_page || chunk.metadata?.endPage || 0,
          section_title: chunk.section_title || '',
          heading_path: chunk.heading_path || '',
          tenant_id: tenantId,
          workspace_id: workspaceId,
          doc_type: ext.replace('.', ''),
          access_label: req.body.access_label || ''
        }, embedResults[j].value).then(() => { storedChunks++; }).catch(() => { failedChunkIndices.push(i + j); });
      }));
    }

    // Get folder's ontology if uploading to a folder
    let folderOntologyId = null;
    if (folderId) {
      const session = neo4jService.getSession();
      try {
        const result = await session.run(
          'MATCH (f:Folder {folder_id: $folderId}) RETURN f.ontology_id as ontologyId',
          { folderId }
        );
        if (result.records.length > 0) {
          folderOntologyId = result.records[0].get('ontologyId');
        }
      } finally {
        await session.close();
      }
    }

    // Stage document for review
    const redisService = require('../../services/redisService');

    // Create doc metadata immediately so agents can discover this document
    // even before the staged review is completed
    const docMetadata = {
      uri: docUri,
      doc_id: docId,
      title: fileName,
      doc_type: ext.replace('.', ''),
      workspace_id: workspaceId,
      tenant_id: tenantId,
      folder_id: folderId || null,
      ontology_id: folderOntologyId,
      entity_count: 0,
      triple_count: 0,
      chunks_stored: storedChunks,
      embedding_failures: failedChunkIndices.length,
      status: 'uploaded',
      created_at: new Date().toISOString()
    };
    await redisService.set(`doc:${docId}`, JSON.stringify(docMetadata), 0);
    await redisService.sAdd(`workspace:${workspaceId}:docs`, docId);

    const staged = {
      type: csvData ? 'csv' : 'document',
      document: {
        doc_id: docId,
        uri: docUri,
        title: fileName,
        doc_type: ext.replace('.', ''),
        folder_id: folderId || null,
        ontology_id: folderOntologyId,
        tenant_id: tenantId,
        workspace_id: workspaceId
      },
      csvData: csvData,
      chunks: chunks.map((c, i) => ({
        uri: `${docUri}#chunk=${i}`,
        chunk_id: `${docId}_chunk_${i}`,
        text: c.text,
        order: i,
        startChar: c.startChar || 0,
        endChar: c.endChar || 0,
        startPage: c.start_page || c.metadata?.startPage || 0,
        endPage: c.end_page || c.metadata?.endPage || 0
      })),
      headers: csvData?.headers,
      sampleRows: csvData?.rows?.slice(0, 5),
      rowCount: csvData?.rowCount,
      chunkCount: chunks.length,
      stagedAt: new Date().toISOString()
    };
    
    await redisService.set(`staged:${docId}`, JSON.stringify(staged), 0); // No TTL — cleaned up on doc delete

    // Cleanup uploaded file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: folderOntologyId 
        ? `Document staged with folder ontology (${folderOntologyId})`
        : 'Document staged for review',
      documentId: docId,
      documentUri: docUri,
      type: staged.type,
      chunksCreated: chunks.length,
      rowCount: csvData?.rowCount,
      staged: true,
      ontologyId: folderOntologyId
    });
  } catch (error) {
    console.error('FM upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /compare-extraction
 * Compare PDF text extraction vs OCR for a document
 */
router.post('/compare-extraction', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.pdf') {
    return res.status(400).json({ error: 'Only PDF files supported for extraction comparison' });
  }

  try {
    const filePath = req.file.path;
    
    // Get text extraction result
    const textResult = await pdfParser.parse(filePath);
    
    // Get OCR result
    const ocrResult = await ocrService.extractText(filePath);
    
    res.json({
      success: true,
      comparison: {
        textExtraction: {
          text: textResult.text,
          length: textResult.text.length,
          method: 'pdf-parse'
        },
        ocr: {
          text: ocrResult.text,
          length: ocrResult.text.length,
          method: 'tesseract'
        }
      }
    });
  } catch (error) {
    console.error('Extraction comparison error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /extract-with-ocr
 * Extract text from PDF using OCR only
 */
router.post('/extract-with-ocr', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const result = await ocrService.extractText(req.file.path);
    res.json({
      success: true,
      text: result.text,
      pages: result.pages,
      confidence: result.confidence
    });
  } catch (error) {
    console.error('OCR extraction error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /extraction-methods
 * Get available PDF text extraction methods
 */
router.get('/extraction-methods', (_req, res) => {
  res.json({
    methods: [
      { id: 'text', name: 'Text Extraction', description: 'Fast extraction using pdf-parse' },
      { id: 'ocr', name: 'OCR', description: 'Optical character recognition using Tesseract' },
      { id: 'hybrid', name: 'Hybrid', description: 'Try text extraction first, fall back to OCR' }
    ]
  });
});

module.exports = router;
