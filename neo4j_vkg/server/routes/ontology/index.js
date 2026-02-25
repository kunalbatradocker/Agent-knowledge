/**
 * Ontology Routes - Main Router
 * Combines all ontology-related route modules
 * 
 * Fully modular structure - no legacy dependencies
 * RBAC guards applied per sub-route based on operation type.
 */

const express = require('express');
const router = express.Router();
const { requireMember, requireManager, requireWorkspaceAccess } = require('../../middleware/auth');

// Import route modules
const analysisRoutes = require('./analysis');
const entitiesRoutes = require('./entities');
const relationshipsRoutes = require('./relationships');
const chunksRoutes = require('./chunks');
const templatesRoutes = require('./templates');
const jobsRoutes = require('./jobs');
const cleanupRoutes = require('./cleanup');
const documentsRoutes = require('./documents');
const foldersRoutes = require('./folders');
const statsRoutes = require('./stats');
const uploadsRoutes = require('./uploads');
const evaluationsRoutes = require('./evaluations');
const extractionReviewRoutes = require('./extractionReview');
const sheetDataRoutes = require('./sheetData');

// Workspace access check on all ontology routes
router.use(requireWorkspaceAccess);

// Mount route modules with prefixes and RBAC guards
router.use('/analyze', requireMember, analysisRoutes);           // Schema analysis (two-phase upload) — member+
router.use('/analysis', analysisRoutes);                         // Analysis CRUD (GET = viewer, PUT/DELETE guarded below)
router.use('/entities', entitiesRoutes);                         // Entity/concept editing (GET = viewer, write = member+)
router.use('/relationships', relationshipsRoutes);               // Relationship editing (GET = viewer, write = member+)
router.use('/chunks', chunksRoutes);                             // Chunk management (GET = viewer, write = member+)
router.use('/templates', templatesRoutes);                       // Ontology templates (GET = viewer, write = manager+)
router.use('/jobs', jobsRoutes);                                 // Background job processing (GET = viewer, write = member+)
router.use('/cleanup', requireManager, cleanupRoutes);           // Data cleanup — manager+
router.use('/documents', documentsRoutes);                       // Document management (GET = viewer, write = member+)
router.use('/folders', foldersRoutes);                           // Folder management (GET = viewer, write = manager+)
router.use('/extraction-review', extractionReviewRoutes);        // Extraction review flow (GET = viewer, write = member+)
router.use('/sheet-data', sheetDataRoutes);                      // Spreadsheet CRUD over GraphDB (GET = viewer, write = member+)

// Template-related aliases at root level (MUST be before /:id catch-all)
router.get('/chunking-methods', templatesRoutes);
router.get('/schema-modes', templatesRoutes);
router.get('/csv-processing-modes', templatesRoutes);
router.get('/industries', templatesRoutes);
router.post('/custom-ontology', requireManager, templatesRoutes);     // manager+
router.get('/custom-ontologies', templatesRoutes);
router.get('/custom-ontology/:id', templatesRoutes);
router.put('/custom-ontology/:id', requireManager, templatesRoutes);  // manager+
router.delete('/custom-ontology/:id', requireManager, templatesRoutes); // manager+
router.post('/generate', requireManager, templatesRoutes);            // manager+

// Stats routes at root level
router.get('/stats', statsRoutes);
router.get('/storage-status', statsRoutes);
router.get('/all', statsRoutes);
router.get('/schema', statsRoutes);
router.post('/schema/initialize', requireManager, statsRoutes);       // manager+
router.get('/debug/keys', statsRoutes);
router.get('/:id', statsRoutes);                  // Get specific ontology by ID (MUST be last - catch-all)

// Entity type routes at root level
router.get('/entity-types', entitiesRoutes);
router.get('/predicates', relationshipsRoutes);

// Cleanup routes at root level
router.post('/cleanup-orphans', requireManager, cleanupRoutes);       // manager+

// Document routes at root level
router.post('/upload-document', requireMember, documentsRoutes);      // member+
router.post('/create-with-predefined-schema', requireMember, documentsRoutes); // member+
router.post('/create-from-analysis/:id', requireMember, documentsRoutes);      // member+
router.post('/analyze-csv', requireMember, documentsRoutes);          // member+

// Audit routes at root level
router.get('/audit/entity', documentsRoutes);
router.get('/audit/log', documentsRoutes);

// Upload routes at root level
router.post('/upload', requireMember, uploadsRoutes);                 // member+
router.post('/upload-async', requireMember, uploadsRoutes);           // member+
router.post('/fm-upload', requireMember, uploadsRoutes);              // member+
router.get('/extraction-methods', uploadsRoutes);
router.post('/compare-extraction', requireMember, uploadsRoutes);     // member+
router.post('/extract-with-ocr', requireMember, uploadsRoutes);       // member+

// Evaluation routes at root level
router.post('/evaluate', requireManager, evaluationsRoutes);          // manager+
router.get('/evaluations', evaluationsRoutes);
router.get('/evaluations/:filename', evaluationsRoutes);

module.exports = router;
