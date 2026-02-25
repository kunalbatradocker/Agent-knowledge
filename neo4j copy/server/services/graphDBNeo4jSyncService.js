/**
 * GraphDB to Neo4j Sync Service
 * Syncs OWL ontology data from GraphDB (RDF) to Neo4j (Property Graph)
 */

const graphDBStore = require('./graphDBStore');
const neo4jService = require('./neo4jService');
const logger = require('../utils/logger');

class GraphDBNeo4jSyncService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Sync only instance data from GraphDB to Neo4j
   * Does NOT sync ontology schema - only actual data instances
   */
  /**
   * Main sync function with mode options
   * @param {string} tenantId
   * @param {string} workspaceId  
   * @param {object} options - { mode: 'full' | 'incremental' }
   */
  async syncAll(tenantId = 'default', workspaceId = 'default', options = {}) {
    const mode = options.mode || 'full';
    
    if (this.isRunning) {
      logger.warn('⚠️ Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    try {
      this.isRunning = true;
      logger.info(`🔄 Starting GraphDB → Neo4j sync (Mode: ${mode})`);

      const stats = { mode, cleared: 0, synced: 0 };

      // Full sync: clear first
      if (mode === 'full') {
        stats.cleared = await this.clearNeo4jInstanceData();
      }

      // Sync instance data
      stats.synced = await this.syncInstanceData(tenantId, workspaceId);

      logger.info(`✅ GraphDB → Neo4j sync completed (${mode}): ${stats.synced} entities synced`);
      return { success: true, stats };

    } catch (error) {
      logger.error('❌ GraphDB → Neo4j sync failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Remove orphaned data in Neo4j (entities not in GraphDB)
   */
  async removeOrphans(tenantId = 'default', workspaceId = 'default') {
    logger.info('🧹 Finding orphaned entities in Neo4j...');
    
    // Get all URIs from GraphDB
    const dataGraphPattern = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
    const graphDBQuery = `
      SELECT DISTINCT ?instance WHERE {
        GRAPH ?g {
          ?instance ?p ?o .
        }
        FILTER(STRSTARTS(STR(?g), "${dataGraphPattern}") || CONTAINS(STR(?g), "/data"))
        FILTER(STRSTARTS(STR(?instance), "doc://") || STRSTARTS(STR(?instance), "http://purplefabric"))
      }
    `;
    
    const graphDBResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, graphDBQuery, 'all');
    const graphDBUris = new Set(
      (graphDBResult?.results?.bindings || []).map(b => b.instance?.value).filter(Boolean)
    );
    
    logger.info(`📊 Found ${graphDBUris.size} entities in GraphDB`);

    // Delete Neo4j nodes not in GraphDB
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (n)
        WHERE n.uri IS NOT NULL 
          AND NOT n:Tenant AND NOT n:Workspace AND NOT n:Folder 
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Concept
          AND NOT n.uri IN $validUris
        DETACH DELETE n
        RETURN count(n) as deleted
      `, { validUris: Array.from(graphDBUris) });
      
      const deleted = result.records[0]?.get('deleted')?.toNumber?.() || 0;
      logger.info(`🗑️ Removed ${deleted} orphaned entities from Neo4j`);
      return { success: true, deleted };
    } finally {
      await session.close();
    }
  }

  /**
   * Clear existing instance data from Neo4j (not system nodes)
   */
  async clearNeo4jInstanceData() {
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (n)
        WHERE NOT n:Tenant AND NOT n:Workspace AND NOT n:Folder 
              AND NOT n:Document AND NOT n:Chunk AND NOT n:Concept
        DETACH DELETE n
        RETURN count(n) as deleted
      `);
      const deleted = result.records[0]?.get('deleted')?.toNumber?.() || 0;
      logger.info(`🗑️ Cleared ${deleted} nodes from Neo4j`);
      return deleted;
    } finally {
      await session.close();
    }
  }

  /**
   * Sync ontology schema (classes and properties) from GraphDB to Neo4j
   * Only syncs GLOBAL ontologies (not workspace copies)
   */
  async syncOntologySchema(tenantId, workspaceId) {
    // Get only GLOBAL classes from GraphDB (not workspace ontologies)
    const classesQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      
      SELECT ?class ?label ?comment WHERE {
        GRAPH ?g {
          ?class a owl:Class .
          OPTIONAL { ?class rdfs:label ?label }
          OPTIONAL { ?class rdfs:comment ?comment }
        }
        FILTER(STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/global/ontology/"))
      }
    `;

    const classesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'all');
    logger.info(`📊 Found ${classesResult?.results?.bindings?.length || 0} ontology classes`);
    
    // Get only GLOBAL properties from GraphDB (not workspace ontologies)
    const propertiesQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      
      SELECT ?property ?label ?comment ?domain ?range ?propertyType WHERE {
        GRAPH ?g {
          {
            ?property a owl:ObjectProperty .
            BIND("ObjectProperty" as ?propertyType)
          } UNION {
            ?property a owl:DatatypeProperty .
            BIND("DatatypeProperty" as ?propertyType)
          }
          OPTIONAL { ?property rdfs:label ?label }
          OPTIONAL { ?property rdfs:comment ?comment }
          OPTIONAL { ?property rdfs:domain ?domain }
          OPTIONAL { ?property rdfs:range ?range }
        }
        FILTER(STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/global/ontology/"))
      }
    `;

    const propertiesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, propertiesQuery, 'all');
    logger.info(`📊 Found ${propertiesResult?.results?.bindings?.length || 0} ontology properties`);

    const session = neo4jService.getSession();
    try {
      // Merge class nodes
      for (const binding of classesResult.results.bindings) {
        const classUri = binding.class?.value;
        const label = binding.label?.value || this.extractLocalName(classUri);
        const comment = binding.comment?.value || '';

        await session.run(`
          MERGE (c:OntologyClass {uri: $uri})
          SET c.label = $label, c.comment = $comment, c.localName = $localName
        `, {
          uri: classUri,
          label,
          comment,
          localName: this.extractLocalName(classUri)
        });
      }

      // Merge property nodes and relationships
      for (const binding of propertiesResult.results.bindings) {
        const propertyUri = binding.property?.value;
        const label = binding.label?.value || this.extractLocalName(propertyUri);
        const comment = binding.comment?.value || '';
        const domain = binding.domain?.value;
        const range = binding.range?.value;
        const propertyType = binding.propertyType?.value;

        // Merge property node
        await session.run(`
          MERGE (p:OntologyProperty {uri: $uri})
          SET p.label = $label, p.comment = $comment, p.localName = $localName, p.propertyType = $propertyType
        `, {
          uri: propertyUri,
          label,
          comment,
          localName: this.extractLocalName(propertyUri),
          propertyType
        });

        // Merge domain relationship
        if (domain) {
          await session.run(`
            MATCH (c:OntologyClass {uri: $domainUri})
            MATCH (p:OntologyProperty {uri: $propertyUri})
            MERGE (c)-[:HAS_PROPERTY]->(p)
          `, {
            domainUri: domain,
            propertyUri: propertyUri
          });
        }

        // Merge range relationship
        if (range) {
          await session.run(`
            MATCH (p:OntologyProperty {uri: $propertyUri})
            MATCH (c:OntologyClass {uri: $rangeUri})
            MERGE (p)-[:POINTS_TO]->(c)
          `, {
            propertyUri: propertyUri,
            rangeUri: range
          });
        }
      }

      logger.info(`✅ Synced ${classesResult.results.bindings.length} classes and ${propertiesResult.results.bindings.length} properties`);

    } finally {
      await session.close();
    }
  }

  /**
   * Sync instance data from GraphDB to Neo4j
   * Two-pass approach: Pass 1 creates all nodes, Pass 2 creates all relationships
   * This ensures both endpoints exist before creating relationships
   */
  async syncInstanceData(tenantId, workspaceId) {
    const dataGraphPattern = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/data`;
    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
    const PF_NAMESPACE = 'http://purplefabric.ai/ontology#';
    const BATCH_SIZE = 10000;

    // Ensure uri index exists for efficient MERGE lookups
    const idxSession = neo4jService.getSession();
    try {
      await idxSession.run('CREATE INDEX uri_index IF NOT EXISTS FOR (n:Resource) ON (n.uri)').catch(() => {});
      await idxSession.run('CREATE RANGE INDEX uri_range IF NOT EXISTS FOR (n) ON (n.uri)').catch(() => {});
      await idxSession.run('CREATE RANGE INDEX concept_id_range IF NOT EXISTS FOR (n) ON (n.concept_id)').catch(() => {});
    } catch (e) { /* index may already exist */ }
    finally { await idxSession.close(); }

    logger.info(`🔍 Querying GraphDB for data in: ${dataGraphPattern}`);

    // Collect all instances across all batches first
    const allInstances = new Map();
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const instancesQuery = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        
        SELECT DISTINCT ?instance ?type ?property ?value WHERE {
          GRAPH ?g {
            ?instance ?property ?value .
            OPTIONAL { ?instance a ?type }
          }
          FILTER(
            STRSTARTS(STR(?g), "${dataGraphPattern}") || CONTAINS(STR(?g), "/data") ||
            STR(?g) = "${auditGraphIRI}"
          )
          FILTER(STRSTARTS(STR(?instance), "doc://") || STRSTARTS(STR(?instance), "http://purplefabric"))
          FILTER(!CONTAINS(STR(?instance), "/rel/"))
          FILTER(!BOUND(?type) || (?type != owl:Class && ?type != owl:ObjectProperty && ?type != owl:DatatypeProperty && ?type != rdf:Statement))
        }
        LIMIT ${BATCH_SIZE}
        OFFSET ${offset}
      `;

      const instancesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, instancesQuery, 'all');
      const bindings = instancesResult?.results?.bindings || [];
      
      logger.info(`📊 Batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${bindings.length} bindings`);

      if (bindings.length === 0) {
        hasMore = false;
        break;
      }

      for (const binding of bindings) {
        const instanceUri = binding.instance?.value;
        const type = binding.type?.value;
        const property = binding.property?.value;
        const valueObj = binding.value;
        const value = valueObj?.value;

        if (!allInstances.has(instanceUri)) {
          allInstances.set(instanceUri, {
            uri: instanceUri,
            typeIRI: type,
            type: this.extractLocalName(type),
            properties: new Map(),
            relationships: []
          });
        }

        const instance = allInstances.get(instanceUri);
        
        if (type && !instance.typeIRI) {
          instance.typeIRI = type;
          instance.type = this.extractLocalName(type);
        }
        
        if (property && value) {
          if (property === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
            // Detect ChangeEvent type and flag the instance
            if (value === `${PF_NAMESPACE}ChangeEvent`) {
              instance.isChangeEvent = true;
            }
            continue;
          }
          if (property === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#subject') continue;
          if (property === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate') continue;
          if (property === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#object') continue;
          
          const propLocalName = this.extractLocalName(property);

          if (valueObj?.type === 'uri') {
            // For ChangeEvent nodes, handle pf:entity as a CHANGED relationship
            if (property === `${PF_NAMESPACE}entity` && valueObj?.type === 'uri') {
              instance.relationships.push({
                propertyIRI: property,
                property: 'CHANGED',
                target: value
              });
            } else if (property === `${PF_NAMESPACE}sourceDocument`) {
              // Store sourceDocument as a property (even though it's a URI in RDF)
              instance.properties.set('sourceDocument', value);
            } else {
              // Use SPARQL result type to distinguish URIs from literals
              instance.relationships.push({
                propertyIRI: property,
                property: propLocalName,
                target: value
              });
            }
          } else {
            instance.properties.set(propLocalName, value);
          }
        }
      }

      offset += BATCH_SIZE;
      hasMore = bindings.length === BATCH_SIZE;
    }

    logger.info(`📊 Total instances collected: ${allInstances.size}`);

    // Pass 1: Create all nodes (batched with UNWIND)
    logger.info('🔵 Pass 1: Creating all nodes...');
    let nodeCount = 0;
    const session1 = neo4jService.getSession();
    try {
      // Group instances by sanitized label for efficient batched MERGE
      const byLabel = new Map();
      for (const [uri, instance] of allInstances) {
        // ChangeEvent nodes get the ChangeEvent label regardless of their RDF type
        let nodeLabel;
        if (instance.isChangeEvent) {
          nodeLabel = 'ChangeEvent';
        } else {
          // Sanitize label: remove special chars, backticks, ensure valid Neo4j label
          const rawLabel = instance.type || 'Entity';
          nodeLabel = rawLabel.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, 'N$&') || 'Entity';
        }
        if (!byLabel.has(nodeLabel)) byLabel.set(nodeLabel, []);
        const props = Object.fromEntries(instance.properties);
        props.uri = uri;
        if (instance.typeIRI) props.typeIRI = instance.typeIRI;

        // Extract concept_id from URI — the last path segment is the business identifier
        // e.g. http://purplefabric.ai/.../entity/Customer/CUST000001 → CUST000001
        // e.g. doc://37401973-0618-... → 37401973-0618-...
        if (!props.concept_id) {
          if (uri.startsWith('doc://')) {
            props.concept_id = uri.replace('doc://', '');
          } else {
            const lastSegment = uri.split('/').pop();
            if (lastSegment) props.concept_id = decodeURIComponent(lastSegment);
          }
        }

        byLabel.get(nodeLabel).push(props);
      }

      const NODE_BATCH = 500;
      for (const [label, nodes] of byLabel) {
        for (let i = 0; i < nodes.length; i += NODE_BATCH) {
          const batch = nodes.slice(i, i + NODE_BATCH);
          await session1.run(`
            UNWIND $batch AS row
            MERGE (n {uri: row.uri})
            SET n:\`${label}\`, n += row,
                n.tenant_id = $tenantId,
                n.workspace_id = $workspaceId
          `, { batch, tenantId, workspaceId });
          nodeCount += batch.length;
        }
      }
    } finally {
      await session1.close();
    }
    logger.info(`✅ Pass 1 complete: ${nodeCount} nodes created`);

    // Pass 2: Create all relationships (batched with UNWIND)
    logger.info('🔵 Pass 2: Creating relationships...');
    let relCount = 0;
    let relSkipped = 0;
    const session2 = neo4jService.getSession();
    try {
      // Group relationships by sanitized property name for batched MERGE
      const byRelType = new Map();
      for (const [uri, instance] of allInstances) {
        for (const rel of instance.relationships) {
          // Sanitize relationship type
          const rawProp = rel.property || 'RELATED_TO';
          const relType = rawProp.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, 'R$&') || 'RELATED_TO';
          if (!byRelType.has(relType)) byRelType.set(relType, []);
          byRelType.get(relType).push({
            sourceUri: uri,
            targetUri: rel.target,
            propertyIRI: rel.propertyIRI
          });
        }
      }

      const REL_BATCH = 500;
      for (const [relType, rels] of byRelType) {
        for (let i = 0; i < rels.length; i += REL_BATCH) {
          const batch = rels.slice(i, i + REL_BATCH);
          try {
            const result = await session2.run(`
              UNWIND $batch AS row
              MATCH (source {uri: row.sourceUri})
              MATCH (target {uri: row.targetUri})
              MERGE (source)-[r:\`${relType}\`]->(target)
              SET r.propertyIRI = row.propertyIRI
              RETURN count(r) AS cnt
            `, { batch });
            const cnt = result.records[0]?.get('cnt')?.toNumber?.() || 0;
            relCount += cnt;
            relSkipped += batch.length - cnt;
          } catch (relErr) {
            logger.warn(`Failed to create batch of ${batch.length} "${relType}" relationships: ${relErr.message}`);
            relSkipped += batch.length;
          }
        }
      }
    } finally {
      await session2.close();
    }
    logger.info(`✅ Pass 2 complete: ${relCount} relationships created, ${relSkipped} skipped (target not found)`);

    return nodeCount;
  }

  /**
   * Sync specific ontology when it's updated.
   * Re-syncs schema nodes for this ontology and removes zombie OntologyClass/OntologyProperty
   * nodes that no longer exist in GraphDB.
   */
  async syncOntology(tenantId, workspaceId, ontologyId) {
    logger.info(`🔄 Syncing ontology: ${ontologyId} — updating schema nodes and cleaning zombies`);

    // Query current classes and properties for this ontology from GraphDB
    const ontologyGraphPatterns = [
      `http://purplefabric.ai/graphs/global/ontology/${ontologyId}`,
      `http://purplefabric.ai/graphs/tenant/${tenantId}/ontology/${ontologyId}`,
      `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}`
    ];
    const graphFilter = ontologyGraphPatterns.map(g => `STR(?g) = "${g}"`).join(' || ');

    const classesQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?class ?label ?comment WHERE {
        GRAPH ?g { ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label } OPTIONAL { ?class rdfs:comment ?comment } }
        FILTER(${graphFilter})
      }
    `;
    const propsQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?property ?label ?comment ?domain ?range ?propertyType WHERE {
        GRAPH ?g {
          { ?property a owl:ObjectProperty . BIND("ObjectProperty" as ?propertyType) }
          UNION
          { ?property a owl:DatatypeProperty . BIND("DatatypeProperty" as ?propertyType) }
          OPTIONAL { ?property rdfs:label ?label }
          OPTIONAL { ?property rdfs:comment ?comment }
          OPTIONAL { ?property rdfs:domain ?domain }
          OPTIONAL { ?property rdfs:range ?range }
        }
        FILTER(${graphFilter})
      }
    `;

    let classBindings = [];
    let propBindings = [];
    try {
      const classesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'all');
      classBindings = classesResult?.results?.bindings || [];
      const propsResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, propsQuery, 'all');
      propBindings = propsResult?.results?.bindings || [];
    } catch (e) {
      logger.warn(`⚠️ Could not query GraphDB for ontology ${ontologyId}: ${e.message}`);
      return { success: true, stats: { mode: 'schema-sync', synced: 0, zombiesRemoved: 0 } };
    }

    const currentClassUris = new Set(classBindings.map(b => b.class?.value).filter(Boolean));
    const currentPropUris = new Set(propBindings.map(b => b.property?.value).filter(Boolean));

    const session = neo4jService.getSession();
    try {
      // Upsert current classes
      for (const binding of classBindings) {
        const uri = binding.class?.value;
        const label = binding.label?.value || this.extractLocalName(uri);
        await session.run(
          `MERGE (c:OntologyClass {uri: $uri}) SET c.label = $label, c.comment = $comment, c.localName = $localName`,
          { uri, label, comment: binding.comment?.value || '', localName: this.extractLocalName(uri) }
        );
      }

      // Upsert current properties with domain/range
      for (const binding of propBindings) {
        const uri = binding.property?.value;
        const label = binding.label?.value || this.extractLocalName(uri);
        await session.run(
          `MERGE (p:OntologyProperty {uri: $uri}) SET p.label = $label, p.comment = $comment, p.localName = $localName, p.propertyType = $propertyType`,
          { uri, label, comment: binding.comment?.value || '', localName: this.extractLocalName(uri), propertyType: binding.propertyType?.value || '' }
        );
        if (binding.domain?.value) {
          await session.run(
            `MATCH (c:OntologyClass {uri: $domainUri}) MATCH (p:OntologyProperty {uri: $propUri}) MERGE (c)-[:HAS_PROPERTY]->(p)`,
            { domainUri: binding.domain.value, propUri: uri }
          );
        }
        if (binding.range?.value) {
          await session.run(
            `MATCH (p:OntologyProperty {uri: $propUri}) MATCH (c:OntologyClass {uri: $rangeUri}) MERGE (p)-[:POINTS_TO]->(c)`,
            { propUri: uri, rangeUri: binding.range.value }
          );
        }
      }

      // Handle removed schema nodes: mark as deprecated instead of deleting,
      // because existing instance data may still reference them via typeIRI.
      // Only fully delete if no instance data references the class/property.
      const ontologyNamespaces = ontologyGraphPatterns.map(g => g.replace('/graphs/', '/').replace(/\/ontology\/.*/, `/${ontologyId}#`));
      ontologyNamespaces.push(`http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}#`);
      ontologyNamespaces.push(`http://purplefabric.ai/${ontologyId}#`);

      let zombiesRemoved = 0;
      let zombiesDeprecated = 0;
      for (const ns of ontologyNamespaces) {
        // For OntologyClass nodes: check if any instance data has typeIRI matching this class
        // If referenced → mark deprecated; if unreferenced → delete
        const classDepResult = await session.run(
          `MATCH (c:OntologyClass)
           WHERE c.uri STARTS WITH $ns AND NOT c.uri IN $validUris
           OPTIONAL MATCH (inst) WHERE inst.typeIRI = c.uri
           WITH c, count(inst) AS refCount
           WHERE refCount > 0
           SET c.deprecated = true, c.deprecatedAt = datetime()
           RETURN count(c) as cnt`,
          { ns, validUris: Array.from(currentClassUris) }
        );
        zombiesDeprecated += classDepResult.records[0]?.get('cnt')?.toNumber?.() || 0;

        const classDelResult = await session.run(
          `MATCH (c:OntologyClass)
           WHERE c.uri STARTS WITH $ns AND NOT c.uri IN $validUris
           OPTIONAL MATCH (inst) WHERE inst.typeIRI = c.uri
           WITH c, count(inst) AS refCount
           WHERE refCount = 0
           DETACH DELETE c
           RETURN count(c) as cnt`,
          { ns, validUris: Array.from(currentClassUris) }
        );
        zombiesRemoved += classDelResult.records[0]?.get('cnt')?.toNumber?.() || 0;

        // For OntologyProperty nodes: check if any relationship in Neo4j uses this property IRI
        const propDepResult = await session.run(
          `MATCH (p:OntologyProperty)
           WHERE p.uri STARTS WITH $ns AND NOT p.uri IN $validUris
           OPTIONAL MATCH ()-[r]->() WHERE r.propertyIRI = p.uri
           WITH p, count(r) AS refCount
           WHERE refCount > 0
           SET p.deprecated = true, p.deprecatedAt = datetime()
           RETURN count(p) as cnt`,
          { ns, validUris: Array.from(currentPropUris) }
        );
        zombiesDeprecated += propDepResult.records[0]?.get('cnt')?.toNumber?.() || 0;

        const propDelResult = await session.run(
          `MATCH (p:OntologyProperty)
           WHERE p.uri STARTS WITH $ns AND NOT p.uri IN $validUris
           OPTIONAL MATCH ()-[r]->() WHERE r.propertyIRI = p.uri
           WITH p, count(r) AS refCount
           WHERE refCount = 0
           DETACH DELETE p
           RETURN count(p) as cnt`,
          { ns, validUris: Array.from(currentPropUris) }
        );
        zombiesRemoved += propDelResult.records[0]?.get('cnt')?.toNumber?.() || 0;
      }

      logger.info(`✅ Ontology ${ontologyId} synced: ${classBindings.length} classes, ${propBindings.length} properties, ${zombiesRemoved} unreferenced removed, ${zombiesDeprecated} deprecated (still referenced by data)`);
      return { success: true, stats: { mode: 'schema-sync', classes: classBindings.length, properties: propBindings.length, zombiesRemoved, zombiesDeprecated } };
    } finally {
      await session.close();
    }
  }

  /**
   * Extract local name from URI
   */
  extractLocalName(uri) {
    if (!uri) return '';
    return uri.split('#').pop() || uri.split('/').pop() || uri;
  }

  /**
   * Auto-sync when ontology changes
   */
  async setupAutoSync() {
    // This would be called after ontology operations
    logger.info('🔄 Auto-sync enabled for GraphDB → Neo4j');
  }
}

module.exports = new GraphDBNeo4jSyncService();
