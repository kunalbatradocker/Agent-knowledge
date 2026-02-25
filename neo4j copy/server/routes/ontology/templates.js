/**
 * Ontology Templates Routes
 * Industry templates and custom ontology management
 */

const express = require('express');
const router = express.Router();

const ontologyTemplateService = require('../../services/ontologyTemplateService');
const owlOntologyService = require('../../services/owlOntologyService');
const chunkingService = require('../../services/chunkingService');
const { optionalTenantContext } = require('../../middleware/tenantContext');

/**
 * GET /api/ontology/templates
 * Get available ontology templates (industries + custom saved)
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;
    
    const allOntologies = await owlOntologyService.listOntologies(tenantId, workspaceId);
    
    // Separate global and custom ontologies
    const systemOntologies = allOntologies.filter(o => o.scope === 'global');
    const customOntologies = allOntologies.filter(o => o.scope !== 'global');
    
    res.json({
      success: true,
      templates: systemOntologies.map(o => ({
        id: o.id,
        name: o.name,
        description: o.description,
        entityTypes: o.entityTypes?.length || 0,
        relationships: o.relationships?.length || 0,
        isCustom: false
      })),
      customOntologies: customOntologies.map(o => ({
        id: o.id,
        name: o.name,
        description: o.description,
        entityTypes: o.entityTypes?.length || 0,
        relationships: o.relationships?.length || 0,
        isCustom: true
      }))
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/templates/:id
 * Get a specific ontology template by industry ID
 */
router.get('/:id', async (req, res) => {
  try {
    const template = await ontologyTemplateService.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    res.json({ success: true, template });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/industries
 * Get available industry ontologies (alias for templates)
 */
router.get('/industries', async (_req, res) => {
  try {
    const ontologies = await owlOntologyService.listOntologies();
    res.json({
      success: true,
      industries: ontologies.map(o => ({
        id: o.id,
        name: o.name,
        description: o.description,
        entityTypes: o.entityTypes?.length || 0,
        relationships: o.relationships?.length || 0
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/chunking-methods
 * Get available chunking methods
 */
router.get('/chunking-methods', (_req, res) => {
  try {
    const methods = chunkingService.getChunkingMethods();
    res.json({ success: true, methods });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/schema-modes
 * Get available schema modes for concept storage
 */
router.get('/schema-modes', (_req, res) => {
  try {
    const modes = [
      {
        id: 'strict',
        name: 'Strict Schema',
        description: 'Only extract concepts matching the ontology template'
      },
      {
        id: 'flexible',
        name: 'Flexible Schema',
        description: 'Extract concepts matching template + suggest new types'
      },
      {
        id: 'discovery',
        name: 'Discovery Mode',
        description: 'Extract all concepts, no schema constraints'
      }
    ];
    res.json({ success: true, modes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/csv-processing-modes
 * Get available CSV processing modes
 */
router.get('/csv-processing-modes', (_req, res) => {
  try {
    const modes = [
      {
        id: 'text',
        name: 'Text Extraction',
        description: 'Treat CSV as text, chunk and extract concepts'
      },
      {
        id: 'graph',
        name: 'Direct Graph',
        description: 'Map columns directly to node properties'
      },
      {
        id: 'hybrid',
        name: 'Hybrid',
        description: 'Create nodes from columns + extract relationships'
      }
    ];
    res.json({ success: true, modes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/custom-ontology
 * Save a custom ontology from LLM analysis
 */
router.post('/custom-ontology', optionalTenantContext, async (req, res) => {
  try {
    const { name, description, entityTypes, relationships, sourceDocument, workspace_id } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Ontology name is required' });
    }
    
    const workspaceId = workspace_id || req.query.workspace_id || req.tenantContext?.workspace_id || 'default';
    const tenantId = req.body.tenant_id || req.tenantContext?.tenant_id || 'default';
    
    // Build ontology IRI from name
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const baseIri = `http://purplefabric.ai/${slug || 'custom'}`;
    const ns = baseIri + '#';

    // Check for duplicate in workspace
    const existing = await owlOntologyService.listOntologies(tenantId, workspaceId, 'workspace');
    if (existing.find(o => o.label?.toLowerCase() === name.trim().toLowerCase())) {
      return res.status(400).json({ success: false, error: `An ontology named "${name}" already exists in this workspace.` });
    }

    // Convert entityTypes/relationships to OWL classes and properties
    const classes = (entityTypes || []).filter(e => e.include !== false).map(e => ({
      iri: `${ns}${(e.userLabel || e.label || '').replace(/\s+/g, '')}`,
      label: e.userLabel || e.label,
      comment: e.description || ''
    }));

    const objectProperties = (relationships || []).filter(r => r.include !== false).map(r => ({
      iri: `${ns}${(r.userPredicate || r.predicate || r.type || '').replace(/\s+/g, '_')}`,
      label: r.userPredicate || r.predicate || r.type,
      comment: r.description || '',
      domain: r.from ? [`${ns}${r.from.replace(/\s+/g, '')}`] : [],
      range: r.to ? [`${ns}${r.to.replace(/\s+/g, '')}`] : []
    }));

    // Collect data properties from entityType properties
    const dataProperties = [];
    for (const e of (entityTypes || []).filter(et => et.include !== false)) {
      const classIri = `${ns}${(e.userLabel || e.label || '').replace(/\s+/g, '')}`;
      for (const p of (e.suggestedProperties || e.properties || [])) {
        const prop = typeof p === 'string' ? { name: p, data_type: 'string' } : p;
        dataProperties.push({
          iri: `${ns}${(prop.name || prop.label || '').replace(/\s+/g, '_')}`,
          label: prop.name || prop.label,
          comment: prop.description || '',
          domain: [classIri],
          range: prop.data_type || 'xsd:string'
        });
      }
    }

    const result = await owlOntologyService.createOntology(tenantId, workspaceId, {
      iri: baseIri,
      label: name.trim(),
      comment: description || (sourceDocument ? `Generated from: ${sourceDocument}` : ''),
      classes,
      objectProperties,
      dataProperties
    });
    
    res.json({ success: true, ontology: { id: result.ontologyId, name: name.trim(), ...result.stats } });
  } catch (error) {
    console.error('Error saving custom ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/custom-ontologies
 * Get all saved custom ontologies
 */
router.get('/custom-ontologies', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id || 'default';
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id || 'default';
    
    const ontologies = await owlOntologyService.listOntologies(tenantId, workspaceId, 'workspace');
    res.json({ success: true, ontologies });
  } catch (error) {
    console.error('Error fetching custom ontologies:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/custom-ontology/:id
 * Get a specific custom ontology
 */
router.get('/custom-ontology/:id', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id || 'default';
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id || 'default';
    
    // Get ontology structure instead of metadata
    const structure = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, req.params.id);
    if (!structure) {
      return res.status(404).json({ success: false, error: 'Ontology not found' });
    }
    
    // Convert structure to expected format
    const ontology = {
      id: req.params.id,
      name: structure.label || req.params.id,
      description: structure.comment || '',
      classes: structure.classes || [],
      properties: structure.properties || [],
      scope: 'workspace'
    };
    
    res.json({ success: true, ontology });
  } catch (error) {
    console.error('Error fetching custom ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/custom-ontology/:id
 * Update a custom ontology
 */
router.put('/custom-ontology/:id', optionalTenantContext, async (req, res) => {
  try {
    const { name, description, entityTypes, relationships } = req.body;
    const workspaceId = req.query.workspace_id || req.body.workspace_id || req.tenantContext?.workspace_id || 'default';
    const tenantId = req.query.tenant_id || req.body.tenant_id || req.tenantContext?.tenant_id || 'default';
    
    // Get existing structure
    const existing = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, req.params.id, 'workspace');
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Ontology not found' });
    }
    
    const ns = (existing.ontologyIRI || `http://purplefabric.ai/${req.params.id}`) + '#';

    const classes = (entityTypes || existing.classes || []).map(e => ({
      iri: e.iri || `${ns}${(e.userLabel || e.label || '').replace(/\s+/g, '')}`,
      label: e.userLabel || e.label,
      comment: e.description || e.comment || ''
    }));

    const objectProperties = (relationships || []).map(r => ({
      iri: r.iri || `${ns}${(r.predicate || r.type || '').replace(/\s+/g, '_')}`,
      label: r.predicate || r.type,
      comment: r.description || '',
      domain: r.from ? [`${ns}${r.from.replace(/\s+/g, '')}`] : [],
      range: r.to ? [`${ns}${r.to.replace(/\s+/g, '')}`] : []
    }));

    // Extract data properties from entityType properties (new + existing)
    const dataProperties = [];
    if (entityTypes) {
      for (const e of entityTypes.filter(et => et.include !== false)) {
        const classIri = e.iri || `${ns}${(e.userLabel || e.label || '').replace(/\s+/g, '')}`;
        for (const p of (e.suggestedProperties || e.properties || [])) {
          const prop = typeof p === 'string' ? { name: p, data_type: 'string' } : p;
          if (prop.name || prop.label) {
            dataProperties.push({
              iri: `${ns}${(prop.name || prop.label || '').replace(/\s+/g, '_')}`,
              label: prop.name || prop.label,
              comment: prop.description || '',
              domain: [classIri],
              data_type: prop.data_type || 'string'
            });
          }
        }
      }
    }
    // If no entityTypes provided, preserve existing data properties
    const finalDataProperties = dataProperties.length > 0
      ? dataProperties
      : (existing.properties?.filter(p => p.type === 'datatypeProperty') || []);

    // Use updateOntology for existing ontologies (handles graph replacement properly)
    const result = await owlOntologyService.updateOntology(tenantId, workspaceId, req.params.id, {
      label: name || existing.label || req.params.id,
      comment: description !== undefined ? description : (existing.comment || ''),
      classes: classes.map(c => ({ uri: c.iri, label: c.label, comment: c.comment })),
      properties: [
        ...objectProperties.map(p => ({
          uri: p.iri,
          label: p.label,
          comment: p.comment,
          propertyType: 'ObjectProperty',
          domain: Array.isArray(p.domain) ? p.domain[0] : p.domain,
          range: Array.isArray(p.range) ? p.range[0] : p.range
        })),
        ...finalDataProperties.map(p => ({
          uri: p.iri,
          label: p.label,
          comment: p.comment || '',
          propertyType: 'DatatypeProperty',
          domain: Array.isArray(p.domain) ? p.domain[0] : p.domain,
          range: p.range || p.data_type || ''
        }))
      ]
    });
    
    res.json({ success: true, ontology: result });
  } catch (error) {
    console.error('Error updating custom ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/custom-ontology/:id
 * Delete a custom ontology
 */
router.delete('/custom-ontology/:id', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;
    
    const tid = tenantId || 'default';
    const wid = workspaceId || 'default';
    const allOnts = await owlOntologyService.listOntologies(tid, wid, 'workspace');
    const target = allOnts.find(o => o.ontologyId === req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Ontology not found' });
    }
    const result = await owlOntologyService.deleteOntology(tid, wid, target.iri);
    res.json({ success: true, message: 'Ontology deleted' });
  } catch (error) {
    console.error('Error deleting custom ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ONTOLOGY GENERATION ROUTES
// ============================================================

const ontologyGeneratorService = require('../../services/ontologyGeneratorService');

/**
 * POST /api/ontology/generate
 * Generate an ontology from a text prompt or document
 * 
 * Body:
 * - mode: 'prompt' | 'document'
 * - prompt: Text description of the domain (for prompt mode)
 * - documentText: Document content (for document mode)
 * - name: Optional suggested name
 * - industry: Optional industry hint
 */
router.post('/generate', optionalTenantContext, async (req, res) => {
  try {
    const { mode, prompt, documentText, name, industry } = req.body;
    
    if (!mode || (mode !== 'prompt' && mode !== 'document')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Mode must be "prompt" or "document"' 
      });
    }
    
    if (mode === 'prompt' && !prompt) {
      return res.status(400).json({ 
        success: false, 
        error: 'Prompt is required for prompt mode' 
      });
    }
    
    if (mode === 'document' && !documentText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Document text is required for document mode' 
      });
    }
    
    let ontology;
    
    if (mode === 'prompt') {
      ontology = await ontologyGeneratorService.generateFromPrompt(prompt, { name, industry });
    } else {
      ontology = await ontologyGeneratorService.generateFromDocument(documentText, { name, industry });
    }
    
    res.json({ 
      success: true, 
      ontology,
      message: `Ontology generated with ${ontology.entityTypes?.length || 0} entity types and ${ontology.relationships?.length || 0} relationships`
    });
    
  } catch (error) {
    console.error('Error generating ontology:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/templates/version
 * Create initial version for a newly saved ontology
 */
router.post('/version', async (req, res) => {
  try {
    const { ontologyId, description, user_id } = req.body;
    
    if (!ontologyId) {
      return res.status(400).json({ success: false, error: 'ontologyId is required' });
    }
    
    const ontologyVersioningService = require('../../services/ontologyVersioningService');
    const version = await ontologyVersioningService.createVersion(ontologyId, {
      description: description || 'Initial version',
      user_id: user_id || 'system',
      branch: 'main'
    });
    
    res.json({ success: true, version });
  } catch (error) {
    console.error('Error creating version:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
