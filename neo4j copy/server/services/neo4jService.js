/**
 * Neo4j Service
 * Handles all Neo4j database operations for the knowledge graph
 */

const driver = require('../config/neo4j');
const neo4j = require('neo4j-driver');
const { v4: uuidv4 } = require('uuid');

class Neo4jService {
  /**
   * Get a session with the configured database
   */
  getSession() {
    const database = driver.getDatabase();
    return driver.session({ database });
  }

  /**
   * Sanitize label for Neo4j to prevent Cypher injection
   */
  sanitizeLabel(label) {
    if (!label) return 'Entity';
    return label.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[0-9]/, '_$&') || 'Entity';
  }

  /**
   * Helper to convert Neo4j integer to JavaScript number
   */
  toNumber(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low !== 'undefined' && typeof value.high !== 'undefined') {
      return value.low;
    }
    return parseInt(value, 10) || 0;
  }

  /**
   * Convert Neo4j values to native JS types
   */
  toNative(value) {
    if (value === null || value === undefined) return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low !== 'undefined') return this.toNumber(value);
    if (Array.isArray(value)) return value.map(v => this.toNative(v));
    if (value.properties) return this.toNative(value.properties); // Node/Relationship
    if (typeof value === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.toNative(v);
      }
      return result;
    }
    return value;
  }

  // ============================================================
  // DOCUMENT NODE OPERATIONS
  // ============================================================

  /**
   * Create or update a Document node
   * Now supports relationship-based workspace linking via CONTAINS_DOCUMENT
   * @param {Object} doc - Document properties
   * @param {string} doc.workspace_id - Workspace ID for relationship-based linking
   * @param {string} doc.folder_id - Optional folder ID (document goes in folder)
   */
  async createDocument(doc) {
    const session = this.getSession();

    try {
      const docId = doc.doc_id || uuidv4();
      const uri = doc.uri || `doc://${doc.source || 'upload'}/${docId}`;

      // Build query based on folder and workspace context
      let linkingClause = '';
      const params = {
        uri: uri,
        doc_id: docId,
        title: doc.title || doc.name || 'Untitled',
        source: doc.source || 'upload',
        doc_type: doc.doc_type || 'document',
        content_type: doc.content_type || doc.doc_type || 'document',
        language: doc.language || 'en',
        tenant_id: doc.tenant_id || null,
        workspace_id: doc.workspace_id || null,
        version: doc.version || '1.0',
        created_at: doc.created_at || new Date().toISOString(),
        ingested_at: doc.ingested_at || doc.created_at || new Date().toISOString()
      };

      if (doc.folder_id) {
        // Document goes into a folder (folder contains document)
        params.folder_id = doc.folder_id;
        linkingClause = `
          WITH d
          MATCH (f:Folder {folder_id: $folder_id})
          MERGE (f)-[:CONTAINS]->(d)
        `;
      } else if (doc.workspace_id) {
        // Document goes directly into workspace (no folder)
        linkingClause = `
          WITH d
          MATCH (w:Workspace {workspace_id: $workspace_id})
          MERGE (w)-[:CONTAINS_DOCUMENT]->(d)
        `;
      }
      
      const query = `
        MERGE (d:Document {uri: $uri})
        SET d.doc_id = $doc_id,
            d.title = $title,
            d.source = $source,
            d.doc_type = $doc_type,
            d.content_type = $content_type,
            d.language = $language,
            d.tenant_id = $tenant_id,
            d.workspace_id = $workspace_id,
            d.version = $version,
            d.created_at = datetime($created_at),
            d.ingested_at = datetime($ingested_at),
            d.updated_at = datetime()
        ${linkingClause}
        RETURN d
      `;
      
      const result = await session.run(query, params);

      const node = result.records[0]?.get('d');
      console.log(`   📄 Document node created: ${uri} (workspace: ${doc.workspace_id || 'default'})`);

      return {
        doc_id: docId,
        uri: uri,
        workspace_id: doc.workspace_id,
        node: node?.properties
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get a Document by URI or doc_id
   */
  async getDocument(identifier) {
    const session = this.getSession();

    try {
      const query = `
        MATCH (d:Document)
        WHERE d.uri = $id OR d.doc_id = $id
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        RETURN d, count(ch) as chunkCount
      `;

      const result = await session.run(query, { id: identifier });
      if (result.records.length === 0) return null;

      const record = result.records[0];
      return {
        ...record.get('d').properties,
        chunkCount: this.toNumber(record.get('chunkCount'))
      };
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // CHUNK NODE OPERATIONS
  // ============================================================

  /**
   * Create Chunk nodes with PART_OF relationships to Document and NEXT_CHUNK between sequential chunks
   */
  async createChunks(chunks, documentUri) {
    const session = this.getSession();
    let createdCount = 0;

    try {
      // Sort chunks by order to ensure proper NEXT_CHUNK linking
      const sortedChunks = [...chunks].sort((a, b) => 
        (a.order || a.chunkIndex || 0) - (b.order || b.chunkIndex || 0)
      );

      for (const chunk of sortedChunks) {
        const chunkId = chunk.chunk_id || chunk.id || uuidv4();
        const chunkUri = chunk.uri || `${documentUri}#chunk=${chunk.order || chunk.chunkIndex || 0}`;

        const query = `
          MATCH (d:Document {uri: $docUri})
          MERGE (ch:Chunk {uri: $uri})
          SET ch.chunk_id = $chunk_id,
              ch.text = $text,
              ch.order = $order,
              ch.start_page = $start_page,
              ch.end_page = $end_page,
              ch.vector_key = $vector_key,
              ch.summary = $summary,
              ch.context_type = $context_type,
              ch.section_title = $section_title,
              ch.heading_path = $heading_path,
              ch.token_count = $token_count,
              ch.char_count = $char_count,
              ch.tenant_id = $tenant_id,
              ch.workspace_id = $workspace_id,
              ch.language = $language
          MERGE (ch)-[r:PART_OF]->(d)
          SET r.order = $order
          RETURN ch
        `;

        // Calculate token count (rough estimate: 1 token ≈ 4 characters)
        const charCount = (chunk.text || '').length;
        const tokenCount = Math.ceil(charCount / 4);

        await session.run(query, {
          docUri: documentUri,
          uri: chunkUri,
          chunk_id: chunkId,
          text: chunk.text,
          order: neo4j.int(chunk.order || chunk.chunkIndex || 0),
          start_page: chunk.start_page ? neo4j.int(chunk.start_page) : null,
          end_page: chunk.end_page ? neo4j.int(chunk.end_page) : null,
          vector_key: chunk.vector_key || chunk.id || chunkId,
          summary: chunk.summary || null,
          context_type: chunk.context_type || null,
          section_title: chunk.section_title || null,
          heading_path: chunk.heading_path || null,
          token_count: chunk.token_count !== undefined ? neo4j.int(chunk.token_count) : neo4j.int(tokenCount),
          char_count: chunk.char_count !== undefined ? neo4j.int(chunk.char_count) : neo4j.int(charCount),
          tenant_id: chunk.tenant_id || null,
          workspace_id: chunk.workspace_id || null,
          language: chunk.language || null
        });

        createdCount++;
      }

      // Note: NEXT_CHUNK relationships removed - chunk.order property is sufficient for sequencing
      // Query sequential chunks with: MATCH (c:Chunk)-[:PART_OF]->(d) ORDER BY c.order

      console.log(`   📝 Created ${createdCount} Chunk nodes with PART_OF relationships`);
      return { chunksCreated: createdCount };
    } finally {
      await session.close();
    }
  }

  /**
   * Get chunks for a document
   */
  async getDocumentChunks(documentUri, limit = 100) {
    const session = this.getSession();

    try {
      const query = `
        MATCH (ch:Chunk)-[:PART_OF]->(d:Document {uri: $uri})
        RETURN ch
        ORDER BY ch.order
        LIMIT $limit
      `;

      const result = await session.run(query, {
        uri: documentUri,
        limit: neo4j.int(limit)
      });

      return result.records.map(r => r.get('ch').properties);
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // CONCEPT NODE OPERATIONS
  // ============================================================

  /**
   * Create Concept nodes with dynamic labels
   * @param {Array} concepts - Array of concept objects
   * @param {Object} options - Options for concept creation
   * @param {Object} options.ontology - Ontology with identity_keys per entity type
   * 
   * Schema: Entity types become Neo4j labels (e.g., :Person, :Organization, :Contract)
   * This provides fast queries by type and clear visual distinction in Neo4j Browser
   */
  async createConcepts(concepts, options = {}) {
    const entityUriService = require('./entityUriService');
    const session = this.getSession();
    let createdCount = 0;
    let updatedCount = 0;
    const { workspaceId = null, ontology = null } = options;

    try {
      for (const concept of concepts) {
        // Get the specific type for labeling (from user-approved schema or type property)
        const specificType = concept.specificType || concept.type || null;
        const sanitizedSpecificType = specificType ? entityUriService.sanitizeNeo4jLabel(specificType) : null;
        
        // Ensure workspace_id is set at top level (not just in properties)
        const wsId = concept.workspace_id || concept.properties?.workspace_id || workspaceId;
        
        // Get identity keys for this entity type from ontology
        const identityKeys = concept.identityKeys || 
                            concept.identity_keys || 
                            entityUriService.getIdentityKeysForType(ontology, specificType) ||
                            [];
        
        // Generate deterministic URI if not provided (now with identity keys support)
        if (!concept.uri || concept.uri.includes('undefined')) {
          concept.uri = entityUriService.generateUri(concept.label, specificType, wsId, {
            properties: concept.properties,
            identityKeys: identityKeys
          });
        }
        
        // Ensure workspace_id and identityKeys are set for createConceptWithDynamicLabel
        concept.workspace_id = wsId;
        concept.identityKeys = identityKeys;
        
        // Create node with dynamic label (type becomes Neo4j label)
        const exists = await this.createConceptWithDynamicLabel(session, concept, sanitizedSpecificType);
        if (exists) updatedCount++;
        else createdCount++;
      }

      console.log(`   💡 Nodes: ${createdCount} new, ${updatedCount} merged`);
      
      return { conceptsCreated: createdCount, conceptsUpdated: updatedCount, total: createdCount + updatedCount };
    } finally {
      await session.close();
    }
  }


  /**

  /**
   * Create node with user-approved type as the PRIMARY label
   * Structure: (:Person), (:Skill), (:Organization) - NOT as sub-labels of Concept
   * User-approved types become independent node types
   * 
   * CRITICAL: Uses identity_hash for MERGE to ensure deduplication
   * Identity resolution strategy:
   * 1. If identity_keys defined in ontology → use property values (e.g., email for Person)
   * 2. Otherwise → use normalized_label + workspace_id
   * 
   * @param {Object} session - Neo4j session
   * @param {Object} concept - Concept object with label, specificType, workspace_id, properties, identityKeys
   * @param {string|null} sanitizedSpecificType - Pre-sanitized specific type label or null
   */
  async createConceptWithDynamicLabel(session, concept, sanitizedSpecificType) {
    const entityUriService = require('./entityUriService');
    
    // Use user-approved type as the PRIMARY label
    const nodeLabel = sanitizedSpecificType || 'Concept';
    const workspaceId = concept.workspace_id || 'global';
    const properties = concept.properties || {};
    const identityKeys = concept.identityKeys || concept.identity_keys || [];
    
    // Generate identity hash - uses identity keys if available, else normalized label
    const identityHash = entityUriService.generateIdentityHash(concept.label, properties, identityKeys);
    const normalizedLabel = entityUriService.normalizeLabel(concept.label);
    
    // Determine which identity strategy we're using
    const usingIdentityKeys = identityKeys.length > 0 && 
      identityKeys.some(key => properties[key] !== undefined && properties[key] !== null && properties[key] !== '');
    
    // Check if exists using identity_hash + workspace_id
    // This ensures same entity always matches regardless of label variations
    const checkQuery = `
      MATCH (c:\`${nodeLabel}\`)
      WHERE c.identity_hash = $identity_hash 
        AND c.workspace_id = $workspace_id
      RETURN c
    `;
    const checkResult = await session.run(checkQuery, { 
      identity_hash: identityHash,
      workspace_id: workspaceId
    });
    const exists = checkResult.records.length > 0;

    const identityInfo = usingIdentityKeys 
      ? `identity: ${identityKeys.map(k => `${k}=${properties[k]}`).join(', ')}`
      : `normalized: ${normalizedLabel}`;
    console.log(`      ${exists ? 'Updating' : 'Creating'}: ${concept.label} as :${nodeLabel} (${identityInfo}, workspace: ${workspaceId})`);
    
    // Build dynamic SET clause for properties
    const sanitizePropertyKey = (key) => {
      return key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
    };
    const propertyKeys = Object.keys(properties).filter(key => {
      const value = properties[key];
      return value !== null && value !== undefined && value !== '';
    });
    const propertySetClause = propertyKeys.length > 0 
      ? ', ' + propertyKeys.map(key => {
          const sanitized = sanitizePropertyKey(key);
          return `c.${sanitized} = $prop_${sanitized}`;
        }).join(', ')
      : '';
    
    // CRITICAL: MERGE on identity_hash + workspace_id for deduplication
    // identity_hash is either from identity keys (email, ssn) or normalized label
    const query = `
      MERGE (c:\`${nodeLabel}\` {identity_hash: $identity_hash, workspace_id: $workspace_id})
      ON CREATE SET
        c.uri = $uri,
        c.concept_id = $concept_id,
        c.label = $label,
        c.normalized_label = $normalized_label,
        c.type = $type,
        c.description = $description,
        c.source = $source,
        c.confidence = $confidence,
        c.tenant_id = $tenant_id,
        c.identity_strategy = $identity_strategy,
        c.created_at = datetime()${propertySetClause}
      ON MATCH SET
        c.uri = CASE WHEN c.uri IS NULL OR c.uri = '' THEN $uri ELSE c.uri END,
        c.label = CASE WHEN size($label) > size(coalesce(c.label, '')) THEN $label ELSE c.label END,
        c.normalized_label = $normalized_label,
        c.description = CASE WHEN size($description) > size(coalesce(c.description, '')) THEN $description ELSE c.description END,
        c.confidence = CASE WHEN $confidence > coalesce(c.confidence, 0) THEN $confidence ELSE c.confidence END,
        c.updated_at = datetime()${propertySetClause}
      RETURN c
    `;

    const params = {
      uri: concept.uri,
      concept_id: concept.concept_id || uuidv4(),
      label: concept.label,
      normalized_label: normalizedLabel,
      identity_hash: identityHash,
      workspace_id: workspaceId,
      tenant_id: concept.tenant_id || null,
      type: nodeLabel,
      description: concept.description || '',
      source: concept.source || '',
      confidence: concept.confidence || 0.7,
      identity_strategy: usingIdentityKeys ? 'identity_keys' : 'normalized_label'
    };

    // Add property parameters
    for (const key of propertyKeys) {
      const sanitized = sanitizePropertyKey(key);
      params[`prop_${sanitized}`] = properties[key];
    }

    await session.run(query, params);

    return exists;
  }

  sanitizeLabelName(name) {
    if (!name) return 'Entity';
    // Remove special characters, spaces, and ensure it starts with a letter
    let sanitized = name
      .replace(/[^a-zA-Z0-9_]/g, '')
      .replace(/^[0-9]+/, '');
    
    // Capitalize first letter for convention
    if (sanitized.length > 0) {
      sanitized = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
    }
    
    return sanitized || 'Entity';
  }

  /**
   * Create MENTIONED_IN relationships between Concepts/Entities and Chunks
   * Works with :Concept nodes (which may have additional type labels like :Concept:Person)
   */
  async createConceptMentions(mentions) {
    const session = this.getSession();
    let createdCount = 0;

    try {
      for (const mention of mentions) {
        // Match nodes by URI (labels vary: :Person, :Skill, :Organization, etc.)
        const query = `
          MATCH (c {uri: $conceptUri})
          MATCH (ch:Chunk {uri: $chunkUri})
          MERGE (c)-[r:MENTIONED_IN]->(ch)
          SET r.relevance = $relevance,
              r.start_char = $start_char,
              r.end_char = $end_char
          RETURN r
        `;

        try {
          await session.run(query, {
            conceptUri: mention.conceptUri,
            chunkUri: mention.chunkUri,
            relevance: mention.relevance || 0.8,
            start_char: mention.startChar ? neo4j.int(mention.startChar) : null,
            end_char: mention.endChar ? neo4j.int(mention.endChar) : null
          });
          createdCount++;
        } catch (e) {
          // Chunk or concept might not exist, skip
        }
      }

      console.log(`   🔗 Created ${createdCount} MENTIONED_IN relationships`);
      return { mentionsCreated: createdCount };
    } finally {
      await session.close();
    }
  }

  /**
   * Create RELATED_TO relationships between Concepts
   * Tries to match by URI first, then normalized_label, then falls back to label matching
   */
  async createConceptRelations(relations) {
    const entityUriService = require('./entityUriService');
    const session = this.getSession();
    let relatedCount = 0;
    let isaCount = 0;
    let skippedCount = 0;

    console.log(`   Processing ${relations.length} relationships...`);

    try {
      for (const rel of relations) {
        if (relatedCount + isaCount + skippedCount < 5) {
          console.log(`      [${relatedCount + isaCount + 1}] ${rel.sourceLabel} --[${rel.predicate}]--> ${rel.targetLabel}`);
        }
        
        // Generate normalized labels for matching
        const sourceNormalized = entityUriService.normalizeLabel(rel.sourceLabel || '');
        const targetNormalized = entityUriService.normalizeLabel(rel.targetLabel || '');
        
        if (rel.type === 'IS_A') {
          // Build dynamic SET clause for properties
          const relProperties = rel.properties || {};
          const propertyKeys = Object.keys(relProperties);
          const propertySetClause = propertyKeys.length > 0 
            ? ', ' + propertyKeys.map(key => `r.${key} = $prop_${key}`).join(', ')
            : '';
          
          // Try matching by URI first, then normalized_label, then label
          const query = `
            OPTIONAL MATCH (child1 {uri: $sourceUri})
            OPTIONAL MATCH (child2) WHERE child2.normalized_label = $sourceNormalized AND child1 IS NULL
            OPTIONAL MATCH (child3) WHERE toLower(child3.label) = toLower($sourceLabel) AND child1 IS NULL AND child2 IS NULL
            OPTIONAL MATCH (parent1 {uri: $targetUri})
            OPTIONAL MATCH (parent2) WHERE parent2.normalized_label = $targetNormalized AND parent1 IS NULL
            OPTIONAL MATCH (parent3) WHERE toLower(parent3.label) = toLower($targetLabel) AND parent1 IS NULL AND parent2 IS NULL
            WITH coalesce(child1, child2, child3) as child, coalesce(parent1, parent2, parent3) as parent
            WHERE child IS NOT NULL AND parent IS NOT NULL AND child <> parent
            MERGE (child)-[r:IS_A]->(parent)
            SET r.confidence = $confidence${propertySetClause}
            RETURN r
          `;

          const params = {
            sourceUri: rel.sourceUri,
            targetUri: rel.targetUri,
            sourceLabel: rel.sourceLabel || '',
            targetLabel: rel.targetLabel || '',
            sourceNormalized: sourceNormalized,
            targetNormalized: targetNormalized,
            confidence: rel.confidence || 0.8
          };
          
          // Add property parameters
          for (const key of propertyKeys) {
            params[`prop_${key}`] = relProperties[key];
          }
          
          try {
            const result = await session.run(query, params);
            if (result.records.length > 0 && result.records[0].get('r')) {
              isaCount++;
            } else {
              skippedCount++;
            }
          } catch (e) {
            skippedCount++;
          }
        } else {
          // Build dynamic SET clause for properties
          const relProperties = rel.properties || {};
          const propertyKeys = Object.keys(relProperties);
          const propertySetClause = propertyKeys.length > 0 
            ? ', ' + propertyKeys.map(key => `r.${key} = $prop_${key}`).join(', ')
            : '';
          
          // Try matching by URI first, then normalized_label, then label
          const query = `
            OPTIONAL MATCH (c1a {uri: $sourceUri})
            OPTIONAL MATCH (c1b) WHERE c1b.normalized_label = $sourceNormalized AND c1a IS NULL
            OPTIONAL MATCH (c1c) WHERE toLower(c1c.label) = toLower($sourceLabel) AND c1a IS NULL AND c1b IS NULL
            OPTIONAL MATCH (c2a {uri: $targetUri})
            OPTIONAL MATCH (c2b) WHERE c2b.normalized_label = $targetNormalized AND c2a IS NULL
            OPTIONAL MATCH (c2c) WHERE toLower(c2c.label) = toLower($targetLabel) AND c2a IS NULL AND c2b IS NULL
            WITH coalesce(c1a, c1b, c1c) as c1, coalesce(c2a, c2b, c2c) as c2
            WHERE c1 IS NOT NULL AND c2 IS NOT NULL AND c1 <> c2
            MERGE (c1)-[r:RELATED_TO]->(c2)
            SET r.predicate = $predicate,
                r.relevance = $relevance,
                r.confidence = $confidence,
                r.source_uri = $source_uri${propertySetClause}
            RETURN r
          `;

          const params = {
            sourceUri: rel.sourceUri,
            targetUri: rel.targetUri,
            sourceLabel: rel.sourceLabel || '',
            targetLabel: rel.targetLabel || '',
            sourceNormalized: sourceNormalized,
            targetNormalized: targetNormalized,
            predicate: rel.predicate || 'RELATED_TO',
            relevance: rel.relevance || 0.7,
            confidence: rel.confidence || 0.7,
            source_uri: rel.source_uri || ''
          };
          
          // Add property parameters
          for (const key of propertyKeys) {
            params[`prop_${key}`] = relProperties[key];
          }

          try {
            const result = await session.run(query, params);
            if (result.records.length > 0 && result.records[0].get('r')) {
              relatedCount++;
            } else {
              skippedCount++;
            }
          } catch (e) {
            skippedCount++;
          }
        }
      }

      console.log(`   🔗 Created ${relatedCount} RELATED_TO and ${isaCount} IS_A relationships (${skippedCount} skipped - concepts not found)`);
      return { relatedCreated: relatedCount, isaCreated: isaCount, skipped: skippedCount };
    } finally {
      await session.close();
    }
  }

  /**
   * Find concepts related to a query (for Graph RAG)
   * Searches across all concept types dynamically
   * Uses normalized_label for consistent matching
   * Searches: normalized_label, label, type, node labels, description
   */
  async findRelatedConcepts(query, limit = 20, depth = 1) {
    const entityUriService = require('./entityUriService');
    const session = this.getSession();

    try {
      // Normalize search term for better matching
      const normalizedTerm = query.toLowerCase().trim();
      // Use entityUriService for consistent normalization
      const normalizedForMatching = entityUriService.normalizeLabel(query);
      
      // Create variations for fuzzy matching
      const searchVariations = [
        normalizedTerm,
        normalizedTerm.replace(/\s+/g, ''),  // Remove spaces
        normalizedTerm.replace(/\s+/g, '_'), // Replace spaces with underscore
        normalizedTerm.replace(/s$/, ''),     // Remove trailing s (plural)
        normalizedTerm.charAt(0).toUpperCase() + normalizedTerm.slice(1), // Capitalize first
        normalizedTerm.toUpperCase(), // All caps
        normalizedForMatching  // Add normalized version
      ];
      
      // Singular form for type matching (parties -> party, cases -> case)
      const singularTerm = normalizedTerm
        .replace(/ies$/, 'y')  // parties -> party
        .replace(/es$/, '')    // cases -> case (but careful with other words)
        .replace(/s$/, '');    // contracts -> contract

      console.log(`   🔍 Searching for concept: "${query}" (normalized: ${normalizedForMatching}, depth: ${depth})`);

      // Clamp depth to 1-3 range
      const safeDepth = Math.max(1, Math.min(3, depth));

      // Search across ALL nodes with variable depth relationship traversal
      // Uses normalized_label for consistent matching
      const searchQuery = `
        MATCH (c)
        WHERE c.label IS NOT NULL
          AND NOT c:Document AND NOT c:Chunk AND NOT c:Folder
          AND (
            // 0. Match by normalized_label (most reliable for deduped entities)
            c.normalized_label = $normalizedForMatching
            OR c.normalized_label CONTAINS $normalizedForMatching
            
            // 1. Match by concept label (name) - highest priority
            OR toLower(c.label) = toLower($searchTerm)
            OR toLower(c.label) CONTAINS toLower($searchTerm)
            OR any(term IN $variations WHERE toLower(c.label) CONTAINS toLower(term))
            OR any(word IN split(toLower(c.label), ' ') WHERE word = toLower($searchTerm) OR word = $singularTerm)
            
            // 2. Match by Neo4j node label (e.g., :Party, :Contract)
            OR any(nodeLabel IN labels(c) WHERE toLower(nodeLabel) = toLower($searchTerm) OR toLower(nodeLabel) = $singularTerm)
            
            // 3. Match by type property
            OR toLower(coalesce(c.type, '')) = toLower($searchTerm)
            OR toLower(coalesce(c.type, '')) = $singularTerm
            
            // 4. Match by description (lower priority but useful)
            OR toLower(coalesce(c.description, '')) CONTAINS toLower($searchTerm)
          )
        // Variable depth relationship traversal (1 to N hops)
        OPTIONAL MATCH path = (c)-[r:RELATED_TO|IS_A*1..${safeDepth}]-(related)
        WHERE related.label IS NOT NULL AND related <> c
        WITH c, labels(c) as nodeLabels,
             collect(DISTINCT {
               concept: related.label,
               type: type(last(relationships(path))),
               predicate: last(relationships(path)).predicate,
               depth: length(path)
             }) as allRels
        // Get mentions separately to avoid cartesian product
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(ch:Chunk)-[:PART_OF]->(d:Document)
        WITH c, nodeLabels, allRels,
             collect(DISTINCT {
               chunkUri: ch.uri,
               chunkText: left(ch.text, 200),
               docTitle: d.title
             }) as allMentions
        RETURN c,
               nodeLabels[0] as conceptType,
               [rel IN allRels WHERE rel.depth = 1][0..5] as directRelations,
               [rel IN allRels WHERE rel.depth > 1][0..5] as indirectRelations,
               allMentions[0..3] as mentions,
               CASE 
                 // Exact normalized_label match = highest score
                 WHEN c.normalized_label = $normalizedForMatching THEN 1.0
                 // Exact label match
                 WHEN toLower(c.label) = toLower($searchTerm) THEN 0.98
                 // Node label/type match = very high (finds all Party nodes when searching "party")
                 WHEN any(nodeLabel IN nodeLabels WHERE toLower(nodeLabel) = toLower($searchTerm) OR toLower(nodeLabel) = $singularTerm) THEN 0.95
                 WHEN toLower(coalesce(c.type, '')) = toLower($searchTerm) OR toLower(coalesce(c.type, '')) = $singularTerm THEN 0.95
                 // Label starts with search term
                 WHEN toLower(c.label) STARTS WITH toLower($searchTerm) THEN 0.9
                 // Label contains search term
                 WHEN toLower(c.label) CONTAINS toLower($searchTerm) THEN 0.8
                 // normalized_label contains
                 WHEN c.normalized_label CONTAINS $normalizedForMatching THEN 0.75
                 // Description contains search term = lower score
                 WHEN toLower(coalesce(c.description, '')) CONTAINS toLower($searchTerm) THEN 0.6
                 ELSE 0.5
               END as score
        ORDER BY score DESC
        LIMIT $limit
      `;

      const result = await session.run(searchQuery, {
        searchTerm: query,
        normalizedForMatching: normalizedForMatching,
        singularTerm: singularTerm,
        variations: searchVariations,
        limit: neo4j.int(limit)
      });
      
      const found = result.records.map(r => {
        const props = r.get('c').properties;
        const conceptType = r.get('conceptType');
        const directRelations = r.get('directRelations') || [];
        const indirectRelations = r.get('indirectRelations') || [];
        
        // Combine relations, marking depth
        const allRelations = [
          ...directRelations.map(rel => ({ ...rel, isDirect: true })),
          ...indirectRelations.map(rel => ({ ...rel, isDirect: false }))
        ];
        
        return {
          concept: {
            ...props,
            type: conceptType || props.type || 'Concept'
          },
          relations: allRelations.filter(rel => rel.concept),
          mentions: r.get('mentions').filter(m => m.chunkUri),
          score: r.get('score')
        };
      });
      
      console.log(`   ✅ Found ${found.length} concepts matching "${query}"`);
      if (found.length > 0) {
        const directCount = found.reduce((sum, f) => sum + f.relations.filter(r => r.isDirect).length, 0);
        const indirectCount = found.reduce((sum, f) => sum + f.relations.filter(r => !r.isDirect).length, 0);
        console.log(`   📝 Matched: ${found.slice(0, 5).map(f => `${f.concept?.label} (${f.concept?.type}, score:${f.score?.toFixed(2)})`).join(', ')}`);
        console.log(`   🔗 Relations: ${directCount} direct, ${indirectCount} indirect (depth > 1)`);
      }
      
      return found;
    } catch (e) {
      console.error(`   ❌ Error searching concepts: ${e.message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Get chunks for concepts (for Graph RAG context)
   * Works with type-specific concept labels (Person, Location, etc.)
   */
  async getChunksForConcepts(conceptUris, limit = 10) {
    const session = this.getSession();

    try {
      const query = `
        MATCH (c)-[m:MENTIONED_IN]->(ch:Chunk)-[:PART_OF]->(d:Document)
        WHERE c.uri IN $conceptUris
          AND c.label IS NOT NULL
        WITH ch, d, c, m
        ORDER BY m.relevance DESC
        WITH ch, d, collect({concept: c.label, relevance: m.relevance})[0..5] as concepts
        RETURN ch, d.title as docTitle, d.uri as docUri, concepts
        LIMIT $limit
      `;

      const result = await session.run(query, {
        conceptUris: conceptUris,
        limit: neo4j.int(limit)
      });

      return result.records.map(r => ({
        chunk: r.get('ch').properties,
        docTitle: r.get('docTitle'),
        docUri: r.get('docUri'),
        concepts: r.get('concepts')
      }));
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // LEGACY ONTOLOGY OPERATIONS (kept for backward compatibility)
  // ============================================================

  async createKnowledgeGraph(ontology) {
    try {
      await driver.verifyConnectivity();
    } catch (error) {
      throw new Error('Neo4j database is not available. Please ensure Neo4j is running.');
    }

    const session = this.getSession();

    try {
      // Create ontology node (deprecated - ontologies stored in Redis)
      console.warn('⚠️  Creating legacy ontology graph. Consider using Redis-stored templates instead.');
      await this.createOntology(session, ontology);

      // Create class nodes
      for (const cls of ontology.classes) {
        await this.createClass(session, cls, ontology.uri);
      }

      // Create property nodes
      for (const prop of ontology.properties) {
        await this.createProperty(session, prop, ontology.uri);
      }

      // Create individuals
      for (const individual of ontology.individuals) {
        await this.createIndividual(session, individual, ontology.uri);
      }

      // Create subclass relationships
      for (const cls of ontology.classes) {
        if (cls.subClassOf?.length > 0) {
          for (const parentUri of cls.subClassOf) {
            await this.createSubClassRelationship(session, cls.uri, parentUri);
          }
        }
      }

      // Create property relationships
      for (const prop of ontology.properties) {
        for (const domainUri of prop.domain || []) {
          await this.createPropertyDomainRelationship(session, prop.uri, domainUri);
        }
        for (const rangeUri of prop.range || []) {
          await this.createPropertyRangeRelationship(session, prop.uri, rangeUri);
        }
      }

      return {
        success: true,
        message: 'Knowledge graph created successfully',
        stats: {
          classes: ontology.classes.length,
          properties: ontology.properties.length,
          individuals: ontology.individuals.length
        }
      };
    } finally {
      await session.close();
    }
  }

  /**
   * @deprecated Legacy ontology creation - ontologies are now stored in Redis
   * This method is kept for backwards compatibility but should not be used
   */
  async createOntology(session, ontology) {
    console.warn('⚠️  createOntology() is deprecated. Ontologies are now stored in Redis.');
    const query = `
      MERGE (o:Ontology {uri: $uri})
      SET o.name = $name, o.createdAt = datetime()
      RETURN o
    `;
    await session.run(query, {
      uri: ontology.uri,
      name: this.extractNameFromURI(ontology.uri)
    });
  }

  async createClass(session, cls, ontologyUri) {
    const query = `
      MERGE (c:Class {uri: $uri})
      SET c.label = $label, c.comment = $comment, c.ontologyUri = $ontologyUri
      WITH c
      MATCH (o:Ontology {uri: $ontologyUri})
      MERGE (c)-[:BELONGS_TO]->(o)
      RETURN c
    `;
    await session.run(query, {
      uri: cls.uri,
      label: cls.label || this.extractNameFromURI(cls.uri),
      comment: cls.comment || null,
      ontologyUri: ontologyUri
    });
  }

  async createProperty(session, prop, ontologyUri) {
    const query = `
      MERGE (p:Property {uri: $uri})
      SET p.label = $label, p.comment = $comment, p.ontologyUri = $ontologyUri
      WITH p
      MATCH (o:Ontology {uri: $ontologyUri})
      MERGE (p)-[:BELONGS_TO]->(o)
      RETURN p
    `;
    await session.run(query, {
      uri: prop.uri,
      label: prop.label || this.extractNameFromURI(prop.uri),
      comment: prop.comment || null,
      ontologyUri: ontologyUri
    });
  }

  async createIndividual(session, individual, ontologyUri) {
    const query = `
      MERGE (i:Individual {uri: $uri})
      SET i.label = $label, i.ontologyUri = $ontologyUri
      WITH i
      MATCH (o:Ontology {uri: $ontologyUri})
      MERGE (i)-[:BELONGS_TO]->(o)
    `;

    await session.run(query, {
      uri: individual.uri,
      label: individual.label || this.extractNameFromURI(individual.uri),
      ontologyUri: ontologyUri
    });

    for (const typeUri of individual.type || []) {
      const typeQuery = `
        MATCH (i:Individual {uri: $individualUri})
        MATCH (c:Class {uri: $typeUri})
        MERGE (i)-[:INSTANCE_OF]->(c)
      `;
      await session.run(typeQuery, { individualUri: individual.uri, typeUri });
    }
  }

  async createSubClassRelationship(session, childUri, parentUri) {
    const query = `
      MATCH (child:Class {uri: $childUri})
      MATCH (parent:Class {uri: $parentUri})
      MERGE (child)-[:SUBCLASS_OF]->(parent)
    `;
    await session.run(query, { childUri, parentUri });
  }

  async createPropertyDomainRelationship(session, propUri, domainUri) {
    const query = `
      MATCH (p:Property {uri: $propUri})
      MATCH (d:Class {uri: $domainUri})
      MERGE (p)-[:HAS_DOMAIN]->(d)
    `;
    await session.run(query, { propUri, domainUri });
  }

  async createPropertyRangeRelationship(session, propUri, rangeUri) {
    const query = `
      MATCH (p:Property {uri: $propUri})
      MATCH (r:Class {uri: $rangeUri})
      MERGE (p)-[:HAS_RANGE]->(r)
    `;
    await session.run(query, { propUri, rangeUri });
  }

  // ============================================================
  // WORKSPACE-SCOPED QUERY METHODS (Multi-Tenant)
  // ============================================================

  /**
   * Get all documents for a workspace (relationship-based)
   * @param {string} workspaceId - Workspace ID
   * @param {Object} options - Query options (limit, offset)
   */
  async getDocumentsForWorkspace(workspaceId, options = {}) {
    const session = this.getSession();
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    try {
      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (w)-[:CONTAINS_DOCUMENT]->(d:Document)
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        WITH d, count(ch) as chunkCount
        RETURN d, chunkCount
        ORDER BY d.created_at DESC
        SKIP $offset
        LIMIT $limit
      `;

      const result = await session.run(query, {
        workspace_id: workspaceId,
        offset: neo4j.int(offset),
        limit: neo4j.int(limit)
      });

      return result.records.map(record => ({
        ...record.get('d').properties,
        chunkCount: this.toNumber(record.get('chunkCount'))
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get all concepts for a workspace (via document/chunk relationships)
   * @param {string} workspaceId - Workspace ID
   * @param {Object} options - Query options (limit, type filter)
   */
  async getConceptsForWorkspace(workspaceId, options = {}) {
    const session = this.getSession();
    const limit = options.limit || 100;
    const typeFilter = options.type || null;

    try {
      let typeClause = '';
      const params = {
        workspace_id: workspaceId,
        limit: neo4j.int(limit)
      };

      if (typeFilter) {
        typeClause = 'AND c.type = $type';
        params.type = typeFilter;
      }

      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (w)-[:CONTAINS_DOCUMENT]->(d:Document)
        MATCH (ch:Chunk)-[:PART_OF]->(d)
        MATCH (c)-[:MENTIONED_IN]->(ch)
        WHERE c.label IS NOT NULL ${typeClause}
        WITH DISTINCT c
        RETURN c
        ORDER BY c.label
        LIMIT $limit
      `;

      const result = await session.run(query, params);

      return result.records.map(record => record.get('c').properties);
    } finally {
      await session.close();
    }
  }

  /**
   * Find related concepts scoped to a workspace
   * Uses normalized_label for consistent matching across different label variations
   * @param {string} query - Search query
   * @param {string} workspaceId - Workspace ID for scoping
   * @param {number} limit - Max results
   * @param {number} depth - Relationship traversal depth
   */
  async findRelatedConceptsInWorkspace(query, workspaceId, limit = 20, depth = 1) {
    const entityUriService = require('./entityUriService');
    const session = this.getSession();

    try {
      const normalizedTerm = query.toLowerCase().trim();
      // Use entityUriService for consistent normalization
      const normalizedForMatching = entityUriService.normalizeLabel(query);
      const singularTerm = normalizedTerm
        .replace(/ies$/, 'y')
        .replace(/es$/, '')
        .replace(/s$/, '');

      const searchVariations = [
        normalizedTerm,
        normalizedTerm.replace(/\s+/g, ''),
        normalizedTerm.replace(/\s+/g, '_'),
        normalizedTerm.replace(/s$/, ''),
        normalizedTerm.charAt(0).toUpperCase() + normalizedTerm.slice(1),
        normalizedTerm.toUpperCase(),
        normalizedForMatching  // Add normalized version for matching
      ];

      console.log(`   🔍 Searching for concept in workspace ${workspaceId}: "${query}" (normalized: ${normalizedForMatching}, depth: ${depth})`);

      const safeDepth = Math.max(1, Math.min(3, depth));

      // Workspace-scoped search using normalized_label for consistent matching
      // This ensures entities are found regardless of case/spacing variations
      const searchQuery = `
        MATCH (c)
        WHERE c.label IS NOT NULL
          AND (c.workspace_id = $workspace_id OR c.workspace_id = 'global')
          AND (
            // Match by normalized_label (most reliable for deduped entities)
            c.normalized_label = $normalizedForMatching
            OR c.normalized_label CONTAINS $normalizedForMatching
            // Match by label
            OR toLower(c.label) = toLower($searchTerm)
            OR toLower(c.label) CONTAINS toLower($searchTerm)
            OR any(term IN $variations WHERE toLower(c.label) CONTAINS toLower(term))
            OR any(word IN split(toLower(c.label), ' ') WHERE word = toLower($searchTerm) OR word = $singularTerm)
            // Match by Neo4j node label (type)
            OR any(nodeLabel IN labels(c) WHERE toLower(nodeLabel) = toLower($searchTerm) OR toLower(nodeLabel) = $singularTerm)
            // Match by type property
            OR toLower(coalesce(c.type, '')) = toLower($searchTerm)
            OR toLower(coalesce(c.type, '')) = $singularTerm
            // Match by description
            OR toLower(coalesce(c.description, '')) CONTAINS toLower($searchTerm)
          )
        WITH DISTINCT c, labels(c) as nodeLabels
        OPTIONAL MATCH path = (c)-[r:RELATED_TO|IS_A*1..${safeDepth}]-(related)
        WHERE related.label IS NOT NULL AND related <> c
        WITH c, nodeLabels,
             collect(DISTINCT {
               concept: related.label,
               type: type(last(relationships(path))),
               predicate: last(relationships(path)).predicate,
               depth: length(path)
             }) as allRels
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(ch2:Chunk)-[:PART_OF]->(d2:Document)
        WITH c, nodeLabels, allRels,
             collect(DISTINCT {
               chunkUri: ch2.uri,
               chunkText: left(ch2.text, 200),
               docTitle: d2.title
             }) as allMentions
        RETURN c,
               nodeLabels[0] as conceptType,
               [rel IN allRels WHERE rel.depth = 1][0..5] as directRelations,
               [rel IN allRels WHERE rel.depth > 1][0..5] as indirectRelations,
               allMentions[0..3] as mentions,
               CASE 
                 // Exact normalized_label match = highest score
                 WHEN c.normalized_label = $normalizedForMatching THEN 1.0
                 // Exact label match
                 WHEN toLower(c.label) = toLower($searchTerm) THEN 0.98
                 // Node label/type match
                 WHEN any(nodeLabel IN nodeLabels WHERE toLower(nodeLabel) = toLower($searchTerm) OR toLower(nodeLabel) = $singularTerm) THEN 0.95
                 WHEN toLower(coalesce(c.type, '')) = toLower($searchTerm) OR toLower(coalesce(c.type, '')) = $singularTerm THEN 0.95
                 // Label starts with search term
                 WHEN toLower(c.label) STARTS WITH toLower($searchTerm) THEN 0.9
                 // Label contains search term
                 WHEN toLower(c.label) CONTAINS toLower($searchTerm) THEN 0.8
                 // normalized_label contains
                 WHEN c.normalized_label CONTAINS $normalizedForMatching THEN 0.75
                 // Description contains search term
                 WHEN toLower(coalesce(c.description, '')) CONTAINS toLower($searchTerm) THEN 0.6
                 ELSE 0.5
               END as score
        ORDER BY score DESC
        LIMIT $limit
      `;

      const result = await session.run(searchQuery, {
        workspace_id: workspaceId,
        searchTerm: query,
        normalizedForMatching: normalizedForMatching,
        singularTerm: singularTerm,
        variations: searchVariations,
        limit: neo4j.int(limit)
      });

      const found = result.records.map(r => {
        const props = r.get('c').properties;
        const conceptType = r.get('conceptType');
        const directRelations = r.get('directRelations') || [];
        const indirectRelations = r.get('indirectRelations') || [];

        const allRelations = [
          ...directRelations.map(rel => ({ ...rel, isDirect: true })),
          ...indirectRelations.map(rel => ({ ...rel, isDirect: false }))
        ];

        return {
          concept: {
            ...props,
            type: conceptType || props.type || 'Concept'
          },
          relations: allRelations.filter(rel => rel.concept),
          mentions: r.get('mentions').filter(m => m.chunkUri),
          score: r.get('score')
        };
      });

      console.log(`   ✅ Found ${found.length} concepts in workspace ${workspaceId}`);
      return found;
    } catch (e) {
      console.error(`   ❌ Error searching concepts in workspace: ${e.message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Get chunks for concepts scoped to a workspace
   * @param {Array} conceptUris - Concept URIs to find chunks for
   * @param {string} workspaceId - Workspace ID for scoping
   * @param {number} limit - Max results
   */
  async getChunksForConceptsInWorkspace(conceptUris, workspaceId, limit = 10) {
    const session = this.getSession();

    try {
      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        MATCH (w)-[:CONTAINS_DOCUMENT]->(d:Document)
        MATCH (ch:Chunk)-[:PART_OF]->(d)
        MATCH (c)-[m:MENTIONED_IN]->(ch)
        WHERE c.uri IN $conceptUris
          AND c.label IS NOT NULL
        WITH ch, d, c, m
        ORDER BY m.relevance DESC
        WITH ch, d, collect({concept: c.label, relevance: m.relevance})[0..5] as concepts
        RETURN ch, d.title as docTitle, d.uri as docUri, concepts
        LIMIT $limit
      `;

      const result = await session.run(query, {
        workspace_id: workspaceId,
        conceptUris: conceptUris,
        limit: neo4j.int(limit)
      });

      return result.records.map(r => ({
        chunk: r.get('ch').properties,
        docTitle: r.get('docTitle'),
        docUri: r.get('docUri'),
        concepts: r.get('concepts')
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get graph statistics for a workspace
   * @param {string} workspaceId - Workspace ID
   */
  async getWorkspaceGraphStats(workspaceId) {
    const session = this.getSession();

    try {
      const query = `
        MATCH (w:Workspace {workspace_id: $workspace_id})
        OPTIONAL MATCH (w)-[:CONTAINS_DOCUMENT]->(d:Document)
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(ch)
        WHERE c.label IS NOT NULL
        RETURN 
          count(DISTINCT d) as documents,
          count(DISTINCT ch) as chunks,
          count(DISTINCT c) as concepts
      `;

      const result = await session.run(query, { workspace_id: workspaceId });
      const record = result.records[0];

      return {
        documents: this.toNumber(record.get('documents')),
        chunks: this.toNumber(record.get('chunks')),
        concepts: this.toNumber(record.get('concepts'))
      };
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // STATISTICS AND UTILITY METHODS
  // ============================================================

  async getGraphStats(workspaceId = null) {
    try {
      await driver.verifyConnectivity();
    } catch (error) {
      return [];
    }

    const session = this.getSession();

    try {
      const wsFilter = workspaceId
        ? 'WHERE d.workspace_id = $workspaceId'
        : '';
      const params = {};
      if (workspaceId) params.workspaceId = workspaceId;

      const query = `
        MATCH (d:Document)
        ${wsFilter}
        OPTIONAL MATCH (ch:Chunk)-[:PART_OF]->(d)
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(ch)
        WHERE c.label IS NOT NULL
        WITH d, count(DISTINCT ch) as chunks, count(DISTINCT c) as concepts
        RETURN d.uri as documentUri,
               d.title as documentTitle,
               d.doc_type as docType,
               chunks,
               concepts
      `;

      const result = await session.run(query, params);
      return result.records.map(record => ({
        uri: record.get('documentUri'),
        title: record.get('documentTitle'),
        type: record.get('docType'),
        chunks: this.toNumber(record.get('chunks')),
        concepts: this.toNumber(record.get('concepts'))
      }));
    } finally {
      await session.close();
    }
  }

  async getGraphData(limit = 100, workspaceId = null) {
    try {
      await driver.verifyConnectivity();
    } catch (error) {
      return { nodes: [], relationships: [] };
    }

    const session = this.getSession();

    try {
      // Build workspace filter clause
      const wsFilter = workspaceId
        ? 'AND n.workspace_id = $workspaceId'
        : '';

      // Get knowledge graph nodes only (exclude Folder nodes from file manager)
      // Include: Document, Chunk, and any dynamically labeled concept nodes
      // Exclude: Folder nodes (file manager structure)
      const nodesQuery = `
        MATCH (n)
        WHERE NOT 'Folder' IN labels(n)
          AND NOT 'Workspace' IN labels(n)
          AND NOT 'Tenant' IN labels(n)
          ${wsFilter}
          AND (
            'Document' IN labels(n)
            OR 'Chunk' IN labels(n)
            OR (n.uri IS NOT NULL AND NOT n.uri STARTS WITH 'folder://')
            OR n.label IS NOT NULL
          )
        RETURN n
        ORDER BY 
          CASE 
            WHEN 'Document' IN labels(n) THEN 1
            WHEN 'Chunk' IN labels(n) THEN 2
            ELSE 3
          END,
          id(n) DESC
        LIMIT $limit
      `;

      const params = { limit: neo4j.int(Math.floor(limit)) };
      if (workspaceId) params.workspaceId = workspaceId;

      const nodesResult = await session.run(nodesQuery, params);

      const nodes = new Map();
      const nodeIds = new Set();

      // Collect all nodes first
      nodesResult.records.forEach(record => {
        const node = record.get('n');
        if (node) {
          const nodeId = node.identity.toString();
          nodeIds.add(nodeId);
          nodes.set(nodeId, {
            id: nodeId,
            labels: node.labels || [],
            properties: node.properties || {}
          });
        }
      });

      // Then get all relationships between these nodes (excluding CONTAINS relationships from folders)
      const relsQuery = `
        MATCH (n)-[r]->(m)
        WHERE id(n) IN $nodeIds 
          AND id(m) IN $nodeIds
          AND type(r) <> 'CONTAINS'  // Exclude folder CONTAINS relationships
        RETURN r, id(n) as startId, id(m) as endId
      `;

      const nodeIdList = Array.from(nodeIds).map(id => neo4j.int(id));
      const relsResult = await session.run(relsQuery, { nodeIds: nodeIdList });

      const relationships = [];

      relsResult.records.forEach(record => {
        const rel = record.get('r');
        const startId = record.get('startId');
        const endId = record.get('endId');

        if (rel && startId && endId) {
          // Use predicate property if available, otherwise fall back to relationship type
          const predicate = rel.properties?.predicate || rel.type;
          relationships.push({
            id: rel.identity.toString(),
            type: rel.type, // Keep the Neo4j relationship type (RELATED_TO, IS_A, etc.)
            predicate: predicate, // The semantic predicate (ORDERS_FROM, LOCATED_AT, etc.)
            start: startId.toString(),
            end: endId.toString(),
            properties: rel.properties || {}
          });
        }
      });

      return {
        nodes: Array.from(nodes.values()),
        relationships: relationships
      };
    } finally {
      await session.close();
    }
  }

  async checkConnection() {
    const database = driver.getDatabase();
    try {
      await driver.verifyConnectivity();
      const session = this.getSession();
      try {
        await session.run('RETURN 1 as test');
        return {
          connected: true,
          message: `Connected to Neo4j database: ${database}`,
          uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
          user: process.env.NEO4J_USER || 'neo4j',
          database: database
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      return {
        connected: false,
        message: 'Not connected to Neo4j database',
        error: error.message,
        uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
        user: process.env.NEO4J_USER || 'neo4j',
        database: database
      };
    }
  }

  extractNameFromURI(uri) {
    if (!uri) return 'Unknown';
    const parts = uri.split('#');
    if (parts.length > 1) return parts[parts.length - 1];
    const pathParts = uri.split('/');
    return pathParts[pathParts.length - 1] || 'Unknown';
  }

  /**
   * Get Neo4j schema - node labels, relationship types, and sample properties
   * Used for NL-to-Cypher query generation
   */
  async getSchema() {
    const session = this.getSession();
    try {
      // Get all node labels with counts and sample properties + values
      const labelsResult = await session.run(`
        CALL db.labels() YIELD label
        CALL {
          WITH label
          MATCH (n) WHERE label IN labels(n)
          WITH n LIMIT 3
          UNWIND keys(n) as key
          RETURN key, collect(DISTINCT n[key])[0..3] as sampleValues
        }
        CALL {
          WITH label
          MATCH (n) WHERE label IN labels(n)
          RETURN count(n) as cnt
        }
        RETURN label, cnt as count, collect({property: key, samples: sampleValues}) as properties
        ORDER BY cnt DESC
      `);

      // Get all relationship types with counts
      const relsResult = await session.run(`
        CALL db.relationshipTypes() YIELD relationshipType
        CALL {
          WITH relationshipType
          MATCH ()-[r]->() WHERE type(r) = relationshipType
          RETURN count(r) as cnt
        }
        RETURN relationshipType, cnt as count
        ORDER BY cnt DESC
      `);

      // Get relationship patterns (which labels connect via which relationships)
      const patternsResult = await session.run(`
        MATCH (a)-[r]->(b)
        WITH labels(a)[0] as fromLabel, type(r) as relType, labels(b)[0] as toLabel, count(*) as cnt
        WHERE cnt > 0
        RETURN fromLabel, relType, toLabel, cnt as count
        ORDER BY cnt DESC
        LIMIT 500
      `);

      const nodeLabels = labelsResult.records.map(r => ({
        label: r.get('label'),
        count: this.toNumber(r.get('count')),
        properties: (r.get('properties') || []).filter(p => p.property)
      }));

      const relationshipTypes = relsResult.records.map(r => ({
        type: r.get('relationshipType'),
        count: this.toNumber(r.get('count'))
      }));

      const patterns = patternsResult.records.map(r => ({
        from: r.get('fromLabel'),
        relationship: r.get('relType'),
        to: r.get('toLabel'),
        count: this.toNumber(r.get('count'))
      }));

      return { nodeLabels, relationshipTypes, patterns };
    } finally {
      await session.close();
    }
  }

  /**
   * Format schema as text for LLM context
   */
  formatSchemaForLLM(schema) {
    let text = '## Neo4j Graph Schema\n\n';
    
    text += '### Node Labels and Properties (USE EXACT VALUES SHOWN):\n';
    schema.nodeLabels.forEach(n => {
      text += `\n**${n.label}** (${n.count} nodes)\n`;
      if (n.properties?.length > 0) {
        n.properties.forEach(p => {
          const samples = (p.samples || []).filter(v => v !== null && v !== undefined);
          if (samples.length > 0) {
            const formattedSamples = samples.map(v => 
              typeof v === 'string' ? `"${v}"` : String(v)
            ).join(', ');
            text += `  - ${p.property}: EXACT VALUES = [${formattedSamples}]\n`;
          } else {
            text += `  - ${p.property}\n`;
          }
        });
      }
    });

    text += '\n### Relationship Types:\n';
    schema.relationshipTypes.forEach(r => {
      text += `- ${r.type} (${r.count})\n`;
    });

    text += '\n### Connection Patterns (ONLY these relationships exist — use EXACTLY as shown):\n';
    schema.patterns.forEach(p => {
      text += `- (${p.from})-[:${p.relationship}]->(${p.to}) [${p.count}]\n`;
    });

    return text;
  }
}

module.exports = new Neo4jService();
