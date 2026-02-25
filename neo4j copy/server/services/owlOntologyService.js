/**
 * OWL Ontology Service
 * Handles OWL/RDF ontology operations via GraphDB
 * Primary semantic storage for the Enterprise Knowledge Graph Platform
 */

const graphDBStore = require('./graphDBStore');
const graphDBNeo4jSyncService = require('./graphDBNeo4jSyncService');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

class OWLOntologyService {
  /**
   * Initialize the service
   */
  async initialize() {
    logger.info('🔧 OWL Ontology Service initialized');
    return { success: true };
  }

  /**
   * Import OWL ontology from Turtle string
   * @param {Object} options - Import options
   * @param {string} options.scope - 'global', 'tenant', or 'workspace' (default: 'global')
   */
  async importOntology(tenantId, workspaceId, turtleContent, options = {}) {
    // Strict validation - no empty content
    if (!turtleContent || turtleContent.trim().length === 0) {
      throw new Error('Turtle content is required and cannot be empty');
    }
    
    const { 
      ontologyIRI, 
      applyReasoning = false,
      replaceExisting = false,
      ontologyId = null,
      scope = 'global'
    } = options;

    // Validate scope-specific requirements
    if (scope === 'tenant' && !tenantId) {
      throw new Error('tenantId is required for tenant-scoped ontology');
    }
    if (scope === 'workspace' && (!tenantId || !workspaceId)) {
      throw new Error('tenantId and workspaceId are required for workspace-scoped ontology');
    }

    // Extract ontology ID - required, no auto-generation
    let finalOntologyId = ontologyId;
    if (!finalOntologyId && ontologyIRI) {
      finalOntologyId = graphDBStore.extractOntologyId(ontologyIRI);
    }
    if (!finalOntologyId) {
      // Try to extract from turtle content
      const ontologyMatch = turtleContent.match(/<([^>]+)>\s+a\s+owl:Ontology/);
      if (ontologyMatch) {
        finalOntologyId = graphDBStore.extractOntologyId(ontologyMatch[1]);
      }
    }
    if (!finalOntologyId) {
      throw new Error('ontologyId is required - could not extract from ontologyIRI or turtle content. Provide ontologyId explicitly.');
    }

    logger.info(`📥 Importing OWL ontology (${finalOntologyId}) at ${scope} scope`);

    // Determine graph type based on scope
    let graphType = 'schema';
    if (scope === 'global') {
      graphType = 'global';
    } else if (scope === 'tenant') {
      graphType = 'tenant';
    }

    // Clear existing if requested (handled atomically in graphDBStore.importTurtle)
    if (replaceExisting && finalOntologyId) {
      if (scope === 'global') {
        const graphIRI = graphDBStore.getGlobalOntologyGraphIRI(finalOntologyId);
        await this.clearGraph(graphIRI);
      } else if (scope === 'tenant') {
        const graphIRI = graphDBStore.getTenantOntologyGraphIRI(tenantId, finalOntologyId);
        await this.clearGraph(graphIRI);
      } else if (scope === 'workspace') {
        const graphIRI = graphDBStore.getSchemaGraphIRI(tenantId, workspaceId, finalOntologyId);
        await this.clearGraph(graphIRI);
      }
    }

    // Import Turtle to GraphDB (atomic with rollback)
    const result = await graphDBStore.importTurtle(
      tenantId, 
      workspaceId, 
      turtleContent, 
      ontologyIRI, 
      graphType, 
      finalOntologyId
    );

    // Validate import produced triples
    if (result.triplesAdded === 0) {
      throw new Error('Ontology import produced 0 triples - turtle content may be invalid or empty');
    }

    // Apply reasoning if requested
    let reasoning = null;
    if (applyReasoning) {
      reasoning = await graphDBStore.triggerReasoning(tenantId, workspaceId);
    }

    // Get ontology metadata
    const ontologies = await graphDBStore.listOntologies(tenantId, workspaceId, scope);
    
    // Get stats for the specific ontology just imported (not all ontologies)
    const structure = await this.getOntologyStructure(tenantId, workspaceId, finalOntologyId, scope);
    const classes = structure?.classes || [];
    const objectProps = (structure?.properties || []).filter(p => p.type === 'objectProperty');
    const dataProps = (structure?.properties || []).filter(p => p.type === 'datatypeProperty');

    // Validate ontology has at least one class
    if (classes.length === 0) {
      logger.warn(`⚠️ Ontology ${finalOntologyId} has no OWL classes defined`);
    }

    logger.info(`✅ Imported ${scope} ontology: ${classes.length} classes, ${objectProps.length} object properties, ${dataProps.length} data properties`);

    // Sync to Neo4j - failure here is logged but doesn't fail the import
    try {
      await graphDBNeo4jSyncService.syncOntology(tenantId, workspaceId, finalOntologyId);
    } catch (syncError) {
      logger.warn('⚠️ Neo4j sync failed (non-fatal):', syncError.message);
    }

    return {
      success: true,
      ontologies,
      ontologyId: finalOntologyId,
      scope,
      stats: {
        classes: classes.length,
        objectProperties: objectProps.length,
        dataProperties: dataProps.length,
        triples: result.triplesAdded,
        inferredTriples: 0
      },
      reasoning
    };
  }

  /**
   * Clear a specific graph
   */
  async clearGraph(graphIRI) {
    try {
      const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
      const updateQuery = `CLEAR GRAPH <${graphIRI}>`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-update'
        },
        body: updateQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn(`⚠️  Could not clear graph ${graphIRI}: ${response.status} - ${errorText}`);
      } else {
        logger.info(`🗑️  Cleared graph: ${graphIRI}`);
      }
    } catch (error) {
      logger.warn(`⚠️  Could not clear graph: ${error.message}`);
    }
  }

  /**
   * Import OWL ontology from file - DEPRECATED: Use GraphDB-only approach
   * @deprecated Use /api/owl/import endpoint instead
   */
  async importOntologyFromFile(tenantId, workspaceId, filePath, options = {}) {
    throw new Error('File-based import is deprecated. Use /api/owl/import endpoint with turtle content instead.');
  }

  /**
   * Export ontology to Turtle format
   * @param {string} exportType - 'schema', 'data', or 'all'
   * @param {string} ontologyId - Optional ontology ID for schema export
   */
  async exportOntology(tenantId, workspaceId, ontologyIRI = null, exportType = 'schema', ontologyId = null, options = {}) {
    logger.info(`📤 Exporting ${exportType}${ontologyId ? ` (${ontologyId})` : ''} for ${tenantId}:${workspaceId}`);
    
    try {
      // Extract ontology ID from IRI if provided
      if (!ontologyId && ontologyIRI) {
        ontologyId = graphDBStore.extractOntologyId(ontologyIRI);
      }
      
      const turtle = await graphDBStore.exportTurtle(tenantId, workspaceId, exportType, ontologyId, options.scope);
      return turtle;
    } catch (error) {
      logger.error(`Export failed: ${error.message}`);
      
      // If GraphDB is empty, return a helpful message
      if (error.message.includes('404') || error.message.includes('not found')) {
        logger.warn(`No ontologies found in GraphDB for ${tenantId}:${workspaceId}`);
        return `# No ontologies found in GraphDB\n# Run initialization: POST /api/owl/initialize\n`;
      }
      
      throw error;
    }
  }

  /**
   * Export only schema (ontology definitions)
   */
  async exportSchemaOnly(tenantId, workspaceId) {
    return this.exportOntology(tenantId, workspaceId, null, 'schema');
  }

  /**
   * Export only instance data
   */
  async exportDataOnly(tenantId, workspaceId) {
    return this.exportOntology(tenantId, workspaceId, null, 'data');
  }

  /**
   * Export both schema and data
   */
  async exportAll(tenantId, workspaceId) {
    return this.exportOntology(tenantId, workspaceId, null, 'all');
  }

  /**
   * Copy global ontology to workspace with version 1
   */
  async copyGlobalOntology(tenantId, workspaceId, globalOntologyId, workspaceName, customOntologyId = null) {
    try {
      // Get global ontology
      const globalOntologies = await this.listOntologies(null, null, 'global');
      const globalOnt = globalOntologies.find(ont => ont.ontologyId === globalOntologyId);
      
      if (!globalOnt) {
        throw new Error(`Global ontology ${globalOntologyId} not found`);
      }

      // Generate or validate workspace ontology ID
      let workspaceOntologyId;
      if (customOntologyId) {
        // Validate custom ID format (alphanumeric, hyphens, underscores only)
        if (!/^[a-zA-Z0-9_-]+$/.test(customOntologyId)) {
          throw new Error('Ontology ID must contain only letters, numbers, hyphens, and underscores');
        }
        workspaceOntologyId = customOntologyId;
      } else {
        // Create a safe ID from workspace name
        const safeName = workspaceName
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
          .replace(/\s+/g, '-')         // Replace spaces with hyphens
          .replace(/-+/g, '-')          // Replace multiple hyphens with single
          .replace(/^-|-$/g, '');       // Remove leading/trailing hyphens
        
        workspaceOntologyId = `${tenantId}-${workspaceId}-${safeName}`;
      }

      // Check for duplicates in workspace
      const existingOntologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
      const duplicate = existingOntologies.find(ont => ont.ontologyId === workspaceOntologyId);
      if (duplicate) {
        throw new Error(`Ontology with ID '${workspaceOntologyId}' already exists in this workspace`);
      }

      // Export global ontology content
      const turtleContent = await this.exportOntology(null, null, globalOnt.iri, 'schema', globalOntologyId, { scope: 'global' });
      
      // Generate workspace-specific URIs
      const workspaceOntologyIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${workspaceOntologyId}`;
      const modifiedTurtle = this.updateOntologyURIs(turtleContent, globalOnt.iri, workspaceOntologyIRI);
      
      const result = await this.importOntology(tenantId, workspaceId, modifiedTurtle, {
        ontologyId: workspaceOntologyId,
        ontologyIRI: workspaceOntologyIRI,
        scope: 'workspace',
        version: '1.0.0',
        sourceGlobal: globalOntologyId,
        replaceExisting: true
      });

      // Create version record
      await this.createVersion(tenantId, workspaceId, workspaceOntologyId, {
        version: '1.0.0',
        description: `Initial copy from global ontology: ${globalOnt.label || globalOntologyId}`,
        sourceGlobal: globalOntologyId
      });

      return {
        success: true,
        workspaceOntologyId,
        workspaceOntologyIRI,
        workspaceName,
        version: '1.0.0',
        message: 'Global ontology copied to workspace with unique URI'
      };

    } catch (error) {
      logger.error(`Failed to copy global ontology ${globalOntologyId}:`, error);
      throw error;
    }
  }

  /**
   * Update ontology URIs in turtle content for workspace copy
   */
  updateOntologyURIs(turtleContent, originalIRI, newIRI) {
    let modifiedTurtle = turtleContent;
    
    // Extract the namespace from the ontology declaration (e.g., http://purplefabric.ai/banking#)
    const ontologyMatch = turtleContent.match(/<(http[^>]+)>\s+a\s+owl:Ontology/);
    const originalNamespace = ontologyMatch ? ontologyMatch[1].replace(/#[^#]*$/, '#') : null;
    const newNamespace = newIRI + '#';
    
    // Replace the ontology namespace in all URIs
    if (originalNamespace) {
      modifiedTurtle = modifiedTurtle.replace(
        new RegExp(originalNamespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        newNamespace
      );
    }
    
    // Also replace the graph IRI if different
    if (originalIRI && originalIRI !== originalNamespace?.replace(/#$/, '')) {
      modifiedTurtle = modifiedTurtle.replace(
        new RegExp(`<${originalIRI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g'),
        `<${newIRI}>`
      );
    }
    
    // Update base URI if present
    modifiedTurtle = modifiedTurtle.replace(
      /@base\s+<[^>]+>/g,
      `@base <${newIRI}>`
    );
    
    // Update default prefix
    modifiedTurtle = modifiedTurtle.replace(
      /@prefix\s+:\s+<[^>]+>/g,
      `@prefix : <${newNamespace}>`
    );
    
    return modifiedTurtle;
  }

  /**
   * Create new version of workspace ontology
   */
  /**
   * @deprecated Use ontologyVersioningService.createVersion() instead.
   * Kept as a no-op to avoid breaking callers during migration.
   */
  async createVersion(tenantId, workspaceId, ontologyId, versionData) {
    logger.warn(`owlOntologyService.createVersion() is deprecated — use ontologyVersioningService.createVersion()`);
    return { id: `${ontologyId}_v${versionData.version}`, ontologyId, version: versionData.version };
  }

  /**
   * @deprecated Use ontologyVersioningService.getVersionHistory() instead.
   */
  async getVersionHistory(tenantId, workspaceId, ontologyId) {
    logger.warn(`owlOntologyService.getVersionHistory() is deprecated — use ontologyVersioningService.getVersionHistory()`);
    try {
      const ontologyVersioningService = require('./ontologyVersioningService');
      const versions = await ontologyVersioningService.getVersionHistory(ontologyId);
      return versions.map(v => ({
        id: v.version_id,
        version: v.version_id,
        created: v.created_at,
        description: v.description || '',
        author: v.created_by || 'system'
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Save new version of ontology — delegates to ontologyVersioningService
   */
  async saveNewVersion(tenantId, workspaceId, ontologyId, turtleContent, versionInfo) {
    try {
      // Import updated ontology
      await this.importOntology(tenantId, workspaceId, turtleContent, {
        ontologyId,
        scope: 'workspace',
        version: versionInfo.version,
        replaceExisting: true
      });

      // Create version record in Redis (the single source of truth)
      const ontologyVersioningService = require('./ontologyVersioningService');
      await ontologyVersioningService.createVersion(ontologyId, {
        description: versionInfo.description || `Version ${versionInfo.version}`,
        user_id: versionInfo.author || 'system',
        tenant_id: tenantId,
        workspace_id: workspaceId
      });

      // Auto-sync to Neo4j
      try {
        await graphDBNeo4jSyncService.syncOntology(tenantId, workspaceId, ontologyId);
      } catch (syncError) {
        logger.warn('⚠️ Neo4j sync failed:', syncError.message);
      }

      return {
        success: true,
        version: versionInfo.version,
        message: 'New version saved successfully'
      };

    } catch (error) {
      logger.error(`Failed to save new version for ${ontologyId}:`, error);
      throw error;
    }
  }

  /**
   * Get ontology structure (classes and properties only)
   */
  async getOntologyStructure(tenantId, workspaceId, ontologyId, scope = 'all') {
    try {
      const ontologies = await this.listOntologies(tenantId, workspaceId, scope);
      const ontology = ontologies.find(ont => ont.ontologyId === ontologyId);
      
      if (!ontology) {
        throw new Error(`Ontology ${ontologyId} not found`);
      }

      // Query for classes and properties only (no instances)
      const structureQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
        
        SELECT DISTINCT ?type ?iri ?label ?comment ?domain ?range ?subClassOf
        FROM <${ontology.graphIRI}>
        WHERE {
          {
            ?iri a owl:Class .
            FILTER(!STRSTARTS(STR(?iri), "http://purplefabric.ai/data/"))
            FILTER(!STRSTARTS(STR(?iri), "nodeID://"))
            BIND("class" AS ?type)
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri rdfs:subClassOf ?subClassOf . FILTER(!isBlank(?subClassOf)) }
          }
          UNION
          {
            ?iri a owl:ObjectProperty .
            FILTER(!STRSTARTS(STR(?iri), "http://purplefabric.ai/data/"))
            FILTER(!STRSTARTS(STR(?iri), "nodeID://"))
            BIND("objectProperty" AS ?type)
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri rdfs:domain ?domain . FILTER(!isBlank(?domain)) }
            OPTIONAL { ?iri rdfs:range ?range . FILTER(!isBlank(?range)) }
          }
          UNION
          {
            ?iri a owl:DatatypeProperty .
            FILTER(!STRSTARTS(STR(?iri), "http://purplefabric.ai/data/"))
            FILTER(!STRSTARTS(STR(?iri), "nodeID://"))
            BIND("datatypeProperty" AS ?type)
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri rdfs:domain ?domain . FILTER(!isBlank(?domain)) }
            OPTIONAL { ?iri rdfs:range ?range . FILTER(!isBlank(?range)) }
          }
          UNION
          {
            ?iri a rdf:Property .
            FILTER NOT EXISTS { ?iri a owl:ObjectProperty }
            FILTER NOT EXISTS { ?iri a owl:DatatypeProperty }
            FILTER(!STRSTARTS(STR(?iri), "http://purplefabric.ai/data/"))
            FILTER(!STRSTARTS(STR(?iri), "nodeID://"))
            BIND("untypedProperty" AS ?type)
            OPTIONAL { ?iri rdfs:label ?label }
            OPTIONAL { ?iri rdfs:comment ?comment }
            OPTIONAL { ?iri rdfs:domain ?domain . FILTER(!isBlank(?domain)) }
            OPTIONAL { ?iri rdfs:range ?range . FILTER(!isBlank(?range)) }
          }
        }
        ORDER BY ?type ?iri
      `;

      const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, structureQuery);
      
      const classes = [];
      const properties = [];

      for (const binding of result.results.bindings) {
        const item = {
          iri: binding.iri.value,
          localName: binding.iri.value.split(/[#/]/).pop(),
          label: binding.label?.value,
          comment: binding.comment?.value
        };

        if (binding.type.value === 'class') {
          if (binding.subClassOf) {
            item.subClassOf = binding.subClassOf.value.split(/[#/]/).pop();
          }
          classes.push(item);
        } else if (binding.type.value === 'datatypeProperty') {
          item.type = 'datatypeProperty';
          if (binding.domain) {
            item.domain = binding.domain.value.split(/[#/]/).pop();
          }
          if (binding.range) {
            item.range = binding.range.value.split(/[#/]/).pop();
          }
          properties.push(item);
        } else if (binding.type.value === 'objectProperty') {
          item.type = 'objectProperty';
          if (binding.domain) {
            item.domain = binding.domain.value.split(/[#/]/).pop();
          }
          if (binding.range) {
            item.range = binding.range.value.split(/[#/]/).pop();
          }
          properties.push(item);
        } else if (binding.type.value === 'untypedProperty') {
          // Classify untyped rdf:Property based on range
          // If range is an XSD datatype → datatypeProperty, otherwise → objectProperty
          const rangeValue = binding.range?.value || '';
          const isDatatype = rangeValue.includes('XMLSchema#') || rangeValue.includes('xmlschema#');
          item.type = isDatatype ? 'datatypeProperty' : 'objectProperty';
          if (binding.domain) {
            item.domain = binding.domain.value.split(/[#/]/).pop();
          }
          if (binding.range) {
            item.range = binding.range.value.split(/[#/]/).pop();
          }
          properties.push(item);
        }
      }

      return {
        ontologyId,
        ontologyIRI: ontology.iri,
        classes,
        properties,
        stats: {
          classCount: classes.length,
          propertyCount: properties.filter(p => p.type === 'datatypeProperty').length,
          relationshipCount: properties.filter(p => p.type === 'objectProperty').length
        }
      };

    } catch (error) {
      logger.error(`Failed to get ontology structure for ${ontologyId}:`, error);
      throw error;
    }
  }

  /**
   * Get version history for an ontology
   */
  /**
   * List all ontologies in workspace
   * @param {string} scope - 'global', 'tenant', 'workspace', or 'all'
   */
  async listOntologies(tenantId, workspaceId, scope = 'all') {
    const ontologies = await graphDBStore.listOntologies(tenantId, workspaceId, scope);
    
    // If requesting all ontologies, deduplicate workspace copies
    if (scope === 'all') {
      const ontologyMap = new Map();
      const workspaceBaseIds = new Set();

      // First pass: collect workspace ontologies (keep latest only)
      ontologies.forEach(ont => {
        if (ont.scope === 'workspace') {
          const baseId = ont.ontologyId.replace(/-workspace-\d+$/, '');
          workspaceBaseIds.add(baseId);
          
          const existing = ontologyMap.get(baseId);
          if (!existing || ont.ontologyId > existing.ontologyId) {
            ontologyMap.set(baseId, ont);
          }
        }
      });

      // Second pass: add global ontologies only if no workspace copy exists
      ontologies.forEach(ont => {
        if (ont.scope === 'global' && !workspaceBaseIds.has(ont.ontologyId)) {
          ontologyMap.set(ont.ontologyId, ont);
        }
      });

      return Array.from(ontologyMap.values());
    }
    
    return ontologies;
  }

  /**
   * Get ontology details
   */
  async getOntology(tenantId, workspaceId, ontologyIRI) {
    const metadata = await graphDBStore.getOntologyMetadata(tenantId, workspaceId, ontologyIRI);
    const classes = await graphDBStore.getClasses(tenantId, workspaceId);
    const objectProps = await graphDBStore.getObjectProperties(tenantId, workspaceId);
    const dataProps = await graphDBStore.getDataProperties(tenantId, workspaceId);

    return {
      ...metadata,
      classes,
      objectProperties: objectProps,
      dataProperties: dataProps,
      stats: {
        classCount: classes.length,
        objectPropertyCount: objectProps.length,
        dataPropertyCount: dataProps.length
      }
    };
  }

  /**
   * Create new ontology
   */
  async createOntology(tenantId, workspaceId, ontologyData) {
    const {
      iri,
      label,
      comment,
      versionInfo,
      classes = [],
      objectProperties = [],
      dataProperties = []
    } = ontologyData;

    if (!iri) {
      throw new Error('Ontology IRI is required');
    }

    // Helper to escape strings for Turtle literals
    const escapeTurtle = (str) => {
      if (!str) return '';
      return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    };

    // Extract ontologyId from IRI
    const ontologyId = graphDBStore.extractOntologyId(iri);
    logger.info(`🆕 Creating new ontology: ${iri} (ID: ${ontologyId})`);

    // Build Turtle representation
    let turtle = `@prefix rdf: <${RDF}> .
@prefix rdfs: <${RDFS}> .
@prefix owl: <${OWL}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix : <${iri}#> .

<${iri}> a owl:Ontology`;

    if (label) {
      turtle += ` ;\n  rdfs:label "${escapeTurtle(label)}"`;
    }

    if (comment) {
      turtle += ` ;\n  rdfs:comment "${escapeTurtle(comment)}"`;
    }

    if (versionInfo) {
      turtle += ` ;\n  owl:versionInfo "${escapeTurtle(versionInfo)}"`;
    }

    turtle += ' .\n\n';

    // Add classes
    for (const cls of classes) {
      if (!cls.iri) {
        throw new Error(`Class IRI is required for class: ${cls.label || 'unknown'}`);
      }
      turtle += `<${cls.iri}> a owl:Class`;
      
      if (cls.label) {
        turtle += ` ;\n  rdfs:label "${escapeTurtle(cls.label)}"`;
      }
      
      if (cls.comment) {
        turtle += ` ;\n  rdfs:comment "${escapeTurtle(cls.comment)}"`;
      }
      
      if (cls.superClasses && cls.superClasses.length > 0) {
        for (const superClass of cls.superClasses) {
          turtle += ` ;\n  rdfs:subClassOf <${superClass}>`;
        }
      }
      
      turtle += ' .\n\n';
    }

    // Add object properties (relationships)
    for (const prop of objectProperties) {
      if (!prop.iri) {
        throw new Error(`Property IRI is required for property: ${prop.label || 'unknown'}`);
      }
      turtle += `<${prop.iri}> a owl:ObjectProperty`;
      
      if (prop.label) {
        turtle += ` ;\n  rdfs:label "${escapeTurtle(prop.label)}"`;
      }
      
      if (prop.comment) {
        turtle += ` ;\n  rdfs:comment "${escapeTurtle(prop.comment)}"`;
      }
      
      if (prop.domain && prop.domain.length > 0) {
        for (const domain of prop.domain) {
          turtle += ` ;\n  rdfs:domain <${domain}>`;
        }
      }
      
      if (prop.range && prop.range.length > 0) {
        for (const range of prop.range) {
          turtle += ` ;\n  rdfs:range <${range}>`;
        }
      }
      
      if (prop.inverse) {
        turtle += ` ;\n  owl:inverseOf <${prop.inverse}>`;
      }
      
      if (prop.symmetric) {
        turtle += ` ;\n  a owl:SymmetricProperty`;
      }
      
      if (prop.transitive) {
        turtle += ` ;\n  a owl:TransitiveProperty`;
      }
      
      turtle += ' .\n\n';
    }

    // Add data properties
    for (const prop of dataProperties) {
      if (!prop.iri) {
        throw new Error(`Property IRI is required for property: ${prop.label || 'unknown'}`);
      }
      turtle += `<${prop.iri}> a owl:DatatypeProperty`;
      
      if (prop.label) {
        turtle += ` ;\n  rdfs:label "${escapeTurtle(prop.label)}"`;
      }
      
      if (prop.comment) {
        turtle += ` ;\n  rdfs:comment "${escapeTurtle(prop.comment)}"`;
      }
      
      if (prop.domain && prop.domain.length > 0) {
        for (const domain of prop.domain) {
          turtle += ` ;\n  rdfs:domain <${domain}>`;
        }
      }
      
      // Handle range - convert xsd: prefix to full IRI if needed
      const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
      if (prop.range) {
        const ranges = Array.isArray(prop.range) ? prop.range : [prop.range];
        for (let range of ranges) {
          // Convert prefixed notation to full IRI
          if (range.startsWith('xsd:')) {
            range = XSD_NS + range.substring(4);
          }
          turtle += ` ;\n  rdfs:range <${range}>`;
        }
      } else {
        // Map data_type to XSD
        const dataType = prop.data_type || prop.dataType || 'string';
        const xsdType = dataType === 'number' || dataType === 'integer' ? 'xsd:integer' :
                        dataType === 'decimal' || dataType === 'float' ? 'xsd:decimal' :
                        dataType === 'boolean' ? 'xsd:boolean' :
                        dataType === 'date' ? 'xsd:date' :
                        dataType === 'dateTime' ? 'xsd:dateTime' : 'xsd:string';
        turtle += ` ;\n  rdfs:range ${xsdType}`;
      }
      
      turtle += ' .\n\n';
    }

    // Import the ontology - always to workspace scope when created via API
    return this.importOntology(tenantId, workspaceId, turtle, { 
      ontologyIRI: iri,
      ontologyId: ontologyId,
      scope: 'workspace'
    });
  }

  /**
   * Clear data associated with a specific ontology
   */
  async clearAssociatedData(tenantId, workspaceId, ontologyId) {
    try {
      // Clear data graph for this ontology
      const dataGraphURI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
      
      const clearQuery = `
        DELETE WHERE {
          GRAPH <${dataGraphURI}> {
            ?s ?p ?o .
          }
        }
      `;

      await graphDBStore.executeSPARQL(tenantId, workspaceId, clearQuery, 'data');
      logger.info(`🗑️ Cleared associated data for ontology: ${ontologyId}`);

    } catch (error) {
      logger.warn(`⚠️ Could not clear associated data for ${ontologyId}:`, error.message);
      // Don't throw - allow deletion to proceed
    }
  }

  /**
   * Check if ontology has associated data
   */
  async hasAssociatedData(tenantId, workspaceId, ontologyId) {
    try {
      // Check for data in the corresponding data graph
      const dataGraphURI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
      
      const checkQuery = `
        ASK {
          GRAPH <${dataGraphURI}> {
            ?s ?p ?o .
          }
        }
      `;

      const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, checkQuery, 'data');
      return result.boolean || false;

    } catch (error) {
      logger.error(`❌ Error checking associated data for ${ontologyId}:`, error);
      return false;
    }
  }

  /**
   * Update existing ontology structure
   */
  async updateOntology(tenantId, workspaceId, ontologyId, structure) {
    try {
      logger.info(`📝 Updating ontology: ${ontologyId}`);

      // Find the ontology
      const ontologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
      const targetOntology = ontologies.find(ont => ont.ontologyId === ontologyId);
      
      if (!targetOntology) {
        throw new Error(`Ontology not found: ${ontologyId}`);
      }

      if (targetOntology.scope === 'global') {
        throw new Error('Cannot update global ontologies. Copy to workspace first.');
      }

      const ontologyIRI = targetOntology.iri || `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}`;

      // Build Turtle from structure
      let turtle = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix : <${ontologyIRI}#> .

<${ontologyIRI}> a owl:Ontology ;
  rdfs:label "${structure.label || ontologyId}" .

`;

      // Add classes
      for (const cls of (structure.classes || [])) {
        const clsUri = cls.uri || `${ontologyIRI}#${cls.label?.replace(/\s+/g, '')}`;
        turtle += `<${clsUri}> a owl:Class`;
        if (cls.label) turtle += ` ;\n  rdfs:label "${cls.label}"`;
        if (cls.comment) turtle += ` ;\n  rdfs:comment "${cls.comment}"`;
        if (cls.subClassOf) {
          for (const parent of (Array.isArray(cls.subClassOf) ? cls.subClassOf : [cls.subClassOf])) {
            if (parent) turtle += ` ;\n  rdfs:subClassOf <${parent}>`;
          }
        }
        turtle += ' .\n\n';
      }

      // Add properties
      for (const prop of (structure.properties || [])) {
        const propUri = prop.uri || `${ontologyIRI}#${prop.label?.replace(/\s+/g, '')}`;
        // Support both editor format (propertyType: 'DatatypeProperty') and structure format (type: 'datatypeProperty')
        const isDatatypeProp = prop.propertyType === 'DatatypeProperty' || prop.type === 'datatypeProperty';
        const propType = isDatatypeProp ? 'owl:DatatypeProperty' : 'owl:ObjectProperty';
        turtle += `<${propUri}> a ${propType}`;
        if (prop.label) turtle += ` ;\n  rdfs:label "${prop.label}"`;
        if (prop.comment) turtle += ` ;\n  rdfs:comment "${prop.comment}"`;
        if (prop.domain) turtle += ` ;\n  rdfs:domain <${prop.domain}>`;
        if (prop.range) {
          let rangeValue = prop.range;
          // Handle XSD data types for datatype properties
          if (isDatatypeProp && rangeValue && !rangeValue.startsWith('http')) {
            const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
            if (rangeValue.startsWith('xsd:')) {
              rangeValue = XSD_NS + rangeValue.substring(4);
            } else {
              // Map common type names to XSD
              const typeMap = { string: 'string', integer: 'integer', number: 'integer', decimal: 'decimal', float: 'decimal', boolean: 'boolean', date: 'date', dateTime: 'dateTime' };
              rangeValue = XSD_NS + (typeMap[rangeValue] || 'string');
            }
          }
          turtle += ` ;\n  rdfs:range <${rangeValue}>`;
        }
        turtle += ' .\n\n';
      }

      // --- Deprecated-schema preservation ---
      // Before replacing, diff old vs new and write removed definitions to the
      // deprecated named graph so SPARQL queries against old instance data still
      // resolve types correctly.
      try {
        const oldStructure = await this.getOntologyStructure(tenantId, workspaceId, ontologyId, 'all');
        const newClassUris = new Set((structure.classes || []).map(c => c.uri || `${ontologyIRI}#${c.label?.replace(/\s+/g, '')}`));
        const newPropUris = new Set((structure.properties || []).map(p => p.uri || `${ontologyIRI}#${p.label?.replace(/\s+/g, '')}`));

        const removedClasses = (oldStructure.classes || []).filter(c => !newClassUris.has(c.uri) && !newClassUris.has(c.iri));
        const removedProps = (oldStructure.properties || []).filter(p => !newPropUris.has(p.uri) && !newPropUris.has(p.iri));

        if (removedClasses.length > 0 || removedProps.length > 0) {
          // Build Turtle for deprecated definitions — annotated with owl:deprecated true
          const depPrefixes = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
          let depTurtle = depPrefixes + '\n';

          for (const cls of removedClasses) {
            const uri = cls.uri || cls.iri;
            if (!uri) continue;
            depTurtle += `<${uri}> a owl:Class ;\n  owl:deprecated true`;
            if (cls.label) depTurtle += ` ;\n  rdfs:label "${cls.label}"`;
            if (cls.comment) depTurtle += ` ;\n  rdfs:comment "${cls.comment}"`;
            depTurtle += ' .\n\n';
          }

          for (const prop of removedProps) {
            const uri = prop.uri || prop.iri;
            if (!uri) continue;
            const isDt = prop.type === 'datatypeProperty' || prop.propertyType === 'DatatypeProperty';
            depTurtle += `<${uri}> a ${isDt ? 'owl:DatatypeProperty' : 'owl:ObjectProperty'} ;\n  owl:deprecated true`;
            if (prop.label) depTurtle += ` ;\n  rdfs:label "${prop.label}"`;
            if (prop.domain) depTurtle += ` ;\n  rdfs:domain <${prop.domain}>`;
            if (prop.range && prop.range.startsWith('http')) depTurtle += ` ;\n  rdfs:range <${prop.range}>`;
            depTurtle += ' .\n\n';
          }

          // Append to the deprecated graph (POST adds triples, doesn't clear)
          const deprecatedGraphIRI = graphDBStore.getDeprecatedGraphIRI(tenantId, workspaceId);
          const depUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(deprecatedGraphIRI)}`;
          const depResponse = await fetch(depUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-turtle' },
            body: depTurtle
          });
          if (depResponse.ok) {
            logger.info(`📦 Preserved ${removedClasses.length} classes + ${removedProps.length} properties in deprecated graph`);
          } else {
            logger.warn(`⚠️ Failed to write deprecated definitions: ${depResponse.status}`);
          }
        }
      } catch (depError) {
        // Non-fatal — don't block the update
        logger.warn(`⚠️ Deprecated-schema preservation failed (non-fatal): ${depError.message}`);
      }

      // Import the updated ontology (replaces existing)
      const result = await this.importOntology(tenantId, workspaceId, turtle, {
        ontologyId,
        ontologyIRI,
        scope: 'workspace',
        replaceExisting: true
      });

      logger.info(`✅ Ontology updated: ${ontologyId}`);
      return { success: true, ontologyId, ...result };

    } catch (error) {
      logger.error(`❌ Error updating ontology ${ontologyId}:`, error);
      throw error;
    }
  }

  /**
   * Delete ontology
   */
  async deleteOntology(tenantId, workspaceId, ontologyIRI) {
    try {
      logger.info(`🗑️ Deleting ontology: ${ontologyIRI} for ${tenantId}:${workspaceId}`);

      // First, find the ontology to get its actual graph IRI and scope
      const ontologies = await this.listOntologies(tenantId, workspaceId, 'all');
      const targetOntology = ontologies.find(ont => ont.iri === ontologyIRI);
      
      if (!targetOntology) {
        throw new Error(`Ontology not found: ${ontologyIRI}`);
      }

      // Check if it's a global ontology (can't delete global ontologies)
      if (targetOntology.scope === 'global') {
        throw new Error('Cannot delete global ontologies. Only workspace ontologies can be deleted.');
      }

      // Only allow deletion of workspace-scoped ontologies
      if (targetOntology.scope !== 'workspace') {
        throw new Error(`Cannot delete ${targetOntology.scope} ontology. Only workspace ontologies can be deleted.`);
      }

      // Extract ontology ID for data check
      const ontologyId = targetOntology.ontologyId;
      
      // For workspace ontologies, clear associated data before deletion
      if (targetOntology.scope === 'workspace') {
        await this.clearAssociatedData(tenantId, workspaceId, ontologyId);
      }

      // Use the actual graph IRI from the ontology
      const graphURI = targetOntology.graphIRI;
      
      // Clear the specific ontology graph using GraphDB update endpoint
      const updateQuery = `CLEAR GRAPH <${graphURI}>`;
      const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-update'
        },
        body: updateQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete ontology graph: ${response.status} - ${errorText}`);
      }

      logger.info(`✅ Ontology deleted: ${ontologyIRI}`);

      // Clean up deprecated definitions that belonged to this ontology.
      // The deprecated graph accumulates removed class/property definitions so
      // old instance data can still resolve types.  Once the ontology itself is
      // deleted (along with its instance data above), those deprecated
      // definitions are no longer needed.
      try {
        const deprecatedGraphIRI = graphDBStore.getDeprecatedGraphIRI(tenantId, workspaceId);
        const cleanupQuery = `
          DELETE {
            GRAPH <${deprecatedGraphIRI}> { ?s ?p ?o }
          }
          WHERE {
            GRAPH <${deprecatedGraphIRI}> { ?s ?p ?o }
            FILTER(STRSTARTS(STR(?s), "${ontologyIRI}#") || STR(?s) = "${ontologyIRI}")
          }
        `;
        const depUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
        const depResponse = await fetch(depUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sparql-update' },
          body: cleanupQuery
        });
        if (depResponse.ok) {
          logger.info(`🗑️ Cleaned deprecated definitions for deleted ontology: ${ontologyIRI}`);
        } else {
          logger.warn(`⚠️ Could not clean deprecated definitions: ${depResponse.status}`);
        }
      } catch (depError) {
        logger.warn(`⚠️ Deprecated cleanup failed (non-fatal): ${depError.message}`);
      }
      
      // Auto-sync to Neo4j after deletion
      try {
        await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId);
      } catch (syncError) {
        logger.warn('⚠️ Neo4j sync failed after deletion:', syncError.message);
      }
      
      return { 
        success: true, 
        message: `Ontology ${ontologyIRI} deleted successfully`,
        ontologyIRI,
        graphURI
      };

    } catch (error) {
      logger.error(`❌ Error deleting ontology ${ontologyIRI}:`, error);
      throw error;
    }
  }

  /**
   * Clear instance data only (keep schema)
   */
  async clearData(tenantId, workspaceId) {
    logger.info(`🗑️  Clearing instance data for ${tenantId}:${workspaceId}`);
    
    await graphDBStore.clearDataOnly(tenantId, workspaceId);
    
    // Auto-sync to Neo4j after data clearing
    try {
      await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId);
    } catch (syncError) {
      logger.warn('⚠️ Neo4j sync failed after data clearing:', syncError.message);
    }
    
    return { success: true };
  }

  /**
   * Clear everything (schema + data)
   */
  async clearAll(tenantId, workspaceId) {
    logger.info(`🗑️  Clearing all data for ${tenantId}:${workspaceId}`);
    
    await graphDBStore.clearAll(tenantId, workspaceId);
    
    // Auto-sync to Neo4j after clearing all
    try {
      await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId);
    } catch (syncError) {
      logger.warn('⚠️ Neo4j sync failed after clearing all:', syncError.message);
    }
    
    return { success: true };
  }

  /**
   * Check if ontology exists in GraphDB
   * @param {string} scope - 'global', 'tenant', 'workspace', or 'all'
   */
  async hasOntology(tenantId, workspaceId, scope = 'all') {
    if (scope === 'global') {
      return graphDBStore.hasGlobalOntologies();
    }
    return graphDBStore.hasSchema(tenantId, workspaceId);
  }

  /**
   * Load ontology from file system to GraphDB
   */
  async loadFromFile(tenantId, workspaceId, filePath, options = {}) {
    logger.info(`📂 Loading ontology from file: ${filePath}`);
    
    const content = await fs.readFile(filePath, 'utf-8');
    // Derive ontologyId from filename if not provided
    if (!options.ontologyId) {
      options.ontologyId = path.basename(filePath, path.extname(filePath));
    }
    return this.importOntology(tenantId, workspaceId, content, options);
  }

  /**
   * Initialize ontologies from file system if not in GraphDB
   * @param {string} scope - 'global', 'tenant', or 'workspace'
   */
  async initializeFromFiles(tenantId, workspaceId, ontologyDir, scope = 'global') {
    logger.info(`🔄 Initializing ${scope} ontologies`);
    
    // Check if ontologies already exist
    const hasExisting = await this.hasOntology(tenantId, workspaceId, scope);
    
    if (hasExisting) {
      logger.info(`✅ ${scope} ontologies already exist in GraphDB, skipping file load`);
      return { skipped: true, reason: `${scope} ontologies already exist` };
    }

    // Load all .ttl files from directory
    const files = await fs.readdir(ontologyDir);
    const ttlFiles = files.filter(f => f.endsWith('.ttl'));
    
    const results = [];
    
    for (const file of ttlFiles) {
      const filePath = path.join(ontologyDir, file);
      try {
        const result = await this.loadFromFile(tenantId, workspaceId, filePath, {
          replaceExisting: false,
          scope
        });
        results.push({ file, success: true, result });
        logger.info(`✅ Loaded ${file} to ${scope} scope`);
      } catch (error) {
        logger.error(`❌ Failed to load ${file}: ${error.message}`);
        results.push({ file, success: false, error: error.message });
      }
    }
    
    return {
      initialized: true,
      scope,
      filesProcessed: ttlFiles.length,
      results
    };
  }

  /**
   * Convert legacy YAML ontology to OWL/Turtle
   * This is for migration purposes
   */
  convertYAMLToOWL(yamlOntology) {
    const baseIRI = yamlOntology.namespace || `http://purplefabric.ai/ontology/${yamlOntology.name}`;
    
    const ontologyData = {
      iri: baseIRI,
      label: yamlOntology.name,
      comment: yamlOntology.description || '',
      versionInfo: yamlOntology.version || '1.0',
      classes: [],
      objectProperties: [],
      dataProperties: []
    };

    // Convert entity types to OWL classes
    if (yamlOntology.entityTypes || yamlOntology.entity_types) {
      const entityTypes = yamlOntology.entityTypes || yamlOntology.entity_types;
      
      for (const et of entityTypes) {
        const classIRI = `${baseIRI}#${et.name || et.label}`;
        
        ontologyData.classes.push({
          iri: classIRI,
          label: et.label || et.name,
          comment: et.description || '',
          superClasses: []
        });

        // Convert properties to data properties
        if (et.properties) {
          for (const prop of et.properties) {
            const propIRI = `${baseIRI}#${prop.name}`;
            
            ontologyData.dataProperties.push({
              iri: propIRI,
              label: prop.name,
              comment: prop.description || '',
              domain: [classIRI],
              range: [this.mapDataTypeToXSD(prop.data_type || prop.dataType)]
            });
          }
        }
      }
    }

    // Convert relationships to object properties
    if (yamlOntology.relationships || yamlOntology.relationship_types) {
      const relationships = yamlOntology.relationships || yamlOntology.relationship_types;
      
      for (const rel of relationships) {
        const propIRI = `${baseIRI}#${rel.type || rel.predicate || rel.name}`;
        
        const sourceTypes = rel.source_types || (rel.from ? [rel.from] : []);
        const targetTypes = rel.target_types || (rel.to ? [rel.to] : []);
        
        ontologyData.objectProperties.push({
          iri: propIRI,
          label: rel.type || rel.predicate || rel.name,
          comment: rel.description || '',
          domain: sourceTypes.map(t => `${baseIRI}#${t}`),
          range: targetTypes.map(t => `${baseIRI}#${t}`)
        });
      }
    }

    return ontologyData;
  }

  /**
   * Map data type to XSD type
   */
  mapDataTypeToXSD(dataType) {
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    
    const mapping = {
      'string': `${XSD}string`,
      'integer': `${XSD}integer`,
      'int': `${XSD}integer`,
      'float': `${XSD}float`,
      'double': `${XSD}double`,
      'boolean': `${XSD}boolean`,
      'bool': `${XSD}boolean`,
      'date': `${XSD}date`,
      'datetime': `${XSD}dateTime`,
      'time': `${XSD}time`
    };

    return mapping[dataType?.toLowerCase()] || `${XSD}string`;
  }

  /**
   * Get extraction schema from OWL ontology
   * Converts OWL classes and properties to extraction format
   */
  async getExtractionSchema(tenantId, workspaceId, ontologyIRI) {
    const ontology = await this.getOntology(tenantId, workspaceId, ontologyIRI);
    
    // Convert to extraction format
    const schema = {
      entityTypes: ontology.classes.map(cls => ({
        name: cls.label,
        iri: cls.iri,
        description: cls.comment,
        properties: []
      })),
      relationships: ontology.objectProperties.map(prop => ({
        type: prop.label,
        iri: prop.iri,
        description: prop.comment,
        source_types: prop.domain.map(d => this.extractLocalName(d)),
        target_types: prop.range.map(r => this.extractLocalName(r))
      }))
    };

    // Add data properties to entity types
    for (const dataProp of ontology.dataProperties) {
      for (const domainIRI of dataProp.domain) {
        const entityType = schema.entityTypes.find(et => et.iri === domainIRI);
        if (entityType) {
          entityType.properties.push({
            name: dataProp.label,
            iri: dataProp.iri,
            dataType: this.extractLocalName(dataProp.range[0] || '')
          });
        }
      }
    }

    return schema;
  }

  /**
   * Copy a global ontology to workspace scope
   */
  async copyGlobalToWorkspace(tenantId, workspaceId, globalOntologyId) {
    // Get the global ontology
    const globalOntologies = await this.listOntologies(tenantId, workspaceId, 'global');
    const globalOnt = globalOntologies.find(o => o.ontologyId === globalOntologyId);
    
    if (!globalOnt) {
      throw new Error(`Global ontology not found: ${globalOntologyId}`);
    }

    // Get the full structure
    const structure = await this.getOntologyStructure(tenantId, workspaceId, globalOntologyId, 'global');
    
    // Export as Turtle
    const turtle = await graphDBStore.exportGraphAsTurtle(globalOnt.graphIRI);
    
    // Import to workspace with new ID
    const newOntologyId = `${globalOnt.label?.toLowerCase().replace(/\s+/g, '-') || globalOntologyId}-copy-${Date.now()}`;
    
    const result = await this.importOntology(tenantId, workspaceId, {
      turtleContent: turtle,
      ontologyId: newOntologyId,
      scope: 'workspace',
      label: `${globalOnt.label} (Copy)`,
      description: `Workspace copy of global ontology: ${globalOnt.label}`
    });

    return { ontologyId: result.ontologyId || newOntologyId };
  }

  /**
   * Extract local name from IRI
   */
  extractLocalName(iri) {
    if (!iri) return '';
    const parts = iri.split(/[#/]/);
    return parts[parts.length - 1];
  }
}

module.exports = new OWLOntologyService();
