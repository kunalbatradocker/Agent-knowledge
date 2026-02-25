/**
 * Versioning Routes
 * API endpoints for extraction versioning, rollback, and audit
 */

const express = require('express');
const router = express.Router();
const extractionVersioningService = require('../services/extractionVersioningService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireMember, requireManager } = require('../middleware/auth');

// Apply tenant context to all routes
router.use(optionalTenantContext);

// ============================================================
// DOCUMENT EXTRACTION VERSIONS
// ============================================================

/**
 * GET /api/versioning/documents/:docId/versions
 * Get all extraction versions for a document
 */
router.get('/documents/:docId/versions', async (req, res) => {
  try {
    const { docId } = req.params;
    
    const versions = await extractionVersioningService.getExtractionVersions(docId);
    const meta = await extractionVersioningService.getDocumentExtractionMeta(docId);
    
    res.json({
      success: true,
      doc_id: docId,
      current_version: meta?.current_version_id || null,
      total_versions: versions.length,
      versions
    });
  } catch (error) {
    console.error('Error getting extraction versions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/documents/:docId/versions/:versionId
 * Get a specific extraction snapshot
 */
router.get('/documents/:docId/versions/:versionId', async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    
    const snapshot = await extractionVersioningService.getExtractionSnapshot(docId, versionId);
    
    if (!snapshot) {
      return res.status(404).json({ success: false, error: 'Snapshot not found' });
    }
    
    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    console.error('Error getting extraction snapshot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/documents/:docId/current
 * Get current extraction snapshot for a document
 */
router.get('/documents/:docId/current', async (req, res) => {
  try {
    const { docId } = req.params;
    
    const snapshot = await extractionVersioningService.getCurrentExtractionSnapshot(docId);
    const meta = await extractionVersioningService.getDocumentExtractionMeta(docId);
    
    res.json({
      success: true,
      doc_id: docId,
      meta,
      snapshot
    });
  } catch (error) {
    console.error('Error getting current extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/versioning/documents/:docId/rollback
 * Rollback document to a previous extraction version
 */
router.post('/documents/:docId/rollback', requireManager, async (req, res) => {
  try {
    const { docId } = req.params;
    const { version_id, reason } = req.body;
    
    if (!version_id) {
      return res.status(400).json({ success: false, error: 'version_id is required' });
    }
    
    const result = await extractionVersioningService.rollbackToVersion(docId, version_id, {
      user_id: req.headers['x-user-id'] || 'anonymous',
      reason: reason || ''
    });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error rolling back extraction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/documents/:docId/compare
 * Compare two extraction versions
 */
router.get('/documents/:docId/compare', async (req, res) => {
  try {
    const { docId } = req.params;
    const { v1, v2 } = req.query;
    
    if (!v1 || !v2) {
      return res.status(400).json({ success: false, error: 'v1 and v2 query params required' });
    }
    
    const diff = await extractionVersioningService.compareVersions(docId, v1, v2);
    
    res.json({
      success: true,
      ...diff
    });
  } catch (error) {
    console.error('Error comparing versions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// CONCEPT REFERENCES
// ============================================================

/**
 * GET /api/versioning/concepts/:conceptId/references
 * Get all documents that reference a concept
 */
router.get('/concepts/:conceptId/references', async (req, res) => {
  try {
    const { conceptId } = req.params;
    
    const references = await extractionVersioningService.getConceptReferences(conceptId);
    const meta = await extractionVersioningService.getConceptMeta(conceptId);
    const isShared = await extractionVersioningService.isConceptShared(conceptId);
    
    res.json({
      success: true,
      concept_id: conceptId,
      meta,
      is_shared: isShared,
      reference_count: references.length,
      referenced_by: references
    });
  } catch (error) {
    console.error('Error getting concept references:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/concepts/orphaned
 * Find concepts with no document references
 */
router.get('/concepts/orphaned', async (_req, res) => {
  try {
    const orphaned = await extractionVersioningService.findOrphanedConcepts();
    
    res.json({
      success: true,
      count: orphaned.length,
      orphaned
    });
  } catch (error) {
    console.error('Error finding orphaned concepts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/versioning/concepts/cleanup
 * Clean up orphaned concepts
 */
router.post('/concepts/cleanup', requireManager, async (_req, res) => {
  try {
    const result = await extractionVersioningService.cleanupOrphanedConcepts();
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error cleaning up orphaned concepts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// SCHEMA VERSIONING
// ============================================================

/**
 * GET /api/versioning/schema/current
 * Get current schema version
 */
router.get('/schema/current', async (_req, res) => {
  try {
    const version = await extractionVersioningService.getCurrentSchemaVersion();
    const data = await extractionVersioningService.getSchemaVersion(version);
    
    res.json({
      success: true,
      version,
      schema: data
    });
  } catch (error) {
    console.error('Error getting current schema:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/schema/history
 * Get schema version history
 */
router.get('/schema/history', async (_req, res) => {
  try {
    const history = await extractionVersioningService.getSchemaVersionHistory();
    
    res.json({
      success: true,
      count: history.length,
      history
    });
  } catch (error) {
    console.error('Error getting schema history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/schema/:version
 * Get a specific schema version
 */
router.get('/schema/:version', async (req, res) => {
  try {
    const { version } = req.params;
    const data = await extractionVersioningService.getSchemaVersion(version);
    
    if (!data) {
      return res.status(404).json({ success: false, error: 'Schema version not found' });
    }
    
    res.json({
      success: true,
      schema: data
    });
  } catch (error) {
    console.error('Error getting schema version:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/versioning/schema
 * Create a new schema version
 */
router.post('/schema', requireManager, async (req, res) => {
  try {
    const { nodeTypes, relationshipTypes, changes, breaking } = req.body;
    
    const result = await extractionVersioningService.saveSchemaVersion(
      { nodeTypes, relationshipTypes },
      {
        user_id: req.headers['x-user-id'] || 'anonymous',
        changes,
        breaking,
        newTypes: nodeTypes?.length > 0,
        newRelations: relationshipTypes?.length > 0
      }
    );
    
    res.json({
      success: true,
      schema: result
    });
  } catch (error) {
    console.error('Error creating schema version:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/schema/outdated-documents
 * Get documents that need re-extraction due to schema changes
 */
router.get('/schema/outdated-documents', async (_req, res) => {
  try {
    const documents = await extractionVersioningService.getDocumentsNeedingReExtraction();
    
    res.json({
      success: true,
      count: documents.length,
      documents
    });
  } catch (error) {
    console.error('Error getting outdated documents:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * GET /api/versioning/audit
 * Get audit log entries
 */
router.get('/audit', async (req, res) => {
  try {
    const { limit = 100, offset = 0, doc_id, action } = req.query;
    
    const entries = await extractionVersioningService.getAuditLog({
      limit: parseInt(limit),
      offset: parseInt(offset),
      doc_id,
      action
    });
    
    res.json({
      success: true,
      count: entries.length,
      entries
    });
  } catch (error) {
    console.error('Error getting audit log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/versioning/audit/document/:docId
 * Get audit log for a specific document
 */
router.get('/audit/document/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const { limit = 50 } = req.query;
    
    const entries = await extractionVersioningService.getDocumentAuditLog(docId, parseInt(limit));
    
    res.json({
      success: true,
      doc_id: docId,
      count: entries.length,
      entries
    });
  } catch (error) {
    console.error('Error getting document audit log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// BULK OPERATIONS
// ============================================================

/**
 * POST /api/versioning/bulk/rollback
 * Rollback multiple documents to their previous versions
 */
router.post('/bulk/rollback', requireManager, async (req, res) => {
  try {
    const { doc_ids, reason } = req.body;
    
    if (!doc_ids || !Array.isArray(doc_ids) || doc_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'doc_ids array is required' });
    }
    
    const results = await extractionVersioningService.bulkRollback(doc_ids, {
      user_id: req.headers['x-user-id'] || 'anonymous',
      reason
    });
    
    res.json({
      success: true,
      total: doc_ids.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    console.error('Error in bulk rollback:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// STATISTICS
// ============================================================

/**
 * GET /api/versioning/stats
 * Get versioning statistics
 */
router.get('/stats', async (_req, res) => {
  try {
    const stats = await extractionVersioningService.getVersioningStats();
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting versioning stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
