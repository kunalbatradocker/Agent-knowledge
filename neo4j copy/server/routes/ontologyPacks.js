/**
 * Ontology Pack API Routes
 * 
 * GraphDB-based ontology storage with tenant/workspace hierarchy.
 * 
 * Hierarchy:
 * - Global templates (system-wide, read-only)
 * - Tenant ontologies (shared across tenant's workspaces)
 * - Workspace ontologies (forked from tenant/global, can be modified)
 */

const express = require('express');
const router = express.Router();
const owlOntologyService = require('../services/owlOntologyService');
const ontologyVersioningService = require('../services/ontologyVersioningService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager } = require('../middleware/auth');

// ============================================================
// ONTOLOGY LISTING
// ============================================================

/**
 * GET /api/ontology-packs
 * List all ontologies visible to the workspace
 * Returns hierarchical structure: { global, tenant, workspace }
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;
    const flat = req.query.flat === 'true';

    const ontologies = await owlOntologyService.listOntologies(tenantId, workspaceId);

    if (flat) {
      // Flat array format
      res.json({
        packs: ontologies.map(o => ({
          pack_id: o.id || o.ontologyId,
          name: o.name || o.label,
          description: o.description || o.comment,
          industry: o.industry,
          scope: o.scope,
          canEdit: o.canEdit,
          entityCount: o.entityTypes?.length || 0,
          relationshipCount: o.relationships?.length || 0
        }))
      });
    } else {
      // Hierarchical format - group by scope
      const grouped = {
        global: ontologies.filter(o => o.scope === 'global'),
        tenant: ontologies.filter(o => o.scope === 'tenant'),
        workspace: ontologies.filter(o => o.scope === 'workspace')
      };

      res.json({
        global: await Promise.all(grouped.global.map(o => formatPackSummary(o))),
        tenant: await Promise.all(grouped.tenant.map(o => formatPackSummary(o))),
        workspace: await Promise.all(grouped.workspace.map(o => formatPackSummary(o)))
      });
    }

  } catch (error) {
    console.error('[GET /ontology-packs] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function formatPackSummary(o) {
  // Get actual counts from GraphDB
  let entityCount = 0;
  let relationshipCount = 0;
  
  try {
    const url = `${process.env.GRAPHDB_URL || 'http://localhost:7200'}/repositories/${process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1'}`;
    
    // Count classes
    const classesQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      SELECT (COUNT(DISTINCT ?class) as ?count)
      FROM <${o.graphIRI}>
      WHERE { ?class a owl:Class . }
    `;
    
    // Count object properties
    const propsQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      SELECT (COUNT(DISTINCT ?prop) as ?count)
      FROM <${o.graphIRI}>
      WHERE { ?prop a owl:ObjectProperty . }
    `;
    
    const [classResponse, propResponse] = await Promise.all([
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: classesQuery
      }),
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: propsQuery
      })
    ]);
    
    if (classResponse.ok) {
      const classResult = await classResponse.json();
      if (classResult?.results?.bindings?.[0]?.count?.value) {
        entityCount = parseInt(classResult.results.bindings[0].count.value);
      }
    }
    
    if (propResponse.ok) {
      const propResult = await propResponse.json();
      if (propResult?.results?.bindings?.[0]?.count?.value) {
        relationshipCount = parseInt(propResult.results.bindings[0].count.value);
      }
    }
  } catch (error) {
    console.warn('Could not fetch ontology counts:', error.message);
  }

  return {
    pack_id: o.id || o.ontologyId,
    id: o.id || o.ontologyId,
    name: o.name || o.label,
    description: o.description || o.comment,
    industry: o.industry,
    scope: o.scope,
    version: o.version || o.versionInfo,
    entityCount,
    relationshipCount,
    tags: o.tags,
    canEdit: o.canEdit || false,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  };
}

/**
 * GET /api/ontology-packs/:packId
 * Get specific ontology details
 */
router.get('/:packId', optionalTenantContext, async (req, res) => {
  try {
    const { packId } = req.params;
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.query.tenant_id || req.tenantContext?.tenant_id;

    const allOntologies = await owlOntologyService.listOntologies(tenantId, workspaceId);
    const ontology = allOntologies.find(ont => ont.ontologyId === packId);
    
    if (!ontology) {
      return res.status(404).json({ error: 'Ontology not found' });
    }

    const formatted = await formatPackSummary(ontology);
    res.json(formatted);

  } catch (error) {
    console.error('[GET /ontology-packs/:packId] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ONTOLOGY CRUD
// ============================================================

/**
 * POST /api/ontology-packs
 * Create a new ontology (workspace or tenant scope)
 */
router.post('/', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const {
      name,
      description,
      industry,
      classes,
      entityTypes,
      relationships,
      tags,
      scope = 'workspace'
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.body.tenant_id || req.tenantContext?.tenant_id;

    // For now, return a placeholder response
    // In a full implementation, this would create the ontology in GraphDB
    res.json({
      success: true,
      message: 'Ontology creation not yet implemented',
      ontology: {
        id: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
        name,
        description,
        scope,
        entityCount: entityTypes?.length || 0,
        relationshipCount: relationships?.length || 0
      }
    });

  } catch (error) {
    console.error('[POST /ontology-packs] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ontology-packs/:packId/fork-to-workspace
 * Fork an ontology to workspace (from global or tenant)
 */
router.post('/:packId/fork-to-workspace', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const { packId } = req.params;
    const { name } = req.body;
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    const tenantId = req.body.tenant_id || req.tenantContext?.tenant_id;

    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id is required' });
    }

    // Get the source ontology by finding it in the list first
    const allOntologies = await owlOntologyService.listOntologies(tenantId, workspaceId);
    const sourceOntology = allOntologies.find(ont => ont.ontologyId === packId);
    
    if (!sourceOntology) {
      return res.status(404).json({ error: 'Ontology not found' });
    }

    // Create workspace-scoped ontology by copying from source
    const forkedOntologyId = `${packId}-workspace-${Date.now()}`;
    const workspaceGraphIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${forkedOntologyId}`;
    
    try {
      // Copy ontology data from source graph to workspace graph
      const graphDBStore = require('../services/graphDBStore');
      const url = `${process.env.GRAPHDB_URL || 'http://localhost:7200'}/repositories/${process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1'}`;
      
      // Copy all triples from source graph to workspace graph
      const copyQuery = `
        INSERT {
          GRAPH <${workspaceGraphIRI}> {
            ?s ?p ?o .
          }
        }
        WHERE {
          GRAPH <${sourceOntology.graphIRI}> {
            ?s ?p ?o .
          }
        }
      `;
      
      const copyResponse = await fetch(url + '/statements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-update'
        },
        body: copyQuery
      });
      
      if (!copyResponse.ok) {
        throw new Error(`Failed to copy ontology: ${copyResponse.status} ${copyResponse.statusText}`);
      }
      
      // Update the ontology metadata in the new graph
      const updateQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        
        DELETE {
          GRAPH <${workspaceGraphIRI}> {
            ?ont rdfs:label ?oldLabel .
          }
        }
        INSERT {
          GRAPH <${workspaceGraphIRI}> {
            ?ont rdfs:label "${name || `${sourceOntology.label || sourceOntology.name} (Workspace Copy)`}" .
          }
        }
        WHERE {
          GRAPH <${workspaceGraphIRI}> {
            ?ont a owl:Ontology .
            OPTIONAL { ?ont rdfs:label ?oldLabel }
          }
        }
      `;
      
      const updateResponse = await fetch(url + '/statements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-update'
        },
        body: updateQuery
      });
      
      if (!updateResponse.ok) {
        console.warn('Failed to update ontology label, but copy succeeded');
      }
      
      // Return the forked ontology info
      const forkedOntology = {
        ...sourceOntology,
        name: name || `${sourceOntology.label || sourceOntology.name} (Workspace Copy)`,
        label: name || `${sourceOntology.label || sourceOntology.name} (Workspace Copy)`,
        scope: 'workspace',
        id: forkedOntologyId,
        ontologyId: forkedOntologyId,
        graphIRI: workspaceGraphIRI
      };

      // Auto-create version snapshot for the forked ontology
      try {
        await ontologyVersioningService.createVersion(forkedOntologyId, {
          description: `Forked from ${sourceOntology.label || packId}`,
          user_id: req.headers['x-user-id'] || 'anonymous',
          tenant_id: tenantId,
          workspace_id: workspaceId
        });
      } catch (versionError) {
        console.warn('Auto-version failed for forked ontology:', versionError.message);
      }

      res.json({
        success: true,
        message: 'Ontology forked to workspace',
        ontology: forkedOntology
      });
      
    } catch (copyError) {
      console.error('Failed to copy ontology to workspace:', copyError);
      res.status(500).json({ 
        error: 'Failed to fork ontology', 
        details: copyError.message 
      });
    }

  } catch (error) {
    console.error('[POST /ontology-packs/:packId/fork-to-workspace] Error:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
