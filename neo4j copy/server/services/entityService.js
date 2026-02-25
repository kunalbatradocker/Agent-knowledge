/**
 * Entity Service
 * Handles entity (graph node instance) operations
 * Separate from ontology classes - this manages DATA, not SCHEMA
 * 
 * TERMINOLOGY:
 * - Class = Ontology type definition (managed in OntologyManager)
 * - Entity = Instance/Node in the graph (managed here)
 * - Node = Internal Neo4j term (never exposed to end user)
 */

const neo4jService = require('./neo4jService');
const neo4j = require('neo4j-driver');

// System labels that are not user entities
const SYSTEM_LABELS = [
  'Document', 'Chunk', 'Workspace', 'Tenant', 'Folder',
  '_Bloom_Perspective_', '_Bloom_Scene_'
];

class EntityService {
  /**
   * List entities with cursor-based pagination
   * Query nodes only - NO relationship traversal
   * 
   * @param {Object} options
   * @param {string} options.tenantId - Required tenant ID
   * @param {string} options.workspaceId - Required workspace ID
   * @param {string} options.class - Optional class filter
   * @param {string} options.search - Optional search term
   * @param {number} options.limit - Page size (default 50)
   * @param {string} options.cursor - Pagination cursor
   * @param {string} options.userId - For RBAC filtering
   */
  async listEntities(options) {
    const {
      tenantId,
      workspaceId,
      class: entityClass,
      search,
      limit = 50,
      cursor
    } = options;

    if (!tenantId || !workspaceId) {
      throw new Error('tenantId and workspaceId are required');
    }

    const session = neo4jService.getSession();
    
    try {
      // Build the query
      let whereConditions = [
        'n.tenant_id = $tenantId',
        'n.workspace_id = $workspaceId'
      ];
      
      const params = {
        tenantId,
        workspaceId,
        limit: neo4j.int(Math.floor(Math.min(limit, 100)) + 1) // Fetch one extra to check for next page (ensure integer)
      };

      // Class filter
      if (entityClass) {
        whereConditions.push('$entityClass IN labels(n)');
        params.entityClass = entityClass;
      }

      // Exclude system labels
      whereConditions.push('NOT any(label IN labels(n) WHERE label IN $systemLabels)');
      params.systemLabels = SYSTEM_LABELS;

      // Search filter (on displayName, name, or primary identifier)
      if (search) {
        whereConditions.push(`(
          toLower(n.name) CONTAINS toLower($search) OR
          toLower(n.displayName) CONTAINS toLower($search) OR
          toLower(n.display_name) CONTAINS toLower($search) OR
          toLower(n.label) CONTAINS toLower($search) OR
          toLower(n.concept_id) CONTAINS toLower($search)
        )`);
        params.search = search;
      }

      // Cursor-based pagination (using concept_id or internal id)
      if (cursor) {
        const decodedCursor = this.decodeCursor(cursor);
        whereConditions.push('n.concept_id > $cursorId OR (n.concept_id IS NULL AND id(n) > $cursorNodeId)');
        params.cursorId = decodedCursor.conceptId || '';
        params.cursorNodeId = decodedCursor.nodeId || 0;
      }

      const whereClause = whereConditions.join(' AND ');

      // Query entities with relationship counts
      const query = `
        MATCH (n)
        WHERE ${whereClause}
        WITH n, labels(n) as nodeLabels
        OPTIONAL MATCH (n)-[r_out]->()
        WITH n, nodeLabels, count(DISTINCT r_out) as outgoingCount
        OPTIONAL MATCH (n)<-[r_in]-()
        WITH n, nodeLabels, outgoingCount, count(DISTINCT r_in) as incomingCount
        RETURN 
          n.concept_id as conceptId,
          id(n) as nodeId,
          [l IN nodeLabels WHERE NOT l IN $systemLabels][0] as class,
          coalesce(n.displayName, n.display_name, n.name, n.label, n.concept_id) as displayName,
          n.tenant_id as tenantId,
          n.workspace_id as workspaceId,
          n.source_system as sourceSystem,
          n.source_systems as sourceSystems,
          n.updated_at as lastUpdated,
          n.created_at as createdAt,
          properties(n) as properties,
          outgoingCount,
          incomingCount,
          outgoingCount + incomingCount as totalRelationships
        ORDER BY n.concept_id ASC, id(n) ASC
        LIMIT $limit
      `;

      const result = await session.run(query, params);
      
      const items = [];
      let hasMore = false;

      for (let i = 0; i < result.records.length; i++) {
        if (i >= limit) {
          hasMore = true;
          break;
        }

        const record = result.records[i];
        const properties = record.get('properties') || {};
        const className = record.get('class');
        const conceptId = record.get('conceptId');
        
        // Build entity ID: Class::identifier
        const entityId = this.buildEntityId(className, conceptId, properties);
        
        // Extract identifiers from properties
        const identifiers = this.extractIdentifiers(properties);
        
        // Get sources
        const sources = this.extractSources(record, properties);

        items.push({
          entityId,
          class: className,
          displayName: record.get('displayName') || entityId,
          identifiers,
          workspaceId: record.get('workspaceId'),
          tenantId: record.get('tenantId'),
          lastUpdated: this.convertNeo4jDateTime(record.get('lastUpdated') || record.get('createdAt')),
          sources,
          relationshipCounts: {
            outgoing: neo4jService.toNumber(record.get('outgoingCount')) || 0,
            incoming: neo4jService.toNumber(record.get('incomingCount')) || 0,
            total: neo4jService.toNumber(record.get('totalRelationships')) || 0
          },
          // Internal IDs for cursor
          _conceptId: conceptId,
          _nodeId: neo4jService.toNumber(record.get('nodeId'))
        });
      }

      // Build next cursor
      let nextCursor = null;
      if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        nextCursor = this.encodeCursor({
          conceptId: lastItem._conceptId,
          nodeId: lastItem._nodeId
        });
      }

      // Remove internal fields
      items.forEach(item => {
        delete item._conceptId;
        delete item._nodeId;
      });

      return {
        items,
        nextCursor,
        totalEstimate: await this.getEntityCountEstimate(tenantId, workspaceId, entityClass)
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Get entity detail by ID
   * Returns: properties, class, provenance, grouped relationship counts, evidence
   */
  async getEntityDetail(entityId, options = {}) {
    const { tenantId, workspaceId } = options;

    if (!tenantId || !workspaceId) {
      throw new Error('tenantId and workspaceId are required');
    }

    const session = neo4jService.getSession();
    
    try {
      // Parse entity ID
      const { className, identifier } = this.parseEntityId(entityId);

      // Find the entity
      const findQuery = `
        MATCH (n)
        WHERE (n.concept_id = $identifier OR n.name = $identifier OR n.label = $identifier)
          AND n.tenant_id = $tenantId
          AND n.workspace_id = $workspaceId
          AND $className IN labels(n)
        RETURN n, labels(n) as nodeLabels, id(n) as nodeId
        LIMIT 1
      `;

      const findResult = await session.run(findQuery, {
        identifier,
        tenantId,
        workspaceId,
        className
      });

      if (findResult.records.length === 0) {
        return null;
      }

      const record = findResult.records[0];
      const node = record.get('n');
      const nodeLabels = record.get('nodeLabels');
      const nodeId = neo4jService.toNumber(record.get('nodeId'));
      const properties = node.properties;

      // Get class (first non-system label)
      const entityClass = nodeLabels.find(l => !SYSTEM_LABELS.includes(l));

      // Get relationship counts grouped by type
      // Get relationship counts — sequential to avoid session conflict
      const outRelQuery = `
        MATCH (n) WHERE id(n) = $nodeId
        MATCH (n)-[r]->()
        RETURN type(r) as relType, count(r) as cnt
      `;
      const inRelQuery = `
        MATCH (n) WHERE id(n) = $nodeId
        MATCH (n)<-[r]-()
        RETURN type(r) as relType, count(r) as cnt
      `;

      const outResult = await session.run(outRelQuery, { nodeId });
      const inResult = await session.run(inRelQuery, { nodeId });

      const outgoing = outResult.records.map(r => ({
        type: r.get('relType'),
        count: r.get('cnt')
      }));
      const incoming = inResult.records.map(r => ({
        type: r.get('relType'),
        count: r.get('cnt')
      }));

      const relationshipCounts = this.processRelationshipCounts(outgoing, incoming);

      // Get evidence from EvidenceChunk nodes (new pattern) + legacy MENTIONED_IN
      const evidenceQuery = `
        MATCH (n) WHERE id(n) = $nodeId
        OPTIONAL MATCH (n)-[r1:EVIDENCED_BY]->(ec:EvidenceChunk)
        WITH n, collect(DISTINCT {
          chunkId: ec.chunk_id,
          documentId: ec.doc_id,
          page: ec.page,
          sectionPath: ec.section_path,
          spanStart: ec.span_start,
          spanEnd: ec.span_end,
          quote: ec.quote,
          textHash: ec.text_hash,
          accessLabel: ec.access_label,
          method: r1.method,
          confidence: r1.confidence,
          source: 'evidence_chunk'
        }) AS ecEvidence
        OPTIONAL MATCH (n) WHERE id(n) = $nodeId
        OPTIONAL MATCH (n)-[:MENTIONED_IN]->(c:Chunk)-[:PART_OF]->(d:Document)
        RETURN ecEvidence,
        collect(DISTINCT {
          chunkId: c.chunk_id,
          documentId: d.doc_id,
          documentTitle: d.title,
          text: substring(c.text, 0, 200),
          source: 'legacy_mention'
        })[0..5] as legacyEvidence
      `;

      const evidenceResult = await session.run(evidenceQuery, { nodeId });
      const ecEvidence = evidenceResult.records[0]?.get('ecEvidence')?.filter(e => e.chunkId) || [];
      const legacyEvidence = evidenceResult.records[0]?.get('legacyEvidence')?.filter(e => e.chunkId) || [];
      const evidence = [...ecEvidence, ...legacyEvidence];

      // Get assertions (reified relationships with evidence)
      const assertionQuery = `
        MATCH (n) WHERE id(n) = $nodeId
        OPTIONAL MATCH (n)-[:ASSERTS]->(a:Assertion)-[:TARGET]->(target)
        OPTIONAL MATCH (a)-[:EVIDENCED_BY]->(aec:EvidenceChunk)
        RETURN collect(DISTINCT {
          assertionId: a.assertion_id,
          predicate: a.predicate,
          confidence: a.confidence,
          claimStatus: a.claim_status,
          method: a.method,
          targetName: target.display_name,
          targetClass: labels(target)[0],
          targetCanonicalId: target.canonical_id,
          evidenceQuote: aec.quote,
          evidenceDoc: aec.doc_id,
          evidencePage: aec.page
        })[0..10] as assertions
      `;

      const assertionResult = await session.run(assertionQuery, { nodeId });
      const assertions = assertionResult.records[0]?.get('assertions')?.filter(a => a.assertionId) || [];

      // Build provenance - convert Neo4j DateTime objects
      const provenance = {
        sourceSystem: properties.source_system || properties.sourceSystem,
        sourceSystems: properties.source_systems || properties.sourceSystems,
        sourceTable: properties.source_table || properties.sourceTable,
        sourceFile: properties.source_file || properties.sourceFile,
        ingestedAt: this.convertNeo4jDateTime(properties.ingested_at || properties.ingestedAt),
        createdAt: this.convertNeo4jDateTime(properties.created_at || properties.createdAt),
        updatedAt: this.convertNeo4jDateTime(properties.updated_at || properties.updatedAt)
      };

      // Clean properties (remove internal fields)
      const cleanProperties = this.cleanProperties(properties);

      return {
        entityId,
        class: entityClass,
        displayName: properties.displayName || properties.display_name || properties.name || properties.label || entityId,
        canonicalId: properties.concept_id || properties.canonical_id,
        attributes: cleanProperties,
        provenance,
        relationships: relationshipCounts,
        evidence,
        assertions,
        status: properties.status || 'active',
        claimStatus: properties.claim_status || null,
        sourceDocIds: properties.source_doc_ids || [],
        workspaceId: properties.workspace_id,
        tenantId: properties.tenant_id
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Get relationships for an entity (expandable, paginated)
   */
  async getEntityRelationships(entityId, options = {}) {
    const {
      tenantId,
      workspaceId,
      relationshipType,
      direction = 'both',
      limit = 20
    } = options;

    if (!tenantId || !workspaceId) {
      throw new Error('tenantId and workspaceId are required');
    }

    const session = neo4jService.getSession();
    
    try {
      const { className, identifier } = this.parseEntityId(entityId);

      // Build relationship pattern based on direction
      let relPattern;
      if (direction === 'outgoing') {
        relPattern = '-[r]->';
      } else if (direction === 'incoming') {
        relPattern = '<-[r]-';
      } else {
        relPattern = '-[r]-';
      }

      // Build type filter
      const typeFilter = relationshipType ? 'WHERE type(r) = $relType' : '';

      const query = `
        MATCH (n)
        WHERE (n.concept_id = $identifier OR n.name = $identifier OR n.label = $identifier)
          AND n.tenant_id = $tenantId
          AND n.workspace_id = $workspaceId
          AND $className IN labels(n)
        MATCH (n)${relPattern}(other)
        ${typeFilter}
        WITH r, n, other, labels(other) as otherLabels,
             CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END as relDirection
        RETURN 
          type(r) as relationshipType,
          relDirection as direction,
          coalesce(other.displayName, other.display_name, other.name, other.label, other.concept_id, other.chunk_id, other.doc_id) as targetName,
          coalesce(other.concept_id, other.chunk_id, other.doc_id) as targetId,
          CASE 
            WHEN any(l IN otherLabels WHERE NOT l IN $systemLabels) 
            THEN [l IN otherLabels WHERE NOT l IN $systemLabels][0]
            ELSE otherLabels[0]
          END as targetClass
        ORDER BY type(r), targetName
        LIMIT $limit
      `;

      const params = {
        identifier,
        tenantId,
        workspaceId,
        className,
        systemLabels: SYSTEM_LABELS,
        limit: neo4j.int(Math.floor(limit) + 1)
      };

      if (relationshipType) {
        params.relType = relationshipType;
      }

      const result = await session.run(query, params);

      const items = [];
      let hasMore = false;

      for (let i = 0; i < result.records.length; i++) {
        if (i >= limit) {
          hasMore = true;
          break;
        }

        const record = result.records[i];
        const targetClass = record.get('targetClass') || 'Unknown';
        const targetId = record.get('targetId');
        const targetName = record.get('targetName');

        items.push({
          relationshipType: record.get('relationshipType'),
          direction: record.get('direction'),
          target: {
            entityId: targetId ? this.buildEntityId(targetClass, targetId, {}) : targetName,
            class: targetClass,
            displayName: targetName || targetId || 'Unknown'
          },
          properties: {}
        });
      }

      return {
        items,
        hasMore
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Get contextual graph for an entity (limited hops)
   * For graph visualization - starts from ONE entity
   */
  async getEntityGraph(entityId, options = {}) {
        const {
          tenantId,
          workspaceId,
          depth = 1,
          relationshipTypes,
          limit = 50,
          mode = 'full'  // 'full' = all connections, 'focused' = main entity path (capped fan-out)
        } = options;

        // In focused mode, limit per-node fan-out at hop 2+ to avoid sibling explosion
        const FOCUSED_FANOUT = 8;

        if (!tenantId || !workspaceId) {
          throw new Error('tenantId and workspaceId are required');
        }

        const maxDepth = Math.min(Math.max(depth, 1), 3);
        const logger = require('../utils/logger');
        const session = neo4jService.getSession();

        try {
          const { className, identifier } = this.parseEntityId(entityId);

          const relTypeClause = relationshipTypes?.length 
            ? `:${relationshipTypes.join('|')}` 
            : '';

          // Step 1: Find the start node
          // Use class::rawId as composite node ID to distinguish different entity types
          // that share the same concept_id (e.g., Customer::CUST000010 vs RiskAssessment::CUST000010)
          const startQuery = `
            MATCH (start)
            WHERE (start.concept_id = $identifier OR start.name = $identifier OR start.label = $identifier)
              AND start.tenant_id = $tenantId
              AND start.workspace_id = $workspaceId
              AND $className IN labels(start)
            RETURN 
              id(start) as neoId,
              coalesce(start.concept_id, start.name, start.label, toString(id(start))) as rawId,
              coalesce(start.displayName, start.display_name, start.name, start.label, start.concept_id) as label,
              [l IN labels(start) WHERE NOT l IN $systemLabels][0] as class
            LIMIT 1
          `;

          const startResult = await session.run(startQuery, {
            identifier, tenantId, workspaceId, className, systemLabels: SYSTEM_LABELS
          });

          if (startResult.records.length === 0) {
            logger.warn(`[getEntityGraph] Start node not found: entityId=${entityId}`);
            return { nodes: [], edges: [], centerEntityId: entityId, depth: maxDepth };
          }

          const startRec = startResult.records[0];
          const startNeoId = neo4jService.toNumber(startRec.get('neoId'));
          const nodesMap = new Map();
          const edgesSet = new Set();
          const edges = [];
          // Map Neo4j internal ID → composite node ID for edge resolution
          const neoIdToNodeId = new Map();

          const startClass = startRec.get('class');
          const startRawId = startRec.get('rawId');
          const startNodeId = `${startClass}::${startRawId}`;
          neoIdToNodeId.set(startNeoId, startNodeId);

          nodesMap.set(startNodeId, {
            id: startNodeId,
            label: startRec.get('label'),
            class: startClass
          });

          // Step 2: BFS — expand one hop at a time
          // Track Neo4j internal IDs we've already expanded from
          let frontierNeoIds = [startNeoId];
          const expandedNeoIds = new Set([startNeoId]);

          for (let hop = 0; hop < maxDepth; hop++) {
            if (frontierNeoIds.length === 0) break;

            // In focused mode at hop 2+, limit per-node fan-out to avoid sibling explosion
            // (e.g., KYCStatus "Verified" → 48 customers). Also exclude same-class-as-center nodes.
            const hopLimit = (mode === 'focused' && hop > 0) ? FOCUSED_FANOUT : limit;
            const excludeCenterClass = (mode === 'focused' && hop > 0);

            // Use two directed queries to avoid startNode(r)/endNode(r) which trigger Neo4j ASTCachedProperty bug
            const classFilter = excludeCenterClass 
              ? `AND NOT $centerClass IN labels(other)` 
              : '';

            const hopQueryOut = `
              UNWIND $frontierIds as fId
              MATCH (src) WHERE id(src) = fId
              MATCH (src)-[r${relTypeClause}]->(other)
              WHERE NOT any(lbl IN labels(other) WHERE lbl IN $systemLabels)
                ${classFilter}
              RETURN DISTINCT
                id(src) as srcNeoId,
                id(other) as otherNeoId,
                coalesce(other.concept_id, other.name, other.label, toString(id(other))) as otherRawId,
                coalesce(other.displayName, other.display_name, other.name, other.label, other.concept_id) as otherLabel,
                [l IN labels(other) WHERE NOT l IN $systemLabels][0] as otherClass,
                type(r) as relType
              LIMIT $limit
            `;

            const hopQueryIn = `
              UNWIND $frontierIds as fId
              MATCH (src) WHERE id(src) = fId
              MATCH (src)<-[r${relTypeClause}]-(other)
              WHERE NOT any(lbl IN labels(other) WHERE lbl IN $systemLabels)
                ${classFilter}
              RETURN DISTINCT
                id(src) as srcNeoId,
                id(other) as otherNeoId,
                coalesce(other.concept_id, other.name, other.label, toString(id(other))) as otherRawId,
                coalesce(other.displayName, other.display_name, other.name, other.label, other.concept_id) as otherLabel,
                [l IN labels(other) WHERE NOT l IN $systemLabels][0] as otherClass,
                type(r) as relType
              LIMIT $limit
            `;

            const hopParams = {
              frontierIds: frontierNeoIds.map(id => neo4j.int(id)),
              systemLabels: SYSTEM_LABELS,
              limit: neo4j.int(Math.floor(hopLimit))
            };
            if (excludeCenterClass) {
              hopParams.centerClass = className;
            }

            // Run outgoing and incoming sequentially (same session can't run concurrently)
            const outResult = await session.run(hopQueryOut, hopParams);
            const inResult = await session.run(hopQueryIn, hopParams);
            const outCount = outResult.records.length;
            const hopRecords = [...outResult.records, ...inResult.records];

            const nextFrontier = [];

            for (let ri = 0; ri < hopRecords.length; ri++) {
              const rec = hopRecords[ri];
              const otherRawId = rec.get('otherRawId');
              const otherClass = rec.get('otherClass');
              const otherNeoId = neo4jService.toNumber(rec.get('otherNeoId'));
              const srcNeoId = neo4jService.toNumber(rec.get('srcNeoId'));
              const otherNodeId = `${otherClass}::${otherRawId}`;

              if (!nodesMap.has(otherNodeId)) {
                nodesMap.set(otherNodeId, {
                  id: otherNodeId,
                  label: rec.get('otherLabel'),
                  class: otherClass
                });
              }
              neoIdToNodeId.set(otherNeoId, otherNodeId);

              // Resolve source node ID from the neoId→nodeId map
              const srcNodeId = neoIdToNodeId.get(srcNeoId) || `unknown::${srcNeoId}`;
              // outgoing (ri < outCount): src→other, incoming (ri >= outCount): other→src
              const isOutgoing = ri < outCount;
              const edgeSource = isOutgoing ? srcNodeId : otherNodeId;
              const edgeTarget = isOutgoing ? otherNodeId : srcNodeId;

              const edgeKey = `${edgeSource}|${edgeTarget}|${rec.get('relType')}`;
              if (!edgesSet.has(edgeKey)) {
                edgesSet.add(edgeKey);
                edges.push({
                  source: edgeSource,
                  target: edgeTarget,
                  type: rec.get('relType')
                });
              }

              // Queue for next hop if not already expanded
              if (!expandedNeoIds.has(otherNeoId)) {
                expandedNeoIds.add(otherNeoId);
                nextFrontier.push(otherNeoId);
              }
            }

            frontierNeoIds = nextFrontier;
          }

          logger.info(`[getEntityGraph] entityId=${entityId}, depth=${maxDepth}, nodes=${nodesMap.size}, edges=${edges.length}`);

          return {
            nodes: Array.from(nodesMap.values()),
            edges,
            centerEntityId: entityId,
            depth: maxDepth
          };

        } finally {
          await session.close();
        }
      }

  /**
   * Get available classes (entity types) in a workspace
   */
  async getAvailableClasses(tenantId, workspaceId) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (n)
        WHERE n.tenant_id = $tenantId AND n.workspace_id = $workspaceId
        WITH labels(n) as nodeLabels
        UNWIND nodeLabels as label
        WITH label WHERE NOT label IN $systemLabels
        RETURN DISTINCT label as class, count(*) as count
        ORDER BY count DESC
      `;

      const result = await session.run(query, {
        tenantId,
        workspaceId,
        systemLabels: SYSTEM_LABELS
      });

      return result.records.map(r => ({
        class: r.get('class'),
        count: neo4jService.toNumber(r.get('count'))
      }));

    } finally {
      await session.close();
    }
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Update entity properties in Neo4j
   */
  async updateEntity(entityId, options = {}) {
    const { tenantId, workspaceId, properties } = options;

    if (!tenantId || !workspaceId) {
      throw new Error('tenantId and workspaceId are required');
    }

    const session = neo4jService.getSession();
    
    try {
      const { className, identifier } = this.parseEntityId(entityId);

      // Build SET clause for properties
      const setEntries = [];
      const params = {
        identifier,
        tenantId,
        workspaceId,
        className,
        updatedAt: new Date().toISOString()
      };

      // Filter out protected properties
      const protectedKeys = ['tenant_id', 'workspace_id', 'concept_id', 'created_at'];
      
      Object.entries(properties).forEach(([key, value], idx) => {
        if (!protectedKeys.includes(key)) {
          const paramName = `prop_${idx}`;
          setEntries.push(`n.${key} = $${paramName}`);
          params[paramName] = value;
        }
      });

      // Always update updated_at
      setEntries.push('n.updated_at = $updatedAt');

      if (setEntries.length === 0) {
        throw new Error('No valid properties to update');
      }

      const query = `
        MATCH (n)
        WHERE (n.concept_id = $identifier OR n.name = $identifier OR n.label = $identifier)
          AND n.tenant_id = $tenantId
          AND n.workspace_id = $workspaceId
          AND $className IN labels(n)
        SET ${setEntries.join(', ')}
        RETURN n, labels(n) as nodeLabels
      `;

      const result = await session.run(query, params);

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const node = record.get('n');
      const nodeLabels = record.get('nodeLabels');
      const nodeProperties = node.properties;

      const entityClass = nodeLabels.find(l => !SYSTEM_LABELS.includes(l));

      return {
        entityId,
        class: entityClass,
        displayName: nodeProperties.displayName || nodeProperties.display_name || nodeProperties.name || nodeProperties.label || entityId,
        properties: this.cleanProperties(nodeProperties),
        updatedAt: nodeProperties.updated_at
      };

    } finally {
      await session.close();
    }
  }

  buildEntityId(className, conceptId, properties) {
    const id = conceptId || properties.name || properties.label || 'unknown';
    return `${className || 'Entity'}::${id}`;
  }

  parseEntityId(entityId) {
    const parts = entityId.split('::');
    if (parts.length >= 2) {
      return {
        className: parts[0],
        identifier: parts.slice(1).join('::')
      };
    }
    return {
      className: null,
      identifier: entityId
    };
  }

  extractIdentifiers(properties) {
    const identifierKeys = [
      'customer_id', 'account_id', 'user_id', 'employee_id',
      'product_id', 'order_id', 'transaction_id', 'case_id',
      'concept_id', 'canonical_id', 'external_id', 'id'
    ];

    const identifiers = {};
    for (const key of identifierKeys) {
      if (properties[key]) {
        identifiers[key] = properties[key];
      }
    }
    return identifiers;
  }

  extractSources(record, properties) {
    const sources = new Set();
    
    if (record.get('sourceSystem')) {
      sources.add(record.get('sourceSystem'));
    }
    
    const sourceSystems = record.get('sourceSystems') || properties.source_systems;
    if (Array.isArray(sourceSystems)) {
      sourceSystems.forEach(s => sources.add(s));
    }
    
    if (properties.source_system) {
      sources.add(properties.source_system);
    }
    
    if (sources.size === 0) {
      sources.add('Document');
    }
    
    return Array.from(sources);
  }

  processRelationshipCounts(outgoing, incoming) {
    const counts = {};
    
    for (const rel of (outgoing || [])) {
      if (rel.type) {
        counts[rel.type] = counts[rel.type] || { outgoing: 0, incoming: 0 };
        counts[rel.type].outgoing = neo4jService.toNumber(rel.count);
      }
    }
    
    for (const rel of (incoming || [])) {
      if (rel.type) {
        counts[rel.type] = counts[rel.type] || { outgoing: 0, incoming: 0 };
        counts[rel.type].incoming = neo4jService.toNumber(rel.count);
      }
    }
    
    return Object.entries(counts).map(([type, c]) => ({
      type,
      outgoing: c.outgoing,
      incoming: c.incoming,
      total: c.outgoing + c.incoming
    }));
  }

  /**
   * Convert Neo4j DateTime objects to ISO strings
   */
  convertNeo4jDateTime(value) {
    if (value === null || value === undefined) {
      return value;
    }
    
    // Check if it's a Neo4j DateTime object (has year, month, day properties)
    if (typeof value === 'object' && value.year !== undefined && value.month !== undefined && value.day !== undefined) {
      const { year, month, day, hour = 0, minute = 0, second = 0 } = value;
      // Convert to number if they're Neo4j integers
      const y = neo4jService.toNumber(year) || year;
      const m = neo4jService.toNumber(month) || month;
      const d = neo4jService.toNumber(day) || day;
      const h = neo4jService.toNumber(hour) || hour;
      const min = neo4jService.toNumber(minute) || minute;
      const s = neo4jService.toNumber(second) || second;
      
      const date = new Date(y, m - 1, d, h, min, s);
      return date.toISOString();
    }
    
    // Check if it's a Neo4j Integer
    if (typeof value === 'object' && value.low !== undefined && value.high !== undefined) {
      return neo4jService.toNumber(value);
    }
    
    return value;
  }

  /**
   * Recursively convert all Neo4j types in an object
   */
  convertNeo4jTypes(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertNeo4jTypes(item));
    }
    
    if (typeof obj === 'object') {
      // Check if it's a Neo4j DateTime first
      if (obj.year !== undefined && obj.month !== undefined && obj.day !== undefined) {
        return this.convertNeo4jDateTime(obj);
      }
      
      // Check if it's a Neo4j Integer
      if (obj.low !== undefined && obj.high !== undefined) {
        return neo4jService.toNumber(obj);
      }
      
      // Otherwise, recursively convert all properties
      const converted = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = this.convertNeo4jTypes(value);
      }
      return converted;
    }
    
    return obj;
  }

  cleanProperties(properties) {
    const internalKeys = [
      'tenant_id', 'workspace_id', 'concept_id', 'canonical_id',
      'source_system', 'source_systems', 'source_table', 'source_file',
      'ingested_at', 'created_at', 'updated_at', 'vector_key'
    ];
    
    const clean = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!internalKeys.includes(key) && value !== null && value !== undefined) {
        // Convert Neo4j types to standard JS types
        clean[key] = this.convertNeo4jTypes(value);
      }
    }
    return clean;
  }

  encodeCursor(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }

  decodeCursor(cursor) {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    } catch {
      return {};
    }
  }

  async getEntityCountEstimate(tenantId, workspaceId, entityClass) {
    const session = neo4jService.getSession();
    try {
      let query;
      const params = { tenantId, workspaceId, systemLabels: SYSTEM_LABELS };
      
      if (entityClass) {
        // Sanitize the label to prevent Cypher injection
        const sanitizedLabel = entityClass.replace(/[^a-zA-Z0-9_]/g, '');
        if (!sanitizedLabel) {
          // Invalid label, fall back to general query
          query = `
            MATCH (n)
            WHERE n.tenant_id = $tenantId 
              AND n.workspace_id = $workspaceId
              AND NOT any(label IN labels(n) WHERE label IN $systemLabels)
            RETURN count(n) as count
          `;
        } else {
          query = `
            MATCH (n:\`${sanitizedLabel}\`)
            WHERE n.tenant_id = $tenantId AND n.workspace_id = $workspaceId
            RETURN count(n) as count
          `;
        }
      } else {
        query = `
          MATCH (n)
          WHERE n.tenant_id = $tenantId 
            AND n.workspace_id = $workspaceId
            AND NOT any(label IN labels(n) WHERE label IN $systemLabels)
          RETURN count(n) as count
        `;
      }
      
      const result = await session.run(query, params);
      return neo4jService.toNumber(result.records[0]?.get('count')) || 0;
    } finally {
      await session.close();
    }
  }
}

module.exports = new EntityService();
