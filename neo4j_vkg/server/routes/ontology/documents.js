/**
 * Document Management Routes
 * CRUD operations for documents in the knowledge graph
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const neo4jService = require('../../services/neo4jService');
const redisService = require('../../services/redisService');
const vectorStoreService = require('../../services/vectorStoreService');
const pdfParser = require('../../services/pdfParser');
const csvParser = require('../../services/csvParser');
const chunkingService = require('../../services/chunkingService');
const conceptExtractionService = require('../../services/conceptExtractionService');
const ontologyTemplateService = require('../../services/ontologyTemplateService');
const owlOntologyService = require('../../services/owlOntologyService');
const schemaAnalysisService = require('../../services/schemaAnalysisService');
const graphRagExtractionService = require('../../services/graphRagExtractionService');
const ocrService = require('../../services/ocrService');
const ontologyJobService = require('../../services/ontologyJobService');
const extractionContractService = require('../../services/extractionContractService');
const reviewQueueService = require('../../services/reviewQueueService');
const metricsService = require('../../services/metricsService');
const csvSchemaAnalyzer = require('../../services/csvSchemaAnalyzer');
const auditService = require('../../services/auditService');
const entityUriService = require('../../services/entityUriService');
const logger = require('../../utils/logger');
const ontologyVersioningService = require('../../services/ontologyVersioningService');
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { upload, ensureSchemaInitialized, cleanupFile, sanitizeLabel } = require('./shared');

const isTabularType = (type) => ['csv', 'xlsx', 'xls'].includes(type);

/**
 * Verify a document belongs to the given workspace.
 * Returns the doc metadata if valid, null otherwise.
 */
async function verifyDocWorkspace(docId, workspaceId) {
  if (!workspaceId) return null;
  const docJson = await redisService.get(`doc:${docId}`);
  if (!docJson) return null;
  const doc = JSON.parse(docJson);
  if (doc.workspace_id && doc.workspace_id !== workspaceId) return null;
  return doc;
}

// Sample rows from all sheets (uses __sheet column to pick from each sheet)
function sampleFromAllSheets(rows, count = 5) {
  if (!rows || rows.length === 0) return [];
  const sheets = {};
  for (const r of rows) {
    const s = r.__sheet || '_default';
    if (!sheets[s]) sheets[s] = [];
    sheets[s].push(r);
  }
  const sheetKeys = Object.keys(sheets);
  if (sheetKeys.length <= 1) return rows.slice(0, count);
  const perSheet = Math.max(1, Math.floor(count / sheetKeys.length));
  const sampled = [];
  for (const key of sheetKeys) {
    sampled.push(...sheets[key].slice(0, perSheet));
  }
  return sampled.slice(0, count);
}

// Derive sheet info from __sheet column when sheets metadata wasn't stored
function deriveSheets(csvData) {
  if (!csvData?.rows) return null;
  const sheetMap = {};
  for (const r of csvData.rows) {
    const s = r.__sheet;
    if (!s) return null; // no __sheet column = plain CSV
    if (!sheetMap[s]) sheetMap[s] = { name: s, headers: [], rowCount: 0 };
    sheetMap[s].rowCount++;
  }
  const sheets = Object.values(sheetMap);
  if (sheets.length <= 1) return null;
  // Derive headers per sheet from non-empty values
  const allHeaders = (csvData.headers || []).filter(h => h !== '__sheet');
  for (const sheet of sheets) {
    const sheetRows = csvData.rows.filter(r => r.__sheet === sheet.name);
    sheet.headers = allHeaders.filter(h => sheetRows.some(r => r[h] != null && r[h] !== ''));
  }
  return sheets;
}

/**
 * GET /api/ontology/documents
 * Get all documents with summary info (from Redis)
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    
    // Get document IDs from workspace index in Redis
    const docIds = workspaceId 
      ? await redisService.sMembers(`workspace:${workspaceId}:docs`)
      : [];
    
    const documents = [];
    for (const docId of docIds) {
      const docJson = await redisService.get(`doc:${docId}`);
      if (docJson) {
        const doc = JSON.parse(docJson);
        documents.push({
          doc_id: doc.doc_id,
          uri: doc.uri,
          title: doc.title,
          doc_type: doc.doc_type,
          entity_count: doc.entity_count || 0,
          triple_count: doc.triple_count || 0,
          chunks_stored: doc.chunks_stored || 0,
          ontology_id: doc.ontology_id,
          created_at: doc.committed_at,
          folderId: doc.folder_id
        });
      }
    }
    
    // Sort by created_at desc
    documents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ success: true, documents });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/staged
 * List all staged documents with expiration info - MUST be before /:id route
 */
router.get('/staged', async (req, res) => {
  try {
    const redisService = require('../../services/redisService');
    const stagedDocs = [];
    const now = new Date();
    const warningThreshold = 24 * 60 * 60 * 1000; // 24 hours
    
    // Get jobs with staged docs
    const jobs = await ontologyJobService.getJobs({ limit: 100 });
    const stagedJobs = jobs.filter(j => j.staged && j.staged_doc_id);
    const jobDocIds = new Set(stagedJobs.map(j => j.staged_doc_id));
    
    // Add staged docs from jobs
    for (const job of stagedJobs) {
      const stagedJson = await redisService.get(`staged:${job.staged_doc_id}`);
      if (stagedJson) {
        const staged = JSON.parse(stagedJson);
        const expiresAt = staged.expiresAt ? new Date(staged.expiresAt) : null;
        const timeUntilExpiry = expiresAt ? expiresAt.getTime() - now.getTime() : null;
        
        stagedDocs.push({
          docId: job.staged_doc_id,
          jobId: job.job_id,
          fileName: job.file_name,
          title: staged.document?.title || job.file_name || 'Untitled',
          type: staged.type,
          rowCount: staged.csvData?.rowCount || staged.chunks?.length || 0,
          headers: staged.csvData?.headers,
          createdAt: job.created_at,
          stagedAt: staged.stagedAt,
          expiresAt: staged.expiresAt,
          expiringWarning: timeUntilExpiry !== null && timeUntilExpiry < warningThreshold,
          hoursUntilExpiry: timeUntilExpiry !== null ? Math.floor(timeUntilExpiry / (60 * 60 * 1000)) : null
        });
      }
    }
    
    // Also scan Redis for orphaned staged docs (no job)
    try {
      const allStagedKeys = await redisService.keys('staged:*');
      for (const key of allStagedKeys) {
        const docId = key.replace('staged:', '');
        if (!jobDocIds.has(docId)) {
          const stagedJson = await redisService.get(key);
          if (stagedJson) {
            const staged = JSON.parse(stagedJson);
            stagedDocs.push({
              docId,
              jobId: null,
              fileName: staged.document?.title || 'Untitled',
              title: staged.document?.title || 'Untitled',
              type: staged.type,
              rowCount: staged.csvData?.rowCount || staged.chunks?.length || 0,
              stagedAt: staged.stagedAt,
              orphaned: true
            });
          }
        }
      }
    } catch (e) {
      logger.warn('Could not scan for orphaned staged docs:', e.message);
    }
    
    // Sort by creation time (newest first)
    stagedDocs.sort((a, b) => {
      const aTime = a.stagedAt || a.createdAt || '';
      const bTime = b.stagedAt || b.createdAt || '';
      return bTime.localeCompare(aTime);
    });
    
    const expiringCount = stagedDocs.filter(d => d.expiringWarning).length;
    const orphanedCount = stagedDocs.filter(d => d.orphaned).length;
    
    res.json({ 
      success: true, 
      staged: stagedDocs,
      summary: {
        total: stagedDocs.length,
        expiringSoon: expiringCount,
        orphaned: orphanedCount,
        warning: expiringCount > 0 ? `${expiringCount} document(s) expiring within 24 hours` : null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/data-profile
 * Deterministic column profiling — no LLM needed.
 * Returns data types, cardinality, FK candidates, etc.
 * Use this BEFORE LLM analysis to show instant results.
 */
router.post('/data-profile', async (req, res) => {
  try {
    const { headers, sampleRows = [], sheets } = req.body;
    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      return res.status(400).json({ success: false, error: 'headers array is required' });
    }
    
    const dataProfileService = require('../../services/dataProfileService');
    const profile = dataProfileService.profileColumns(headers, sampleRows, { sheets });
    
    res.json({ success: true, profile });
  } catch (error) {
    logger.error('Data profiling failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/analyze-csv-schema
 * LLM-based CSV schema analysis for ONTOLOGY CREATION
 * Use this when creating a new ontology from CSV structure
 */
router.post('/analyze-csv-schema', async (req, res) => {
  try {
    const { headers, sampleRows = [], sheets } = req.body;
    
    if (!headers || !Array.isArray(headers)) {
      return res.status(400).json({ success: false, error: 'headers array required' });
    }

    const llmCsvAnalyzer = require('../../services/llmCsvAnalyzer');
    console.log(`📊 analyze-csv-schema: ${headers.length} headers, ${sampleRows.length} sampleRows, ${sheets?.length || 0} sheets`);
    console.log(`📊 Headers: ${headers.join(', ')}`);
    if (sampleRows.length > 0) {
      const row = sampleRows[0];
      const nonEmpty = headers.filter(h => row[h] != null && row[h] !== '');
      console.log(`📊 Row 0 non-empty cols: ${nonEmpty.length}/${headers.length} — ${nonEmpty.slice(0, 5).map(h => `${h}=${row[h]}`).join(', ')}`);
    }
    const analysis = await llmCsvAnalyzer.analyze(headers, sampleRows, { sheets });

    res.json({ success: true, analysis });
  } catch (error) {
    logger.error('CSV schema analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/csv-data
 * Query CSV data from GraphDB with pagination
 */
router.get('/csv-data', async (req, res) => {
  try {
    const { docUri, limit = 50, offset = 0 } = req.query;
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    
    if (!docUri) {
      return res.status(400).json({ success: false, error: 'docUri required' });
    }

    const graphDBStore = require('../../services/graphDBStore');
    
    // First get total count and discover properties
    const countQuery = `
      SELECT (COUNT(DISTINCT ?s) as ?total) WHERE {
        ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
      }
    `;
    const countResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, countQuery, 'data');
    const total = parseInt(countResult?.results?.bindings?.[0]?.total?.value || 0);
    
    // Get properties used
    const propsQuery = `
      SELECT DISTINCT ?p WHERE {
        ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
        ?s ?p ?o .
        FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
        FILTER(?p != <http://purplefabric.ai/ontology#sourceDocument>)
      } LIMIT 50
    `;
    const propsResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, propsQuery, 'data');
    const columns = (propsResult?.results?.bindings || []).map(b => {
      const iri = b.p?.value || '';
      return iri.split('#').pop() || iri.split('/').pop() || iri;
    });
    
    // Get data rows
    const dataQuery = `
      SELECT ?s ?p ?o WHERE {
        ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
        ?s ?p ?o .
        FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
      }
      ORDER BY ?s
      LIMIT ${parseInt(limit) * 20}
      OFFSET ${parseInt(offset) * 20}
    `;
    const dataResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, dataQuery, 'data');
    
    // Group by subject
    const rowMap = new Map();
    for (const b of dataResult?.results?.bindings || []) {
      const subj = b.s?.value;
      const prop = b.p?.value?.split('#').pop() || b.p?.value?.split('/').pop();
      const val = b.o?.value;
      if (!rowMap.has(subj)) rowMap.set(subj, {});
      rowMap.get(subj)[prop] = val;
    }
    
    const rows = Array.from(rowMap.values()).slice(0, parseInt(limit));
    
    res.json({ success: true, columns, rows, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (error) {
    logger.error('CSV data query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/analyze-csv-mapping
 * LLM-based CSV mapping analysis for EXISTING ONTOLOGY
 * Use this when mapping CSV columns to an existing ontology's classes/properties
 */
router.post('/analyze-csv-mapping', async (req, res) => {
  try {
    const { headers, sampleRows = [], ontology, sheets } = req.body;
    
    if (!headers || !Array.isArray(headers)) {
      return res.status(400).json({ success: false, error: 'headers array required' });
    }
    if (!ontology) {
      return res.status(400).json({ success: false, error: 'ontology structure required' });
    }

    const llmCsvAnalyzer = require('../../services/llmCsvAnalyzer');
    const result = await llmCsvAnalyzer.analyzeForMapping(headers, sampleRows, ontology, { sheets });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('CSV mapping analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/analyze-text-schema
 * LLM-based text schema analysis for ONTOLOGY CREATION
 * Use this when creating a new ontology from text document
 */
router.post('/analyze-text-schema', async (req, res) => {
  try {
    const { text, sampleChunks } = req.body;
    
    // Accept either full text or sample chunks
    const textContent = text || (sampleChunks?.map(c => c.text).join('\n\n') || '');
    
    if (!textContent) {
      return res.status(400).json({ success: false, error: 'text or sampleChunks required' });
    }

    const llmCsvAnalyzer = require('../../services/llmCsvAnalyzer');
    const analysis = await llmCsvAnalyzer.analyzeTextForSchema(textContent);

    res.json({ success: true, analysis });
  } catch (error) {
    logger.error('Text schema analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/analyze-text-mapping
 * LLM-based text mapping analysis for EXISTING ONTOLOGY
 * Use this when mapping text document concepts to existing ontology
 */
router.post('/analyze-text-mapping', async (req, res) => {
  try {
    const { text, sampleChunks, ontology } = req.body;
    
    const textContent = text || (sampleChunks?.map(c => c.text).join('\n\n') || '');
    
    if (!textContent) {
      return res.status(400).json({ success: false, error: 'text or sampleChunks required' });
    }
    if (!ontology) {
      return res.status(400).json({ success: false, error: 'ontology structure required' });
    }

    const llmCsvAnalyzer = require('../../services/llmCsvAnalyzer');
    const result = await llmCsvAnalyzer.analyzeTextForMapping(textContent, ontology);

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Text mapping analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/suggest-column-mapping
 * Get AI suggestion for a single column mapping
 */
router.post('/suggest-column-mapping', async (req, res) => {
  try {
    const { column, sampleValues, ontologyClasses, ontologyProperties } = req.body;
    if (!column) {
      return res.status(400).json({ success: false, error: 'column required' });
    }
    const llmCsvAnalyzer = require('../../services/llmCsvAnalyzer');
    const suggestion = await llmCsvAnalyzer.suggestMapping(column, sampleValues || [], ontologyClasses || [], ontologyProperties || []);
    res.json({ success: true, suggestion });
  } catch (error) {
    logger.error('Column mapping suggestion error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/staged/:docId
 * Get specific staged document
 */
router.get('/staged/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const redisService = require('../../services/redisService');
    const stagedJson = await redisService.get(`staged:${docId}`);
    
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged document not found' });
    }

    const staged = JSON.parse(stagedJson);
    
    // Return different structure based on type
    if (isTabularType(staged.type)) {
      res.json({
        success: true,
        staged: {
          docId,
          type: staged.type,
          document: staged.document,
          headers: (staged.csvData?.headers || []).filter(h => h !== '__sheet'),
          rowCount: staged.csvData?.rowCount,
          sampleRows: sampleFromAllSheets(staged.csvData?.rows, 10),
          sheets: staged.csvData?.sheets || deriveSheets(staged.csvData),
          summary: staged.csvData?.summary
        }
      });
    } else {
      // PDF/text document
      res.json({
        success: true,
        staged: {
          docId,
          type: staged.type,
          document: staged.document,
          chunkCount: staged.chunks?.length || 0,
          sampleChunks: (() => {
            const chunks = staged.chunks || [];
            if (chunks.length <= 8) return chunks.map(c => ({ text: c.text?.substring(0, 1500), order: c.order }));
            // Sample from beginning, middle, and end for better coverage
            const indices = [
              0, 1, 2,
              Math.floor(chunks.length * 0.25),
              Math.floor(chunks.length * 0.5),
              Math.floor(chunks.length * 0.5) + 1,
              Math.floor(chunks.length * 0.75),
              chunks.length - 1
            ];
            const unique = [...new Set(indices)].filter(i => i < chunks.length);
            return unique.map(i => ({ text: chunks[i].text?.substring(0, 1500), order: chunks[i].order }));
          })(),
          textPreview: staged.text?.substring(0, 2000)
        }
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/documents/staged/:docId
 * Delete a staged document
 */
router.delete('/staged/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const redisService = require('../../services/redisService');
    
    // Delete from Redis
    await redisService.del(`staged:${docId}`);
    
    // Delete associated job if exists
    const jobs = await ontologyJobService.getJobs({ limit: 100 });
    const job = jobs.find(j => j.staged_doc_id === docId);
    if (job) {
      await ontologyJobService.deleteJob(job.job_id);
    }
    
    res.json({ success: true, message: 'Staged document deleted' });
  } catch (error) {
    logger.error('Error deleting staged document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/extract-entities
 * Extract entities from text document chunks using LLM
 */
router.post('/extract-entities', async (req, res) => {
  try {
    const { docId, ontologyId, sampleOnly = true, maxChunks = 3 } = req.body;
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] || 'default';
    
    // Get staged document
    const stagedJson = await redisService.get(`staged:${docId}`);
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged document not found' });
    }
    const staged = JSON.parse(stagedJson);
    
    if (!staged.chunks || staged.chunks.length === 0) {
      return res.status(400).json({ success: false, error: 'No text chunks to extract from' });
    }
    
    // Get ontology structure if provided
    let ontologyClasses = [];
    let ontologyRelationships = [];
    if (ontologyId) {
      try {
        const owlService = require('../../services/owlOntologyService');
        const structure = await owlService.getOntologyStructure(
          tenantId,
          workspaceId,
          ontologyId
        );
        ontologyClasses = structure.classes || [];
        ontologyRelationships = structure.properties?.filter(p => p.type === 'objectProperty') || [];
      } catch (e) {
        logger.warn('Could not load ontology structure:', e.message);
      }
    }
    
    // Build extraction prompt
    const classDesc = ontologyClasses.length > 0
      ? ontologyClasses.map(c => `- ${c.localName}: ${c.comment || 'No description'}`).join('\n')
      : 'Extract any relevant entities (Person, Organization, Location, Date, Event, etc.)';
    
    const relDesc = ontologyRelationships.length > 0
      ? ontologyRelationships.map(r => `- ${r.localName}: ${r.domain || 'Any'} → ${r.range || 'Any'}`).join('\n')
      : 'Extract any relevant relationships between entities';
    
    // Extract from sample chunks
    const chunksToProcess = sampleOnly ? staged.chunks.slice(0, maxChunks) : staged.chunks;
    const combinedText = chunksToProcess.map(c => c.text).join('\n\n---\n\n');
    
    const llmService = require('../../services/llmService');
    const prompt = `Extract entities and relationships from this text.

ENTITY TYPES TO EXTRACT:
${classDesc}

RELATIONSHIP TYPES:
${relDesc}

TEXT:
${combinedText.substring(0, 15000)}

Return JSON:
{
  "entities": [{"class": "Type", "name": "entity name", "confidence": 0.9, "evidence": "quote from text"}],
  "relationships": [{"type": "REL_TYPE", "from_entity": "name", "to_entity": "name", "confidence": 0.8}]
}`;

    const response = await llmService.chat([
      { role: 'user', content: prompt }
    ], { temperature: 0.1 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      return res.json({ success: true, entities: [], relationships: [], message: 'No entities found' });
    }
    
    let extraction;
    try {
      extraction = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Attempt repair: truncate to last valid array close
      let raw = jsonMatch[0];
      // Try closing open arrays/objects
      const lastEntities = raw.lastIndexOf('"entities"');
      const lastRels = raw.lastIndexOf('"relationships"');
      // Find last complete object in entities array
      const lastCloseBrace = raw.lastIndexOf('}');
      if (lastCloseBrace > 0) {
        raw = raw.substring(0, lastCloseBrace + 1);
        // Close any open arrays and the root object
        const opens = (raw.match(/\[/g) || []).length;
        const closes = (raw.match(/\]/g) || []).length;
        for (let i = 0; i < opens - closes; i++) raw += ']';
        if (!raw.endsWith('}')) raw += '}';
        try {
          extraction = JSON.parse(raw);
        } catch {
          extraction = { entities: [], relationships: [] };
        }
      } else {
        extraction = { entities: [], relationships: [] };
      }
    }
    
    res.json({
      success: true,
      entities: extraction.entities || [],
      relationships: extraction.relationships || [],
      chunksProcessed: chunksToProcess.length,
      totalChunks: staged.chunks.length
    });
    
  } catch (error) {
    logger.error('Error extracting entities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/mapping-templates
 * List all saved mapping templates for a workspace.
 * Returns one entry per ontology that has a saved mapping.
 * MUST be before /:id catch-all
 */
router.get('/mapping-templates', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const pattern = `colmap:${workspaceId}:*`;
    const templates = [];
    const keys = await redisService.keys(pattern);
    for (const key of keys) {
      try {
        const raw = await redisService.get(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const ontologyId = key.split(':').slice(2).join(':');
        templates.push({
          ontologyId,
          primaryClass: parsed.primaryClass || null,
          columnCount: Object.keys(parsed.columnMappings || {}).length,
          version: parsed.version || 1,
          savedAt: parsed.savedAt,
          sourceHeaders: parsed.sourceHeaders || Object.keys(parsed.columnMappings || {}),
          ontologyVersionId: parsed.ontologyVersionId || null,
        });
      } catch (e) { /* skip malformed */ }
    }
    res.json({ success: true, templates });
  } catch (error) {
    logger.error('Failed to list mapping templates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/documents/mapping-templates
 * Delete a saved mapping template for a workspace+ontology combination.
 * MUST be before /:id catch-all
 */
router.delete('/mapping-templates', async (req, res) => {
  try {
    const { ontologyId, workspaceId } = req.query;
    if (!ontologyId || !workspaceId) {
      return res.status(400).json({ success: false, error: 'ontologyId and workspaceId are required' });
    }
    const key = `colmap:${workspaceId}:${ontologyId}`;
    const historyKey = `colmap_history:${workspaceId}:${ontologyId}`;
    await redisService.del(key);
    await redisService.del(historyKey);
    res.json({ success: true, message: 'Mapping template deleted' });
  } catch (error) {
    logger.error('Failed to delete mapping template:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/column-mappings
 * Load saved column mappings for a workspace+ontology combination.
 * Now supports versioning — returns the latest version and version history.
 * MUST be before /:id catch-all
 */
router.get('/column-mappings', async (req, res) => {
  try {
    const { ontologyId, workspaceId } = req.query;
    if (!ontologyId || !workspaceId) {
      return res.status(400).json({ success: false, error: 'ontologyId and workspaceId are required' });
    }
    const key = `colmap:${workspaceId}:${ontologyId}`;
    const saved = await redisService.get(key);
    if (!saved) return res.json({ success: true, mappings: null });
    const parsed = JSON.parse(saved);
    
    // Load version history
    const historyKey = `colmap_history:${workspaceId}:${ontologyId}`;
    let versions = [];
    try {
      const historyJson = await redisService.get(historyKey);
      if (historyJson) versions = JSON.parse(historyJson);
    } catch (e) { /* no history */ }
    
    // Check ontology version staleness
    let ontologyStale = null;
    if (parsed.ontologyVersionId && ontologyId) {
      try {
        const currentVersion = await ontologyVersioningService.getCurrentVersion(ontologyId);
        if (currentVersion && currentVersion !== parsed.ontologyVersionId) {
          // Diff the two versions to show what changed
          let diff = null;
          try {
            diff = await ontologyVersioningService.compareVersions(ontologyId, parsed.ontologyVersionId, currentVersion);
          } catch (e) { /* version may have been pruned */ }
          ontologyStale = {
            mappingBuiltFor: parsed.ontologyVersionId,
            currentVersion,
            diff: diff?.summary || null
          };
        }
      } catch (e) {
        logger.warn('Could not check ontology version staleness:', e.message);
      }
    }

    res.json({ 
      success: true, 
      mappings: parsed.columnMappings, 
      primaryClass: parsed.primaryClass, 
      sheetClassMap: parsed.sheetClassMap, 
      savedAt: parsed.savedAt,
      version: parsed.version || 1,
      ontologyVersionId: parsed.ontologyVersionId || null,
      sourceHeaders: parsed.sourceHeaders || [],
      versions: versions.slice(0, 10), // last 10 versions
      ontologyStale,
    });
  } catch (error) {
    logger.error('Failed to load column mappings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/column-mappings
 * Save column mappings for a workspace+ontology combination.
 * Now versioned — previous mappings are archived in history.
 */
router.post('/column-mappings', async (req, res) => {
  try {
    const { ontologyId, workspaceId, columnMappings, primaryClass, sheetClassMap, sourceHeaders } = req.body;
    if (!ontologyId || !workspaceId || !columnMappings) {
      return res.status(400).json({ success: false, error: 'ontologyId, workspaceId, and columnMappings are required' });
    }
    const key = `colmap:${workspaceId}:${ontologyId}`;
    const historyKey = `colmap_history:${workspaceId}:${ontologyId}`;
    
    // Get current ontology version to stamp the mapping
    let ontologyVersionId = null;
    try {
      ontologyVersionId = await ontologyVersioningService.getCurrentVersion(ontologyId);
    } catch (e) { /* versioning may not be initialized */ }

    // Archive current version before overwriting
    const existing = await redisService.get(key);
    if (existing) {
      let history = [];
      try {
        const historyJson = await redisService.get(historyKey);
        if (historyJson) history = JSON.parse(historyJson);
      } catch (e) { /* no history */ }
      
      const prev = JSON.parse(existing);
      history.unshift({
        version: prev.version || 1,
        savedAt: prev.savedAt,
        columnCount: Object.keys(prev.columnMappings || {}).length,
        primaryClass: prev.primaryClass,
        sourceHeaders: prev.sourceHeaders || [],
        ontologyVersionId: prev.ontologyVersionId || null,
      });
      // Keep last 20 versions
      if (history.length > 20) history = history.slice(0, 20);
      await redisService.set(historyKey, JSON.stringify(history), 0);
    }
    
    // Compute new version number
    const prevVersion = existing ? (JSON.parse(existing).version || 1) : 0;
    const newVersion = prevVersion + 1;
    
    // Detect column changes from previous mapping
    let columnChanges = null;
    if (existing) {
      const prev = JSON.parse(existing);
      const prevHeaders = new Set(prev.sourceHeaders || Object.keys(prev.columnMappings || {}));
      const newHeaders = new Set(sourceHeaders || Object.keys(columnMappings));
      const added = [...newHeaders].filter(h => !prevHeaders.has(h));
      const removed = [...prevHeaders].filter(h => !newHeaders.has(h));
      if (added.length > 0 || removed.length > 0) {
        columnChanges = { added, removed };
        logger.info(`[column-mappings] v${newVersion}: ${added.length} columns added, ${removed.length} removed`);
      }
    }
    
    await redisService.set(key, JSON.stringify({ 
      columnMappings, primaryClass, sheetClassMap, 
      sourceHeaders: sourceHeaders || Object.keys(columnMappings),
      savedAt: new Date().toISOString(),
      version: newVersion,
      ontologyVersionId,
    }), 0);
    
    res.json({ success: true, message: 'Column mappings saved', version: newVersion, columnChanges, ontologyVersionId });
  } catch (error) {
    logger.error('Failed to save column mappings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/:id
 * Get document details with chunks from Redis (primary data store)
 * Falls back to Neo4j only if Redis has no data
 * Supports pagination via query params:
 *   entityLimit, entityOffset, relationLimit, relationOffset
 * Supports server-side filtering:
 *   entitySearch, entityTypeFilter, relationSearch, relationPredicateFilter
 */
router.get('/:id', optionalTenantContext, async (req, res) => {
  try {
    const docId = req.params.id;
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const redisService = require('../../services/redisService');

    // Pagination params
    const entityLimit = Math.min(parseInt(req.query.entityLimit) || 50, 500);
    const entityOffset = parseInt(req.query.entityOffset) || 0;
    const relationLimit = Math.min(parseInt(req.query.relationLimit) || 50, 500);
    const relationOffset = parseInt(req.query.relationOffset) || 0;

    // Filter params
    const entitySearch = (req.query.entitySearch || '').trim().toLowerCase();
    const entityTypeFilter = (req.query.entityTypeFilter || '').trim();
    const relationSearch = (req.query.relationSearch || '').trim().toLowerCase();
    const relationPredicateFilter = (req.query.relationPredicateFilter || '').trim();

    // Cache key for filter options (types + predicates don't change unless data changes)
    const filterCacheKey = `cache:filters:${docId}`;
    const FILTER_CACHE_TTL = 300; // 5 minutes

    // 1. Try Redis first — this is the primary path for committed documents
    const docJson = await redisService.get(`doc:${docId}`);
    
    if (docJson) {
      const docMeta = JSON.parse(docJson);
      
      // Workspace isolation check
      if (workspaceId && docMeta.workspace_id && docMeta.workspace_id !== workspaceId) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      
      // Get chunks from vectorStoreService (stored in Redis)
      let chunks = [];
      try {
        chunks = await vectorStoreService.getDocumentChunks(docId);
      } catch (e) {
        logger.warn(`Could not load chunks from Redis for ${docId}: ${e.message}`);
      }

      // Get entities and relations from GraphDB via SPARQL
      let entities = [];
      let relations = [];
      let totalEntities = 0;
      let totalRelations = 0;
      let allEntityTypes = [];
      let allPredicates = [];
      const docUri = docMeta.uri || `doc://${docId}`;
      logger.info(`[FilterOptions] Loading for docId=${docId}, docUri=${docUri}`);
      try {
        const tenantId = req.headers['x-tenant-id'] || docMeta.tenant_id || 'default';
        const workspaceId = req.headers['x-workspace-id'] || docMeta.workspace_id || 'default';
        const graphDBStore = require('../../services/graphDBStore');

        // Build entity filter clauses
        const entityFilters = [`FILTER(?type != <http://purplefabric.ai/ontology#Document>)`];
        if (entitySearch) {
          entityFilters.push(`FILTER(CONTAINS(LCASE(STR(?label)), "${entitySearch.replace(/"/g, '\\"')}"))`);
        }
        if (entityTypeFilter) {
          entityFilters.push(`FILTER(STRENDS(STR(?type), "${entityTypeFilter.replace(/"/g, '\\"')}"))`);
        }
        const entityFilterStr = entityFilters.join('\n            ');

        // Try cached filter options first (types + predicates)
        let cachedFilters = null;
        try {
          const cached = await redisService.get(filterCacheKey);
          if (cached) cachedFilters = JSON.parse(cached);
        } catch (e) { /* cache miss */ }

        if (cachedFilters) {
          allEntityTypes = cachedFilters.entityTypes || [];
          allPredicates = cachedFilters.predicates || [];
          logger.info(`[FilterOptions] Cache HIT for ${docId}: ${allEntityTypes.length} types, ${allPredicates.length} predicates`);
        } else {
          // Get all unique entity types for filter dropdown (unfiltered)
          const typesQuery = `
            SELECT DISTINCT ?type WHERE {
              ?entity <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
              ?entity <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type .
              FILTER(?type != <http://purplefabric.ai/ontology#Document>)
            } ORDER BY ?type
          `;
          const typesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, typesQuery, 'data');
          allEntityTypes = (typesResult?.results?.bindings || []).map(b => {
            const val = b.type?.value || '';
            return val.includes('#') ? val.split('#').pop() : val.split('/').pop();
          }).filter(Boolean);

          // Get all unique predicates for filter dropdown (unfiltered)
          const predsQuery = `
            SELECT DISTINCT ?p WHERE {
              ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
              ?s ?p ?o .
              ?o <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
              FILTER(?p != <http://purplefabric.ai/ontology#sourceDocument>)
              FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
              FILTER(?p != <http://www.w3.org/2000/01/rdf-schema#label>)
              FILTER(?p != <http://purplefabric.ai/ontology#confidence>)
              FILTER(?p != <http://www.w3.org/2000/01/rdf-schema#comment>)
            } ORDER BY ?p
          `;
          const predsResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, predsQuery, 'data');
          allPredicates = (predsResult?.results?.bindings || []).map(b => {
            const val = b.p?.value || '';
            return val.includes('#') ? val.split('#').pop() : val.split('/').pop();
          }).filter(Boolean);

          // Cache filter options
          try {
            await redisService.set(filterCacheKey, JSON.stringify({ entityTypes: allEntityTypes, predicates: allPredicates }), FILTER_CACHE_TTL);
          } catch (e) { /* cache write failure is non-fatal */ }

          logger.info(`[FilterOptions] Cache MISS for ${docId}: ${allEntityTypes.length} types, ${allPredicates.length} predicates (cached for ${FILTER_CACHE_TTL}s)`);
        }

        // Count filtered entities
        const entityCountQuery = `
          SELECT (COUNT(DISTINCT ?entity) AS ?cnt) WHERE {
            ?entity <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            ?entity <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type .
            OPTIONAL { ?entity <http://www.w3.org/2000/01/rdf-schema#label> ?label }
            ${entityFilterStr}
          }
        `;
        const countResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, entityCountQuery, 'data');
        totalEntities = parseInt(countResult?.results?.bindings?.[0]?.cnt?.value) || 0;

        // Query paginated + filtered entities
        const entityQuery = `
          SELECT DISTINCT ?entity ?type ?label ?confidence WHERE {
            ?entity <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            ?entity <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type .
            OPTIONAL { ?entity <http://www.w3.org/2000/01/rdf-schema#label> ?label }
            OPTIONAL { ?entity <http://purplefabric.ai/ontology#confidence> ?confidence }
            ${entityFilterStr}
          } ORDER BY ?label LIMIT ${entityLimit} OFFSET ${entityOffset}
        `;
        const entityResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, entityQuery, 'data');
        const entityMap = new Map();
        for (const b of (entityResult?.results?.bindings || [])) {
          const uri = b.entity?.value;
          if (!entityMap.has(uri)) {
            entityMap.set(uri, {
              uri,
              label: b.label?.value || uri.split('/').pop(),
              type: (b.type?.value || '').split('#').pop() || (b.type?.value || '').split('/').pop() || 'Entity',
              confidence: b.confidence?.value ? parseFloat(b.confidence.value) : null
            });
          }
        }
        entities = Array.from(entityMap.values());

        // Build relation filter clauses
        const relBaseFilters = [
          `FILTER(?p != <http://purplefabric.ai/ontology#sourceDocument>)`,
          `FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)`,
          `FILTER(?p != <http://www.w3.org/2000/01/rdf-schema#label>)`,
          `FILTER(?p != <http://purplefabric.ai/ontology#confidence>)`,
          `FILTER(?p != <http://www.w3.org/2000/01/rdf-schema#comment>)`
        ];
        if (relationSearch) {
          relBaseFilters.push(`FILTER(CONTAINS(LCASE(STR(?sLabel)), "${relationSearch.replace(/"/g, '\\"')}") || CONTAINS(LCASE(STR(?oLabel)), "${relationSearch.replace(/"/g, '\\"')}") || CONTAINS(LCASE(STR(?p)), "${relationSearch.replace(/"/g, '\\"')}"))`);
        }
        if (relationPredicateFilter) {
          relBaseFilters.push(`FILTER(STRENDS(STR(?p), "${relationPredicateFilter.replace(/"/g, '\\"')}"))`);
        }
        const relFilterStr = relBaseFilters.join('\n            ');

        // Count filtered relations
        const relCountQuery = `
          SELECT (COUNT(*) AS ?cnt) WHERE {
            ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            ?s ?p ?o .
            ?o <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            OPTIONAL { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?sLabel }
            OPTIONAL { ?o <http://www.w3.org/2000/01/rdf-schema#label> ?oLabel }
            ${relFilterStr}
          }
        `;
        const relCountResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, relCountQuery, 'data');
        totalRelations = parseInt(relCountResult?.results?.bindings?.[0]?.cnt?.value) || 0;

        // Query paginated + filtered relationships
        const relQuery = `
          SELECT ?s ?sLabel ?p ?o ?oLabel WHERE {
            ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            ?s ?p ?o .
            ?o <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> .
            OPTIONAL { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?sLabel }
            OPTIONAL { ?o <http://www.w3.org/2000/01/rdf-schema#label> ?oLabel }
            ${relFilterStr}
          } ORDER BY ?sLabel LIMIT ${relationLimit} OFFSET ${relationOffset}
        `;
        const relResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, relQuery, 'data');
        for (const b of (relResult?.results?.bindings || [])) {
          relations.push({
            source: b.sLabel?.value || (b.s?.value || '').split('/').pop(),
            predicate: (b.p?.value || '').split('#').pop() || (b.p?.value || '').split('/').pop(),
            target: b.oLabel?.value || (b.o?.value || '').split('/').pop()
          });
        }
      } catch (e) {
        logger.warn(`Could not load entities from GraphDB for ${docId}: ${e.message}`);
      }

      // Fallback: derive filter options from loaded entities/relations if SPARQL queries returned empty
      if (allEntityTypes.length === 0 && entities.length > 0) {
        allEntityTypes = [...new Set(entities.map(e => e.type).filter(Boolean))].sort();
        logger.info(`[FilterOptions] Derived ${allEntityTypes.length} entity types from loaded entities as fallback`);
      }
      if (allPredicates.length === 0 && relations.length > 0) {
        allPredicates = [...new Set(relations.map(r => r.predicate).filter(Boolean))].sort();
        logger.info(`[FilterOptions] Derived ${allPredicates.length} predicates from loaded relations as fallback`);
      }

      return res.json({
        success: true,
        document: {
          doc_id: docMeta.doc_id || docId,
          uri: docMeta.uri,
          title: docMeta.title,
          doc_type: docMeta.doc_type,
          created_at: docMeta.committed_at,
          entity_count: docMeta.entity_count || totalEntities,
          triple_count: docMeta.triple_count || 0,
          ontology_id: docMeta.ontology_id || null,
          ontology_version_id: docMeta.ontology_version_id || null,
          primary_class: docMeta.primary_class || null,
          chunks_stored: parseInt(docMeta.chunks_stored) || 0,
          workspace_id: docMeta.workspace_id || null
        },
        chunks: chunks.map(c => ({
          chunk_id: c.id,
          uri: c.id,
          text: c.text,
          order: parseInt(c.chunkIndex) || 0,
          start_page: parseInt(c.startPage) || null,
          end_page: parseInt(c.endPage) || null,
          char_count: parseInt(c.char_count) || (c.text || '').length
        })),
        concepts: entities,
        relations,
        stats: {
          chunkCount: chunks.length,
          conceptCount: totalEntities,
          relationCount: totalRelations
        },
        pagination: {
          entities: { limit: entityLimit, offset: entityOffset, total: totalEntities },
          relations: { limit: relationLimit, offset: relationOffset, total: totalRelations }
        },
        filterOptions: {
          entityTypes: allEntityTypes,
          predicates: allPredicates
        }
      });
    }

    // 2. Fallback: check Neo4j (legacy documents)
    try {
      const session = neo4jService.getSession();
      try {
        const docResult = await session.run(`
          MATCH (d:Document) WHERE (d.doc_id = $docId OR d.uri = $docId)
            AND ($workspaceId IS NULL OR d.workspace_id = $workspaceId)
          RETURN d
        `, { docId, workspaceId: workspaceId || null });

        if (docResult.records.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Document not found'
          });
        }

        const document = docResult.records[0].get('d').properties;
        const chunksResult = await session.run(`
          MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
          WHERE d.doc_id = $docId OR d.uri = $docId
          RETURN ch ORDER BY ch.order
        `, { docId });
        const chunks = chunksResult.records.map(r => r.get('ch').properties);

        return res.json({
          success: true,
          document,
          chunks,
          concepts: [],
          relations: [],
          stats: { chunkCount: chunks.length, conceptCount: 0, relationCount: 0 },
          note: 'Legacy document from Neo4j. Entities are in GraphDB.'
        });
      } finally {
        await session.close();
      }
    } catch (neo4jErr) {
      logger.warn(`Neo4j fallback failed for ${docId}: ${neo4jErr.message}`);
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
  } catch (error) {
    console.error('Error fetching document details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/documents/:id/debug-chunks
 * Debug endpoint to check chunk details for a document
 */
router.get('/:id/debug-chunks', async (req, res) => {
  try {
    const docId = req.params.id;
    const session = neo4jService.getSession();
    
    try {
      // Get document with all chunk details
      const result = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        WITH d, ch
        ORDER BY ch.order
        RETURN d, 
               collect({
                 chunk_id: ch.chunk_id,
                 order: ch.order,
                 text_length: size(ch.text),
                 text_preview: substring(ch.text, 0, 200),
                 start_page: ch.start_page,
                 end_page: ch.end_page
               }) as chunks
      `, { docId });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      
      const doc = result.records[0].get('d').properties;
      const chunks = result.records[0].get('chunks').filter(c => c.chunk_id);
      
      // Calculate total text length
      const totalTextLength = chunks.reduce((sum, c) => sum + (c.text_length || 0), 0);
      
      res.json({
        success: true,
        document: {
          doc_id: doc.doc_id,
          title: doc.title,
          numPages: doc.numPages || doc.num_pages,
          file_size: doc.file_size,
          created_at: doc.created_at
        },
        chunkStats: {
          totalChunks: chunks.length,
          totalTextLength,
          avgChunkLength: chunks.length > 0 ? Math.round(totalTextLength / chunks.length) : 0,
          chunkOrders: chunks.map(c => neo4jService.toNumber(c.order)),
          chunkLengths: chunks.map(c => c.text_length)
        },
        chunks: chunks.map(c => ({
          ...c,
          order: neo4jService.toNumber(c.order),
          start_page: c.start_page ? neo4jService.toNumber(c.start_page) : null,
          end_page: c.end_page ? neo4jService.toNumber(c.end_page) : null
        }))
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error fetching chunk debug info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/:id/re-extract-text
 * Re-extract text from original file and compare with stored chunks
 */
router.post('/:id/re-extract-text', async (req, res) => {
  try {
    const docId = req.params.id;
    const { method = 'pdf-parse' } = req.body; // pdf-parse, ocr, or hybrid
    const session = neo4jService.getSession();
    
    try {
      // Get document info including file path
      const result = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        WITH d, ch
        ORDER BY ch.order
        RETURN d, collect(ch.text) as chunkTexts, count(ch) as chunkCount
      `, { docId });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      
      const doc = result.records[0].get('d').properties;
      const storedChunkTexts = result.records[0].get('chunkTexts').filter(t => t);
      const storedChunkCount = neo4jService.toNumber(result.records[0].get('chunkCount'));
      const storedTotalLength = storedChunkTexts.reduce((sum, t) => sum + t.length, 0);
      
      // Find the original file
      const filePath = doc.file_path || doc.filePath;
      if (!filePath) {
        return res.json({
          success: true,
          warning: 'No file path stored - cannot re-extract',
          stored: {
            chunkCount: storedChunkCount,
            totalTextLength: storedTotalLength,
            numPages: doc.numPages || doc.num_pages || 'unknown'
          },
          fresh: null
        });
      }
      
      // Check if file exists
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        return res.json({
          success: true,
          warning: `Original file not found at: ${filePath}`,
          stored: {
            chunkCount: storedChunkCount,
            totalTextLength: storedTotalLength,
            numPages: doc.numPages || doc.num_pages || 'unknown'
          },
          fresh: null
        });
      }
      
      // Re-extract text from file
      const ext = filePath.split('.').pop().toLowerCase();
      let freshExtraction = { text: '', numPages: 0, method: 'unknown' };
      
      if (ext === 'pdf') {
        if (method === 'ocr') {
          const ocrService = require('../../services/ocrService');
          const ocrResult = await ocrService.extractTextFromPDF(filePath);
          freshExtraction = {
            text: ocrResult.text,
            numPages: ocrResult.numPages || 1,
            method: 'ocr'
          };
        } else if (method === 'hybrid') {
          // Try PDF first, fall back to OCR
          const pdfData = await pdfParser.extractText(filePath);
          const pdfWords = (pdfData.text || '').split(/\s+/).filter(w => w.length > 2).length;
          
          if (pdfWords < 50) {
            const ocrService = require('../../services/ocrService');
            const ocrResult = await ocrService.extractTextFromPDF(filePath);
            freshExtraction = {
              text: ocrResult.text,
              numPages: ocrResult.numPages || 1,
              method: 'ocr (fallback)'
            };
          } else {
            freshExtraction = {
              text: pdfData.text,
              numPages: pdfData.numPages || 1,
              method: 'pdf-parse'
            };
          }
        } else {
          // Default: pdf-parse
          const pdfData = await pdfParser.extractText(filePath);
          freshExtraction = {
            text: pdfData.text,
            numPages: pdfData.numPages || 1,
            method: 'pdf-parse'
          };
        }
      } else {
        // Text file
        freshExtraction = {
          text: fs.readFileSync(filePath, 'utf-8'),
          numPages: 1,
          method: 'text-read'
        };
      }
      
      // Compare stored vs fresh
      const comparison = {
        stored: {
          chunkCount: storedChunkCount,
          totalTextLength: storedTotalLength,
          numPages: doc.numPages || doc.num_pages || 'unknown',
          textPreview: storedChunkTexts.join('\n\n').substring(0, 500)
        },
        fresh: {
          textLength: freshExtraction.text.length,
          numPages: freshExtraction.numPages,
          method: freshExtraction.method,
          textPreview: freshExtraction.text.substring(0, 500),
          // Show text from different parts of the document
          middlePreview: freshExtraction.text.substring(
            Math.floor(freshExtraction.text.length / 2) - 250,
            Math.floor(freshExtraction.text.length / 2) + 250
          ),
          endPreview: freshExtraction.text.substring(
            Math.max(0, freshExtraction.text.length - 500)
          )
        },
        analysis: {
          textLengthDiff: freshExtraction.text.length - storedTotalLength,
          textLengthDiffPercent: storedTotalLength > 0 
            ? Math.round((freshExtraction.text.length - storedTotalLength) / storedTotalLength * 100) 
            : 100,
          possibleIssue: null
        }
      };
      
      // Analyze potential issues
      if (comparison.analysis.textLengthDiffPercent > 20) {
        comparison.analysis.possibleIssue = 'Fresh extraction has significantly MORE text than stored - chunks may be missing';
      } else if (comparison.analysis.textLengthDiffPercent < -20) {
        comparison.analysis.possibleIssue = 'Fresh extraction has significantly LESS text than stored - possible extraction issue';
      } else if (freshExtraction.numPages > 1 && storedChunkCount < freshExtraction.numPages) {
        comparison.analysis.possibleIssue = `Document has ${freshExtraction.numPages} pages but only ${storedChunkCount} chunks - some pages may not be chunked`;
      }
      
      res.json({
        success: true,
        filePath,
        comparison
      });
      
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error re-extracting text:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/documents/:id
 * Delete a document and ALL related data (Neo4j + GraphDB)
 */
router.delete('/:id', optionalTenantContext, async (req, res) => {
  try {
    const docId = req.params.id;
    const tenantId = req.query.tenantId || req.tenantContext?.tenant_id || 'default';
    const workspaceId = req.query.workspaceId || req.tenantContext?.workspace_id || 'default';

    // Workspace ownership check
    const docJson = await redisService.get(`doc:${docId}`);
    if (docJson) {
      const docMeta = JSON.parse(docJson);
      if (docMeta.workspace_id && docMeta.workspace_id !== workspaceId) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
    }

    const session = neo4jService.getSession();
    const results = { document: false, chunks: 0, concepts: 0, redis: false, graphdb: false };
    
    try {
      // Get document URI for GraphDB cleanup
      const docResult = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        RETURN d.uri as uri
      `, { docId });
      const docUri = docResult.records[0]?.get('uri');
      
      // Get chunk IDs for Redis cleanup
      const chunkResult = await session.run(`
        MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE d.doc_id = $docId OR d.uri = $docId
        RETURN ch.chunk_id as chunkId, ch.vector_key as vectorKey
      `, { docId });
      
      const chunkIds = chunkResult.records.map(r => ({
        chunkId: r.get('chunkId'),
        vectorKey: r.get('vectorKey')
      }));
      
      // Delete concepts only linked to this document
      const conceptResult = await session.run(`
        MATCH (c)-[:MENTIONED_IN]->(ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE d.doc_id = $docId OR d.uri = $docId
        WITH c, d
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(:Chunk)-[:PART_OF]->(otherDoc:Document)
        WHERE otherDoc.doc_id <> d.doc_id
        WITH c, count(otherDoc) as otherDocCount
        WHERE otherDocCount = 0
        DETACH DELETE c RETURN count(c) as deleted
      `, { docId });
      results.concepts = neo4jService.toNumber(conceptResult.records[0]?.get('deleted') || 0);
      
      // Delete chunks
      const deleteChunksResult = await session.run(`
        MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE d.doc_id = $docId OR d.uri = $docId
        DETACH DELETE ch RETURN count(ch) as deleted
      `, { docId });
      results.chunks = neo4jService.toNumber(deleteChunksResult.records[0]?.get('deleted') || 0);
      
      // Delete document from Neo4j
      const deleteDocResult = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        DETACH DELETE d RETURN count(d) as deleted
      `, { docId });
      results.document = neo4jService.toNumber(deleteDocResult.records[0]?.get('deleted') || 0) > 0;
      
      // Delete from GraphDB
      if (docUri) {
        try {
          const graphDBStore = require('../../services/graphDBStore');
          const dataGraphIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
          
          // Delete all triples related to this document
          const deleteQuery = `
            DELETE WHERE {
              GRAPH <${dataGraphIRI}> {
                { <${docUri}> ?p ?o }
                UNION
                { ?s <http://purplefabric.ai/ontology#sourceDocument> <${docUri}> . ?s ?p ?o }
                UNION
                { ?s <http://purplefabric.ai/ontology#partOf> <${docUri}> . ?s ?p ?o }
              }
            }
          `;
          
          const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sparql-update' },
            body: deleteQuery
          });
          
          results.graphdb = response.ok;
          if (response.ok) {
            logger.info(`[delete] Removed document from GraphDB: ${docUri}`);
          }
        } catch (e) {
          logger.warn('GraphDB cleanup error:', e.message);
        }
      }
      
      // Delete from Redis
      try {
        await vectorStoreService.deleteDocument(docId);
        for (const { vectorKey } of chunkIds) {
          if (vectorKey) {
            const { client } = require('../../config/redis');
            await client.del(`graphrag:vector:${vectorKey}`);
          }
        }
        // Clean up chunk: keys in Redis
        const redisService = require('../../services/redisService');
        const chunkKeys = await redisService.keys(`chunk:${docId}:*`);
        for (const key of chunkKeys) {
          await redisService.del(key);
        }
        // Also try chunk keys by chunk IDs
        for (const { chunkId } of chunkIds) {
          if (chunkId) await redisService.del(`chunk:${chunkId}`);
        }
        // Remove doc metadata key
        await redisService.del(`doc:${docId}`);
        // Remove from workspace docs set
        await redisService.sRem(`workspace:${workspaceId}:docs`, docId);
        results.redis = true;
      } catch (e) {
        console.warn('Redis cleanup error:', e.message);
      }
      
      res.json({ success: true, message: 'Document deleted from Neo4j and GraphDB', results });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/:id/move
 * Move document to folder
 */
router.post('/:id/move', async (req, res) => {
  try {
    const docId = req.params.id;
    const { folderId } = req.body;
    
    const session = neo4jService.getSession();
    try {
      // Remove existing folder relationship
      await session.run(`
        MATCH (d:Document)-[r:IN_FOLDER]->(:Folder)
        WHERE d.doc_id = $docId OR d.uri = $docId
        DELETE r
      `, { docId });
      
      // Add new folder relationship if folderId provided
      if (folderId) {
        await session.run(`
          MATCH (d:Document), (f:Folder {folder_id: $folderId})
          WHERE d.doc_id = $docId OR d.uri = $docId
          CREATE (d)-[:IN_FOLDER]->(f)
        `, { docId, folderId });
      }
      
      res.json({ success: true, message: 'Document moved' });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error moving document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/:id/reprocess
 * Re-extract entities from a document
 */
router.post('/:id/reprocess', async (req, res) => {
  try {
    const docId = req.params.id;
    
    // Clean up existing Neo4j concepts for this document (if any)
    const session = neo4jService.getSession();
    try {
      await session.run(`
        MATCH (c)-[:MENTIONED_IN]->(ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE d.doc_id = $docId OR d.uri = $docId
        WITH c, d
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(:Chunk)-[:PART_OF]->(otherDoc:Document)
        WHERE otherDoc.doc_id <> d.doc_id
        WITH c, count(otherDoc) as otherDocCount
        WHERE otherDocCount = 0
        DETACH DELETE c
      `, { docId });
    } finally {
      await session.close();
    }
    
    // Get chunk count from Redis first, then Neo4j fallback
    let docTitle = docId;
    let chunkCount = 0;
    
    const stagedJson = await redisService.get(`staged:${docId}`);
    if (stagedJson) {
      const staged = JSON.parse(stagedJson);
      chunkCount = staged.chunks?.length || 0;
      docTitle = staged.document?.title || docId;
    } else {
      const docJson = await redisService.get(`doc:${docId}`);
      if (docJson) {
        const docMeta = JSON.parse(docJson);
        docTitle = docMeta.title || docId;
        const redisChunks = await vectorStoreService.getDocumentChunks(docId);
        chunkCount = redisChunks.length;
      } else {
        // Neo4j fallback for legacy docs
        const fallbackSession = neo4jService.getSession();
        try {
          const docResult = await fallbackSession.run(`
            MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
            OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
            RETURN d, count(ch) as chunkCount
          `, { docId });
          if (docResult.records.length === 0) {
            return res.status(404).json({ success: false, error: 'Document not found' });
          }
          const doc = docResult.records[0].get('d').properties;
          docTitle = doc.title || docId;
          chunkCount = neo4jService.toNumber(docResult.records[0].get('chunkCount'));
        } finally {
          await fallbackSession.close();
        }
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Document queued for re-processing',
      document: docTitle,
      chunkCount
    });
  } catch (error) {
    console.error('Error reprocessing document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/:id/entities
 * Add a new entity to a document
 */
router.post('/:id/entities', async (req, res) => {
  try {
    const docId = req.params.id;
    const { label, type, description, confidence, chunkOrder } = req.body;
    
    if (!label || !type) {
      return res.status(400).json({ success: false, error: 'Label and type are required' });
    }
    
    // Sanitize type for Neo4j label
    const sanitizedType = type.split(/\s+/).map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    
    const session = neo4jService.getSession();
    try {
      const conceptId = uuidv4();
      const uri = `ont://general/${type.toLowerCase().replace(/\s+/g, '_')}/${label.toLowerCase().replace(/\s+/g, '_')}`;
      
      const result = await session.run(`
        MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE (d.doc_id = $docId OR d.uri = $docId) AND ch.order = $chunkOrder
        CREATE (c:\`${sanitizedType}\` {
          concept_id: $conceptId, label: $label, description: $description,
          confidence: $confidence, uri: $uri, source: d.uri,
          created_at: datetime()
        })
        CREATE (c)-[:MENTIONED_IN]->(ch)
        RETURN c
      `, { docId, conceptId, label, description: description || '', confidence: confidence || 0.9, uri, chunkOrder: chunkOrder || 0 });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Document or chunk not found' });
      }
      
      res.json({ success: true, entity: { ...result.records[0].get('c').properties, type: sanitizedType } });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error adding entity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/upload-document
 * Upload document with background processing
 * Returns immediately with a job ID, processing happens in background
 */
router.post('/upload-document', upload.single('file'), optionalTenantContext, async (req, res) => {
  try {
    await ensureSchemaInitialized();

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const documentName = req.body.customFileName || req.file.originalname;
    const docId = uuidv4();
    const docUri = `doc://${docId}`;
    
    const tenantContext = req.tenantContext || {};
    const tenantId = req.body.tenant_id || tenantContext.tenant_id || null;
    const workspaceId = req.body.workspace_id || tenantContext.workspace_id || null;
    const folderId = req.body.folder_id || null;
    const chunkingMethod = req.body.chunkingMethod || 'fixed';
    const csvChunkingEnabled = req.body.csvChunkingEnabled === 'true' || req.body.csvChunkingEnabled === true;
    const ontologyId = req.body.ontologyId || req.body.ontology_id || null;
    
    // Parse ontology mapping data for CSV files
    let columnMapping = null;
    let relationshipMapping = null;
    let ontology = null;
    
    if (req.body.columnMapping) {
      try {
        columnMapping = typeof req.body.columnMapping === 'string' 
          ? JSON.parse(req.body.columnMapping) 
          : req.body.columnMapping;
      } catch (e) { /* ignore parse errors */ }
    }
    
    if (req.body.relationshipMapping) {
      try {
        relationshipMapping = typeof req.body.relationshipMapping === 'string'
          ? JSON.parse(req.body.relationshipMapping)
          : req.body.relationshipMapping;
      } catch (e) { /* ignore parse errors */ }
    }
    
    // Load ontology structure if ontologyId provided
    if (ontologyId && ontologyId !== 'auto') {
      try {
        const structure = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
        if (structure) {
          ontology = structure;
        }
      } catch (e) {
        logger.warn(`Could not load ontology ${ontologyId}: ${e.message}`);
      }
    }

    logger.info(`📄 Upload: ${documentName} (background processing)${ontologyId ? ` with ontology: ${ontologyId}` : ''}`);

    // Create upload job for tracking
    const job = await ontologyJobService.createJob({
      fileName: documentName,
      filePath: filePath,
      fileSize: req.file.size,
      workspaceId: workspaceId,
      folderId: folderId,
      
      documentId: docId,
      status: 'pending',
      jobType: 'upload'
    });

    // Start background processing
    processUploadInBackground(job.job_id, {
      filePath,
      ext,
      documentName,
      docId,
      docUri,
      tenantId,
      workspaceId,
      folderId,
      
      chunkingMethod,
      csvChunkingEnabled,
      ontology,
      columnMapping,
      relationshipMapping
    });

    // Return immediately with job info
    res.json({
      success: true,
      message: 'Document upload started - processing in background',
      document: { 
        doc_id: docId, 
        uri: docUri, 
        title: documentName,
        status: 'processing'
      },
      jobId: job.job_id
    });
  } catch (error) {
    console.error('Error starting upload:', error);
    cleanupFile(req.file?.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Background processor for document upload
 */
async function processUploadInBackground(jobId, options) {
  const {
    filePath, ext, documentName, docId, docUri,
    tenantId, workspaceId, folderId, chunkingMethod,
    csvChunkingEnabled, ontology, columnMapping, relationshipMapping
  } = options;

  logger.debug(`Background upload processing for job: ${jobId}`);
  
  setImmediate(async () => {
    try {
      await ontologyJobService.updateProcessingStep(jobId, 'queued', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'parsing', 'active');
      await ontologyJobService.updateJob(jobId, {
        status: 'extracting',
        progress: 10,
        progress_message: 'Extracting text from document...'
      });

      // Extract text
      let text = '';
      let numPages = 1;
      let pageBreaks = [];
      let pageTexts = [];
      let csvData = null;
      
      if (ext === '.pdf') {
        const pdfData = await pdfParser.extractText(filePath);
        text = pdfData.text;
        numPages = pdfData.numPages || 1;
        pageBreaks = pdfData.pageBreaks || [];
        pageTexts = pdfData.pageTexts || [];
        if (pageBreaks.length > 0) {
          logger.debug(`Detected ${pageBreaks.length} page breaks`);
        }
      } else if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
        if (ext === '.csv') {
          csvData = await csvParser.parse(filePath, { hasHeader: true });
          text = csvData.text || csvData.rows?.map(r => Object.values(r).join(' ')).join('\n') || '';
        } else {
          const excelParser = require('../../services/excelParser');
          const parsed = await excelParser.parse(filePath);
          const flat = excelParser.flattenSheets(parsed);
          csvData = {
            headers: flat.headers, rows: flat.rows, rowCount: flat.rowCount,
            sheets: parsed.sheets.map(s => ({ name: s.sheetName, headers: s.headers, rowCount: s.rowCount }))
          };
          text = parsed.text;
        }
      } else {
        text = fs.readFileSync(filePath, 'utf-8');
      }

      if (!text.trim() && !csvData) {
        throw new Error('No text content could be extracted from the document');
      }

      await ontologyJobService.updateProcessingStep(jobId, 'parsing', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'chunking', 'active');
      await ontologyJobService.updateJob(jobId, {
        status: 'processing',
        progress: 30,
        progress_message: 'Staging document for review...',
        preview_text: text.substring(0, 2000)
      });

      // Stage document metadata (don't create in Neo4j yet)
      const stagedDoc = {
        uri: docUri, doc_id: docId, title: documentName,
        source: 'upload', doc_type: ext.replace('.', ''),
         language: 'en',
        tenant_id: tenantId, workspace_id: workspaceId,
        folder_id: folderId,
        file_path: filePath,
        ingested_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };

      let entityCount = 0;
      let relationshipCount = 0;
      let stagedData = null;

      // Handle tabular data - stage data instead of creating nodes
      if ((ext === '.csv' || ext === '.xlsx' || ext === '.xls') && csvData) {
        await ontologyJobService.updateJob(jobId, {
          progress: 50,
          progress_message: 'Analyzing CSV structure...'
        });

        // Create summary for schema analysis (exclude synthetic __sheet column)
        const headers = (csvData.headers || []).filter(h => h !== '__sheet');
        const sampleRows = sampleFromAllSheets(csvData.rows || [], 10);
        const csvSummary = [
          `CSV File: ${documentName}`,
          `Rows: ${csvData.rows?.length || 0}, Columns: ${headers.length}`,
          ``,
          `Headers: ${headers.join(', ')}`,
          ``,
          `Sample Data:`,
          ...sampleRows.map((row, i) => `Row ${i+1}: ${Object.entries(row).map(([k,v]) => `${k}=${v}`).join(', ')}`)
        ].join('\n');

        // Chunk CSV rows for RAG vector search
        let csvChunks = null;
        if (csvData.rows?.length > 0) {
          const rowsPerChunk = 50; // Group 50 rows per chunk
          csvChunks = [];
          for (let i = 0; i < csvData.rows.length; i += rowsPerChunk) {
            const chunkRows = csvData.rows.slice(i, i + rowsPerChunk);
            const chunkText = chunkRows.map(row => 
              Object.entries(row).filter(([k]) => k !== '__sheet' && row[k] != null && row[k] !== '').map(([k, v]) => `${k}: ${v}`).join(', ')
            ).join('\n');
            csvChunks.push({
              uri: `${docUri}#chunk=${csvChunks.length}`,
              chunk_id: uuidv4(),
              text: chunkText,
              order: csvChunks.length,
              startRow: i,
              endRow: Math.min(i + rowsPerChunk, csvData.rows.length),
              vector_key: `${docId}_${csvChunks.length}`,
              tenant_id: tenantId,
              workspace_id: workspaceId
            });
          }
          logger.info(`CSV chunking enabled: created ${csvChunks.length} chunks from ${csvData.rows.length} rows`);
        }

        // Stage the data - store in Redis with 7-day TTL
        const STAGING_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
        const expiresAt = new Date(Date.now() + STAGING_TTL_SECONDS * 1000).toISOString();
        
        stagedData = {
          type: 'csv',
          document: stagedDoc,
          csvData: {
            headers,
            rowCount: csvData.rows?.length || 0,
            rows: csvData.rows,
            sheets: csvData.sheets || null,
            summary: csvSummary
          },
          chunks: csvChunks,
          chunkingEnabled: csvChunkingEnabled,
          ontology: ontology || null,
          columnMapping: columnMapping || null,
          relationshipMapping: relationshipMapping || null,
          stagedAt: new Date().toISOString(),
          expiresAt: expiresAt
        };

        const redisService = require('../../services/redisService');
        await redisService.set(`staged:${docId}`, JSON.stringify(stagedData), STAGING_TTL_SECONDS);

        entityCount = csvData.rows?.length || 0;
        relationshipCount = 0;

        await ontologyJobService.updateJob(jobId, {
          progress: 90,
          progress_message: `Document staged for ontology linking (expires: ${expiresAt})`,
          staged: true,
          staged_doc_id: docId,
          staged_expires_at: expiresAt
        });

      } else {
        // Non-CSV document processing - stage instead of direct Neo4j write
        await ontologyJobService.updateJob(jobId, {
          progress: 50,
          progress_message: 'Chunking document...'
        });

        const chunks = chunkingService.chunkDocumentWithMethod(text, {
          id: docId, uri: docUri, name: documentName,
          doc_type: ext.replace('.', ''),
          chunkingMethod, numPages,
          pageBreaks, pageTexts
        }).chunks;

        // Stage document and chunks in Redis with 7-day TTL
        const STAGING_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
        const expiresAt = new Date(Date.now() + STAGING_TTL_SECONDS * 1000).toISOString();
        
        const stagedData = {
          type: 'document',
          document: stagedDoc,
          chunks: chunks.map((chunk, i) => ({
            uri: `${docUri}#chunk=${i}`,
            chunk_id: uuidv4(),
            text: chunk.text,
            order: i,
            vector_key: `${docId}_${i}`,
            tenant_id: tenantId,
            workspace_id: workspaceId
          })),
          text: text.substring(0, 50000),
          stagedAt: new Date().toISOString(),
          expiresAt: expiresAt
        };

        const redisService = require('../../services/redisService');
        await redisService.set(`staged:${docId}`, JSON.stringify(stagedData), STAGING_TTL_SECONDS);

        entityCount = chunks.length;

        await ontologyJobService.updateJob(jobId, {
          progress: 90,
          progress_message: `Document staged for ontology linking (expires: ${expiresAt})`,
          staged: true,
          staged_doc_id: docId,
          staged_expires_at: expiresAt
        });
      }

      // Clean up file
      cleanupFile(filePath);

      await ontologyJobService.updateProcessingStep(jobId, 'chunking', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'staging', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'complete', 'completed');
      await ontologyJobService.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        progress_message: `Staged: ${entityCount} items ready for ontology linking`,
        entity_count: entityCount,
        relationship_count: relationshipCount,
        staged: true,
        staged_doc_id: docId
      });

      logger.info(`✅ Upload staged for job: ${jobId} (doc: ${docId})`);

    } catch (error) {
      console.error(`❌ Upload failed for job ${jobId}:`, error);
      await ontologyJobService.updateJob(jobId, {
        status: 'failed',
        progress: 0,
        progress_message: `Error: ${error.message}`,
        error: error.message
      });
      cleanupFile(filePath);
    }
  });
}

/**
 * POST /api/ontology/documents/:id/start-extraction
 * Start extraction job for a document
 */
router.post('/:id/start-extraction', optionalTenantContext, async (req, res) => {
  const session = neo4jService.getSession();
  
  try {
    const docId = req.params.id;
    const { ontologyId, schemaMode = 'constrained', existingOntology } = req.body;
    
    logger.debug('[start-extraction] Request body:', { 
      ontologyId, 
      schemaMode, 
      hasExistingOntology: !!existingOntology, 
      existingOntologyEntityTypes: existingOntology?.entityTypes?.length || 0,
      existingOntologyRelationships: existingOntology?.relationships?.length || 0
    });
    
    const tenantContext = req.tenantContext || {};
    const tenantId = req.body.tenant_id || tenantContext.tenant_id || null;
    const workspaceId = req.body.workspace_id || tenantContext.workspace_id || null;

    // Workspace ownership check
    if (workspaceId) {
      const owned = await verifyDocWorkspace(docId, workspaceId);
      if (owned === null) {
        const docJson = await redisService.get(`doc:${docId}`);
        if (docJson) {
          return res.status(404).json({ success: false, error: 'Document not found in this workspace' });
        }
      }
    }

    // Get document info for job name
    const docResult = await session.run(`
      MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
      RETURN d
    `, { docId });
    
    if (docResult.records.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    
    const doc = docResult.records[0].get('d').properties;
    const fileName = doc.title || doc.doc_id;

    // Get ontology - prefer existingOntology from request, then lookup by ID
    let ontology = existingOntology || null;
    if (!ontology && ontologyId && ontologyId !== 'auto') {
      ontology = await ontologyTemplateService.getTemplate(ontologyId);
      if (!ontology) {
        ontology = await owlOntologyService.getOntologyStructure(tenantId || "default", workspaceId || "default", ontologyId);
      }
    }
    
    logger.debug('[start-extraction] Ontology resolved:', ontology ? `${ontology.name || ontology.id} with ${ontology.entityTypes?.length || 0} entity types` : 'None');

    // Create extraction job with proper filename
    const job = await ontologyJobService.createExtractionJob({
      fileName,
      documentId: docId,
      ontologyId,
      ontology,
      schemaMode,
      tenant_id: tenantId,
      workspace_id: workspaceId
    });

    // Start background processing
    processExtractionInBackground(job.job_id, docId, ontology);

    res.json({
      success: true,
      message: 'Extraction job started',
      jobId: job.job_id,
      status: 'pending'
    });
  } catch (error) {
    console.error('Error starting extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await session.close();
  }
});

/**
 * Background processor for entity extraction
 */
async function processExtractionInBackground(jobId, docId, ontology) {
  logger.job(`[${jobId.slice(0,8)}] Starting extraction for document: ${docId.slice(0,8)}`);
  if (ontology) {
    logger.job(`[${jobId.slice(0,8)}] Using ontology: ${ontology.name || 'unnamed'} (${ontology.entityTypes?.length || 0} types, ${ontology.relationships?.length || 0} relationships)`);
    if (ontology.relationships?.length > 0) {
      logger.debug(`[${jobId.slice(0,8)}] Relationship types in ontology: ${ontology.relationships.map(r => r.type || r.predicate || r.name || JSON.stringify(r)).slice(0, 5).join(', ')}`);
    } else {
      logger.warn(`[${jobId.slice(0,8)}] ⚠️ No relationships defined in ontology! Keys: ${Object.keys(ontology).join(', ')}`);
    }
  }
  
  setImmediate(async () => {
    let workspaceId = null;
    const startTime = Date.now();
    
    try {
      // Step 1: Queued -> Text Extraction
      await ontologyJobService.updateProcessingStep(jobId, 'queued', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'text_extraction', 'active');
      await ontologyJobService.updateJob(jobId, {
        status: 'extracting',
        progress: 10,
        progress_message: 'Collecting document text...'
      });
      
      // Try Redis first (primary data store), then fall back to Neo4j for legacy docs
      let chunkTexts = [];
      let chunkCount = 0;
      let docTitle = docId;
      
      // Path 1: Redis — check staged data first, then committed chunks
      const stagedJson = await redisService.get(`staged:${docId}`);
      if (stagedJson) {
        const staged = JSON.parse(stagedJson);
        chunkTexts = (staged.chunks || []).map(c => c.text).filter(Boolean);
        chunkCount = chunkTexts.length;
        docTitle = staged.document?.title || docId;
        workspaceId = staged.document?.workspace_id;
        logger.info(`[extraction] Loaded ${chunkCount} chunks from Redis staging for ${docId}`);
      } else {
        // Check committed doc metadata
        const docJson = await redisService.get(`doc:${docId}`);
        if (docJson) {
          const docMeta = JSON.parse(docJson);
          docTitle = docMeta.title || docId;
          workspaceId = docMeta.workspace_id;
          // Load chunks from vectorStoreService (permanent Redis storage)
          const redisChunks = await vectorStoreService.getDocumentChunks(docId);
          if (redisChunks.length > 0) {
            chunkTexts = redisChunks.map(c => c.text).filter(Boolean);
            chunkCount = chunkTexts.length;
            logger.info(`[extraction] Loaded ${chunkCount} chunks from Redis vector store for ${docId}`);
          }
        }
      }
      
      // Path 2: Neo4j fallback for legacy documents
      if (chunkCount === 0) {
        logger.info(`[extraction] No chunks in Redis, falling back to Neo4j for ${docId}`);
        const session = neo4jService.getSession();
        try {
          const docResult = await session.run(`
            MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
            OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
            WITH d, ch ORDER BY ch.order
            RETURN d, collect(ch.text) as chunkTexts, count(ch) as chunkCount
          `, { docId });
          
          if (docResult.records.length > 0) {
            const doc = docResult.records[0].get('d').properties;
            docTitle = doc.title || docId;
            workspaceId = doc.workspace_id;
            chunkTexts = (docResult.records[0].get('chunkTexts') || []).filter(t => t);
            chunkCount = neo4jService.toNumber(docResult.records[0].get('chunkCount'));
            logger.info(`[extraction] Loaded ${chunkCount} chunks from Neo4j (legacy) for ${docId}`);
          }
        } finally {
          await session.close();
        }
      }
      
      if (chunkCount === 0) {
        throw new Error('Document not found or has no text content');
      }
      
      const combinedText = chunkTexts.join('\n\n');
      
      logger.debug(` Document chunks found: ${chunkCount}`);
      logger.debug(` Combined text length: ${combinedText.length} chars`);
      
      if (!combinedText.trim()) {
        throw new Error('No text content found in document');
      }
      
      // Step 2: Text Extraction complete -> Chunking (already done for this doc)
      await ontologyJobService.updateProcessingStep(jobId, 'text_extraction', 'completed', { 
        chars: combinedText.length 
      });
      await ontologyJobService.updateProcessingStep(jobId, 'chunking', 'completed', { 
        chunks: chunkCount 
      });
      
      // Step 3: LLM Extraction
      await ontologyJobService.updateProcessingStep(jobId, 'llm_extraction', 'active', {
        model: process.env.LOCAL_LLM_MODEL || 'unknown'
      });
      await ontologyJobService.updateJob(jobId, {
        status: 'analyzing',
        progress: 40,
        progress_message: `Extracting entities with LLM from ${chunkCount} chunks (${combinedText.length} chars)...`,
        preview_text: combinedText.substring(0, 2000)
      });
      
      logger.debug(` Calling LLM for extraction...`);
      logger.debug(`Text length: ${combinedText.length} chars`);
      logger.debug(`Ontology entity types: ${ontology?.entityTypes?.length || 0}`);
      logger.debug(`Ontology object keys: ${ontology ? Object.keys(ontology).join(', ') : 'null'}`);
      
      // Extract entities using GraphRAG service
      // Note: graphRagExtractionService expects 'existingOntology' key
      const extractionOptions = {
        existingOntology: ontology,
        documentId: docId,
        documentName: doc.title || docId
      };
      logger.debug(`Extraction options.existingOntology: ${extractionOptions.existingOntology ? 'present' : 'null'}`);
      
      const llmStartTime = Date.now();
      const extractionResult = await graphRagExtractionService.extractFromText(combinedText, extractionOptions);
      const llmDuration = ((Date.now() - llmStartTime) / 1000).toFixed(1);
      
      logger.info(`Extraction: ${extractionResult.entities?.length || 0} entities, ${extractionResult.relationships?.length || 0} relationships`);
      
      // Step 4: LLM complete -> Validation
      await ontologyJobService.updateProcessingStep(jobId, 'llm_extraction', 'completed', {
        duration: `${llmDuration}s`,
        entities: extractionResult.entities?.length || 0,
        relationships: extractionResult.relationships?.length || 0
      });
      await ontologyJobService.updateProcessingStep(jobId, 'validation', 'active');
      await ontologyJobService.updateJob(jobId, {
        status: 'validating',
        progress: 70,
        progress_message: 'Validating extraction against ontology contract...'
      });
      
      // Validate extraction against ontology contract (if ontology provided)
      let validationResult = null;
      let validEntities = extractionResult.entities || [];
      let validRelationships = extractionResult.relationships || [];
      
      if (ontology && ontology.id) {
        try {
          validationResult = await extractionContractService.validateExtraction(
            extractionResult,
            ontology.id,
            {
              strictMode: true,
              confidenceThreshold: 0.5,
              workspaceId,
              extractionRunId: jobId
            }
          );
          
          validEntities = validationResult.valid;
          validRelationships = validationResult.validRelationships;
          
          // Route violations to review queue
          if (validationResult.violations.length > 0) {
            logger.debug(` ${validationResult.violations.length} contract violations found`);
            
            for (const violation of validationResult.violations) {
              await reviewQueueService.addToQueue({
                item_type: violation.violation_type === 'LOW_CONFIDENCE' 
                  ? 'LOW_CONFIDENCE' 
                  : 'QUARANTINED',
                workspace_id: workspaceId,
                tenant_id: doc.tenant_id,
                entity_data: violation.attempted_data,
                confidence: violation.confidence,
                source_document_id: docId,
                source_span: violation.source_span,
                suggested_action: 'REVIEW'
              });
            }
          }
          
          // Route candidates to review queue
          if (validationResult.candidates.length > 0) {
            logger.debug(` ${validationResult.candidates.length} candidate concepts found`);
            
            for (const candidate of validationResult.candidates) {
              await reviewQueueService.addToQueue({
                item_type: 'CANDIDATE',
                workspace_id: workspaceId,
                tenant_id: doc.tenant_id,
                entity_data: {
                  label: candidate.term,
                  type: candidate.suggested_class,
                  description: candidate.suggested_definition
                },
                confidence: 0,
                source_document_id: docId,
                suggested_action: 'REVIEW'
              });
            }
          }
        } catch (validationError) {
          console.warn('Contract validation failed, proceeding with all entities:', validationError.message);
        }
      }
      
      await ontologyJobService.updateJob(jobId, {
        status: 'generating',
        progress: 85,
        progress_message: 'Processing extraction results...'
      });
      
      // Build suggested ontology structure for review
      const suggestedOntology = {
        extractionSummary: extractionResult.extractionSummary || {},
        entity_types: extractEntityTypes(validEntities),
        relationship_types: extractRelationshipTypes(validRelationships),
        entities: validEntities.slice(0, 100),
        relationships: validRelationships.slice(0, 100),
        stats: extractionResult.stats || {},
        validation: validationResult ? {
          mode: validationResult.mode,
          stats: validationResult.stats
        } : null
      };
      
      // Calculate average confidence for metrics
      const avgConfidence = validEntities.length > 0
        ? validEntities.reduce((sum, e) => sum + (e.confidence || 0), 0) / validEntities.length
        : 0;
      
      // Step 5: Validation complete -> Complete
      await ontologyJobService.updateProcessingStep(jobId, 'validation', 'completed', {
        violations: validationResult?.violations?.length || 0,
        candidates: validationResult?.candidates?.length || 0
      });
      await ontologyJobService.updateProcessingStep(jobId, 'complete', 'completed', {
        duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        entities: validEntities.length,
        relationships: validRelationships.length
      });
      
      await ontologyJobService.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        progress_message: 'Extraction complete - ready for review',
        extracted_entities: validEntities,
        extracted_relationships: validRelationships,
        suggested_ontology: suggestedOntology,
        ontology_suggestions: extractionResult.ontologySuggestions || {},
        entity_count: validEntities.length,
        relationship_count: validRelationships.length,
        validation_stats: validationResult?.stats || null
      });
      
      // Record metrics
      await metricsService.recordExtraction(workspaceId, {
        success: true,
        entityCount: validEntities.length,
        relationshipCount: validRelationships.length,
        avgConfidence
      });
      
      logger.info(`✅ Extraction complete: ${jobId}`);
      logger.debug(`Valid entities: ${validEntities.length}, Valid relationships: ${validRelationships.length}`);
      if (validationResult) {
        logger.debug(`Violations: ${validationResult.violations.length}, Candidates: ${validationResult.candidates.length}`);
      }
      
    } catch (error) {
      console.error(`❌ Extraction failed for job ${jobId}:`, error);
      
      // Mark current step as failed
      await ontologyJobService.updateProcessingStep(jobId, 'complete', 'failed', {
        error: error.message
      });
      
      await ontologyJobService.updateJob(jobId, {
        status: 'failed',
        progress: 0,
        progress_message: `Error: ${error.message}`,
        error: error.message
      });
      
      // Record failed extraction metric
      await metricsService.recordExtraction(workspaceId, {
        success: false,
        entityCount: 0,
        relationshipCount: 0,
        avgConfidence: 0
      });
    }
  });
}

// Helper functions for extraction
function extractEntityTypes(entities) {
  const types = new Map();
  for (const entity of entities) {
    const type = entity.type || entity.label || 'Unknown';
    if (!types.has(type)) {
      types.set(type, { type, count: 0, examples: [] });
    }
    const typeInfo = types.get(type);
    typeInfo.count++;
    if (typeInfo.examples.length < 3) {
      // Try multiple property names for the entity name
      const entityName = entity.label || entity.name || entity.text || 'Unknown';
      if (entityName && entityName !== 'Unknown') {
        typeInfo.examples.push(entityName);
      }
    }
  }
  return Array.from(types.values());
}

function extractRelationshipTypes(relationships) {
  const types = new Map();
  for (const rel of relationships) {
    // Use predicate first (semantic relationship), then fall back to type
    const type = rel.predicate || rel.type || rel.relationship || 'RELATED_TO';
    if (!types.has(type)) {
      types.set(type, { type, count: 0 });
    }
    types.get(type).count++;
  }
  return Array.from(types.values());
}

/**
 * POST /api/ontology/documents/:id/generate-graph
 * Generate/regenerate knowledge graph for an existing document
 */
router.post('/:id/generate-graph', async (req, res) => {
  req.setTimeout(30 * 60 * 1000); // 30 minute timeout
  
  try {
    const docId = req.params.id;
    const { ontologyId, schemaMode = 'constrained' } = req.body;
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    
    // Load document and chunks — Redis first, Neo4j fallback
    let doc = null;
    let chunks = [];
    
    const stagedJson = await redisService.get(`staged:${docId}`);
    if (stagedJson) {
      const staged = JSON.parse(stagedJson);
      doc = staged.document;
      chunks = (staged.chunks || []).map((c, i) => ({ text: c.text, uri: c.uri || `${doc.uri}#chunk=${i}`, order: c.order || i }));
    } else {
      const docJson = await redisService.get(`doc:${docId}`);
      if (docJson) {
        doc = JSON.parse(docJson);
        const redisChunks = await vectorStoreService.getDocumentChunks(docId);
        chunks = redisChunks.map((c, i) => ({ text: c.text, uri: c.id || `${doc.uri}#chunk=${i}`, order: parseInt(c.chunkIndex) || i }));
      }
    }
    
    // Neo4j fallback for legacy docs
    if (!doc) {
      const session = neo4jService.getSession();
      try {
        const docResult = await session.run(`
          MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
          OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
          RETURN d, collect(ch) as chunks ORDER BY ch.order
        `, { docId });
        if (docResult.records.length === 0) {
          return res.status(404).json({ success: false, error: 'Document not found' });
        }
        doc = docResult.records[0].get('d').properties;
        chunks = docResult.records[0].get('chunks').map(c => c.properties);
      } finally {
        await session.close();
      }
    }
    
    if (chunks.length === 0) {
      return res.status(400).json({ success: false, error: 'No chunks found for this document' });
    }
    
    // Get ontology
    let ontology = null;
    if (ontologyId && ontologyId !== 'auto') {
      ontology = await ontologyTemplateService.getTemplate(ontologyId);
      if (!ontology) {
        ontology = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
      }
    }
    
    // Build context
    const context = {
      doc_id: doc.doc_id,
      doc_uri: doc.uri,
      doc_type: doc.doc_type,
      
      ontologyTemplate: ontology ? {
        name: ontology.name,
        conceptTypes: ontology.nodeTypes || ontology.entityTypes?.map(e => e.label) || [],
        predicates: ontology.relationships?.map(r => r.type || r.predicate) || [],
        isAutoGenerated: schemaMode === 'unconstrained'
      } : null
    };
    
    // Extract concepts
    const extraction = await conceptExtractionService.extractConceptsFromChunks(
      chunks.map((c, i) => ({ ...c, uri: c.uri || `${doc.uri}#chunk=${i}` })),
      context
    );
    
    // Create concepts
    if (extraction.concepts?.length > 0) {
      await neo4jService.createConcepts(extraction.concepts, {});
    }
    
    // Create mentions
    if (extraction.mentions?.length > 0) {
      await neo4jService.createConceptMentions(extraction.mentions);
    }
    
    // Create relations
    if (extraction.relations?.length > 0) {
      await neo4jService.createConceptRelations(extraction.relations);
    }
    
    res.json({
      success: true,
      message: 'Graph generated',
      stats: {
        concepts: extraction.concepts?.length || 0,
        mentions: extraction.mentions?.length || 0,
        relations: extraction.relations?.length || 0
      }
    });
  } catch (error) {
    console.error('Error generating graph:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/bulk-generate-graph
 * Generate knowledge graph for multiple documents (synchronous processing)
 */
router.post('/bulk-generate-graph', async (req, res) => {
  req.setTimeout(30 * 60 * 1000);
  
  try {
    // Accept both docIds and documentIds for compatibility
    const documentIds = req.body.documentIds || req.body.docIds;
    const { ontologyId, entityTypes, predicates } = req.body;
    
    logger.debug('[bulk-generate-graph] Request body:', JSON.stringify(req.body, null, 2));
    logger.debug('[bulk-generate-graph] Document IDs:', documentIds);
    
    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'documentIds or docIds array is required' });
    }
    
    // Get ontology if specified
    let ontology = null;
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    if (ontologyId && ontologyId !== 'auto') {
      ontology = await ontologyTemplateService.getTemplate(ontologyId);
      if (!ontology) {
        ontology = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
      }
    }
    
    const results = [];
    let totalConcepts = 0;
    let totalRelations = 0;
    
    for (const docId of documentIds) {
      try {
        // Load document and chunks — Redis first, Neo4j fallback
        let doc = null;
        let chunks = [];
        
        const stagedJson = await redisService.get(`staged:${docId}`);
        if (stagedJson) {
          const staged = JSON.parse(stagedJson);
          doc = staged.document;
          chunks = (staged.chunks || []).map((c, i) => ({ text: c.text, uri: c.uri || `${doc.uri}#chunk=${i}`, order: c.order || i }));
        } else {
          const docJson = await redisService.get(`doc:${docId}`);
          if (docJson) {
            doc = JSON.parse(docJson);
            const redisChunks = await vectorStoreService.getDocumentChunks(docId);
            chunks = redisChunks.map((c, i) => ({ text: c.text, uri: c.id || `${doc.uri}#chunk=${i}`, order: parseInt(c.chunkIndex) || i }));
          }
        }
        
        // Neo4j fallback for legacy docs
        if (!doc) {
          const session = neo4jService.getSession();
          try {
            const docResult = await session.run(`
              MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
              OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
              RETURN d, collect(ch) as chunks ORDER BY ch.order
            `, { docId });
            if (docResult.records.length === 0) {
              results.push({ docId, error: 'Document not found', status: 'failed' });
              continue;
            }
            doc = docResult.records[0].get('d').properties;
            chunks = docResult.records[0].get('chunks').map(c => c.properties);
          } finally {
            await session.close();
          }
        }
        
        if (chunks.length === 0) {
          results.push({ docId, error: 'No chunks found', status: 'failed' });
          continue;
        }
        
        // Build context with ontology
        const conceptTypes = entityTypes || ontology?.nodeTypes || ontology?.entityTypes?.map(e => e.label) || [];
        const relTypes = predicates || ontology?.relationships?.map(r => r.type || r.predicate) || [];
        
        const context = {
          doc_id: doc.doc_id,
          doc_uri: doc.uri,
          doc_type: doc.doc_type,
          ontologyTemplate: {
            name: ontology?.name || 'Custom',
            conceptTypes,
            predicates: relTypes,
            isAutoGenerated: !ontologyId || ontologyId === 'auto'
          }
        };
        
        // Extract concepts
        const extraction = await conceptExtractionService.extractConceptsFromChunks(
          chunks.map((c, i) => ({ ...c, uri: c.uri || `${doc.uri}#chunk=${i}` })),
          context
        );
        
        // Create concepts
        if (extraction.concepts?.length > 0) {
          await neo4jService.createConcepts(extraction.concepts, {});
        }
        
        // Create mentions
        if (extraction.mentions?.length > 0) {
          await neo4jService.createConceptMentions(extraction.mentions);
        }
        
        // Create relations
        if (extraction.relations?.length > 0) {
          await neo4jService.createConceptRelations(extraction.relations);
        }
        
        const docConcepts = extraction.concepts?.length || 0;
        const docRelations = extraction.relations?.length || 0;
        totalConcepts += docConcepts;
        totalRelations += docRelations;
        
        results.push({ 
          docId, 
          status: 'success',
          concepts: docConcepts,
          relations: docRelations
        });
        
      } catch (e) {
        console.error(`Error processing document ${docId}:`, e);
        results.push({ docId, error: e.message, status: 'failed' });
      }
    }
    
    const successCount = results.filter(r => r.status === 'success').length;
    
    res.json({
      success: true,
      message: `Processed ${successCount} of ${documentIds.length} documents`,
      totalConcepts,
      totalRelations,
      results
    });
  } catch (error) {
    console.error('Error bulk generating graphs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/commit-staged
 * Commit staged document to GraphDB after ontology approval
 * Runs in background for large datasets
 */
router.post('/commit-staged', async (req, res) => {
  try {
    const { docId, ontologyId, columnMappings, primaryClass, extractedEntities, extractedRelationships, selectedSheets, sheetClassMap } = req.body;
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] || 'default';

    if (!docId) {
      return res.status(400).json({ success: false, error: 'docId is required' });
    }

    const redisService = require('../../services/redisService');
    const stagedJson = await redisService.get(`staged:${docId}`);
    
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged document not found or expired' });
    }

    const staged = JSON.parse(stagedJson);
    
    // Find or create job for this document
    const jobs = await ontologyJobService.getJobs({ limit: 100 });
    let job = jobs.find(j => j.staged_doc_id === docId);
    
    if (!job) {
      // Create a new job for tracking
      job = await ontologyJobService.createJob({
        job_type: 'commit',
        file_name: staged.document?.title || 'Document',
        staged_doc_id: docId,
        tenant_id: tenantId,
        workspace_id: workspaceId
      });
    }

    // Update job to processing status
    await ontologyJobService.updateJob(job.job_id, {
      status: 'processing',
      progress: 10,
      progress_message: 'Starting commit to GraphDB...'
    });

    // Return immediately - process in background
    res.json({
      success: true,
      message: 'Commit started in background',
      jobId: job.job_id,
      status: 'processing'
    });

    // Try to dispatch to BullMQ worker for out-of-process execution
    const commitOptions = {
      ontologyId, columnMappings, primaryClass, tenantId, workspaceId,
      extractedEntities, extractedRelationships, selectedSheets, sheetClassMap
    };

    let dispatched = false;
    try {
      const { QUEUE_NAMES, getQueue } = require('../../config/queue');
      const commitQueue = getQueue(QUEUE_NAMES.COMMIT_PROCESSING);
      await commitQueue.add('commit', {
        jobId: job.job_id, docId, staged, options: commitOptions
      }, { jobId: `commit-${job.job_id}` });
      dispatched = true;
      logger.info(`📤 Commit dispatched to BullMQ worker for job ${job.job_id}`);
    } catch (queueErr) {
      logger.warn(`⚠️ BullMQ dispatch failed (${queueErr.message}), falling back to in-process commit`);
    }

    // Fallback: run in-process if BullMQ is unavailable
    if (!dispatched) {
      processCommitInBackground(job.job_id, docId, staged, commitOptions)
        .catch(err => logger.error(`Background commit failed for job ${job.job_id}:`, err));
    }

  } catch (error) {
    logger.error('Commit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Background commit processing
 */
async function processCommitInBackground(jobId, docId, staged, options) {
  const { ontologyId, columnMappings, primaryClass, tenantId, workspaceId, selectedSheets, sheetClassMap, extractedRelationships } = options;
  const redisService = require('../../services/redisService');
  
  // Resolve current ontology version once for the entire commit
  let ontologyVersionId = null;
  if (ontologyId) {
    try {
      ontologyVersionId = await ontologyVersioningService.getCurrentVersion(ontologyId);
    } catch (e) { /* versioning may not be initialized */ }
  }

  try {
    logger.info(`[commit-staged] Processing doc ${docId}${ontologyId ? ` with ontology ${ontologyId}` : ' (no ontology)'}`);

    await ontologyJobService.updateJob(jobId, {
      progress: 20,
      progress_message: 'Loading ontology...'
    });

    // Load ontology if specified (optional)
    let ontology = null;
    if (ontologyId) {
      const owlService = require('../../services/owlOntologyService');
      try {
        const structure = await owlService.getOntologyStructure(tenantId, workspaceId, ontologyId, 'all');
        if (structure?.classes?.length > 0) {
          ontology = {
            classes: structure.classes,
            properties: structure.properties || [],
            ontologyIRI: structure.ontologyIRI
          };
        }
      } catch (e) {
        logger.warn(`Could not load ontology ${ontologyId}: ${e.message}`);
      }
    }

    await ontologyJobService.updateJob(jobId, {
      progress: 30,
      progress_message: 'Generating triples...'
    });

    const graphDBTripleService = require('../../services/graphDBTripleService');
    const docUri = staged.document.uri;
    let result;

    if (isTabularType(staged.type) && staged.csvData) {
      // For CSV, determine primary class
      let effectivePrimaryClass = primaryClass;
      if (!effectivePrimaryClass) {
        if (ontology?.classes?.[0]) {
          effectivePrimaryClass = ontology.classes[0].iri;
        } else {
          const safeName = staged.document.title.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '');
          effectivePrimaryClass = `http://purplefabric.ai/data#${safeName || 'Record'}`;
        }
      }

      const effectiveMappings = { ...(columnMappings || {}) };
      (staged.csvData.headers || []).forEach(col => {
        if (!effectiveMappings[col]) {
          effectiveMappings[col] = { property: '', linkedClass: '', ignore: false };
        }
      });

      // Filter rows by selected sheets if specified
      let csvDataForCommit = staged.csvData;
      if (selectedSheets && selectedSheets.length > 0 && staged.csvData.rows) {
        const filteredRows = staged.csvData.rows.filter(r => !r.__sheet || selectedSheets.includes(r.__sheet));
        const activeHeaderSet = new Set();
        if (staged.csvData.sheets) {
          staged.csvData.sheets.filter(s => selectedSheets.includes(s.name)).forEach(s => s.headers.forEach(h => activeHeaderSet.add(h)));
        }
        const filteredHeaders = activeHeaderSet.size > 0
          ? staged.csvData.headers.filter(h => h !== '__sheet' && activeHeaderSet.has(h))
          : staged.csvData.headers.filter(h => h !== '__sheet');
        csvDataForCommit = { ...staged.csvData, rows: filteredRows, headers: filteredHeaders, rowCount: filteredRows.length };
        logger.info(`[commit-staged] Filtered to ${selectedSheets.length} sheets: ${filteredRows.length} rows, ${filteredHeaders.length} headers`);
      }

      result = graphDBTripleService.generateCSVTriples(
        csvDataForCommit,
        ontology,
        effectiveMappings,
        { tenantId, workspaceId, docUri, docTitle: staged.document.title, primaryClass: effectivePrimaryClass, strictMode: false, sheetClassMap }
      );

      // Store CSV chunks + embeddings in Redis for RAG queries
      if (staged.chunks && staged.chunks.length > 0) {
        const embeddingService = require('../../services/embeddingService');
        const vectorStoreService = require('../../services/vectorStoreService');
        let stored = 0;
        const EMBED_PARALLEL = parseInt(process.env.EMBEDDING_PARALLELISM) || 10;
        for (let i = 0; i < staged.chunks.length; i += EMBED_PARALLEL) {
          const batch = staged.chunks.slice(i, i + EMBED_PARALLEL);
          const embeddings = await Promise.all(batch.map(c => embeddingService.generateEmbedding(c.text)));
          await Promise.all(batch.map((chunk, j) =>
            vectorStoreService.storeChunk({
              id: chunk.uri || `${docId}_chunk_${i + j}`,
              text: chunk.text,
              documentId: docId,
              documentName: staged.document.title,
              chunkIndex: i + j,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              doc_type: staged.document.doc_type || 'csv'
            }, embeddings[j]).then(() => { stored++; }).catch(e => logger.warn(`Failed to store chunk ${i + j}: ${e.message}`))
          ));
        }
        result.chunksStored = stored;
        logger.info(`📦 Stored ${stored}/${staged.chunks.length} CSV chunks with embeddings in Redis`);
      }

      // Process LLM-extracted relationships for CSV/Excel
      // These can be entity-level (specific IDs) or class-level (e.g., "Customer HAS_ORDER Order")
      if (extractedRelationships && extractedRelationships.length > 0) {
        const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
        const OWL_NS = 'http://www.w3.org/2002/07/owl#';
        const PF_NS = 'http://purplefabric.ai/ontology#';
        const relTriples = [];
        const declaredRelTypes = new Set();
        let resolvedCount = 0;

        // Build reverse maps: className → [rowUris], and value → [rowUris] for FK matching
        const classToRows = {};  // "Customer" → [{uri, row}, ...]
        const csvRows = csvDataForCommit.rows || [];
        const csvHeaders = csvDataForCommit.headers || [];
        csvRows.forEach((row, i) => {
          const sheetName = row.__sheet;
          const classLabel = (sheetName && result.sheetClassLabels?.[sheetName])
            || (ontology?.classes?.find(c => c.iri === effectivePrimaryClass)?.label)
            || effectivePrimaryClass.split('#').pop() || 'Record';
          if (!classToRows[classLabel]) classToRows[classLabel] = [];
          classToRows[classLabel].push({ uri: result.rowToUri[i], row, index: i });
        });

        for (const rel of extractedRelationships) {
          const predName = (rel.type || rel.predicate || 'relatedTo').replace(/[^a-zA-Z0-9]/g, '');
          const fromName = rel.from_entity || rel.from || '';
          const toName = rel.to_entity || rel.to || '';
          if (!fromName || !toName || !predName) continue;

          // Try 1: Direct entity-level resolution via idLookup
          const fromUri = result.idLookup?.[fromName];
          const toUri = result.idLookup?.[toName];

          if (fromUri && toUri && fromUri !== toUri) {
            if (!declaredRelTypes.has(predName)) {
              declaredRelTypes.add(predName);
              relTriples.push(`<${PF_NS}${predName}> <${RDF_NS}type> <${OWL_NS}ObjectProperty> .`);
              relTriples.push(`<${PF_NS}${predName}> <http://www.w3.org/2000/01/rdf-schema#label> "${graphDBTripleService.escapeTurtleLiteral(predName)}"^^<http://www.w3.org/2001/XMLSchema#string> .`);
            }
            relTriples.push(`<${fromUri}> <${PF_NS}${predName}> <${toUri}> .`);
            resolvedCount++;
            continue;
          }

          // Try 2: Class-level relationship — link rows across sheets via shared FK columns
          const fromRows = classToRows[fromName];
          const toRows = classToRows[toName];
          if (fromRows && toRows && fromRows !== toRows) {
            // Find shared column names between the two classes (FK columns)
            // e.g., "Orders" sheet has "CustomerID" column, "Customers" sheet has "CustomerID" column
            const fromCols = new Set(csvHeaders.filter(h => h !== '__sheet' && fromRows[0]?.row[h] != null));
            const toCols = new Set(csvHeaders.filter(h => h !== '__sheet' && toRows[0]?.row[h] != null));
            const sharedCols = [...fromCols].filter(c => toCols.has(c) && /(?:_?id|_?ref|_?code|_?num|_?number|_?key)$/i.test(c));

            if (sharedCols.length > 0) {
              // Build index of toRows by shared column values
              const fkCol = sharedCols[0]; // use first shared FK column
              const toIndex = {}; // value → toRowUri
              for (const tr of toRows) {
                const val = tr.row[fkCol];
                if (val != null && val !== '') toIndex[String(val)] = tr.uri;
              }

              if (!declaredRelTypes.has(predName)) {
                declaredRelTypes.add(predName);
                relTriples.push(`<${PF_NS}${predName}> <${RDF_NS}type> <${OWL_NS}ObjectProperty> .`);
                relTriples.push(`<${PF_NS}${predName}> <http://www.w3.org/2000/01/rdf-schema#label> "${graphDBTripleService.escapeTurtleLiteral(predName)}"^^<http://www.w3.org/2001/XMLSchema#string> .`);
              }

              for (const fr of fromRows) {
                const fkVal = fr.row[fkCol];
                if (fkVal != null && fkVal !== '') {
                  const targetUri = toIndex[String(fkVal)];
                  if (targetUri && targetUri !== fr.uri) {
                    relTriples.push(`<${fr.uri}> <${PF_NS}${predName}> <${targetUri}> .`);
                    resolvedCount++;
                  }
                }
              }
              logger.info(`[commit-staged] Class-level rel "${fromName} -${predName}-> ${toName}" via FK column "${fkCol}": linked rows`);
            } else {
              logger.info(`[commit-staged] Class-level rel "${fromName} -${predName}-> ${toName}": no shared FK column found, skipping`);
            }
          }
        }

        if (relTriples.length > 0) {
          result.triples.push(...relTriples);
          result.tripleCount = result.triples.length;
          logger.info(`[commit-staged] Added ${resolvedCount} resolved relationships (${relTriples.length} triples) from ${extractedRelationships.length} LLM-extracted relationships`);
        } else if (extractedRelationships.length > 0) {
          logger.info(`[commit-staged] ${extractedRelationships.length} LLM-extracted relationships could not be resolved to row entities`);
        }
      }

    } else if (staged.type === 'document' && staged.chunks) {
      // For text documents: store chunks in Redis, entities in GraphDB
      const triples = [];
      const XSD = 'http://www.w3.org/2001/XMLSchema#';
      const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
      const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
      const PF = 'http://purplefabric.ai/ontology#';
      
      // Document metadata triple only
      triples.push(`<${docUri}> <${RDF}type> <${PF}Document> .`);
      triples.push(`<${docUri}> <${RDFS}label> "${graphDBTripleService.escapeTurtleLiteral(staged.document.title)}"^^<${XSD}string> .`);
      
      // Store chunks in Redis with embeddings — parallel batches
      const embeddingService = require('../../services/embeddingService');
      const vectorStoreService = require('../../services/vectorStoreService');
      let storedChunks = 0;
      const EMBED_PARALLEL = parseInt(process.env.EMBEDDING_PARALLELISM) || 10;
      for (let i = 0; i < staged.chunks.length; i += EMBED_PARALLEL) {
        const batch = staged.chunks.slice(i, i + EMBED_PARALLEL);
        const embeddings = await Promise.all(batch.map(c => embeddingService.generateEmbedding(c.text)));
        await Promise.all(batch.map((chunk, j) => 
          vectorStoreService.storeChunk({
            id: chunk.uri || `${docId}_chunk_${i + j}`,
            text: chunk.text,
            documentId: docId,
            documentName: staged.document.title,
            chunkIndex: i + j,
            startPage: chunk.start_page,
            tenant_id: tenantId,
            workspace_id: workspaceId,
            doc_type: staged.document.doc_type || 'pdf'
          }, embeddings[j]).then(() => { storedChunks++; }).catch(e => logger.warn(`Failed to store chunk ${i + j}: ${e.message}`))
        ));
      }
      
      // Full entity extraction from ALL chunks (not just the 3 preview chunks)
      // OPTIMIZATION: If preview extraction results were passed in (from the extraction preview job),
      // use those instead of re-extracting. This eliminates duplicate LLM calls and ensures
      // consistency between what the user reviewed and what gets committed.
      let allEntities = [...(options.extractedEntities || [])];
      let allRelationships = [...(options.extractedRelationships || [])];
      
      const hasPreviewResults = allEntities.length > 0;
      
      if (hasPreviewResults) {
        // Skip re-extraction — use the preview results the user already reviewed
        logger.info(`[commit] Using ${allEntities.length} entities and ${allRelationships.length} relationships from preview (skipping re-extraction)`);
        await ontologyJobService.updateJob(jobId, {
          progress: 45,
          progress_message: `Using ${allEntities.length} reviewed entities (no re-extraction needed)...`
        });
      } else if (staged.chunks.length > 0) {
        await ontologyJobService.updateJob(jobId, {
          progress: 35,
          progress_message: `Extracting entities from ${staged.chunks.length} chunks...`
        });

        // Load ontology classes for guided extraction
        let classDesc = 'Extract any relevant entities (Person, Organization, Location, Date, Event, etc.)';
        let relDesc = 'Extract any relevant relationships between entities';
        if (ontologyId && ontology) {
          const ontClasses = ontology.classes || [];
          const ontRels = (ontology.properties || []).filter(p => p.type === 'objectProperty');
          if (ontClasses.length > 0) classDesc = ontClasses.map(c => `- ${c.localName || c.label}: ${c.comment || ''}`).join('\n');
          if (ontRels.length > 0) relDesc = ontRels.map(r => `- ${r.localName || r.label}: ${r.domain || 'Any'} → ${r.range || 'Any'}`).join('\n');
        }

        const llmService = require('../../services/llmService');
        const BATCH_SIZE = 10;
        const LLM_PARALLEL = parseInt(process.env.LLM_PARALLELISM) || 2;
        const seenEntities = new Set(allEntities.map(e => `${e.class || e.type}:${e.name}`.toLowerCase()));

        // Look up per-user Bedrock token for commit-time extraction
        let commitBedrockToken = null;
        try {
          const tokenStore = require('../../utils/tokenEncryption');
          const userId = options.userId || 'default';
          const userToken = await tokenStore.getToken(userId);
          if (userToken) commitBedrockToken = userToken;
        } catch (e) { /* use server default */ }

        for (let i = 0; i < staged.chunks.length; i += BATCH_SIZE * LLM_PARALLEL) {
          // Run LLM_PARALLEL batches concurrently
          const batchPromises = [];
          for (let p = 0; p < LLM_PARALLEL && (i + p * BATCH_SIZE) < staged.chunks.length; p++) {
            const start = i + p * BATCH_SIZE;
            const batch = staged.chunks.slice(start, start + BATCH_SIZE);
            const batchText = batch.map(c => c.text).join('\n\n---\n\n');
            
            const llmOpts = { temperature: 0, maxTokens: 2000 };
            if (commitBedrockToken) llmOpts.bedrockToken = commitBedrockToken;

            batchPromises.push(
              llmService.chat([{ role: 'user', content: `Extract entities and relationships from this text.

ENTITY TYPES TO EXTRACT:
${classDesc}

RELATIONSHIP TYPES:
${relDesc}

TEXT:
${require('../../utils/promptSanitizer').sanitizeDocumentText(batchText, 15000)}

Return JSON:
{
  "entities": [{"class": "Type", "name": "entity name", "confidence": 0.9}],
  "relationships": [{"type": "REL_TYPE", "from_entity": "name", "to_entity": "name", "confidence": 0.8}]
}` }], llmOpts).catch(e => {
                logger.warn(`Entity extraction batch failed: ${e.message}`);
                return null;
              })
            );
          }

          const responses = await Promise.all(batchPromises);
          for (const response of responses) {
            if (!response) continue;
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              let extraction;
              try { extraction = JSON.parse(jsonMatch[0]); } catch { extraction = { entities: [], relationships: [] }; }
              
              // Validate extraction output
              const llmOutputValidator = require('../../services/llmOutputValidator');
              const validated = llmOutputValidator.validateEntityExtraction(extraction, ontology);
              if (validated.warnings.length > 0) {
                logger.debug(`[commit] Extraction validation: ${validated.warnings.length} warnings`);
              }
              
              for (const e of (validated.cleaned.entities || [])) {
                const key = `${e.class || e.type}:${e.name}`.toLowerCase();
                if (!seenEntities.has(key)) {
                  seenEntities.add(key);
                  allEntities.push(e);
                }
              }
              allRelationships.push(...(validated.cleaned.relationships || []));
            }
          }

          const processed = Math.min(i + BATCH_SIZE * LLM_PARALLEL, staged.chunks.length);
          await ontologyJobService.updateJob(jobId, {
            progress: 35 + Math.round((processed / staged.chunks.length) * 10),
            progress_message: `Extracted entities from ${processed}/${staged.chunks.length} chunks (${allEntities.length} entities found)...`
          });
        }
        logger.info(`[commit] Full extraction: ${allEntities.length} entities, ${allRelationships.length} relationships from ${staged.chunks.length} chunks`);
      }

      // Build cross-document-safe entity URIs using entityUriService
      // This ensures the same entity (e.g., "John Smith" of type Person) across
      // multiple documents maps to the SAME URI, enabling cross-document linking.
      // entityUriService uses identity_keys from ontology when available for smarter dedup.
      const dataGraphIRI = require('../../services/graphDBStore').getDataGraphIRI(tenantId, workspaceId);
      const entityUriMap = new Map(); // "name" → entityUri (for relationship resolution)

      // Write extracted entities as triples
      if (allEntities.length > 0) {
        const OWL = 'http://www.w3.org/2002/07/owl#';
        
        // Collect unique classes and relationship types for OWL declarations
        const uniqueClasses = new Set();
        const uniqueRelTypes = new Set();
        
        for (const entity of allEntities) {
          const entityClass = entity.class || entity.type || 'Entity';
          uniqueClasses.add(entityClass);
        }
        
        if (allRelationships.length > 0) {
          for (const rel of allRelationships) {
            const relType = (rel.type || rel.predicate || 'relatedTo').replace(/[^a-zA-Z0-9]/g, '');
            uniqueRelTypes.add(relType);
          }
        }
        
        // Declare OWL classes
        for (const cls of uniqueClasses) {
          const classUri = `${PF}${cls.replace(/[^a-zA-Z0-9]/g, '')}`;
          triples.push(`<${classUri}> <${RDF}type> <${OWL}Class> .`);
          triples.push(`<${classUri}> <${RDFS}label> "${graphDBTripleService.escapeTurtleLiteral(cls)}"^^<${XSD}string> .`);
        }
        
        // Declare OWL object properties for relationship types
        for (const relType of uniqueRelTypes) {
          const propUri = `${PF}${relType}`;
          triples.push(`<${propUri}> <${RDF}type> <${OWL}ObjectProperty> .`);
          triples.push(`<${propUri}> <${RDFS}label> "${graphDBTripleService.escapeTurtleLiteral(relType)}"^^<${XSD}string> .`);
        }
        
        // Declare sourceDocument and confidence as datatype properties
        triples.push(`<${PF}sourceDocument> <${RDF}type> <${OWL}ObjectProperty> .`);
        triples.push(`<${PF}confidence> <${RDF}type> <${OWL}DatatypeProperty> .`);
        
        // Create entity instances using entityUriService for deterministic, identity-aware URIs
        for (const entity of allEntities) {
          const entityClass = (entity.class || entity.type || 'Entity').replace(/[^a-zA-Z0-9]/g, '');
          // Look up identity keys from ontology for this entity type
          const identityKeys = entityUriService.getIdentityKeysForType(ontology, entityClass);
          // Build properties map from entity for identity resolution
          const entityProps = entity.properties || {};
          // Generate deterministic URI via entityUriService
          const identityHash = entityUriService.generateIdentityHash(entity.name, entityProps, identityKeys);
          const normalizedType = entityUriService.normalizeType(entityClass);
          const entityUri = `${dataGraphIRI}/entity/${normalizedType}/${identityHash}`;
          entityUriMap.set(entity.name, entityUri);
          // Also index lowercase for fuzzy relationship matching
          entityUriMap.set(entity.name.toLowerCase(), entityUri);

          triples.push(`<${entityUri}> <${RDF}type> <${PF}${entityClass}> .`);
          triples.push(`<${entityUri}> <${RDFS}label> "${graphDBTripleService.escapeTurtleLiteral(entity.name)}"^^<${XSD}string> .`);
          triples.push(`<${entityUri}> <${PF}sourceDocument> <${docUri}> .`);
          if (entity.confidence) {
            triples.push(`<${entityUri}> <${PF}confidence> "${entity.confidence}"^^<${XSD}decimal> .`);
          }
          if (entity.evidence) {
            triples.push(`<${entityUri}> <${RDFS}comment> "${graphDBTripleService.escapeTurtleLiteral(entity.evidence.substring(0, 500))}"^^<${XSD}string> .`);
          }
        }
      }
      
      if (allRelationships.length > 0) {
        let relResolved = 0;
        let relSkipped = 0;
        for (const rel of allRelationships) {
          const fromName = rel.from_entity || rel.from;
          const toName = rel.to_entity || rel.to;
          if (!fromName || !toName) { relSkipped++; continue; }

          // Resolve relationship endpoints with fuzzy matching:
          // 1. Exact match by name
          // 2. Case-insensitive match
          // 3. Substring match (e.g., "John" matches "John Smith")
          let fromUri = entityUriMap.get(fromName) || entityUriMap.get(fromName.toLowerCase());
          let toUri = entityUriMap.get(toName) || entityUriMap.get(toName.toLowerCase());

          // Fuzzy: find entity whose name contains the relationship label (or vice versa)
          if (!fromUri) {
            const fromLower = fromName.toLowerCase();
            for (const entity of allEntities) {
              const eName = entity.name.toLowerCase();
              if (eName.includes(fromLower) || fromLower.includes(eName)) {
                fromUri = entityUriMap.get(entity.name);
                break;
              }
            }
          }
          if (!toUri) {
            const toLower = toName.toLowerCase();
            for (const entity of allEntities) {
              const eName = entity.name.toLowerCase();
              if (eName.includes(toLower) || toLower.includes(eName)) {
                toUri = entityUriMap.get(entity.name);
                break;
              }
            }
          }

          if (!fromUri || !toUri || fromUri === toUri) { relSkipped++; continue; }

          const relType = (rel.type || rel.predicate || 'relatedTo').replace(/[^a-zA-Z0-9]/g, '');
          triples.push(`<${fromUri}> <${PF}${relType}> <${toUri}> .`);
          // Store confidence as inline property on the relationship triple (no reification)
          if (rel.confidence) {
            triples.push(`<${fromUri}> <${PF}${relType}_confidence> "${rel.confidence}"^^<${XSD}decimal> .`);
          }
          relResolved++;
        }
        logger.info(`[commit] Relationships: ${relResolved} resolved, ${relSkipped} skipped (unresolvable endpoints)`);
      }
      
      result = { 
        triples, 
        entityCount: allEntities.length, 
        tripleCount: triples.length,
        chunksStored: storedChunks
      };
    } else {
      throw new Error('Unknown document type or missing data');
    }

    await ontologyJobService.updateJob(jobId, {
      progress: 50,
      progress_message: `Writing ${result.tripleCount} triples to GraphDB...`
    });

    // Write to GraphDB
    await graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, result.triples, { sourceDocumentURI: docUri });

    // Persist column mappings for future re-uploads (CSV only) — with versioning
    if (isTabularType(staged.type) && columnMappings && ontologyId) {
      try {
        const mapKey = `colmap:${workspaceId}:${ontologyId}`;
        const historyKey = `colmap_history:${workspaceId}:${ontologyId}`;

        // Archive previous version
        const existing = await redisService.get(mapKey);
        let newVersion = 1;
        if (existing) {
          const prev = JSON.parse(existing);
          newVersion = (prev.version || 1) + 1;
          let history = [];
          try {
            const historyJson = await redisService.get(historyKey);
            if (historyJson) history = JSON.parse(historyJson);
          } catch (e) { /* no history */ }
          history.unshift({
            version: prev.version || 1,
            savedAt: prev.savedAt,
            columnCount: Object.keys(prev.columnMappings || {}).length,
            primaryClass: prev.primaryClass,
            ontologyVersionId: prev.ontologyVersionId || null,
          });
          if (history.length > 20) history = history.slice(0, 20);
          await redisService.set(historyKey, JSON.stringify(history), 0);
        }
        
        const sourceHeaders = staged.csvData?.headers?.filter(h => h !== '__sheet') || Object.keys(columnMappings);
        await redisService.set(mapKey, JSON.stringify({
          columnMappings, primaryClass, sheetClassMap,
          sourceHeaders,
          savedAt: new Date().toISOString(),
          version: newVersion,
          ontologyVersionId,
        }), 0);
        logger.info(`[commit-staged] Saved column mappings v${newVersion} for workspace=${workspaceId} ontology=${ontologyId} (ontologyVersion=${ontologyVersionId})`);
      } catch (e) {
        logger.warn(`[commit-staged] Failed to save column mappings: ${e.message}`);
      }
    }

    await ontologyJobService.updateJob(jobId, {
      progress: 80,
      progress_message: 'Storing document metadata...'
    });

    // Store document metadata in Redis (not Neo4j)
    const docMetadata = {
      uri: staged.document.uri,
      doc_id: docId,
      title: staged.document.title,
      doc_type: staged.document.doc_type || staged.type,
      workspace_id: workspaceId,
      tenant_id: tenantId,
      folder_id: staged.document.folder_id || null,
      ontology_id: ontologyId,
      ontology_version_id: ontologyVersionId || null,
      primary_class: primaryClass,
      entity_count: result.entityCount,
      triple_count: result.tripleCount,
      chunks_stored: result.chunksStored || 0,
      committed_at: new Date().toISOString()
    };
    await redisService.set(`doc:${docId}`, JSON.stringify(docMetadata), 0);
    
    // Add to workspace document index
    await redisService.sAdd(`workspace:${workspaceId}:docs`, docId);

    // Remove from staging
    await redisService.del(`staged:${docId}`);

    // Mark complete
    await ontologyJobService.updateJob(jobId, {
      status: 'committed',
      progress: 100,
      staged: false,
      progress_message: `✅ Committed ${result.entityCount} entities (${result.tripleCount} triples)`,
      entity_count: result.entityCount,
      triple_count: result.tripleCount,
      committed_at: new Date().toISOString()
    });

    logger.info(`✅ Commit complete for job ${jobId}: ${result.entityCount} entities`);

    // Invalidate filter cache for this document
    try { await redisService.del(`cache:filters:${docId}`); } catch (e) { /* non-fatal */ }

    // Auto-sync committed data from GraphDB to Neo4j (incremental — don't clear existing data)
    try {
      await ontologyJobService.updateProcessingStep(jobId, 'syncing', 'active');
      await ontologyJobService.updateJob(jobId, {
        progress: 95,
        progress_message: 'Syncing to Neo4j...'
      });
      const graphDBNeo4jSyncService = require('../../services/graphDBNeo4jSyncService');
      await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId, { mode: 'incremental' });
      await ontologyJobService.updateProcessingStep(jobId, 'syncing', 'completed');
      await ontologyJobService.updateProcessingStep(jobId, 'complete', 'completed');
      await ontologyJobService.updateJob(jobId, {
        progress: 100,
        progress_message: `✅ Committed ${result.entityCount} entities (${result.tripleCount} triples)`
      });
      logger.info(`🔄 Neo4j sync completed after commit for job ${jobId}`);
    } catch (syncErr) {
      await ontologyJobService.updateProcessingStep(jobId, 'syncing', 'completed', { error: 'Sync failed (non-fatal)' });
      await ontologyJobService.updateProcessingStep(jobId, 'complete', 'completed');
      await ontologyJobService.updateJob(jobId, {
        progress: 100,
        progress_message: `✅ Committed ${result.entityCount} entities (Neo4j sync skipped)`
      });
      logger.warn(`⚠️ Neo4j sync failed after commit (non-fatal): ${syncErr.message}`);
    }

  } catch (error) {
    logger.error(`❌ Commit failed for job ${jobId}:`, error);
    await ontologyJobService.updateJob(jobId, {
      status: 'failed',
      progress_message: `❌ ${error.message}`,
      error: error.message
    });
  }
}

/**
 * POST /api/ontology/documents/analyze-staged
 * Analyze a staged document directly (synchronous, for review flow)
 */
router.post('/analyze-staged', async (req, res) => {
  try {
    const { docId } = req.body;
    if (!docId) {
      return res.status(400).json({ success: false, error: 'docId required' });
    }

    const redisService = require('../../services/redisService');
    const stagedJson = await redisService.get(`staged:${docId}`);
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged document not found' });
    }

    const staged = JSON.parse(stagedJson);
    let analysis;

    // For CSV, analyze columns directly instead of using text analysis
    if (isTabularType(staged.type) && staged.csvData) {
      const headers = staged.csvData.headers || [];
      const rows = staged.csvData.rows || [];
      
      // Build column suggestions and convert to entityTypes format for UI
      const columns = headers.map(header => {
        const sampleValues = rows.slice(0, 5).map(r => r[header]).filter(Boolean);
        const isNumeric = sampleValues.length > 0 && sampleValues.every(v => !isNaN(Number(v)));
        const isId = /id$/i.test(header) || header.toLowerCase() === 'id';
        const isDate = /date|time|created|updated/i.test(header);
        
        return {
          column: header,
          suggestedLabel: header.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, ''),
          suggestedType: (isId || isNumeric || isDate) ? 'property' : 'node',
          includeAsNode: !isId && !isNumeric && !isDate,
          includeAsProperty: isId || isNumeric || isDate,
          sampleValues,
          confidence: 0.7
        };
      });

      // Convert columns to entityTypes format expected by UI
      const entityTypes = columns
        .filter(c => c.includeAsNode)
        .map(c => ({
          name: c.suggestedLabel,
          label: c.suggestedLabel,
          description: `Entity derived from column "${c.column}". Sample values: ${c.sampleValues.slice(0, 3).join(', ')}`,
          column: c.column,
          include: true
        }));

      // Suggest relationships between entity columns
      const relationships = [];
      const nodeColumns = columns.filter(c => c.includeAsNode);
      for (let i = 0; i < nodeColumns.length - 1; i++) {
        relationships.push({
          from: nodeColumns[i].suggestedLabel,
          predicate: `HAS_${nodeColumns[i + 1].suggestedLabel.toUpperCase()}`,
          to: nodeColumns[i + 1].suggestedLabel,
          description: `Relationship between ${nodeColumns[i].column} and ${nodeColumns[i + 1].column}`
        });
      }

      analysis = {
        id: require('uuid').v4(),
        fileType: 'csv',
        documentName: staged.document?.title || 'document',
        columns,
        entityTypes,
        relationships,
        summary: {
          totalColumns: headers.length,
          totalRows: rows.length,
          suggestedNodeColumns: columns.filter(c => c.includeAsNode).length,
          suggestedPropertyColumns: columns.filter(c => c.includeAsProperty).length,
          suggestedEntityTypes: entityTypes.length,
          suggestedRelationships: relationships.length
        }
      };
    } else {
      // For non-CSV, use text analysis
      let textToAnalyze = '';
      if (staged.text) {
        textToAnalyze = staged.text.substring(0, 20000);
      } else if (staged.chunks) {
        textToAnalyze = staged.chunks.slice(0, 5).map(c => c.text).join('\n\n');
      }

      if (!textToAnalyze) {
        return res.status(400).json({ success: false, error: 'No text content to analyze' });
      }

      analysis = await schemaAnalysisService.analyzeText(textToAnalyze, {
        documentName: staged.document?.title || 'document'
      });
    }

    res.json({
      success: true,
      analysis: {
        ...analysis,
        entityTypes: analysis.entityTypes || [],
        relationships: analysis.relationships || [],
        summary: analysis.summary
      }
    });
  } catch (error) {
    logger.error('Error analyzing staged document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/analyze-for-schema
 * Analyze existing documents to suggest an ontology schema (background job)
 */
router.post('/analyze-for-schema', optionalTenantContext, async (req, res) => {
  try {
    const documentIds = req.body.documentIds || req.body.docIds;
    const { industry = 'general' } = req.body;
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id || '';
    
    logger.debug('[analyze-for-schema] Document IDs:', documentIds);
    
    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'documentIds or docIds array is required' });
    }

    // Verify all documents belong to this workspace
    if (workspaceId) {
      for (const dId of documentIds) {
        const owned = await verifyDocWorkspace(dId, workspaceId);
        if (owned === null) {
          const exists = await redisService.get(`doc:${dId}`);
          if (exists) {
            return res.status(403).json({ success: false, error: `Document ${dId} does not belong to this workspace` });
          }
        }
      }
    }
    
    // Create a schema analysis job
    const job = await ontologyJobService.createJob({
      fileName: `Schema Analysis (${documentIds.length} docs)`,
      filePath: '',
      fileSize: 0,
      workspaceId,
      folderId: req.body.folder_id || '',
      
      documentId: documentIds.join(','),
      status: 'pending',
      jobType: 'schema_analysis'
    });
    
    // Process in background
    processSchemaAnalysisInBackground(job.job_id, documentIds);
    
    res.json({
      success: true,
      message: 'Schema analysis started',
      jobId: job.job_id,
      status: 'pending'
    });
  } catch (error) {
    console.error('Error starting schema analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Background processor for schema analysis
 */
async function processSchemaAnalysisInBackground(jobId, documentIds) {
  logger.debug(`Background schema analysis for job: ${jobId}`);
  
  setImmediate(async () => {
    const session = neo4jService.getSession();
    
    try {
      await ontologyJobService.updateJob(jobId, {
        status: 'extracting',
        progress: 10,
        progress_message: 'Collecting document text...'
      });
      
      // Collect text from all documents (check Redis staging first, then Neo4j)
      let combinedText = '';
      const documentNames = [];
      const redisService = require('../../services/redisService');
      
      for (let i = 0; i < documentIds.length; i++) {
        const docId = documentIds[i];
        
        // Check Redis staging first
        const stagedJson = await redisService.get(`staged:${docId}`);
        if (stagedJson) {
          const staged = JSON.parse(stagedJson);
          documentNames.push(staged.document?.title || docId);
          
          if (isTabularType(staged.type) && staged.csvData) {
            // Use CSV summary for analysis
            combinedText += staged.csvData.summary || '';
            combinedText += '\n\n---\n\n';
            logger.info(`[Schema Analysis] Doc ${docId}: STAGED CSV, ${staged.csvData.rowCount} rows`);
          } else if (staged.chunks) {
            combinedText += staged.chunks.map(c => c.text).join('\n\n');
            combinedText += '\n\n---\n\n';
            logger.info(`[Schema Analysis] Doc ${docId}: STAGED, ${staged.chunks.length} chunks`);
          } else if (staged.text) {
            combinedText += staged.text + '\n\n---\n\n';
            logger.info(`[Schema Analysis] Doc ${docId}: STAGED text`);
          }
          continue;
        }
        
        // Fall back to Neo4j
        const docResult = await session.run(`
          MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
          OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
          WITH d, ch
          ORDER BY ch.order
          RETURN d, collect(ch.text) as chunkTexts
        `, { docId });
        
        if (docResult.records.length > 0) {
          const doc = docResult.records[0].get('d').properties;
          const chunkTexts = docResult.records[0].get('chunkTexts') || [];
          
          logger.info(`[Schema Analysis] Doc ${docId}: ${chunkTexts.length} chunks, ${chunkTexts.join('').length} chars`);
          documentNames.push(doc.title || doc.doc_id);
          combinedText += chunkTexts.join('\n\n') + '\n\n---\n\n';
        } else {
          logger.warn(`[Schema Analysis] Doc ${docId}: NOT FOUND in staging or Neo4j`);
        }
        
        await ontologyJobService.updateJob(jobId, {
          progress: 10 + Math.floor((i + 1) / documentIds.length * 30),
          progress_message: `Collected ${i + 1}/${documentIds.length} documents...`
        });
      }
      
      if (!combinedText.trim()) {
        throw new Error('No text content found in selected documents');
      }
      
      await ontologyJobService.updateJob(jobId, {
        status: 'analyzing',
        progress: 50,
        progress_message: 'Analyzing with LLM to suggest schema...'
      });
      
      // Analyze the combined text
      const analysis = await schemaAnalysisService.analyzeText(combinedText, {
        
        documentName: documentNames.join(', '),
        docType: 'multi-document'
      });
      
      await ontologyJobService.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        progress_message: 'Ontology analysis complete - ready for review',
        suggested_ontology: {
          analysisId: analysis.id,
          entityTypes: analysis.entityTypes || [],
          relationships: analysis.relationships || [],
          summary: analysis.summary,
          documentNames,
          // New fields from ontology analysis
          attributeCandidates: analysis.attributeCandidates || [],
          ontologyGaps: analysis.ontologyGaps || [],
          uncertainties: analysis.uncertainties || []
        },
        entity_count: analysis.entityTypes?.length || 0,
        relationship_count: analysis.relationships?.length || 0
      });
      
      logger.info(`✅ Schema analysis complete for job: ${jobId}`);
      logger.debug(`Candidate classes: ${analysis.entityTypes?.length || 0}`);
      logger.debug(`Candidate relationships: ${analysis.relationships?.length || 0}`);
      logger.debug(`Attribute candidates: ${analysis.attributeCandidates?.length || 0}`);
      console.log(`   Uncertainties: ${analysis.uncertainties?.length || 0}`);
      
    } catch (error) {
      console.error(`❌ Schema analysis failed for job ${jobId}:`, error);
      await ontologyJobService.updateJob(jobId, {
        status: 'failed',
        progress_message: `Error: ${error.message}`,
        error: error.message
      });
    } finally {
      await session.close();
    }
  });
}

/**
 * POST /api/ontology/documents/:id/preview-extraction
 * Preview extraction results before committing
 */
router.post('/:id/preview-extraction', async (req, res) => {
  req.setTimeout(30 * 60 * 1000);
  
  try {
    const docId = req.params.id;
    const { ontologyId, schemaMode = 'unconstrained', sampleChunks = 3 } = req.body;
    
    const session = neo4jService.getSession();
    
    try {
      // Get document and sample chunks
      const docResult = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        WITH d, ch ORDER BY ch.order
        WITH d, collect(ch)[0..$sampleChunks] as chunks
        RETURN d, chunks
      `, { docId, sampleChunks });
      
      if (docResult.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      
      const doc = docResult.records[0].get('d').properties;
      const chunks = docResult.records[0].get('chunks').map(c => c.properties);
      
      // Get ontology for context
      let ontology = null;
      if (ontologyId && ontologyId !== 'auto') {
        ontology = await ontologyTemplateService.getTemplate(ontologyId);
        if (!ontology) {
          ontology = await owlOntologyService.getOntologyStructure(tenantId || "default", workspaceId || "default", ontologyId);
        }
      }
      
      // Extract from sample chunks
      const context = {
        doc_id: doc.doc_id,
        doc_uri: doc.uri,
        
        ontologyTemplate: ontology ? {
          name: ontology.name,
          conceptTypes: ontology.nodeTypes || [],
          predicates: ontology.relationships?.map(r => r.type) || [],
          isAutoGenerated: schemaMode === 'unconstrained'
        } : { isAutoGenerated: true }
      };
      
      const extraction = await conceptExtractionService.extractConceptsFromChunks(
        chunks.map((c, i) => ({ ...c, uri: `${doc.uri}#chunk=${i}` })),
        context
      );
      
      res.json({
        success: true,
        preview: {
          document: doc.title,
          chunksAnalyzed: chunks.length,
          entities: extraction.concepts || [],
          relationships: extraction.relations || [],
          suggestedTypes: [...new Set((extraction.concepts || []).map(c => c.type))]
        }
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error previewing extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/documents/:id/approve-extraction
 * Approve and save reviewed entities/relationships to BOTH Neo4j AND GraphDB
 * STRICT MODE: Requires ontology, validates all entity types and relationships
 */
router.post('/:id/approve-extraction', async (req, res) => {
  try {
    const docId = req.params.id;
    const { entities, relationships, ontologyId } = req.body;
    const tenantId = req.body.tenantId || req.headers['x-tenant-id'];
    const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'];
    
    // Strict validation
    if (!entities || !Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({ success: false, error: 'entities array with at least one entity is required' });
    }
    if (!ontologyId) {
      return res.status(400).json({ success: false, error: 'ontologyId is required - extractions must be validated against an ontology' });
    }
    if (!tenantId) {
      return res.status(400).json({ success: false, error: 'tenantId is required' });
    }
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    
    // Load ontology
    const owlService = require('../../services/owlOntologyService');
    const structure = await owlService.getOntologyStructure(tenantId, workspaceId, ontologyId, 'all');
    
    if (!structure || !structure.classes || structure.classes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Ontology "${ontologyId}" not found or has no classes defined` 
      });
    }
    
    const ontology = {
      classes: structure.classes,
      properties: structure.properties || [],
      ontologyIRI: structure.ontologyIRI
    };
    
    const session = neo4jService.getSession();
    
    try {
      // Get document
      const docResult = await session.run(`
        MATCH (d:Document) WHERE d.doc_id = $docId OR d.uri = $docId
        RETURN d
      `, { docId });
      
      if (docResult.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      
      const doc = docResult.records[0].get('d').properties;
      
      // Generate GraphDB triples with strict validation
      const graphDBTripleService = require('../../services/graphDBTripleService');
      const tripleResult = graphDBTripleService.generateEntityTriples(
        entities,
        relationships || [],
        ontology,
        { tenantId, workspaceId, docUri: doc.uri }
      );
      
      // Write to GraphDB first (if this fails, don't write to Neo4j)
      await graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, tripleResult.triples);
      
      // Now write to Neo4j for visualization
      let createdEntities = 0;
      let createdRelationships = 0;
      
      for (const entity of entities) {
        const entityType = sanitizeLabel(entity.type || entity.class);
        const conceptId = uuidv4();
        
        await session.run(`
          MERGE (c:\`${entityType}\` {label: $label})
          ON CREATE SET 
            c.concept_id = $conceptId,
            c.description = $description,
            c.confidence = $confidence,
            c.source = $source,
            c.tenant_id = $tenantId,
            c.workspace_id = $workspaceId,
            c.created_at = datetime()
          RETURN c
        `, {
          label: entity.label || entity.name,
          conceptId,
          description: entity.description || '',
          confidence: entity.confidence || 0.9,
          source: doc.uri,
          tenantId,
          workspaceId
        });
        createdEntities++;
      }
      
      for (const rel of (relationships || [])) {
        const relType = sanitizeLabel(rel.predicate || rel.type);
        
        await session.run(`
          MATCH (from {label: $fromLabel, tenant_id: $tenantId})
          MATCH (to {label: $toLabel, tenant_id: $tenantId})
          MERGE (from)-[r:\`${relType}\`]->(to)
          ON CREATE SET r.confidence = $confidence, r.source = $source
          RETURN r
        `, {
          fromLabel: rel.sourceLabel || rel.from || rel.source,
          toLabel: rel.targetLabel || rel.to || rel.target,
          confidence: rel.confidence || 0.8,
          source: doc.uri,
          tenantId
        });
        createdRelationships++;
      }
      
      res.json({
        success: true,
        message: 'Extraction approved and saved to GraphDB and Neo4j',
        stats: { 
          entities: createdEntities, 
          relationships: createdRelationships,
          triples: tripleResult.tripleCount
        }
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Error approving extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/analyze-csv
 * Analyze a CSV file and return suggested column mappings
 */
router.post('/analyze-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.csv') {
      cleanupFile(req.file.path);
      return res.status(400).json({ success: false, error: 'Only CSV files are supported' });
    }
    
    const analysis = await schemaAnalysisService.analyzeCSV(req.file.path, {
      documentName: req.file.originalname,
      industry: req.body.industry || 'general'
    });
    
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Error analyzing CSV:', error);
    cleanupFile(req.file?.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/create-with-predefined-schema
 * Create nodes using a predefined industry schema
 */
router.post('/create-with-predefined-schema', upload.single('file'), optionalTenantContext, async (req, res) => {
  try {
    await ensureSchemaInitialized();

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const documentName = req.file.originalname;
    const industry = req.body.industry;
    const chunkingMethod = req.body.chunkingMethod || 'fixed';
    const extractionMethod = req.body.extractionMethod || 'pdf-parse';
    const ontologyId = req.body.ontologyId || null;
    
    const tenantContext = req.tenantContext || {};
    const tenantId = req.body.tenant_id || tenantContext.tenant_id || null;
    const workspaceId = req.body.workspace_id || tenantContext.workspace_id || null;
    const folderId = req.body.folder_id || null;
    
    let predefinedSchema;
    try {
      predefinedSchema = JSON.parse(req.body.predefinedSchema || '{}');
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid predefinedSchema JSON' });
    }

    // Parse column and relationship mapping for CSV
    let columnMapping = null;
    let relationshipMapping = null;
    try {
      if (req.body.columnMapping) {
        columnMapping = JSON.parse(req.body.columnMapping);
      }
      if (req.body.relationshipMapping) {
        relationshipMapping = JSON.parse(req.body.relationshipMapping);
      }
    } catch (e) {
      logger.warn('Failed to parse mapping data:', e.message);
    }

    const selectedEntityTypes = predefinedSchema.entityTypes || [];
    const selectedRelationships = predefinedSchema.relationships || [];

    console.log(`🏭 Creating with predefined schema: ${documentName}${ontologyId ? ` (ontology: ${ontologyId})` : ''}`);

    const docId = uuidv4();
    const docUri = `doc://${docId}`;

    // Load ontology structure if ontologyId provided
    let ontology = null;
    if (ontologyId && ontologyId !== 'auto') {
      try {
        ontology = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
      } catch (e) {
        logger.warn(`Could not load ontology ${ontologyId}: ${e.message}`);
      }
    }

    // Extract text
    let text = '';
    let csvData = null;
    let numPages = 1;
    let pageBreaks = [];
    let pageTexts = [];

    if (ext === '.pdf') {
      if (extractionMethod === 'ocr') {
        const ocrResult = await ocrService.extractTextFromPDF(filePath);
        text = ocrResult.text;
        numPages = ocrResult.numPages || 1;
      } else {
        const pdfData = await pdfParser.extractText(filePath);
        text = pdfData.text;
        numPages = pdfData.numPages || 1;
        pageBreaks = pdfData.pageBreaks || [];
        pageTexts = pdfData.pageTexts || [];
      }
    } else if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
      if (ext === '.csv') {
        csvData = await csvParser.parse(filePath, { hasHeader: true });
        text = csvData.text;
      } else {
        const excelParser = require('../../services/excelParser');
        const parsed = await excelParser.parse(filePath);
        const flat = excelParser.flattenSheets(parsed);
        csvData = { headers: flat.headers, rows: flat.rows, rowCount: flat.rowCount };
        text = parsed.text;
      }
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    // Create Document node
    await neo4jService.createDocument({
      uri: docUri, doc_id: docId, title: documentName,
      source: 'upload', doc_type: ext.replace('.', ''),
       language: 'en',
      tenant_id: tenantId, workspace_id: workspaceId, folder_id: folderId,
      ingested_at: new Date().toISOString(), created_at: new Date().toISOString()
    });

    let result = {
      documentUri: docUri, documentId: docId,
      chunksCreated: 0, conceptsCreated: 0, relationshipsCreated: 0, nodesCreated: 0
    };

    // Handle CSV/Excel with ontology-aware processing
    if ((ext === '.csv' || ext === '.xlsx' || ext === '.xls') && csvData) {
      const csvToGraphService = require('../../services/csvToGraphService');
      let graphResult;

      if (ontology && (ontology.classes?.length > 0 || ontology.entityTypes?.length > 0)) {
        logger.info(`   📊 Using ontology-aware CSV processing`);
        graphResult = csvToGraphService.convertWithOntology(
          csvData,
          ontology,
          columnMapping || {},
          relationshipMapping || []
        );
      } else if (columnMapping && Object.keys(columnMapping).length > 0) {
        // Use column mapping even without full ontology
        graphResult = csvToGraphService.convertWithOntology(
          csvData,
          { classes: selectedEntityTypes.map(t => ({ label: t })) },
          columnMapping,
          relationshipMapping || []
        );
      } else {
        graphResult = csvToGraphService.convertToGraph(csvData, { industry });
      }

      if (graphResult.nodes.length > 0) {
        await neo4jService.createConcepts(graphResult.nodes, { industry });
        result.nodesCreated = graphResult.nodes.length;
        result.conceptsCreated = graphResult.nodes.length;
      }

      if (graphResult.relationships.length > 0) {
        await neo4jService.createConceptRelations(graphResult.relationships);
        result.relationshipsCreated = graphResult.relationships.length;
      }

      // Create summary chunk
      await neo4jService.createChunks([{
        uri: `${docUri}#csv`, chunk_id: uuidv4(),
        text: `CSV: ${documentName} - ${csvData.rowCount} rows`,
        order: 0, vector_key: `${docId}_csv`,
        tenant_id: tenantId, workspace_id: workspaceId
      }], docUri);
      result.chunksCreated = 1;

    } else {
      // Non-CSV document processing
      const chunks = chunkingService.chunkDocumentWithMethod(text, {
        id: docId, uri: docUri, name: documentName,
        doc_type: ext.replace('.', ''), chunkingMethod, numPages,
        pageBreaks, pageTexts
      }).chunks;

      await neo4jService.createChunks(
        chunks.map((chunk, i) => ({
          uri: `${docUri}#chunk=${i}`, chunk_id: uuidv4(),
          text: chunk.text, order: i, vector_key: `${docId}_${i}`,
          tenant_id: tenantId, workspace_id: workspaceId
        })),
        docUri
      );
      result.chunksCreated = chunks.length;

      // Build ontology context
      const context = {
        doc_id: docId, doc_uri: docUri, doc_type: ext.replace('.', ''),
        
        ontologyTemplate: {
          name: `${industry} (Predefined)`,
          conceptTypes: selectedEntityTypes,
          predicates: selectedRelationships,
          isAutoGenerated: false
        }
      };

      // Extract concepts
      let extraction = { concepts: [], mentions: [], relations: [] };
      try {
        extraction = await conceptExtractionService.extractConceptsFromChunks(
          chunks.map((c, i) => ({ ...c, uri: `${docUri}#chunk=${i}` })),
          context
        );
      } catch (e) {
        console.warn('Concept extraction failed:', e.message);
      }

      if (extraction.concepts?.length > 0) {
        await neo4jService.createConcepts(extraction.concepts, { industry });
        result.conceptsCreated = extraction.concepts.length;
        result.nodesCreated = extraction.concepts.length;
      }
      if (extraction.mentions?.length > 0) {
        await neo4jService.createConceptMentions(extraction.mentions);
      }
      if (extraction.relations?.length > 0) {
        await neo4jService.createConceptRelations(extraction.relations);
        result.relationshipsCreated = extraction.relations.length;
      }

      // Generate embeddings
      try {
        await vectorStoreService.addChunks(
          chunks.map((c, i) => ({
            id: `${docId}_${i}`, chunk_id: `${docId}_${i}`,
            docId, documentId: docId, documentName, chunkIndex: i, text: c.text,
            tenant_id: tenantId, workspace_id: workspaceId,
            metadata: { docUri, chunkUri: `${docUri}#chunk=${i}` }
          }))
        );
      } catch (e) {
        console.warn('Embedding generation failed:', e.message);
      }
    }

    cleanupFile(filePath);

    res.json({
      success: true,
      message: 'Document processed with predefined schema',
      result
    });
  } catch (error) {
    console.error('Error creating with predefined schema:', error);
    cleanupFile(req.file?.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/create-from-analysis/:id
 * Create nodes from approved analysis
 */
router.post('/create-from-analysis/:id', optionalTenantContext, async (req, res) => {
  try {
    await ensureSchemaInitialized();

    const analysisId = req.params.id;
    
    let analysis = schemaAnalysisService.getAnalysis(analysisId);
    if (!analysis) {
      analysis = await schemaAnalysisService.getAnalysisAsync(analysisId);
    }
    
    if (!analysis) {
      return res.status(404).json({ 
        success: false, 
        error: 'Analysis not found or expired',
        message: 'Please re-analyze the file.'
      });
    }

    const tenantContext = req.tenantContext || {};
    const tenantId = req.body.tenant_id || tenantContext.tenant_id || analysis.tenant_id || null;
    const workspaceId = req.body.workspace_id || tenantContext.workspace_id || analysis.workspace_id || null;
    const folderId = req.body.folder_id || analysis.folder_id || null;
    
    let approvedSchema;
    try {
      approvedSchema = schemaAnalysisService.getApprovedSchema(analysisId);
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    console.log(`✅ Creating from analysis: ${analysis.documentName}`);

    const docId = uuidv4();
    const docUri = `doc://${docId}`;

    // Create Document node
    await neo4jService.createDocument({
      uri: docUri, doc_id: docId, title: analysis.documentName,
      source: 'upload', doc_type: analysis.fileType,
      language: 'en',
      tenant_id: tenantId, workspace_id: workspaceId, folder_id: folderId,
      ingested_at: new Date().toISOString(), created_at: new Date().toISOString()
    });

    let result = {
      documentUri: docUri, documentId: docId,
      nodesCreated: 1, relationshipsCreated: 0, chunksEmbedded: 0
    };

    // Handle CSV vs text documents differently
    if (analysis.fileType === 'csv' && analysis.filePath) {
      // Process CSV with approved schema
      const csvData = await csvParser.parse(analysis.filePath, { hasHeader: true });
      
      // Create nodes from CSV rows based on approved columns
      const nodeColumns = approvedSchema.nodeColumns || [];
      for (const row of csvData.rows || []) {
        for (const col of nodeColumns) {
          if (row[col]) {
            const nodeType = sanitizeLabel(col);
            await neo4jService.getSession().run(`
              MERGE (n:\`${nodeType}\` {label: $label})
              ON CREATE SET n.concept_id = $id, n.source = $source, n.created_at = datetime()
            `, { label: row[col], id: uuidv4(), source: docUri });
            result.nodesCreated++;
          }
        }
      }
    } else if (analysis.filePath && fs.existsSync(analysis.filePath)) {
      // Process text document
      let text = '';
      if (analysis.fileType === 'pdf') {
        const pdfData = await pdfParser.extractText(analysis.filePath);
        text = pdfData.text;
      } else {
        text = fs.readFileSync(analysis.filePath, 'utf-8');
      }

      // Chunk and process
      const chunks = chunkingService.chunkDocumentWithMethod(text, {
        id: docId, uri: docUri, name: analysis.documentName,
        doc_type: analysis.fileType, chunkingMethod: analysis.chunkingMethod || 'fixed',
        numPages: analysis.numPages || 1
      }).chunks;

      // Create chunks
      await neo4jService.createChunks(
        chunks.map((chunk, i) => ({
          uri: `${docUri}#chunk=${i}`, chunk_id: uuidv4(),
          text: chunk.text, order: i, vector_key: `${docId}_${i}`,
          tenant_id: tenantId, workspace_id: workspaceId
        })),
        docUri
      );

      // Extract concepts using approved schema
      const context = {
        doc_id: docId, doc_uri: docUri, doc_type: analysis.fileType,
        ontologyTemplate: {
          conceptTypes: approvedSchema.entityTypes || [],
          predicates: approvedSchema.relationships?.map(r => r.type || r.predicate) || [],
          isAutoGenerated: false
        }
      };

      const extraction = await conceptExtractionService.extractConceptsFromChunks(
        chunks.map((c, i) => ({ ...c, uri: `${docUri}#chunk=${i}` })),
        context
      );

      if (extraction.concepts?.length > 0) {
        await neo4jService.createConcepts(extraction.concepts, {});
        result.nodesCreated += extraction.concepts.length;
      }
      if (extraction.mentions?.length > 0) {
        await neo4jService.createConceptMentions(extraction.mentions);
        result.relationshipsCreated += extraction.mentions.length;
      }
      if (extraction.relations?.length > 0) {
        await neo4jService.createConceptRelations(extraction.relations);
        result.relationshipsCreated += extraction.relations.length;
      }

      // Store embeddings
      try {
        await vectorStoreService.addChunks(
          chunks.map((c, i) => ({
            id: `${docId}_${i}`, chunk_id: `${docId}_${i}`,
            docId, documentId: docId, documentName: analysis.documentName,
            chunkIndex: i, text: c.text,
            tenant_id: tenantId, workspace_id: workspaceId,
            metadata: { docUri: analysis.industry }
          }))
        );
        result.chunksEmbedded = chunks.length;
      } catch (e) {
        console.warn('Embedding failed:', e.message);
      }
    }

    // Clean up analysis
    schemaAnalysisService.deleteAnalysis(analysisId);
    if (analysis.filePath) cleanupFile(analysis.filePath);

    res.json({ success: true, message: 'Document created from analysis', result });
  } catch (error) {
    console.error('Error creating from analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/audit/entity
 * Get change history for a specific entity
 */
router.get('/audit/entity', async (req, res) => {
  try {
    const { uri } = req.query;
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
    const workspaceId = req.query.workspaceId || req.headers['x-workspace-id'];

    if (!uri) {
      return res.status(400).json({ error: 'uri query parameter is required' });
    }
    if (!tenantId || !workspaceId) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    const changes = await auditService.getEntityChangeHistory(tenantId, workspaceId, uri);
    res.json({ changes });
  } catch (error) {
    logger.error('Failed to get entity change history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ontology/audit/log
 * Get workspace-wide audit log with filtering and pagination
 */
router.get('/audit/log', async (req, res) => {
  try {
    const { limit, offset, changeType, dateFrom, dateTo } = req.query;
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
    const workspaceId = req.query.workspaceId || req.headers['x-workspace-id'];

    if (!tenantId || !workspaceId) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    const result = await auditService.getWorkspaceAuditLog(tenantId, workspaceId, {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      changeType,
      dateFrom,
      dateTo
    });

    res.json(result);
  } catch (error) {
    logger.error('Failed to get workspace audit log:', error);
    res.status(500).json({ error: error.message });
  }
});

router.processCommitInBackground = processCommitInBackground;

module.exports = router;
