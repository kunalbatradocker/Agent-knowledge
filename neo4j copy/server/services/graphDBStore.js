/**
 * GraphDB Store Service
 * Replaces in-memory N3.Store with persistent GraphDB triplestore
 * GraphDB provides: persistent storage, SPARQL 1.1, reasoning, scalability
 */

const logger = require('../utils/logger');
require('dotenv').config();

const GRAPHDB_URL = process.env.GRAPHDB_URL || 'http://localhost:7200';
const GRAPHDB_REPOSITORY = process.env.GRAPHDB_REPOSITORY || 'ontologies';

// Standard namespaces
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

class GraphDBStore {
  constructor() {
    this.baseUrl = GRAPHDB_URL;
    this.repository = GRAPHDB_REPOSITORY;
    this.prefixes = {
      rdf: RDF,
      rdfs: RDFS,
      owl: OWL,
      xsd: XSD
    };
    
    // Concurrency control — limit parallel requests to GraphDB
    this._maxConcurrent = parseInt(process.env.GRAPHDB_MAX_CONCURRENT) || 10;
    this._activeRequests = 0;
    this._waitQueue = [];
    
    logger.info(`🗄️  GraphDB Store initialized: ${this.baseUrl}/repositories/${this.repository} (max concurrent: ${this._maxConcurrent})`);
  }

  /**
   * Acquire a concurrency slot. Resolves when a slot is available.
   */
  async _acquireSlot() {
    if (this._activeRequests < this._maxConcurrent) {
      this._activeRequests++;
      return;
    }
    // Wait for a slot to free up
    return new Promise(resolve => {
      this._waitQueue.push(resolve);
    });
  }

  /**
   * Release a concurrency slot.
   */
  _releaseSlot() {
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift();
      next(); // Don't decrement — the waiter takes the slot
    } else {
      this._activeRequests--;
    }
  }

  /**
   * Execute a fetch with concurrency control and retry on 5xx/network errors.
   */
  async _fetchWithPool(url, options, retries = 2) {
    const FETCH_TIMEOUT = (parseInt(process.env.GRAPHDB_TIMEOUT) || 120) * 1000; // default 2 min
    await this._acquireSlot();
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
          const response = await fetch(url, { ...options, signal: controller.signal });
          clearTimeout(timeoutId);
          // Retry on 5xx server errors
          if (response.status >= 500 && attempt < retries) {
            logger.warn(`GraphDB ${response.status} on attempt ${attempt + 1}, retrying...`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          return response;
        } catch (err) {
          if (err.name === 'AbortError') {
            if (attempt < retries) {
              logger.warn(`GraphDB request timed out on attempt ${attempt + 1}, retrying...`);
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
              continue;
            }
            throw new Error(`GraphDB request timed out after ${FETCH_TIMEOUT / 1000}s. Increase GRAPHDB_TIMEOUT env var.`);
          }
          // Retry on network errors
          if (attempt < retries && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.message.includes('fetch failed'))) {
            logger.warn(`GraphDB network error on attempt ${attempt + 1}: ${err.message}, retrying...`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    } finally {
      this._releaseSlot();
    }
  }

  /**
   * Get global ontology graph IRI (shared across all tenants/workspaces)
   * @param {string} ontologyId - Ontology identifier (e.g., 'resume', 'legal-contract')
   */
  getGlobalOntologyGraphIRI(ontologyId) {
    if (!ontologyId || ontologyId === 'undefined' || ontologyId === 'null') {
      throw new Error('ontologyId is required for global ontology graph IRI');
    }
    return `http://purplefabric.ai/graphs/global/ontology/${ontologyId}`;
  }

  /**
   * Get tenant-specific ontology graph IRI (for customizations)
   * @param {string} ontologyId - Ontology identifier
   */
  getTenantOntologyGraphIRI(tenantId, ontologyId) {
    if (!tenantId || !ontologyId) throw new Error('tenantId and ontologyId required');
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/ontology/${ontologyId}`;
  }

  /**
   * Get schema graph IRI for a specific ontology
   * @param {string} ontologyId - Optional ontology identifier (e.g., 'resume', 'legal-contract')
   * @deprecated Use getGlobalOntologyGraphIRI() or getTenantOntologyGraphIRI() instead
   */
  getSchemaGraphIRI(tenantId, workspaceId, ontologyId = null) {
    if (!tenantId || tenantId === 'undefined') {
      throw new Error('tenantId is required for schema graph IRI');
    }
    if (!workspaceId || workspaceId === 'undefined') {
      throw new Error('workspaceId is required for schema graph IRI');
    }
    if (ontologyId) {
      if (ontologyId === 'undefined' || ontologyId === 'null') {
        throw new Error('Invalid ontologyId for schema graph IRI');
      }
      return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}`;
    }
    // Legacy: return base schema graph
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/schema`;
  }

  /**
   * Get data graph IRI (for instance data - workspace-specific)
   */
  getDataGraphIRI(tenantId, workspaceId) {
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
  }

  /**
   * Get audit graph IRI (for change tracking - workspace-specific)
   * @param {string} tenantId - Tenant identifier
   * @param {string} workspaceId - Workspace identifier
   * @returns {string} The audit graph IRI
   */
  getAuditGraphIRI(tenantId, workspaceId) {
    if (!tenantId || tenantId === 'undefined') {
      throw new Error('tenantId is required for audit graph IRI');
    }
    if (!workspaceId || workspaceId === 'undefined') {
      throw new Error('workspaceId is required for audit graph IRI');
    }
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/audit`;
  }

  /**
   * Get deprecated schema graph IRI.
   * Accumulates owl:Class and owl:*Property definitions that were removed from
   * the active schema but are still referenced by committed instance data.
   * Each triple is annotated with owl:deprecated true so queries can distinguish
   * current from legacy definitions.
   */
  getDeprecatedGraphIRI(tenantId, workspaceId) {
    if (!tenantId || tenantId === 'undefined') {
      throw new Error('tenantId is required for deprecated graph IRI');
    }
    if (!workspaceId || workspaceId === 'undefined') {
      throw new Error('workspaceId is required for deprecated graph IRI');
    }
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/deprecated`;
  }

  /**
   * Get repository URL for tenant/workspace (legacy - kept for compatibility)
   * Uses named graphs for multi-tenancy
   */
  getGraphIRI(tenantId, workspaceId) {
    return this.getSchemaGraphIRI(tenantId, workspaceId);
  }

  /**
   * Extract ontology ID from IRI - NEVER returns null
   * e.g., http://purplefabric.ai/resume#ResumeOntology -> 'resume'
   */
  extractOntologyId(ontologyIRI) {
    if (!ontologyIRI || typeof ontologyIRI !== 'string') {
      return `ont-${Date.now()}`;
    }
    
    // Pattern 1: http://purplefabric.ai/resume#ResumeOntology -> 'resume'
    let match = ontologyIRI.match(/\/([^\/]+)#/);
    if (match && match[1]) return match[1];
    
    // Pattern 2: http://purplefabric.ai/graphs/global/ontology/resume -> 'resume'
    match = ontologyIRI.match(/\/ontology\/([^\/]+)$/);
    if (match && match[1]) return match[1];
    
    // Pattern 3: http://purplefabric.ai/resume -> 'resume'
    match = ontologyIRI.match(/\/([^\/]+)$/);
    if (match && match[1] && match[1].trim()) return match[1];
    
    // Pattern 4: Last part after # or /
    const parts = ontologyIRI.split(/[#\/]/);
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.trim()) {
      return lastPart.toLowerCase().replace(/ontology$/i, '') || `ont-${Date.now()}`;
    }
    
    // Fallback: generate from hash - NEVER return null
    const hash = Math.abs(ontologyIRI.split('').reduce((a,b) => (((a << 5) - a) + b.charCodeAt(0))|0, 0));
    return `ont-${hash}`;
  }

  /**
   * Check GraphDB connection
   */
  async checkConnection() {
    try {
      const response = await this._fetchWithPool(`${this.baseUrl}/rest/repositories`, {});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const repos = await response.json();
      const repoExists = repos.some(r => r.id === this.repository);
      
      if (!repoExists) {
        logger.warn(`⚠️  Repository '${this.repository}' not found in GraphDB`);
        logger.warn(`   Available repositories: ${repos.map(r => r.id).join(', ')}`);
        logger.warn(`   Create repository in GraphDB or set GRAPHDB_REPOSITORY env var`);
      }
      
      return {
        connected: true,
        repository: this.repository,
        repositoryExists: repoExists,
        availableRepositories: repos.map(r => r.id)
      };
    } catch (error) {
      logger.error(`❌ GraphDB connection failed: ${error.message}`);
      return {
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * Import Turtle into GraphDB
   * @param {string} graphType - 'schema', 'data', 'global', or 'tenant'
   * @param {string} ontologyId - Required for schema/global/tenant graphs
   */
  async importTurtle(tenantId, workspaceId, turtleString, baseIRI = null, graphType = 'schema', ontologyId = null) {
    if (!turtleString || turtleString.trim().length === 0) {
      throw new Error('Turtle content is required and cannot be empty');
    }
    
    let graphIRI;
    
    if (graphType === 'data') {
      if (!tenantId || !workspaceId) {
        throw new Error('tenantId and workspaceId are required for data graph');
      }
      graphIRI = this.getDataGraphIRI(tenantId, workspaceId);
    } else if (graphType === 'global') {
      // Global ontology - ontologyId required
      if (!ontologyId && baseIRI) {
        ontologyId = this.extractOntologyId(baseIRI);
      }
      if (!ontologyId) {
        const ontologyMatch = turtleString.match(/<([^>]+)>\s+a\s+owl:Ontology/);
        if (ontologyMatch) {
          ontologyId = this.extractOntologyId(ontologyMatch[1]);
        }
      }
      if (!ontologyId) {
        throw new Error('ontologyId is required for global ontology import - could not extract from content');
      }
      graphIRI = this.getGlobalOntologyGraphIRI(ontologyId);
    } else if (graphType === 'tenant') {
      if (!tenantId) {
        throw new Error('tenantId is required for tenant ontology import');
      }
      if (!ontologyId && baseIRI) {
        ontologyId = this.extractOntologyId(baseIRI);
      }
      if (!ontologyId) {
        const ontologyMatch = turtleString.match(/<([^>]+)>\s+a\s+owl:Ontology/);
        if (ontologyMatch) {
          ontologyId = this.extractOntologyId(ontologyMatch[1]);
        }
      }
      if (!ontologyId) {
        throw new Error('ontologyId is required for tenant ontology import - could not extract from content');
      }
      graphIRI = this.getTenantOntologyGraphIRI(tenantId, ontologyId);
    } else {
      // Workspace-specific schema
      if (!tenantId || !workspaceId) {
        throw new Error('tenantId and workspaceId are required for workspace schema');
      }
      if (!ontologyId && baseIRI) {
        ontologyId = this.extractOntologyId(baseIRI);
      }
      if (!ontologyId) {
        const ontologyMatch = turtleString.match(/<([^>]+)>\s+a\s+owl:Ontology/);
        if (ontologyMatch) {
          ontologyId = this.extractOntologyId(ontologyMatch[1]);
        }
      }
      graphIRI = this.getSchemaGraphIRI(tenantId, workspaceId, ontologyId);
    }

    // Backup existing graph for atomic operation
    let backup = null;
    try {
      const existingCount = await this.countTriplesInGraph(graphIRI);
      if (existingCount > 0) {
        const backupUrl = `${this.baseUrl}/repositories/${this.repository}/statements?context=${encodeURIComponent('<' + graphIRI + '>')}`;
        const backupResponse = await this._fetchWithPool(backupUrl, {
          headers: { 'Accept': 'application/x-turtle' }
        });
        if (backupResponse.ok) {
          backup = await backupResponse.text();
          logger.info(`📦 Backed up ${existingCount} triples from ${graphIRI}`);
        }
      }
    } catch (backupError) {
      logger.warn(`Could not backup graph (may not exist): ${backupError.message}`);
    }

    try {
      // Clear existing graph
      const clearUrl = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
      await this._fetchWithPool(clearUrl, { method: 'DELETE' });
      logger.info(`🗑️ Cleared GraphDB graph: ${graphIRI}`);

      // Import to named graph
      const url = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
      
      const response = await this._fetchWithPool(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-turtle'
        },
        body: turtleString
      });

      if (!response.ok) {
        const error = await response.text();
        
        // Rollback on failure
        if (backup) {
          logger.warn(`⚠️ Import failed, rolling back to previous state...`);
          await this._fetchWithPool(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-turtle' },
            body: backup
          });
          logger.info(`✅ Rollback complete`);
        }
        
        logger.error(`❌ Failed to import to GraphDB: ${error}`);
        logger.error(`❌ Turtle preview:\n${turtleString.substring(0, 500)}`);
        throw new Error(`GraphDB import failed: ${response.status} - ${error}`);
      }

      // Count triples in this graph
      const count = await this.countTriplesInGraph(graphIRI);

      logger.info(`✅ Imported to GraphDB ${graphType} graph${ontologyId ? ` (${ontologyId})` : ''}: ${count} triples`);

      return {
        triplesAdded: count,
        graphIRI,
        graphType,
        ontologyId,
        prefixes: this.prefixes
      };

    } catch (error) {
      logger.error(`Failed to import to GraphDB: ${error.message}`);
      throw error;
    }
  }

  /**
   * Import Turtle directly to a specific named graph IRI.
   * Used by VKG service which builds its own human-readable graph IRIs
   * (using workspace name instead of UUID).
   */
  async importTurtleToGraph(tenantId, turtleString, graphIRI) {
    if (!turtleString || turtleString.trim().length === 0) {
      throw new Error('Turtle content is required and cannot be empty');
    }

    // Clear existing graph
    const clearUrl = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
    await this._fetchWithPool(clearUrl, { method: 'DELETE' });
    logger.info(`🗑️ Cleared GraphDB graph: ${graphIRI}`);

    // Import to named graph
    const url = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
    const response = await this._fetchWithPool(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-turtle' },
      body: turtleString
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(`❌ Failed to import to GraphDB: ${error}`);
      throw new Error(`GraphDB import failed: ${response.status} - ${error}`);
    }

    const count = await this.countTriplesInGraph(graphIRI);
    logger.info(`✅ Imported to GraphDB graph ${graphIRI}: ${count} triples`);

    return { triplesAdded: count, graphIRI };
  }

  /**
   * Export from GraphDB to Turtle
   * @param {string} graphType - 'schema', 'data', or 'all'
   * @param {string} ontologyId - Optional ontology ID for schema export
   */
  async exportTurtle(tenantId, workspaceId, graphType = 'schema', ontologyId = null, scope = 'workspace') {
    try {
      let url;
      
      if (graphType === 'all') {
        // Export all schema graphs and data graph
        const ontologies = await this.listOntologies(tenantId, workspaceId, scope);
        const contexts = ontologies.map(ont => `<${ont.graphIRI}>`).join('&context=');
        const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
        
        url = `${this.baseUrl}/repositories/${this.repository}/statements?context=${encodeURIComponent(contexts)}&context=${encodeURIComponent('<' + dataGraphIRI + '>')}`;
      } else if (graphType === 'data') {
        // Export only data graph
        const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
        url = `${this.baseUrl}/repositories/${this.repository}/statements?context=${encodeURIComponent('<' + dataGraphIRI + '>')}`;
      } else {
        // Export schema graph(s)
        if (ontologyId) {
          // Export specific ontology - find its actual graph IRI
          const ontologies = await this.listOntologies(tenantId, workspaceId, scope);
          const targetOntology = ontologies.find(ont => ont.ontologyId === ontologyId);
          
          if (!targetOntology) {
            logger.warn(`Ontology ${ontologyId} not found for ${tenantId}:${workspaceId} (scope: ${scope})`);
            return `# Ontology ${ontologyId} not found\n`;
          }
          
          url = `${this.baseUrl}/repositories/${this.repository}/statements?context=${encodeURIComponent('<' + targetOntology.graphIRI + '>')}`;
        } else {
          // Export all ontologies
          const ontologies = await this.listOntologies(tenantId, workspaceId, scope);
          if (ontologies.length === 0) {
            logger.warn(`No ontologies found for ${tenantId}:${workspaceId} (scope: ${scope})`);
            return `# No ontologies found\n`;
          }
          
          const contexts = ontologies.map(ont => encodeURIComponent('<' + ont.graphIRI + '>')).join('&context=');
          url = `${this.baseUrl}/repositories/${this.repository}/statements?context=${contexts}`;
        }
      }
      
      logger.info(`Exporting ${graphType}${ontologyId ? ` (${ontologyId})` : ''} from GraphDB`);
      
      const response = await this._fetchWithPool(url, {
        headers: {
          'Accept': 'application/x-turtle'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`GraphDB export failed: ${response.status} - ${errorText}`);
        throw new Error(`GraphDB export failed: ${response.status}`);
      }

      const turtle = await response.text();
      
      // If empty, return a minimal valid turtle document
      if (!turtle || turtle.trim().length === 0) {
        logger.warn(`No data found in ${graphType} graph for ${tenantId}:${workspaceId}`);
        return `# Empty ${graphType} graph for ${tenantId}:${workspaceId}\n`;
      }
      
      return turtle;

    } catch (error) {
      logger.error(`Failed to export from GraphDB: ${error.message}`);
      throw error;
    }
  }

  /**
   * Export only schema (ontology definitions)
   */
  async exportSchemaOnly(tenantId, workspaceId) {
    return this.exportTurtle(tenantId, workspaceId, 'schema');
  }

  /**
   * Export only instance data
   */
  async exportDataOnly(tenantId, workspaceId) {
    return this.exportTurtle(tenantId, workspaceId, 'data');
  }

  /**
   * Export both schema and data
   */
  async exportAll(tenantId, workspaceId) {
    return this.exportTurtle(tenantId, workspaceId, 'all');
  }

  /**
   * Fix common SPARQL syntax errors from LLM generation
   */
  fixSparqlSyntax(query) {
    let fixed = query;
    
    // Fix invalid prefixed names with dots (e.g., Party.Complaint -> Party:Complaint)
    // Only match PascalCase.PascalCase patterns not inside <URIs>
    fixed = fixed.replace(/\b([A-Z][a-z][A-Za-z0-9]*)\.([A-Z][a-z][A-Za-z0-9]*)\b/g, '$1:$2');
    
    // Fix LIMIT/OFFSET inside WHERE clause - move them outside
    const limitInsideWhere = /(\}\s*)(LIMIT\s+\d+)/gi;
    const offsetInsideWhere = /(\}\s*)(OFFSET\s+\d+)/gi;
    
    // Check if LIMIT is before the closing brace of WHERE
    const whereMatch = fixed.match(/WHERE\s*\{[\s\S]*?\}/i);
    if (whereMatch) {
      const whereClause = whereMatch[0];
      const limitMatch = whereClause.match(/LIMIT\s+\d+/i);
      const offsetMatch = whereClause.match(/OFFSET\s+\d+/i);
      
      if (limitMatch || offsetMatch) {
        // Remove LIMIT/OFFSET from inside WHERE
        let cleanedWhere = whereClause
          .replace(/LIMIT\s+\d+/gi, '')
          .replace(/OFFSET\s+\d+/gi, '')
          .trim();
        
        // Rebuild query with LIMIT/OFFSET outside
        fixed = fixed.replace(whereMatch[0], cleanedWhere);
        if (limitMatch) fixed += `\n${limitMatch[0]}`;
        if (offsetMatch) fixed += `\n${offsetMatch[0]}`;
      }
    }
    
    return fixed;
  }

  /**
   * Execute SPARQL SELECT query with multi-tenant support
   * @param {string} graphType - 'schema', 'data', or 'all'
   * @param {Object} options - Query options
   * @param {Array<string>} options.additionalWorkspaces - Additional workspace IDs for cross-workspace queries
   * @param {boolean} options.includeGlobalOntologies - Include global ontologies (default: true)
   * @param {boolean} options.includeTenantOntologies - Include tenant ontologies (default: true)
   */
  async executeSPARQL(tenantId, workspaceId, sparqlQuery, graphType = 'schema', options = {}) {
    try {
      const {
        additionalWorkspaces = [],
        includeGlobalOntologies = true,
        includeTenantOntologies = true,
        includeWorkspaceOntologies = false,
        specificGraphs = [],
        vkgGraphPattern = null
      } = options;

      let query = this.fixSparqlSyntax(sparqlQuery.trim());
      
      // Add FROM clause if not present
      if (!query.toLowerCase().includes('from') && !query.toLowerCase().includes('graph')) {
        const fromClauses = [];
        
        // Add global ontologies (shared across all tenants)
        if (includeGlobalOntologies && (graphType === 'schema' || graphType === 'all')) {
          const globalOntologies = await this.listOntologies(tenantId, workspaceId, 'global');
          for (const ont of globalOntologies) {
            fromClauses.push(`FROM <${ont.graphIRI}>`);
          }
        }
        
        // Add tenant-specific ontologies
        if (includeTenantOntologies && (graphType === 'schema' || graphType === 'all')) {
          const tenantOntologies = await this.listOntologies(tenantId, workspaceId, 'tenant');
          for (const ont of tenantOntologies) {
            fromClauses.push(`FROM <${ont.graphIRI}>`);
          }
        }
        
        // Add workspace data graph
        if (graphType === 'data' || graphType === 'all') {
          const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
          fromClauses.push(`FROM <${dataGraphIRI}>`);
          
          // Include deprecated schema graph so old data types still resolve
          const deprecatedGraphIRI = this.getDeprecatedGraphIRI(tenantId, workspaceId);
          fromClauses.push(`FROM <${deprecatedGraphIRI}>`);
          
          // Only add all workspace ontology graphs if no specific graphs were requested
          // When specificGraphs is provided (user selected a specific ontology in UI),
          // we only want data graph + that specific ontology graph
          if (specificGraphs.length === 0) {
            try {
              const workspaceOntologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
              for (const ont of workspaceOntologies) {
                if (!fromClauses.some(f => f.includes(ont.graphIRI))) {
                  fromClauses.push(`FROM <${ont.graphIRI}>`);
                }
              }
            } catch (e) {
              logger.warn('Could not list workspace ontologies for FROM clauses:', e.message);
            }
          }
          
          // Add additional workspaces for cross-workspace queries
          for (const wsId of additionalWorkspaces) {
            const additionalDataGraph = this.getDataGraphIRI(tenantId, wsId);
            fromClauses.push(`FROM <${additionalDataGraph}>`);
          }

          // Also include audit graph for change tracking data
          const auditGraphIRI = this.getAuditGraphIRI(tenantId, workspaceId);
          fromClauses.push(`FROM <${auditGraphIRI}>`);
        }

        // Add workspace ontologies (opt-in for VKG queries that only need workspace scope)
        if (includeWorkspaceOntologies && (graphType === 'schema' || graphType === 'all')) {
          try {
            const workspaceOntologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
            for (const ont of workspaceOntologies) {
              if (!fromClauses.some(f => f.includes(ont.graphIRI))) {
                fromClauses.push(`FROM <${ont.graphIRI}>`);
              }
            }
          } catch (e) {
            logger.warn('Could not list workspace ontologies for schema FROM clauses:', e.message);
          }
        }

        // Add VKG-specific graphs (stored with workspace name instead of UUID in IRI)
        if (vkgGraphPattern && (graphType === 'schema' || graphType === 'all')) {
          try {
            const vkgGraphsQuery = `
              SELECT DISTINCT ?g WHERE {
                GRAPH ?g { ?s ?p ?o }
                FILTER(STRSTARTS(STR(?g), "${vkgGraphPattern}"))
              }
            `;
            const vkgResponse = await this._fetchWithPool(`${this.baseUrl}/repositories/${this.repository}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/sparql-query',
                'Accept': 'application/sparql-results+json'
              },
              body: vkgGraphsQuery
            });
            if (vkgResponse.ok) {
              const vkgResults = await vkgResponse.json();
              for (const binding of (vkgResults.results?.bindings || [])) {
                const gIRI = binding.g?.value;
                if (gIRI && !fromClauses.some(f => f.includes(gIRI))) {
                  fromClauses.push(`FROM <${gIRI}>`);
                }
              }
            }
          } catch (e) {
            logger.warn('Could not discover VKG graphs:', e.message);
          }
        }
        
        // Add specific graphs (e.g., selected ontology graph from UI)
        for (const graphIri of specificGraphs) {
          if (!fromClauses.some(f => f.includes(graphIri))) {
            fromClauses.push(`FROM <${graphIri}>`);
          }
        }
        
        const fromClause = fromClauses.join('\n') + '\n';
        
        if (process.env.DEBUG_SPARQL === 'true') {
          logger.info(`📋 SPARQL FROM clauses (${fromClauses.length}):\n${fromClauses.join('\n')}`);
        }
        
        // Insert FROM clause before WHERE
        query = query.replace(/WHERE\s*{/i, `${fromClause}WHERE {`);
      }

      const url = `${this.baseUrl}/repositories/${this.repository}`;
      
      if (process.env.DEBUG_SPARQL === 'true') {
        console.log('DEBUG executeSPARQL query:', query.substring(0, 800));
      }
      
      const response = await this._fetchWithPool(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: query
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`SPARQL query failed: ${response.status} - ${error}`);
      }

      const results = await response.json();
      logger.debug(`SPARQL returned ${results?.results?.bindings?.length || 0} bindings`);
      return results;

    } catch (error) {
      logger.error(`SPARQL query failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all OWL classes
   */
  async getClasses(tenantId, workspaceId, options = {}) {
    const query = `
      PREFIX owl: <${OWL}>
      PREFIX rdfs: <${RDFS}>
      PREFIX rdf: <${RDF}>
      
      SELECT ?class ?label ?comment
      WHERE {
        ?class rdf:type owl:Class .
        OPTIONAL { ?class rdfs:label ?label }
        OPTIONAL { ?class rdfs:comment ?comment }
      }
    `;

    const results = await this.executeSPARQL(tenantId, workspaceId, query, 'schema', options);
    
    return results.results.bindings.map(binding => ({
      iri: binding.class.value,
      label: binding.label?.value || this.extractLocalName(binding.class.value),
      comment: binding.comment?.value || null,
      superClasses: [] // Would need separate query
    }));
  }

  /**
   * Get all object properties
   */
  async getObjectProperties(tenantId, workspaceId, options = {}) {
    const query = `
      PREFIX owl: <${OWL}>
      PREFIX rdfs: <${RDFS}>
      PREFIX rdf: <${RDF}>
      
      SELECT ?prop ?label ?comment ?domain ?range
      WHERE {
        ?prop rdf:type owl:ObjectProperty .
        OPTIONAL { ?prop rdfs:label ?label }
        OPTIONAL { ?prop rdfs:comment ?comment }
        OPTIONAL { ?prop rdfs:domain ?domain }
        OPTIONAL { ?prop rdfs:range ?range }
      }
    `;

    const results = await this.executeSPARQL(tenantId, workspaceId, query, 'schema', options);
    
    // Group by property
    const propsMap = new Map();
    
    for (const binding of results.results.bindings) {
      const iri = binding.prop.value;
      
      if (!propsMap.has(iri)) {
        propsMap.set(iri, {
          iri,
          label: binding.label?.value || this.extractLocalName(iri),
          comment: binding.comment?.value || null,
          domain: [],
          range: []
        });
      }
      
      const prop = propsMap.get(iri);
      if (binding.domain && !prop.domain.includes(binding.domain.value)) {
        prop.domain.push(binding.domain.value);
      }
      if (binding.range && !prop.range.includes(binding.range.value)) {
        prop.range.push(binding.range.value);
      }
    }
    
    return Array.from(propsMap.values());
  }

  /**
   * Get all data properties
   */
  async getDataProperties(tenantId, workspaceId, options = {}) {
    const query = `
      PREFIX owl: <${OWL}>
      PREFIX rdfs: <${RDFS}>
      PREFIX rdf: <${RDF}>
      
      SELECT ?prop ?label ?comment ?domain ?range
      WHERE {
        ?prop rdf:type owl:DatatypeProperty .
        OPTIONAL { ?prop rdfs:label ?label }
        OPTIONAL { ?prop rdfs:comment ?comment }
        OPTIONAL { ?prop rdfs:domain ?domain }
        OPTIONAL { ?prop rdfs:range ?range }
      }
    `;

    const results = await this.executeSPARQL(tenantId, workspaceId, query, 'schema', options);
    
    const propsMap = new Map();
    
    for (const binding of results.results.bindings) {
      const iri = binding.prop.value;
      
      if (!propsMap.has(iri)) {
        propsMap.set(iri, {
          iri,
          label: binding.label?.value || this.extractLocalName(iri),
          comment: binding.comment?.value || null,
          domain: [],
          range: []
        });
      }
      
      const prop = propsMap.get(iri);
      if (binding.domain && !prop.domain.includes(binding.domain.value)) {
        prop.domain.push(binding.domain.value);
      }
      if (binding.range && !prop.range.includes(binding.range.value)) {
        prop.range.push(binding.range.value);
      }
    }
    
    return Array.from(propsMap.values());
  }

  /**
   * Get ontology metadata
   */
  async getOntologyMetadata(tenantId, workspaceId, ontologyIRI) {
    const query = `
      PREFIX owl: <${OWL}>
      PREFIX rdfs: <${RDFS}>
      
      SELECT ?label ?comment ?versionInfo
      WHERE {
        <${ontologyIRI}> a owl:Ontology .
        OPTIONAL { <${ontologyIRI}> rdfs:label ?label }
        OPTIONAL { <${ontologyIRI}> rdfs:comment ?comment }
        OPTIONAL { <${ontologyIRI}> owl:versionInfo ?versionInfo }
      }
    `;

    const results = await this.executeSPARQL(tenantId, workspaceId, query);
    
    if (results.results.bindings.length === 0) {
      return {
        iri: ontologyIRI,
        label: null,
        comment: null,
        versionInfo: null,
        imports: []
      };
    }

    const binding = results.results.bindings[0];
    
    return {
      iri: ontologyIRI,
      label: binding.label?.value || null,
      comment: binding.comment?.value || null,
      versionInfo: binding.versionInfo?.value || null,
      imports: []
    };
  }

  /**
   * List all ontologies (global + tenant-specific)
   * @param {string} scope - 'global', 'tenant', 'workspace', or 'all'
   */
  async listOntologies(tenantId, workspaceId, scope = 'all') {
    try {
      const url = `${this.baseUrl}/repositories/${this.repository}`;
      const ontologies = [];

      // Build filter based on scope
      let filters = [];
      
      if (scope === 'global' || scope === 'all') {
        filters.push('STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/global/ontology")');
      }
      
      if (scope === 'tenant' || scope === 'all') {
        filters.push(`STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${tenantId}/ontology")`);
      }
      
      if (scope === 'workspace' || scope === 'all') {
        filters.push(`STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology")`);
      }

      const filterClause = filters.length > 0 ? `FILTER(${filters.join(' || ')})` : '';

      // Query all graphs to find ontologies
      const graphsQuery = `
        SELECT DISTINCT ?g
        WHERE {
          GRAPH ?g {
            ?ont a <http://www.w3.org/2002/07/owl#Ontology> .
          }
          ${filterClause}
        }
      `;

      const response = await this._fetchWithPool(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: graphsQuery
      });

      if (!response.ok) {
        logger.warn('Could not list ontology graphs');
        return [];
      }

      const results = await response.json();
      logger.debug(`GraphDB returned ${results.results.bindings.length} ontology graphs`);

      // For each graph, get the ontology metadata
      for (const binding of results.results.bindings) {
        const graphIRI = binding.g.value;
        
        // Determine scope from graph IRI
        let ontologyScope = 'workspace';
        if (graphIRI.includes('/global/ontology/')) {
          ontologyScope = 'global';
        } else if (graphIRI.match(/\/tenant\/[^/]+\/ontology\//)) {
          ontologyScope = 'tenant';
        } else if (graphIRI.match(/\/tenant\/[^/]+\/workspace\/[^/]+\/ontology\//)) {
          ontologyScope = 'workspace';
        }
        
        const ontQuery = `
          PREFIX owl: <${OWL}>
          PREFIX rdfs: <${RDFS}>
          
          SELECT DISTINCT ?ontology ?label ?comment ?versionInfo
          FROM <${graphIRI}>
          WHERE {
            ?ontology a owl:Ontology .
            OPTIONAL { ?ontology rdfs:label ?label }
            OPTIONAL { ?ontology rdfs:comment ?comment }
            OPTIONAL { ?ontology owl:versionInfo ?versionInfo }
          }
        `;

        const ontResponse = await this._fetchWithPool(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sparql-query',
            'Accept': 'application/sparql-results+json'
          },
          body: ontQuery
        });

        if (ontResponse.ok) {
          const ontResults = await ontResponse.json();
          logger.debug(`Graph ${graphIRI} has ${ontResults.results.bindings.length} ontology entries`);
          
          // Fetch counts separately to avoid cross-product issues with OPTIONAL aggregation
          let classCount = 0, objectPropertyCount = 0, dataPropertyCount = 0;
          try {
            const countsQuery = `
              PREFIX owl: <${OWL}>
              PREFIX rdf: <${RDF}>
              SELECT 
                (COUNT(DISTINCT ?class) AS ?classCount)
                (COUNT(DISTINCT ?objProp) AS ?objPropCount)
                (COUNT(DISTINCT ?dataProp) AS ?dataPropCount)
                (COUNT(DISTINCT ?untypedProp) AS ?untypedPropCount)
              FROM <${graphIRI}>
              WHERE {
                { ?class a owl:Class } UNION
                { ?objProp a owl:ObjectProperty } UNION
                { ?dataProp a owl:DatatypeProperty } UNION
                { ?untypedProp a rdf:Property .
                  FILTER NOT EXISTS { ?untypedProp a owl:ObjectProperty }
                  FILTER NOT EXISTS { ?untypedProp a owl:DatatypeProperty }
                }
              }
            `;
            const countsResponse = await this._fetchWithPool(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/sparql-query',
                'Accept': 'application/sparql-results+json'
              },
              body: countsQuery
            });
            if (countsResponse.ok) {
              const countsData = await countsResponse.json();
              const cb = countsData.results?.bindings?.[0];
              if (cb) {
                classCount = parseInt(cb.classCount?.value || '0', 10);
                objectPropertyCount = parseInt(cb.objPropCount?.value || '0', 10);
                dataPropertyCount = parseInt(cb.dataPropCount?.value || '0', 10);
                // Untyped rdf:Property count — add to objectProperty as default
                const untypedCount = parseInt(cb.untypedPropCount?.value || '0', 10);
                objectPropertyCount += untypedCount;
              }
            }
          } catch (countErr) {
            logger.warn(`Could not fetch counts for graph ${graphIRI}:`, countErr.message);
          }

          for (const ont of ontResults.results.bindings) {
            let ontologyId = this.extractOntologyId(ont.ontology.value);
            
            // For workspace ontologies, extract ID from graph IRI as fallback
            if ((!ontologyId || ontologyId.startsWith('unknown-')) && ontologyScope === 'workspace') {
              const workspaceMatch = graphIRI.match(/\/ontology\/([^\/]+)$/);
              if (workspaceMatch) {
                ontologyId = workspaceMatch[1];
              }
            }
            
            // Final fallback if still no valid ID
            if (!ontologyId || ontologyId.startsWith('unknown-')) {
              ontologyId = `${ontologyScope}-${Date.now()}`;
              logger.warn(`Generated fallback ontology ID: ${ontologyId} for IRI: ${ont.ontology.value}`);
            }
            
            // Extract label with fallback to ontologyId
            const label = ont.label?.value || ontologyId;
            
            ontologies.push({
              iri: ont.ontology.value,
              label: label,
              comment: ont.comment?.value || null,
              versionInfo: ont.versionInfo?.value || null,
              graphIRI: graphIRI,
              ontologyId: ontologyId,
              scope: ontologyScope,
              classCount: classCount,
              propertyCount: dataPropertyCount + objectPropertyCount,
              relationshipCount: objectPropertyCount
            });
          }
        }
      }

      logger.debug(`Found ${ontologies.length} ontologies in GraphDB (scope: ${scope})`);
      return ontologies;
    } catch (error) {
      logger.error('Failed to list ontologies:', error);
      return [];
    }
  }

  /**
   * Store data with ontology version reference and auto-sync to Neo4j
   */
  async storeDataWithOntologyRef(tenantId, workspaceId, data, ontologyId, ontologyVersion) {
    try {
      const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
      
      // Add ontology reference metadata to each entity
      const dataWithRefs = data.map(triple => {
        if (triple.includes('a ')) { // Instance declaration
          return `${triple} ;\n  <http://purplefabric.ai/meta#usesOntology> "${ontologyId}" ;\n  <http://purplefabric.ai/meta#ontologyVersion> "${ontologyVersion}" .`;
        }
        return triple;
      }).join('\n');

      await this.importTurtle(tenantId, workspaceId, dataWithRefs, null, 'data');
      
      // Auto-sync to Neo4j
      try {
        const graphDBNeo4jSyncService = require('./graphDBNeo4jSyncService');
        await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId);
      } catch (syncError) {
        logger.warn('⚠️ Neo4j sync failed after data storage:', syncError.message);
      }
      
      return { success: true };

    } catch (error) {
      logger.error('Failed to store data with ontology reference:', error);
      throw error;
    }
  }

  /**
   * Query data with ontology version awareness
   */
  async queryWithOntologyVersion(tenantId, workspaceId, sparqlQuery) {
    try {
      // Get current ontology versions for workspace
      const ontologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
      
      // Build FROM clauses with version-aware graphs
      let fromClauses = [];
      for (const ont of ontologies) {
        fromClauses.push(`FROM <${ont.graphIRI}>`);
      }
      
      // Add data graph
      const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
      fromClauses.push(`FROM <${dataGraphIRI}>`);
      
      // Inject FROM clauses into query
      const enhancedQuery = sparqlQuery.replace(
        /WHERE\s*{/i,
        `${fromClauses.join('\n')}\nWHERE {`
      );

      return await this.executeSPARQL(tenantId, workspaceId, enhancedQuery);

    } catch (error) {
      logger.error('Failed to execute version-aware query:', error);
      throw error;
    }
  }
  async countTriples(tenantId, workspaceId, graphType = 'schema') {
    const query = `
      SELECT (COUNT(*) as ?count)
      WHERE {
        ?s ?p ?o .
      }
    `;

    const results = await this.executeSPARQL(tenantId, workspaceId, query, graphType);
    
    if (results.results.bindings.length > 0) {
      return parseInt(results.results.bindings[0].count.value);
    }
    
    return 0;
  }

  /**
   * Count triples in specific graph IRI
   */
  async countTriplesInGraph(graphIRI) {
    try {
      const query = `
        SELECT (COUNT(*) as ?count)
        FROM <${graphIRI}>
        WHERE {
          ?s ?p ?o .
        }
      `;

      const url = `${this.baseUrl}/repositories/${this.repository}`;
      
      const response = await this._fetchWithPool(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: query
      });

      if (!response.ok) {
        return 0;
      }

      const results = await response.json();
      
      if (results.results.bindings.length > 0) {
        return parseInt(results.results.bindings[0].count.value);
      }
      
      return 0;
    } catch (error) {
      logger.error(`Failed to count triples: ${error.message}`);
      return 0;
    }
  }

  /**
   * Clear graph
   * @param {string} graphType - 'schema', 'data', or 'all'
   */
  async clearGraph(tenantId, workspaceId, graphType = 'all') {
    try {
      const graphs = [];
      
      if (graphType === 'all' || graphType === 'schema') {
        graphs.push(this.getSchemaGraphIRI(tenantId, workspaceId));
      }
      
      if (graphType === 'all' || graphType === 'data') {
        graphs.push(this.getDataGraphIRI(tenantId, workspaceId));
        // Also clear audit graph when clearing data (audit tracks data changes)
        graphs.push(this.getAuditGraphIRI(tenantId, workspaceId));
      }

      const url = `${this.baseUrl}/repositories/${this.repository}/statements`;
      
      for (const graphIRI of graphs) {
        const updateQuery = `CLEAR GRAPH <${graphIRI}>`;
        
        const response = await this._fetchWithPool(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sparql-update'
          },
          body: updateQuery
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.warn(`⚠️  Could not clear graph ${graphIRI}: ${response.status} - ${errorText}`);
          // Don't throw - graph might not exist yet
          continue;
        }

        logger.info(`🗑️  Cleared GraphDB graph: ${graphIRI}`);
      }

    } catch (error) {
      logger.warn(`⚠️  Could not clear graph: ${error.message}`);
      // Don't throw - graph might not exist yet
    }
  }

  /**
   * Clear only instance data (keep schema)
   */
  async clearDataOnly(tenantId, workspaceId) {
    return this.clearGraph(tenantId, workspaceId, 'data');
  }

  /**
   * Clear only schema (keep data)
   */
  async clearSchemaOnly(tenantId, workspaceId) {
    return this.clearGraph(tenantId, workspaceId, 'schema');
  }

  /**
   * Clear both schema and data
   */
  async clearAll(tenantId, workspaceId) {
    return this.clearGraph(tenantId, workspaceId, 'all');
  }

  /**
   * Trigger reasoning (GraphDB-specific)
   */
  async triggerReasoning(tenantId, workspaceId) {
    // GraphDB performs reasoning automatically if repository is configured with reasoner
    // This is a placeholder for explicit reasoning triggers if needed
    logger.info(`🧠 GraphDB reasoning is automatic (configured in repository settings)`);
    
    return {
      message: 'GraphDB reasoning is automatic based on repository configuration',
      note: 'Configure reasoning in GraphDB Workbench: Repository Settings → Ruleset'
    };
  }

  /**
   * Extract local name from IRI
   */
  extractLocalName(iri) {
    const parts = iri.split(/[#/]/);
    return parts[parts.length - 1];
  }

  /**
   * Add triple
   * @param {string} graphType - 'schema' or 'data'
   */
  async addTriple(tenantId, workspaceId, subject, predicate, object, graphType = 'data') {
    const turtle = `<${subject}> <${predicate}> <${object}> .`;
    return this.importTurtle(tenantId, workspaceId, turtle, null, graphType);
  }

  /**
   * Check if schema exists in GraphDB
   */
  async hasSchema(tenantId, workspaceId) {
    const count = await this.countTriples(tenantId, workspaceId, 'schema');
    return count > 0;
  }

  /**
   * Check if global ontologies exist
   */
  async hasGlobalOntologies() {
    try {
      const ontologies = await this.listOntologies(null, null, 'global');
      return ontologies.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if data exists in GraphDB
   */
  async hasData(tenantId, workspaceId) {
    const count = await this.countTriples(tenantId, workspaceId, 'data');
    return count > 0;
  }

  /**
   * Get accessible workspace data graphs for a user
   * This should be integrated with your ACL/permission system
   * @param {string} userId - User identifier
   * @param {string} tenantId - Tenant identifier
   * @returns {Array<string>} Array of workspace IDs the user can access
   */
  async getAccessibleWorkspaces(userId, tenantId) {
    // TODO: Integrate with your ACL/permission system
    // For now, return empty array (only current workspace accessible)
    // In production, query your permission database
    logger.warn('getAccessibleWorkspaces not implemented - using empty array');
    return [];
  }

  /**
   * Execute cross-workspace query with ACL enforcement
   * @param {string} userId - User identifier for ACL check
   * @param {Array<string>} requestedWorkspaces - Workspace IDs to query
   */
  async executeCrossWorkspaceQuery(userId, tenantId, workspaceId, sparqlQuery, requestedWorkspaces = []) {
    // Get workspaces user has access to
    const accessibleWorkspaces = await this.getAccessibleWorkspaces(userId, tenantId);
    
    // Filter requested workspaces to only those user can access
    const allowedWorkspaces = requestedWorkspaces.filter(ws => 
      accessibleWorkspaces.includes(ws) || ws === workspaceId
    );
    
    if (allowedWorkspaces.length < requestedWorkspaces.length) {
      logger.warn(`User ${userId} requested access to ${requestedWorkspaces.length} workspaces but only has access to ${allowedWorkspaces.length}`);
    }
    
    // Execute query with allowed workspaces
    return this.executeSPARQL(tenantId, workspaceId, sparqlQuery, 'all', {
      additionalWorkspaces: allowedWorkspaces,
      includeGlobalOntologies: true,
      includeTenantOntologies: true
    });
  }

  /**
   * Pattern matching (basic SPARQL)
   */
  async getQuads(tenantId, workspaceId, subject, predicate, object) {
    let query = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o ';
    
    const filters = [];
    if (subject) filters.push(`FILTER(?s = <${subject}>)`);
    if (predicate) filters.push(`FILTER(?p = <${predicate}>)`);
    if (object) {
      if (object.startsWith('http')) {
        filters.push(`FILTER(?o = <${object}>)`);
      } else {
        filters.push(`FILTER(?o = "${object}")`);
      }
    }
    
    query += filters.join(' ') + ' }';
    
    const results = await this.executeSPARQL(tenantId, workspaceId, query);
    
    return results.results.bindings.map(b => ({
      subject: { value: b.s.value },
      predicate: { value: b.p.value },
      object: { value: b.o.value, termType: b.o.type === 'uri' ? 'NamedNode' : 'Literal' }
    }));
  }

  /**
   * Clean up duplicate workspace ontologies (keep only latest)
   */
  async cleanupWorkspaceDuplicates(tenantId, workspaceId) {
    try {
      // Get all workspace ontologies
      const workspaceOntologies = await this.listOntologies(tenantId, workspaceId, 'workspace');
      
      // Group by base ontology ID
      const groups = {};
      workspaceOntologies.forEach(ont => {
        const baseId = ont.ontologyId.replace(/-workspace-\d+$/, '');
        if (!groups[baseId]) groups[baseId] = [];
        groups[baseId].push(ont);
      });

      let removedCount = 0;

      // For each group, keep only the latest (highest timestamp)
      for (const [baseId, ontologies] of Object.entries(groups)) {
        if (ontologies.length > 1) {
          // Sort by ontologyId (contains timestamp)
          ontologies.sort((a, b) => b.ontologyId.localeCompare(a.ontologyId));
          
          // Remove all except the first (latest)
          for (let i = 1; i < ontologies.length; i++) {
            const ont = ontologies[i];
            const clearUrl = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(ont.graphIRI)}`;
            
            const response = await this._fetchWithPool(clearUrl, {
              method: 'DELETE',
              headers: { 'Accept': 'application/json' }
            });

            if (response.ok) {
              removedCount++;
              logger.info(`🗑️ Removed duplicate workspace ontology: ${ont.ontologyId}`);
            }
          }
        }
      }

      return { removedCount, totalGroups: Object.keys(groups).length };

    } catch (error) {
      logger.error('Failed to cleanup workspace duplicates:', error);
      throw error;
    }
  }

  /**
   * Clear all workspace ontologies and data
   */
  async clearWorkspaceData(tenantId, workspaceId) {
    try {
      let clearedGraphs = 0;
      
      // Get only graphs scoped to this specific tenant/workspace
      // IMPORTANT: Exclude the deprecated graph — it's an accumulation graph that
      // preserves removed schema definitions for backward-compatible SPARQL queries.
      const deprecatedGraphIRI = this.getDeprecatedGraphIRI(tenantId, workspaceId);
      const listQuery = `
        SELECT DISTINCT ?g
        WHERE {
          GRAPH ?g { ?s ?p ?o }
          FILTER(
            STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/")
            && STR(?g) != "${deprecatedGraphIRI}"
          )
        }
      `;

      const response = await this._fetchWithPool(`${this.baseUrl}/repositories/${this.repository}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: listQuery
      });

      if (response.ok) {
        const results = await response.json();
        
        // Clear each graph
        for (const binding of results.results.bindings) {
          const graphIRI = binding.g.value;
          
          const clearUrl = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
          
          const clearResponse = await this._fetchWithPool(clearUrl, {
            method: 'DELETE',
            headers: { 'Accept': 'application/json' }
          });

          if (clearResponse.ok) {
            clearedGraphs++;
            logger.info(`🗑️ Cleared GraphDB graph: ${graphIRI}`);
          }
        }
      }

      return { clearedGraphs };

    } catch (error) {
      logger.error('Failed to clear workspace data:', error);
      throw error;
    }
  }
  async clearDataGraphs(tenantId, workspaceId) {
    try {
      const dataGraphIRI = this.getDataGraphIRI(tenantId, workspaceId);
      
      // List all graphs to find data graphs
      const listQuery = `
        SELECT DISTINCT ?g
        WHERE {
          GRAPH ?g { ?s ?p ?o }
          FILTER(
            STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data") ||
            STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/versions")
          )
        }
      `;

      const response = await this._fetchWithPool(`${this.baseUrl}/repositories/${this.repository}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          'Accept': 'application/sparql-results+json'
        },
        body: listQuery
      });

      if (!response.ok) {
        throw new Error(`Failed to list data graphs: ${response.statusText}`);
      }

      const results = await response.json();
      let clearedGraphs = 0;

      // Clear each data graph
      for (const binding of results.results.bindings) {
        const graphIRI = binding.g.value;
        
        const clearUrl = `${this.baseUrl}/repositories/${this.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
        
        const clearResponse = await this._fetchWithPool(clearUrl, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });

        if (clearResponse.ok) {
          clearedGraphs++;
          logger.info(`🗑️ Cleared GraphDB data graph: ${graphIRI}`);
        }
      }

      return { clearedGraphs, totalFound: results.results.bindings.length };

    } catch (error) {
      logger.error('Failed to clear GraphDB data graphs:', error);
      throw error;
    }
  }
}

module.exports = new GraphDBStore();
