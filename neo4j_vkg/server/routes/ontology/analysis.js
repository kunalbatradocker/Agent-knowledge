/**
 * Schema Analysis Routes
 * Two-phase upload flow: analyze document, then create nodes
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Services
const pdfParser = require('../../services/pdfParser');
const schemaAnalysisService = require('../../services/schemaAnalysisService');

// Middleware & Shared
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { upload, cleanupFile } = require('./shared');

/**
 * POST /api/ontology/analyze
 * Phase 1: Analyze document and suggest schema (labels/types)
 * 
 * Body params:
 * - industry: Industry/domain hint (default: 'general')
 * - chunkingMethod: 'fixed' | 'page' (default: 'page' for PDFs)
 * - analysisMode: 'auto' | 'full' | 'sampled' (default: 'auto')
 *   - 'auto': Automatically choose based on document size
 *   - 'full': Always analyze full document (slower, more thorough)
 *   - 'sampled': Always sample from beginning/middle/end (faster)
 * - sampleSize: Total chars for sampled mode (default: 20000)
 * - maxChars: Max chars for full mode (default: 100000)
 */
router.post('/', upload.single('file'), optionalTenantContext, async (req, res) => {
  
  req.setTimeout(120000);
  
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const documentName = req.file.originalname;
    const industry = req.body.industry || 'general';
    const chunkingMethod = req.body.chunkingMethod || (ext === '.pdf' ? 'page' : 'fixed');
    
    // Analysis mode options
    const analysisMode = req.body.analysisMode || 'auto';
    const sampleSize = parseInt(req.body.sampleSize) || 20000;
    const maxChars = parseInt(req.body.maxChars) || 100000;
    
    const tenantContext = req.tenantContext || {};
    const tenantId = req.body.tenant_id || tenantContext.tenant_id || null;
    const workspaceId = req.body.workspace_id || tenantContext.workspace_id || null;

    console.log(`📊 Analyzing: ${documentName} | Industry: ${industry} | Mode: ${analysisMode} | Extension: ${ext}`);

    let analysis;
    let numPages = 1;

    console.log(`📊 File extension check: "${ext}" === ".csv" ? ${ext === '.csv'}`);

    try {
      if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
        console.log('📊 Tabular file detected, using analyzeCSV');
        let csvFilePath = filePath;
        // For Excel, flatten to CSV-compatible structure first
        if (ext === '.xlsx' || ext === '.xls') {
          const excelParser = require('../../services/excelParser');
          const parsed = await excelParser.parse(filePath);
          const flat = excelParser.flattenSheets(parsed);
          // Write a temp CSV for the analyzer (exclude synthetic __sheet column)
          const headers = flat.headers.filter(h => h !== '__sheet');
          const tmpPath = filePath + '.csv';
          const csvContent = [headers.join(','), ...flat.rows.map(r => headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');
          require('fs').writeFileSync(tmpPath, csvContent);
          csvFilePath = tmpPath;
        }
        analysis = await schemaAnalysisService.analyzeCSV(csvFilePath, {
          industry, documentName, chunkingMethod,
          tenant_id: tenantId, workspace_id: workspaceId
        });
        console.log('📊 CSV analysis complete:', {
          columns: analysis?.columns?.length,
          relationships: analysis?.relationships?.length
        });
      } else if (['.pdf', '.txt', '.md', '.html'].includes(ext)) {
        console.log('📊 Text/PDF file detected, using analyzeText');
        let text;
        if (ext === '.pdf') {
          const pdfData = await pdfParser.extractText(filePath);
          text = pdfData.text;
          numPages = pdfData.numPages || 1;
        } else {
          text = fs.readFileSync(filePath, 'utf-8');
        }

        analysis = await schemaAnalysisService.analyzeText(text, {
          industry, documentName, docType: ext.replace('.', ''),
          filePath, chunkingMethod, numPages,
          tenant_id: tenantId, workspace_id: workspaceId,
          // Analysis mode options
          analysisMode,
          sampleSize,
          maxChars
        });
      } else {
        return res.status(400).json({ 
          success: false,
          error: `Schema analysis not supported for ${ext} files.` 
        });
      }

      res.json({ success: true, analysis });
    } catch (analysisError) {
      console.error('Analysis error:', analysisError.message);
      
      // Fallback for LLM failures
      if (analysisError.message?.includes('LLM')) {
        analysis = {
          id: uuidv4(),
          documentName, industry, filePath,
          fileType: ext.replace('.', ''),
          chunkingMethod, numPages,
          analysisMode,
          tenant_id: tenantId, workspace_id: workspaceId,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          entityTypes: [], relationships: [],
          summary: { suggestedEntityTypes: 0, suggestedRelationships: 0, analysisMode }
        };
        await schemaAnalysisService.storeAnalysis(analysis.id, analysis);
        res.json({ success: true, analysis, warning: 'LLM unavailable, using basic structure' });
      } else {
        throw analysisError;
      }
    }
  } catch (error) {
    console.error('ANALYSIS ERROR:', error.message);
    cleanupFile(req.file?.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/analysis/:id
 * Get a pending analysis by ID
 */
router.get('/:id', async (req, res) => {
  try {
    let analysis = schemaAnalysisService.getAnalysis(req.params.id);
    if (!analysis) {
      analysis = await schemaAnalysisService.getAnalysisAsync(req.params.id);
    }
    if (!analysis) {
      return res.status(404).json({ success: false, error: 'Analysis not found or expired' });
    }
    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/analysis/:id
 * Update analysis with user edits
 */
router.put('/:id', async (req, res) => {
  try {
    const analysisId = req.params.id;
    const updates = req.body;
    
    let existingAnalysis = schemaAnalysisService.getAnalysis(analysisId);
    if (!existingAnalysis) {
      existingAnalysis = await schemaAnalysisService.getAnalysisAsync(analysisId);
    }
    
    if (!existingAnalysis) {
      return res.status(404).json({ 
        success: false, 
        error: 'Analysis not found or expired',
        message: 'Please re-analyze the file.'
      });
    }
    
    const analysis = schemaAnalysisService.updateAnalysis(analysisId, updates);
    if (!analysis) {
      return res.status(404).json({ success: false, error: 'Failed to update analysis' });
    }
    
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Error updating analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/analysis/:id
 * Cancel/delete a pending analysis
 */
router.delete('/:id', (_req, res) => {
  try {
    const deleted = schemaAnalysisService.deleteAnalysis(_req.params.id);
    res.json({ success: deleted, message: deleted ? 'Analysis cancelled' : 'Analysis not found' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
