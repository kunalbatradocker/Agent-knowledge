/**
 * OWL Ontology Routes
 * Replaces YAML-based ontology management with OWL/RDF
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const owlOntologyService = require('../services/owlOntologyService');
const ontologyVersioningService = require('../services/ontologyVersioningService');
const logger = require('../utils/logger');
const { requireManager } = require('../middleware/auth');

// Allowed file types for uploads
const ALLOWED_MIME_TYPES = ['text/turtle', 'application/rdf+xml', 'text/plain'];
const ALLOWED_EXTENSIONS = ['.ttl', '.rdf', '.owl', '.txt'];

// IRI validation regex
const IRI_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/;

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
    if (ALLOWED_MIME_TYPES.includes(file.mimetype) || ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .ttl, .rdf, .owl files allowed.'));
    }
  }
});

// Utility functions
const sanitizeIRI = (iri) => {
  if (!iri || typeof iri !== 'string') return null;
  const trimmed = iri.trim();
  return IRI_REGEX.test(trimmed) ? trimmed : null;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

const safeDecodeURI = (str) => {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
};

const safeBufferToString = (buffer) => {
  try {
    return buffer.toString('utf-8');
  } catch (e) {
    throw new Error('Invalid file encoding');
  }
};

/**
 * POST /api/owl/import
 * Import OWL ontology from Turtle file or JSON body
 */
router.post('/import', requireManager, upload.single('file'), async (req, res) => {
  try {
    const { tenantId, workspaceId, applyReasoning, replaceExisting, turtleContent, ontologyId, scope = 'workspace' } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    // Get turtle content from file or body
    let turtle;
    if (req.file) {
      turtle = req.file.buffer.toString('utf-8');
    } else if (turtleContent) {
      turtle = turtleContent;
    } else {
      return res.status(400).json({
        error: 'No content provided',
        message: 'Please upload a Turtle (.ttl) file or provide turtleContent in body'
      });
    }

    const result = await owlOntologyService.importOntology(
      tenantId,
      workspaceId,
      turtle,
      {
        applyReasoning: applyReasoning === 'true' || applyReasoning === true,
        replaceExisting: replaceExisting === 'true' || replaceExisting === true,
        ontologyId,
        scope
      }
    );

    // Auto-create version snapshot after successful import
    const finalOntologyId = result?.ontologyId || ontologyId;
    if (finalOntologyId) {
      try {
        await ontologyVersioningService.createVersion(finalOntologyId, {
          description: `Imported ontology: ${finalOntologyId}`,
          user_id: req.headers['x-user-id'] || 'anonymous',
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
        logger.info(`[POST /owl/import] Auto-version created for ${finalOntologyId}`);
      } catch (versionError) {
        logger.warn(`[POST /owl/import] Auto-version failed for ${finalOntologyId}:`, versionError.message);
      }
    }

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/import] Error:', error);
    res.status(500).json({
      error: 'Failed to import ontology',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/import-text
 * Import OWL ontology from Turtle text
 */
router.post('/import-text', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId, turtle, applyReasoning, replaceExisting, ontologyId, scope = 'workspace' } = req.body;

    if (!tenantId || !workspaceId || !turtle) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId, workspaceId, and turtle are required'
      });
    }

    const result = await owlOntologyService.importOntology(
      tenantId,
      workspaceId,
      turtle,
      {
        applyReasoning,
        replaceExisting,
        ontologyId,
        scope
      }
    );

    // Auto-create version snapshot after successful import
    const finalOntologyId = result?.ontologyId || ontologyId;
    if (finalOntologyId) {
      try {
        await ontologyVersioningService.createVersion(finalOntologyId, {
          description: `Imported ontology (text): ${finalOntologyId}`,
          user_id: req.headers['x-user-id'] || 'anonymous',
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
      } catch (versionError) {
        logger.warn(`[POST /owl/import-text] Auto-version failed for ${finalOntologyId}:`, versionError.message);
      }
    }

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/import-text] Error:', error);
    res.status(500).json({
      error: 'Failed to import ontology',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/structure/:ontologyId
 * Get ontology structure (classes and properties only, no instances)
 */
router.get('/structure/:ontologyId', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tenantId = 'default', workspaceId = 'default', scope = 'all' } = req.query;

    // Validate ontologyId
    if (!ontologyId || ontologyId === 'undefined' || ontologyId === 'null') {
      return res.status(400).json({
        error: 'Invalid ontology ID',
        message: 'Ontology ID is required and cannot be undefined or null'
      });
    }

    const structure = await owlOntologyService.getOntologyStructure(
      tenantId,
      workspaceId,
      ontologyId,
      scope
    );

    res.json(structure);

  } catch (error) {
    logger.error(`[GET /owl/structure] Error for ontologyId "${req.params.ontologyId}":`, error);
    res.status(500).json({
      error: 'Failed to get ontology structure',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/versions/:ontologyId
 * Get version history for an ontology
 */
router.get('/versions/:ontologyId', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tenantId = 'default', workspaceId = 'default' } = req.query;

    // Validate ontologyId
    if (!ontologyId || ontologyId === 'undefined' || ontologyId === 'null') {
      return res.status(400).json({
        error: 'Invalid ontology ID',
        message: 'Ontology ID is required and cannot be undefined or null'
      });
    }

    const versions = await owlOntologyService.getVersionHistory(
      tenantId,
      workspaceId,
      ontologyId
    );

    res.json({ versions });

  } catch (error) {
    logger.error(`[GET /owl/versions] Error for ontologyId "${req.params.ontologyId}":`, error);
    res.status(500).json({
      error: 'Failed to get version history',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/save-version
 * Save new version of workspace ontology
 */
router.post('/save-version', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId, ontologyId, turtleContent, version, description } = req.body;

    if (!tenantId || !workspaceId || !ontologyId || !turtleContent || !version) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId, workspaceId, ontologyId, turtleContent, and version are required'
      });
    }

    const result = await owlOntologyService.saveNewVersion(
      tenantId,
      workspaceId,
      ontologyId,
      turtleContent,
      { version, description }
    );

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/save-version] Error:', error);
    res.status(500).json({
      error: 'Failed to save new version',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/versions/:ontologyId
 * Add properties/classes to existing ontology as new version
 */
router.post('/versions/:ontologyId', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tenantId = 'default', workspaceId = 'default', additions, comment } = req.body;

    if (!additions || (!additions.classes?.length && !additions.properties?.length)) {
      return res.status(400).json({
        error: 'No additions provided',
        message: 'additions.classes or additions.properties required'
      });
    }

    // Get current ontology structure
    const structure = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
    if (!structure) {
      return res.status(404).json({ error: 'Ontology not found' });
    }

    // Merge additions
    const newClasses = [...(structure.classes || [])];
    const newProps = [...(structure.properties || [])];
    
    for (const cls of (additions.classes || [])) {
      if (!newClasses.find(c => c.iri === cls.iri)) {
        newClasses.push({ iri: cls.iri, label: cls.label, comment: cls.comment || '' });
      }
    }
    for (const prop of (additions.properties || [])) {
      if (!newProps.find(p => p.iri === prop.iri)) {
        newProps.push({ iri: prop.iri, label: prop.label, comment: prop.comment || '', type: prop.type || 'DatatypeProperty' });
      }
    }

    // Generate new Turtle content
    const baseIri = structure.ontologyIRI || `http://purplefabric.ai/${ontologyId}`;
    
    // Sanitize IRI - remove invalid characters
    const sanitizeIri = (iri) => iri.replace(/[^a-zA-Z0-9_\-.:/#%~]/g, '');
    // Escape Turtle string literals
    const escapeLiteral = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    
    let turtle = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix : <${sanitizeIri(baseIri)}#> .

<${sanitizeIri(baseIri)}> rdf:type owl:Ontology ;
    rdfs:label "${escapeLiteral(structure.label || ontologyId)}" .

`;
    for (const cls of newClasses) {
      turtle += `<${sanitizeIri(cls.iri)}> rdf:type owl:Class ;\n    rdfs:label "${escapeLiteral(cls.label)}" .\n\n`;
    }
    for (const prop of newProps) {
      const isObjProp = prop.type === 'ObjectProperty' || prop.type === 'objectProperty';
      const propType = isObjProp ? 'owl:ObjectProperty' : 'owl:DatatypeProperty';
      let propTurtle = `<${sanitizeIri(prop.iri)}> rdf:type ${propType} ;\n    rdfs:label "${escapeLiteral(prop.label)}"`;
      
      // domain/range may be local names from getOntologyStructure or full IRIs from additions
      const resolveIri = (val) => {
        if (!val) return null;
        if (val.startsWith('http')) return sanitizeIri(val);
        if (val.startsWith('xsd:')) return `http://www.w3.org/2001/XMLSchema#${val.split(':')[1]}`;
        return `${sanitizeIri(baseIri)}#${val}`;
      };
      
      const domainIri = resolveIri(prop.domain);
      if (domainIri) propTurtle += ` ;\n    rdfs:domain <${domainIri}>`;
      
      const rangeIri = resolveIri(prop.range);
      if (rangeIri) propTurtle += ` ;\n    rdfs:range <${rangeIri}>`;
      
      turtle += propTurtle + ` .\n\n`;
    }

    // Get next version number
    const versions = await owlOntologyService.getVersionHistory?.(tenantId, workspaceId, ontologyId) || [];
    const nextVersion = versions.length > 0 ? `v${versions.length + 1}` : 'v2';

    const result = await owlOntologyService.saveNewVersion(
      tenantId, workspaceId, ontologyId, turtle,
      { version: nextVersion, description: comment || `Added ${additions.classes?.length || 0} classes, ${additions.properties?.length || 0} properties` }
    );

    res.json({ success: true, version: nextVersion, ...result });

  } catch (error) {
    logger.error('[POST /owl/versions/:ontologyId] Error:', error);
    res.status(500).json({ error: 'Failed to add to ontology', message: error.message });
  }
});

/**
 * POST /api/owl/copy-global
 * Copy global ontology to workspace with version 1
 */
router.post('/copy-global', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId, globalOntologyId, workspaceName, customOntologyId } = req.body;

    if (!tenantId || !workspaceId || !globalOntologyId || !workspaceName) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId, workspaceId, globalOntologyId, and workspaceName are required'
      });
    }

    const result = await owlOntologyService.copyGlobalOntology(
      tenantId,
      workspaceId,
      globalOntologyId,
      workspaceName,
      customOntologyId
    );

    // Auto-create version snapshot so it shows in version history UI
    const newOntologyId = result?.workspaceOntologyId;
    if (newOntologyId) {
      try {
        await ontologyVersioningService.createVersion(newOntologyId, {
          description: `Initial copy from global ontology: ${globalOntologyId}`,
          user_id: req.headers['x-user-id'] || 'anonymous',
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
        logger.info(`[POST /owl/copy-global] Auto-version created for ${newOntologyId}`);
      } catch (versionError) {
        logger.warn(`[POST /owl/copy-global] Auto-version failed for ${newOntologyId}:`, versionError.message);
      }
    }

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/copy-global] Error:', error);
    res.status(500).json({
      error: 'Failed to copy global ontology',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/export
 * Export ontology to Turtle format
 * Query params: exportType = 'schema' (default), 'data', or 'all'
 *               ontologyId = specific ontology to export (optional)
 *               structureOnly = 'true' to exclude instance data (optional)
 */
router.get('/export', async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default', ontologyIRI, ontologyId, exportType = 'schema', structureOnly, scope = 'workspace' } = req.query;

    // Validate ontologyId if provided
    if (ontologyId && (ontologyId === 'undefined' || ontologyId === 'null')) {
      return res.status(400).json({
        error: 'Invalid ontology ID',
        message: 'Ontology ID cannot be undefined or null'
      });
    }

    // Validate exportType
    if (!['schema', 'data', 'all'].includes(exportType)) {
      return res.status(400).json({
        error: 'Invalid exportType',
        message: 'exportType must be "schema", "data", or "all"'
      });
    }

    const turtle = await owlOntologyService.exportOntology(
      tenantId,
      workspaceId,
      ontologyIRI,
      exportType,
      ontologyId,
      { structureOnly: structureOnly === 'true', scope }
    );

    // Set headers for file download
    const filename = ontologyId 
      ? `ontology-${ontologyId}-${exportType}.ttl`
      : `ontology-${tenantId}-${workspaceId}-${exportType}.ttl`;
    res.setHeader('Content-Type', 'text/turtle');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(turtle);

  } catch (error) {
    logger.error(`[GET /owl/export] Error for ontologyId "${req.query.ontologyId}":`, error);
    res.status(500).json({
      error: 'Failed to export ontology',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/list
 * List all ontologies in workspace
 * Query params: scope = 'global' (default), 'tenant', 'workspace', or 'all'
 */
router.get('/list', async (req, res) => {
  try {
    const tenantId = (req.query.tenantId && req.query.tenantId !== 'undefined') ? req.query.tenantId : 'default';
    const workspaceId = (req.query.workspaceId && req.query.workspaceId !== 'undefined') ? req.query.workspaceId : 'default';
    const scope = req.query.scope || 'global';

    // Validate scope
    if (!['global', 'tenant', 'workspace', 'all'].includes(scope)) {
      return res.status(400).json({
        error: 'Invalid scope',
        message: 'scope must be "global", "tenant", "workspace", or "all"'
      });
    }

    const ontologies = await owlOntologyService.listOntologies(tenantId, workspaceId, scope);

    res.json({
      ontologies,
      total: ontologies.length,
      scope
    });

  } catch (error) {
    logger.error('[GET /owl/list] Error:', error);
    res.status(500).json({
      error: 'Failed to list ontologies',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/:iri
 * Get ontology details
 */
router.get('/:iri', async (req, res) => {
  try {
    const { iri } = req.params;
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedIRI = decodeURIComponent(iri);
    const ontology = await owlOntologyService.getOntology(tenantId, workspaceId, decodedIRI);

    res.json(ontology);

  } catch (error) {
    logger.error('[GET /owl/:iri] Error:', error);
    res.status(500).json({
      error: 'Failed to get ontology',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/create
 * Create new ontology
 * Requires proper OWL structure: iri, label, classes with IRIs, properties with IRIs
 */
router.post('/create', requireManager, async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default', ontology } = req.body;

    if (!ontology) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'ontology object is required with iri, label, classes, and properties'
      });
    }

    if (!ontology.iri) {
      return res.status(400).json({
        error: 'Missing ontology IRI',
        message: 'ontology.iri is required (e.g., http://purplefabric.ai/my-ontology)'
      });
    }

    // Validate ontology has at least one class
    if (!ontology.classes?.length && !ontology.objectProperties?.length && !ontology.dataProperties?.length) {
      return res.status(400).json({
        error: 'Empty ontology',
        message: 'Ontology must have at least one class or property defined'
      });
    }

    // Validate classes have IRIs
    for (const cls of (ontology.classes || [])) {
      if (!cls.iri) {
        return res.status(400).json({
          error: 'Missing class IRI',
          message: `Class "${cls.label || 'unknown'}" requires an iri field`
        });
      }
    }

    // Validate properties have IRIs
    for (const prop of (ontology.objectProperties || [])) {
      if (!prop.iri) {
        return res.status(400).json({
          error: 'Missing property IRI',
          message: `Object property "${prop.label || 'unknown'}" requires an iri field`
        });
      }
    }

    for (const prop of (ontology.dataProperties || [])) {
      if (!prop.iri) {
        return res.status(400).json({
          error: 'Missing property IRI',
          message: `Data property "${prop.label || 'unknown'}" requires an iri field`
        });
      }
    }

    const result = await owlOntologyService.createOntology(tenantId, workspaceId, ontology);

    // Auto-create initial version snapshot after successful creation
    const newOntologyId = result?.ontologyId || ontology.label?.toLowerCase().replace(/\s+/g, '-');
    if (newOntologyId) {
      try {
        await ontologyVersioningService.createVersion(newOntologyId, {
          description: `Initial version: ${ontology.label || 'New Ontology'}`,
          user_id: req.headers['x-user-id'] || 'anonymous',
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
        logger.info(`[POST /owl/create] Auto-version created for ${newOntologyId}`);
      } catch (versionError) {
        logger.warn(`[POST /owl/create] Auto-version failed for ${newOntologyId}:`, versionError.message);
      }
    }

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/create] Error:', error);
    res.status(500).json({
      error: 'Failed to create ontology',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/:ontologyId/impact
 * Check downstream impact before modifying an ontology.
 * Returns: committed documents, active mappings, and data graph triple count.
 */
router.get('/:ontologyId/impact', async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tenantId = 'default', workspaceId = 'default' } = req.query;
    const redisService = require('../services/redisService');

    // 1. Count committed documents using this ontology
    const docIds = await redisService.sMembers(`workspace:${workspaceId}:docs`);
    const committedDocs = [];
    for (const docId of docIds) {
      const docJson = await redisService.get(`doc:${docId}`);
      if (docJson) {
        const doc = JSON.parse(docJson);
        if (doc.ontology_id === ontologyId) {
          committedDocs.push({ doc_id: doc.doc_id, title: doc.title, triple_count: doc.triple_count || 0, ontology_version_id: doc.ontology_version_id || null });
        }
      }
    }

    // 2. Check for active column mappings
    const mapKey = `colmap:${workspaceId}:${ontologyId}`;
    const mapJson = await redisService.get(mapKey);
    let activeMapping = null;
    if (mapJson) {
      const parsed = JSON.parse(mapJson);
      activeMapping = {
        version: parsed.version || 1,
        savedAt: parsed.savedAt,
        columnCount: Object.keys(parsed.columnMappings || {}).length,
        ontologyVersionId: parsed.ontologyVersionId || null,
      };
    }

    // 3. Count triples in the data graph (instance data committed against this ontology)
    let dataTripleCount = 0;
    try {
      const graphDBStore = require('../services/graphDBStore');
      const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
      const countQuery = `SELECT (COUNT(*) as ?cnt) WHERE { GRAPH <${dataGraphIRI}> { ?s ?p ?o } }`;
      const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, countQuery, 'all');
      dataTripleCount = parseInt(result?.results?.bindings?.[0]?.cnt?.value || 0);
    } catch (e) {
      logger.warn('Could not count data triples:', e.message);
    }

    const hasDownstreamData = committedDocs.length > 0 || dataTripleCount > 0;

    res.json({
      success: true,
      ontologyId,
      impact: {
        committedDocuments: committedDocs,
        documentCount: committedDocs.length,
        totalTriples: dataTripleCount,
        activeMapping,
        hasDownstreamData,
        warning: hasDownstreamData
          ? `This ontology has ${committedDocs.length} committed document(s) with ${dataTripleCount} triples. Modifying classes or properties may orphan existing data.`
          : null
      }
    });
  } catch (error) {
    logger.error('[GET /owl/:ontologyId/impact] Error:', error);
    res.status(500).json({ error: 'Failed to check impact', message: error.message });
  }
});

/**
 * PUT /api/owl/:ontologyId
 * Update existing ontology structure
 */
router.put('/:ontologyId', requireManager, async (req, res) => {
  try {
    const { ontologyId } = req.params;
    const { tenantId = 'default', workspaceId = 'default', structure, changes } = req.body;

    if (!ontologyId || ontologyId === 'undefined') {
      return res.status(400).json({
        error: 'Invalid ontology ID',
        message: 'Ontology ID is required'
      });
    }

    const result = await owlOntologyService.updateOntology(
      tenantId,
      workspaceId,
      ontologyId,
      structure
    );

    // Auto-create version snapshot after successful update
    try {
      await ontologyVersioningService.createVersion(ontologyId, {
        description: `Ontology updated via editor`,
        user_id: req.headers['x-user-id'] || 'anonymous',
        tenant_id: tenantId,
        workspace_id: workspaceId
      });
      logger.info(`[PUT /owl/:ontologyId] Auto-version created for ${ontologyId}`);
    } catch (versionError) {
      // Don't fail the update if versioning fails
      logger.warn(`[PUT /owl/:ontologyId] Auto-version failed for ${ontologyId}:`, versionError.message);
    }

    res.json(result);

  } catch (error) {
    logger.error('[PUT /owl/:ontologyId] Error:', error);
    res.status(500).json({
      error: 'Failed to update ontology',
      message: error.message
    });
  }
});

/**
 * DELETE /api/owl/:iri
 * Delete ontology
 */
router.delete('/:iri', requireManager, async (req, res) => {
  try {
    const { iri } = req.params;
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedIRI = decodeURIComponent(iri);
    const result = await owlOntologyService.deleteOntology(tenantId, workspaceId, decodedIRI);

    res.json(result);

  } catch (error) {
    logger.error('[DELETE /owl/:iri] Error:', error);
    res.status(500).json({
      error: 'Failed to delete ontology',
      message: error.message
    });
  }
});

/**
 * DELETE /api/owl/data/clear
 * Clear instance data only (keep schema)
 */
router.delete('/data/clear', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const result = await owlOntologyService.clearData(tenantId, workspaceId);

    res.json({
      ...result,
      message: 'Instance data cleared successfully'
    });

  } catch (error) {
    logger.error('[DELETE /owl/data/clear] Error:', error);
    res.status(500).json({
      error: 'Failed to clear data',
      message: error.message
    });
  }
});

/**
 * DELETE /api/owl/all/clear
 * Clear everything (schema + data)
 */
router.delete('/all/clear', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const result = await owlOntologyService.clearAll(tenantId, workspaceId);

    res.json({
      ...result,
      message: 'All data cleared successfully'
    });

  } catch (error) {
    logger.error('[DELETE /owl/all/clear] Error:', error);
    res.status(500).json({
      error: 'Failed to clear all data',
      message: error.message
    });
  }
});

/**
 * GET /api/owl/:iri/extraction-schema
 * Get extraction schema from ontology
 */
router.get('/:iri/extraction-schema', async (req, res) => {
  try {
    const { iri } = req.params;
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const decodedIRI = decodeURIComponent(iri);
    const schema = await owlOntologyService.getExtractionSchema(tenantId, workspaceId, decodedIRI);

    res.json(schema);

  } catch (error) {
    logger.error('[GET /owl/:iri/extraction-schema] Error:', error);
    res.status(500).json({
      error: 'Failed to get extraction schema',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/initialize
 * Initialize ontologies from file system if not in GraphDB
 */
router.post('/initialize', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId, ontologyDir } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const dir = ontologyDir || './server/data/owl-ontologies';
    
    const result = await owlOntologyService.initializeFromFiles(tenantId, workspaceId, dir);

    res.json(result);

  } catch (error) {
    logger.error('[POST /owl/initialize] Error:', error);
    res.status(500).json({
      error: 'Failed to initialize ontologies',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/reload
 * Reload ontologies from file system (force refresh)
 */
router.post('/reload', requireManager, async (req, res) => {
  try {
    const { tenantId, workspaceId } = req.body;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'tenantId and workspaceId are required'
      });
    }

    const ontologyInitializationService = require('../services/ontologyInitializationService');
    const result = await ontologyInitializationService.reloadFromFiles(tenantId, workspaceId);

    res.json({
      ...result,
      message: 'Ontologies reloaded from file system'
    });

  } catch (error) {
    logger.error('[POST /owl/reload] Error:', error);
    res.status(500).json({
      error: 'Failed to reload ontologies',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/sync-to-neo4j
 * Manually trigger sync from GraphDB to Neo4j
 */
router.post('/sync-to-neo4j', requireManager, async (req, res) => {
  try {
    const { tenantId = 'default', workspaceId = 'default' } = req.body;

    const graphDBNeo4jSyncService = require('../services/graphDBNeo4jSyncService');
    const result = await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId);

    res.json({
      success: true,
      message: 'GraphDB to Neo4j sync completed successfully',
      ...result
    });

  } catch (error) {
    logger.error('[POST /owl/sync-to-neo4j] Error:', error);
    res.status(500).json({
      error: 'Failed to sync to Neo4j',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/multi-hop-reasoning
 * Perform multi-hop reasoning across GraphDB and Neo4j
 */
router.post('/multi-hop-reasoning', async (req, res) => {
  try {
    const { query, tenantId = 'default', workspaceId = 'default', maxHops = 3, reasoning = 'hybrid' } = req.body;

    if (!query) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'query is required'
      });
    }

    const multiHopReasoningService = require('../services/multiHopReasoningService');
    const results = await multiHopReasoningService.multiHopReasoning(query, {
      tenantId,
      workspaceId,
      maxHops,
      reasoning
    });

    res.json({
      success: true,
      query,
      reasoning,
      maxHops,
      ...results
    });

  } catch (error) {
    logger.error('[POST /owl/multi-hop-reasoning] Error:', error);
    res.status(500).json({
      error: 'Multi-hop reasoning failed',
      message: error.message
    });
  }
});

/**
 * POST /api/owl/copy-to-workspace
 * Copy a global ontology to workspace scope
 */
router.post('/copy-to-workspace', requireManager, async (req, res) => {
  try {
    const { globalOntologyId, tenantId = 'default', workspaceId = 'default' } = req.body;

    if (!globalOntologyId) {
      return res.status(400).json({ success: false, error: 'globalOntologyId required' });
    }

    const result = await owlOntologyService.copyGlobalToWorkspace(tenantId, workspaceId, globalOntologyId);
    
    res.json({
      success: true,
      message: 'Ontology copied to workspace',
      ontologyId: result.ontologyId
    });

  } catch (error) {
    logger.error('[POST /owl/copy-to-workspace] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
