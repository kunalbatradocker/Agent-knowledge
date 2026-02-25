/**
 * Extraction API Routes
 * Handles document processing and structured data extraction
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const extractionService = require('../services/extractionService');
const universalDataProcessor = require('../services/universalDataProcessor');
const enhancedExtractionService = require('../services/enhancedExtractionService');
const { UPLOAD } = require('../config/constants');
const logger = require('../utils/logger');
const { requireMember, requireManager } = require('../middleware/auth');

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: UPLOAD.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, UPLOAD.ALLOWED_EXTENSIONS.includes(ext));
  }
});

// Enhanced upload for universal processor
const enhancedUpload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    cb(null, universalDataProcessor.isSupported(file.originalname));
  }
});

// ============================================================
// ENHANCED EXTRACTION ENDPOINTS (Tier 1-3)
// ============================================================

/**
 * POST /api/extraction/enhanced
 * Enhanced extraction with multiple approaches (NER + LLM + Patterns)
 */
router.post('/enhanced', requireMember, enhancedUpload.single('file'), async (req, res) => {
  try {
    const { 
      ontologyId, 
      tenantId, 
      workspaceId,
      approaches = 'ner,llm,patterns',
      userFeedback = null
    } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!tenantId || !workspaceId) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    logger.info(`🚀 Enhanced extraction for: ${req.file.originalname}`);

    // Parse approaches
    const extractionApproaches = approaches.split(',').map(a => a.trim());

    // Parse user feedback if provided
    let feedback = null;
    if (userFeedback) {
      try {
        feedback = typeof userFeedback === 'string' ? JSON.parse(userFeedback) : userFeedback;
      } catch (e) {
        logger.warn('Invalid user feedback format:', e.message);
      }
    }

    // Process with universal processor
    const result = await universalDataProcessor.processFile(req.file.path, {
      ontologyId,
      tenantId,
      workspaceId,
      extractionApproaches,
      userFeedback: feedback
    });

    // Clean up uploaded file
    try {
      await fs.promises.unlink(req.file.path);
    } catch (cleanupError) {
      logger.warn('Failed to cleanup uploaded file:', cleanupError);
    }

    res.json({
      success: true,
      ...result,
      metadata: {
        ...result.metadata,
        approaches: extractionApproaches,
        extractedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Enhanced extraction failed:', error);
    
    // Clean up file on error
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupError) {
        logger.warn('Failed to cleanup file after error:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      error: 'Extraction failed', 
      details: error.message 
    });
  }
});

/**
 * POST /api/extraction/text
 * Enhanced text-only extraction
 */
router.post('/text', requireMember, async (req, res) => {
  try {
    const { 
      text, 
      ontologyId, 
      tenantId, 
      workspaceId,
      approaches = ['ner', 'llm', 'patterns'],
      userFeedback = null
    } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (!tenantId || !workspaceId) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    logger.info(`🧠 Enhanced text extraction: ${approaches.join('+')} approaches`);

    const result = await enhancedExtractionService.extract(text, ontologyId, {
      approaches,
      tenantId,
      workspaceId,
      userFeedback
    });

    res.json({
      success: true,
      extraction: result,
      metadata: {
        textLength: text.length,
        approaches: approaches,
        extractedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Enhanced text extraction failed:', error);
    res.status(500).json({ 
      error: 'Text extraction failed', 
      details: error.message 
    });
  }
});

/**
 * GET /api/extraction/supported-types
 * Get supported file types for enhanced extraction
 */
router.get('/supported-types', (req, res) => {
  res.json({
    types: universalDataProcessor.getSupportedTypes(),
    approaches: ['ner', 'llm', 'patterns', 'hybrid']
  });
});

// ============================================================
// DOCUMENT EXTRACTION ENDPOINTS
// ============================================================

/**
 * POST /api/extraction/documents
 * Upload and process a document
 */
router.post('/documents', requireMember, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const {
      tenant_id,
      workspace_id,
      ontology_version_id,
      extraction_profile_id
    } = req.body;

    if (!tenant_id || !workspace_id) {
      return res.status(400).json({ 
        error: 'tenant_id and workspace_id are required' 
      });
    }

    const documentId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fileType = path.extname(req.file.originalname).toLowerCase().replace('.', '');

    const result = await extractionService.processDocument(documentId, {
      tenant_id,
      workspace_id,
      ontology_version_id,
      extraction_profile_id,
      file_path: req.file.path,
      file_type: fileType,
      document_name: req.file.originalname,
      created_by: req.body.user_id
    });

    res.json({
      success: true,
      document_id: documentId,
      ...result
    });

  } catch (error) {
    console.error('[POST /extraction/documents] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/extraction/documents/:docId/process
 * Process an existing document
 */
router.post('/documents/:docId/process', requireMember, async (req, res) => {
  try {
    const { docId } = req.params;
    const {
      tenant_id,
      workspace_id,
      ontology_version_id,
      extraction_profile_id,
      file_path,
      file_type
    } = req.body;

    if (!tenant_id || !workspace_id) {
      return res.status(400).json({ 
        error: 'tenant_id and workspace_id are required' 
      });
    }

    const result = await extractionService.processDocument(docId, {
      tenant_id,
      workspace_id,
      ontology_version_id,
      extraction_profile_id,
      file_path,
      file_type,
      created_by: req.body.user_id
    });

    res.json(result);

  } catch (error) {
    console.error('[POST /extraction/documents/:docId/process] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction/documents/:docId/status
 * Get extraction status for a document
 */
router.get('/documents/:docId/status', async (req, res) => {
  try {
    const { docId } = req.params;
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const runs = await extractionService.listRuns(tenant_id, {
      document_id: docId
    });

    if (runs.length === 0) {
      return res.status(404).json({ error: 'No extraction runs found for document' });
    }

    // Return most recent run
    res.json(runs[0]);

  } catch (error) {
    console.error('[GET /extraction/documents/:docId/status] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction/documents/:docId/extractions
 * Get extraction results for a document
 */
router.get('/documents/:docId/extractions', async (req, res) => {
  try {
    const { docId } = req.params;
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const runs = await extractionService.listRuns(tenant_id, {
      document_id: docId
    });

    res.json({
      document_id: docId,
      runs: runs.map(r => ({
        run_id: r.run_id,
        state: r.state,
        stats: r.stats,
        created_at: r.created_at,
        completed_at: r.completed_at
      }))
    });

  } catch (error) {
    console.error('[GET /extraction/documents/:docId/extractions] Error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================
// STRUCTURED DATA EXTRACTION ENDPOINTS
// ============================================================

/**
 * POST /api/extraction/datasources
 * Register a new data source
 */
router.post('/datasources', requireMember, async (req, res) => {
  try {
    const {
      tenant_id,
      name,
      type,
      connection_config
    } = req.body;

    if (!tenant_id || !name || !type) {
      return res.status(400).json({ 
        error: 'tenant_id, name, and type are required' 
      });
    }

    // Store datasource config (simplified - would use proper storage)
    const datasource = {
      datasource_id: `ds_${Date.now()}`,
      tenant_id,
      name,
      type,
      connection_config,
      created_at: new Date().toISOString()
    };

    res.json({
      success: true,
      datasource
    });

  } catch (error) {
    console.error('[POST /extraction/datasources] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/extraction/datasources/:id/mapping-spec
 * Define mapping specification for a data source
 */
router.post('/datasources/:id/mapping-spec', requireMember, async (req, res) => {
  try {
    const { id } = req.params;
    const { mapping_spec } = req.body;

    if (!mapping_spec || !mapping_spec.tables) {
      return res.status(400).json({ 
        error: 'mapping_spec with tables array is required' 
      });
    }

    // Validate mapping spec structure
    for (const table of mapping_spec.tables) {
      if (!table.source_table || !table.target_class) {
        return res.status(400).json({
          error: 'Each table mapping requires source_table and target_class'
        });
      }
    }

    res.json({
      success: true,
      datasource_id: id,
      mapping_spec
    });

  } catch (error) {
    console.error('[POST /extraction/datasources/:id/mapping-spec] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/extraction/datasources/:id/run
 * Execute extraction from a data source
 */
router.post('/datasources/:id/run', requireMember, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      workspace_id,
      ontology_version_id,
      mapping_spec
    } = req.body;

    if (!tenant_id || !workspace_id) {
      return res.status(400).json({ 
        error: 'tenant_id and workspace_id are required' 
      });
    }

    if (!mapping_spec) {
      return res.status(400).json({ 
        error: 'mapping_spec is required' 
      });
    }

    const result = await extractionService.processStructuredSource(
      id,
      mapping_spec,
      {
        tenant_id,
        workspace_id,
        ontology_version_id,
        created_by: req.body.user_id
      }
    );

    res.json(result);

  } catch (error) {
    console.error('[POST /extraction/datasources/:id/run] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction/runs/:runId
 * Get extraction run details
 */
router.get('/runs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;

    const run = await extractionService.getRun(runId);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.json(run);

  } catch (error) {
    console.error('[GET /extraction/runs/:runId] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

/**
 * GET /api/extraction/candidate-concepts
 * List candidate concepts for a tenant
 */
router.get('/candidate-concepts', async (req, res) => {
  try {
    const { tenant_id, workspace_id, status } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const ontologyPackService = require('../services/ontologyPackService');
    const candidates = await ontologyPackService.listCandidateConcepts(tenant_id, {
      workspace_id,
      status
    });

    res.json({ candidates });

  } catch (error) {
    console.error('[GET /extraction/candidate-concepts] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/extraction/candidate-concepts/:id/convert-to-class
 * Convert a candidate concept to an ontology class
 */
router.post('/candidate-concepts/:id/convert-to-class', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { version_id, class_data, user_id } = req.body;

    if (!version_id) {
      return res.status(400).json({ 
        error: 'version_id is required (must be a DRAFT version)' 
      });
    }

    const ontologyPackService = require('../services/ontologyPackService');
    const result = await ontologyPackService.convertCandidateToClass(
      id,
      version_id,
      class_data || {},
      user_id
    );

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('[POST /extraction/candidate-concepts/:id/convert-to-class] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction/quarantine
 * Get quarantined records
 */
router.get('/quarantine', async (req, res) => {
  try {
    const { tenant_id, limit } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const records = await extractionService.getQuarantinedRecords(tenant_id, {
      limit: parseInt(limit) || 100
    });

    res.json({ records });

  } catch (error) {
    console.error('[GET /extraction/quarantine] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction/stats
 * Get extraction statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const stats = await extractionService.getExtractionStats(tenant_id);
    res.json(stats);

  } catch (error) {
    console.error('[GET /extraction/stats] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
