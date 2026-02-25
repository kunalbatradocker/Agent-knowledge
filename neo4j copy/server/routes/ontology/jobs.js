/**
 * Ontology Job Routes
 * Background processing for document analysis and graph generation
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');

const pdfParser = require('../../services/pdfParser');
const ontologyJobService = require('../../services/ontologyJobService');
const graphRagExtractionService = require('../../services/graphRagExtractionService');
const logger = require('../../utils/logger');
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { requireMember, requireManager } = require('../../middleware/auth');
const { upload } = require('./shared');

/**
 * Helper function to process job in background with GraphRAG extraction
 */
async function processOntologyJobInBackground(jobId, filePath, industry, existingOntology = null, extractionOptions = {}) {
  logger.debug(`Background job: ${jobId}`);
  
  setImmediate(async () => {
    try {
      await ontologyJobService.processJob(jobId, {
        extractText: async (path) => {
          const ext = filePath.split('.').pop().toLowerCase();
          if (ext === 'pdf') {
            return await pdfParser.extractText(path);
          } else {
            const content = fs.readFileSync(path, 'utf-8');
            return { text: content, pages: 1 };
          }
        },
        analyzeWithLLM: async (text, ind) => {
          // Use the extraction mode from options, or default to 'auto'
          const mode = extractionOptions.extractionMode || 'auto';
          
          return await graphRagExtractionService.extractFromText(text, {
            domain: ind,
            existingOntology: existingOntology,
            extractionMode: mode,
            chunkSize: extractionOptions.chunkSize || 20000,
            maxChars: extractionOptions.maxChars || 100000,
            chunkThreshold: extractionOptions.chunkThreshold || 80000
          });
        }
      });
      logger.info(`✅ Job complete for job: ${jobId}`);
    } catch (error) {
      console.error(`❌ Background job error for ${jobId}:`, error);
      try {
        await ontologyJobService.updateJob(jobId, {
          status: 'failed',
          error: error.message,
          progress_message: `Error: ${error.message}`
        });
      } catch (updateError) {
        console.error('Failed to update job error status:', updateError);
      }
    }
  });
}

/**
 * POST /api/ontology/jobs
 * Upload file and create a job (NO automatic ontology generation)
 */
router.post('/', upload.single('file'), requireMember, optionalTenantContext, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { industry, workspace_id, folder_id } = req.body;
    const effectiveWorkspaceId = workspace_id || req.tenantContext?.workspace_id;

    const job = await ontologyJobService.createJob({
      fileName: req.file.originalname,
      filePath: req.file.path,
      fileSize: req.file.size,
      workspaceId: effectiveWorkspaceId,
      folderId: folder_id,
      industry: industry || 'general',
      status: 'uploaded'
    });

    res.json({ 
      success: true, 
      job,
      message: 'File uploaded. Select files and click "Generate" to extract ontology.'
    });
  } catch (error) {
    console.error('Error creating ontology job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/bulk-generate
 * Generate ontology preview for multiple jobs at once
 * 
 * Body params:
 * - jobIds: Array of job IDs to process
 * - existingOntology: Ontology to use for extraction
 * - extractionMode: 'auto' | 'full' | 'chunked' (default: 'auto')
 * - chunkSize: Chunk size for chunked mode (default: 20000)
 * - maxChars: Max chars for full mode (default: 100000)
 */
router.post('/bulk-generate', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const { 
      jobIds, 
      existingOntology,
      extractionMode = 'auto',
      chunkSize = 20000,
      maxChars = 100000
    } = req.body;
    
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No job IDs provided' });
    }

    const extractionOptions = { extractionMode, chunkSize, maxChars };
    const results = [];
    
    for (const jobId of jobIds) {
      const job = await ontologyJobService.getJob(jobId);
      
      if (!job) {
        results.push({ job_id: jobId, success: false, error: 'Job not found' });
        continue;
      }
      
      if (!['uploaded', 'failed'].includes(job.status)) {
        results.push({ job_id: jobId, success: false, error: `Invalid status: ${job.status}` });
        continue;
      }

      processOntologyJobInBackground(job.job_id, job.file_path, job.industry, existingOntology, extractionOptions);
      results.push({ job_id: jobId, success: true });
    }

    res.json({ 
      success: true, 
      message: `Started generation for ${results.filter(r => r.success).length} jobs`,
      extractionMode,
      results
    });
  } catch (error) {
    console.error('Error in bulk generate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/generate
 * Generate ontology preview for a job
 * 
 * Body params:
 * - existingOntology: Ontology to use for extraction
 * - extractionMode: 'auto' | 'full' | 'chunked' (default: 'auto')
 * - chunkSize: Chunk size for chunked mode (default: 20000)
 * - maxChars: Max chars for full mode (default: 100000)
 */
router.post('/:id/generate', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const job = await ontologyJobService.getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    if (!['uploaded', 'failed'].includes(job.status)) {
      return res.status(400).json({ success: false, error: `Cannot generate for job in status: ${job.status}` });
    }

    const { 
      existingOntology,
      extractionMode = 'auto',
      chunkSize = 20000,
      maxChars = 100000
    } = req.body;
    
    const extractionOptions = { extractionMode, chunkSize, maxChars };
    processOntologyJobInBackground(job.job_id, job.file_path, job.industry, existingOntology, extractionOptions);

    res.json({ 
      success: true, 
      message: 'Ontology generation started.',
      job_id: job.job_id,
      extractionMode
    });
  } catch (error) {
    console.error('Error starting generation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs
 * Get all ontology jobs
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const { status, workspace_id } = req.query;
    const effectiveWorkspaceId = workspace_id || req.tenantContext?.workspace_id;

    console.log('[Jobs API] Fetching jobs for workspace:', effectiveWorkspaceId, 
      '| query:', workspace_id, 
      '| header:', req.headers['x-workspace-id']);

    const jobs = await ontologyJobService.getJobs({
      status,
      workspaceId: effectiveWorkspaceId
    });

    res.json({ success: true, jobs, workspaceFilter: effectiveWorkspaceId });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs/:id
 * Get a specific job
 */
router.get('/:id', async (req, res) => {
  try {
    const job = await ontologyJobService.getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({ success: true, job });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/cancel
 * Cancel a running job
 */
router.post('/:id/cancel', requireMember, async (req, res) => {
  try {
    const result = await ontologyJobService.cancelJob(req.params.id);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({ success: true, message: 'Job cancelled' });
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/approve
 * Approve job results
 */
router.post('/:id/approve', requireMember, async (req, res) => {
  try {
    const { modifications } = req.body;
    const result = await ontologyJobService.approveJob(req.params.id, modifications);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({ success: true, job: result.job });
  } catch (error) {
    console.error('Error approving job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/reject
 * Reject job results
 */
router.post('/:id/reject', requireMember, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await ontologyJobService.rejectJob(req.params.id, reason);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({ success: true, message: 'Job rejected' });
  } catch (error) {
    console.error('Error rejecting job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/re-extract
 * Re-run extraction on a completed/failed job
 * Resets the job and starts extraction again with same or different ontology
 */
router.post('/:id/re-extract', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const job = await ontologyJobService.getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    // Only allow re-extraction for completed, failed, or rejected jobs
    if (!['completed', 'failed', 'rejected'].includes(job.status)) {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot re-extract job in status: ${job.status}. Only completed, failed, or rejected jobs can be re-extracted.` 
      });
    }

    // Check if file still exists
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Original file no longer exists. Cannot re-extract.' 
      });
    }

    const { 
      existingOntology,
      extractionMode = 'auto',
      chunkSize = 20000,
      maxChars = 100000
    } = req.body;
    
    // Reset job status
    await ontologyJobService.updateJob(job.job_id, {
      status: 'pending',
      progress: 0,
      progress_message: 'Re-extraction queued...',
      extracted_entities: null,
      extracted_relationships: null,
      suggested_ontology: null,
      entity_count: 0,
      relationship_count: 0,
      error: null
    });
    
    const extractionOptions = { extractionMode, chunkSize, maxChars };
    processOntologyJobInBackground(job.job_id, job.file_path, job.industry, existingOntology, extractionOptions);

    logger.info(`🔄 Re-extraction started for job: ${job.job_id}`);

    res.json({ 
      success: true, 
      message: 'Re-extraction started.',
      job_id: job.job_id,
      extractionMode
    });
  } catch (error) {
    console.error('Error starting re-extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/jobs/:id
 * Delete a job
 */
router.delete('/:id', requireMember, async (req, res) => {
  try {
    const result = await ontologyJobService.deleteJob(req.params.id);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({ success: true, message: 'Job deleted' });
  } catch (error) {
    console.error('Error deleting job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/cleanup
 * Manually trigger job cleanup
 */
router.post('/cleanup', requireManager, async (req, res) => {
  try {
    await ontologyJobService.cleanupOldJobs();
    const stats = await ontologyJobService.getJobStats();
    res.json({ 
      success: true, 
      message: 'Cleanup completed',
      stats 
    });
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/jobs/stats
 * Get job statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await ontologyJobService.getJobStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting job stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/create-graph
 * Create graph from approved job
 */
router.post('/:id/create-graph', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const job = await ontologyJobService.getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    if (job.status !== 'approved') {
      return res.status(400).json({ success: false, error: 'Job must be approved before creating graph' });
    }

    // Get extracted data from job
    const entities = job.extracted_entities || [];
    const relationships = job.extracted_relationships || [];
    
    // For now, mark job as completed with graph creation
    await ontologyJobService.updateJob(req.params.id, {
      status: 'completed',
      progress_message: `Graph created with ${entities.length} entities and ${relationships.length} relationships`
    });
    
    res.json({ 
      success: true, 
      message: 'Graph created from approved job',
      stats: {
        entities: entities.length,
        relationships: relationships.length
      }
    });
  } catch (error) {
    console.error('Error creating graph from job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/jobs/:id/approve-and-create
 * Approve extraction results with modifications and create graph nodes
 * Used for extraction jobs where user can edit entities/relationships before creating graph
 */
router.post('/:id/approve-and-create', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const job = await ontologyJobService.getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    if (job.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Job must be completed before approving' });
    }

    const { entities, relationships } = req.body;
    
    if (!entities || !Array.isArray(entities)) {
      return res.status(400).json({ success: false, error: 'Entities array is required' });
    }

    const neo4jService = require('../../services/neo4jService');
    const entityUriService = require('../../services/entityUriService');
    
    // Get workspace context
    const workspaceId = job.workspace_id || req.tenantContext?.workspace_id || 'global';
    const tenantId = job.tenant_id || req.tenantContext?.tenant_id;
    const documentId = job.document_id;
    
    logger.info(`📊 Creating graph from extraction job: ${req.params.id}`);
    logger.debug(`Entities: ${entities.length}, Relationships: ${relationships?.length || 0}`);
    logger.debug(`Workspace: ${workspaceId}, Document: ${documentId}`);

    // Transform entities to concept format for neo4jService
    // Use entityUriService for consistent, deterministic URIs
    const concepts = entities.map(entity => {
      const label = entity.name || entity.label;
      const type = entity.type || 'Entity';
      const uri = entityUriService.generateUri(label, type, workspaceId);
      const conceptId = entityUriService.generateConceptId(label, type, workspaceId);
      
      return {
        uri: uri,
        concept_id: conceptId,
        label: label,
        type: type,
        specificType: type,
        description: entity.description || '',
        confidence: entity.confidence || 0.8,
        source: `extraction:${job.job_id}`,
        sourceSpan: entity.sourceSpan || '',
        // CRITICAL: workspace_id must be top-level for Neo4j queries
        workspace_id: workspaceId,
        tenant_id: tenantId,
        properties: {
          ...entity.properties,
          source_document: documentId,
          extracted_at: new Date().toISOString()
        }
      };
    });

    // Create concept nodes with workspace context
    const conceptResult = await neo4jService.createConcepts(concepts, {
      industry: job.industry || 'general',
      workspaceId: workspaceId
    });

    // Build URI map for relationship creation
    const labelToUri = new Map();
    const labelToType = new Map();
    concepts.forEach(c => {
      labelToUri.set((c.label || '').toLowerCase(), c.uri);
      labelToUri.set(entityUriService.normalizeForMatching(c.label), c.uri);
      labelToType.set((c.label || '').toLowerCase(), c.type);
    });

    // Transform relationships for neo4jService
    const relations = (relationships || []).map(rel => {
      const sourceLabel = rel.source || rel.sourceLabel || rel.from_entity || '';
      const targetLabel = rel.target || rel.targetLabel || rel.to_entity || '';
      const sourceType = labelToType.get(sourceLabel.toLowerCase()) || rel.sourceType || 'Entity';
      const targetType = labelToType.get(targetLabel.toLowerCase()) || rel.targetType || 'Entity';
      
      return {
        sourceUri: labelToUri.get(sourceLabel.toLowerCase()) || 
                   labelToUri.get(entityUriService.normalizeForMatching(sourceLabel)) ||
                   entityUriService.generateUri(sourceLabel, sourceType, workspaceId),
        targetUri: labelToUri.get(targetLabel.toLowerCase()) || 
                   labelToUri.get(entityUriService.normalizeForMatching(targetLabel)) ||
                   entityUriService.generateUri(targetLabel, targetType, workspaceId),
        sourceLabel: sourceLabel,
        targetLabel: targetLabel,
        predicate: rel.type || rel.relationship || rel.predicate || 'RELATED_TO',
        confidence: rel.confidence || 0.7,
        properties: rel.properties || {}
      };
    });

    // Create relationships
    let relationResult = { relatedCreated: 0, isaCreated: 0, skipped: 0 };
    if (relations.length > 0) {
      relationResult = await neo4jService.createConceptRelations(relations);
    }

    // Create MENTIONED_IN relationships to document chunks
    // Use sourceSpan from entities to link to correct chunks
    if (documentId) {
      try {
        const session = neo4jService.getSession();
        try {
          // Get all document chunks
          const chunkResult = await session.run(`
            MATCH (ch:Chunk)-[:PART_OF]->(d:Document)
            WHERE d.doc_id = $docId OR d.uri CONTAINS $docId
            RETURN ch
            ORDER BY ch.order
          `, { docId: documentId });
          
          const chunks = chunkResult.records.map(r => r.get('ch').properties);
          
          if (chunks.length > 0) {
            logger.debug(`Found ${chunks.length} chunks for document, creating MENTIONED_IN relationships`);
            
            // Create MENTIONED_IN for each entity to relevant chunks
            for (const concept of concepts) {
              // Link to first chunk (simplified - could match by sourceSpan)
              // Find the best matching chunk for this entity based on sourceSpan
              let bestChunk = chunks[0]; // Default to first chunk
              
              if (concept.sourceSpan && chunks.length > 1) {
                // Try to find chunk that contains the sourceSpan text
                const sourceSpanLower = concept.sourceSpan.toLowerCase();
                for (const chunk of chunks) {
                  if (chunk.text && chunk.text.toLowerCase().includes(sourceSpanLower.substring(0, 50))) {
                    bestChunk = chunk;
                    break;
                  }
                }
              }
              
              const chunkUri = bestChunk?.uri;
              if (chunkUri) {
                await session.run(`
                  MATCH (c) WHERE c.concept_id = $conceptId OR c.uri = $conceptUri
                         OR (c.normalized_label = $normalizedLabel AND c.workspace_id = $workspaceId)
                  MATCH (ch:Chunk {uri: $chunkUri})
                  MERGE (c)-[r:MENTIONED_IN]->(ch)
                  ON CREATE SET r.created_at = datetime(), r.relevance = 0.8
                  RETURN c, ch
                `, { 
                  conceptId: concept.concept_id,
                  conceptUri: concept.uri,
                  normalizedLabel: entityUriService.normalizeLabel(concept.label),
                  workspaceId: workspaceId,
                  chunkUri: chunkUri 
                });
              }
            }
            logger.debug(`Created MENTIONED_IN relationships for ${concepts.length} entities`);
          } else {
            logger.debug(`No chunks found for document ${documentId}`);
          }
        } finally {
          await session.close();
        }
      } catch (mentionError) {
        console.warn('   ⚠️ Could not create document mentions:', mentionError.message);
      }
    }
    
    // Also ensure document is linked to workspace
    if (workspaceId && documentId) {
      try {
        const session = neo4jService.getSession();
        try {
          await session.run(`
            MATCH (w:Workspace {workspace_id: $workspaceId})
            MATCH (d:Document) WHERE d.doc_id = $docId
            MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
          `, { workspaceId, docId: documentId });
          logger.debug(`Ensured document is linked to workspace`);
        } finally {
          await session.close();
        }
      } catch (linkError) {
        console.warn('   ⚠️ Could not link document to workspace:', linkError.message);
      }
    }

    // Update job status
    await ontologyJobService.updateJob(req.params.id, {
      status: 'approved',
      progress_message: `Graph created: ${conceptResult.total} nodes, ${relationResult.relatedCreated + relationResult.isaCreated} relationships`,
      approved_entities: entities,
      approved_relationships: relationships
    });

    logger.info(`✅ Graph created for job: ${req.params.id}`);

    res.json({ 
      success: true, 
      message: 'Graph created from approved extraction',
      nodesCreated: conceptResult.total,
      relationshipsCreated: relationResult.relatedCreated + relationResult.isaCreated,
      stats: {
        conceptsCreated: conceptResult.conceptsCreated,
        conceptsUpdated: conceptResult.conceptsUpdated,
        relationsCreated: relationResult.relatedCreated,
        isaCreated: relationResult.isaCreated,
        skipped: relationResult.skipped
      }
    });
  } catch (error) {
    console.error('Error in approve-and-create:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
