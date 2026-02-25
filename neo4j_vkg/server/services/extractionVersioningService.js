/**
 * Extraction Versioning Service
 * Manages document extraction versions, snapshots, and rollback capabilities
 * 
 * Features:
 * - Extraction snapshots before overwriting
 * - Version history per document
 * - Rollback to previous versions
 * - Reference counting for shared concepts
 * - Audit trail for all operations
 */

const { client: redisClient, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');
const { v4: uuidv4 } = require('uuid');

// Redis key prefixes
const REDIS_KEYS = {
  // Document extraction metadata
  DOC_EXTRACTION_META: 'doc_extraction:', // doc_extraction:{doc_id} → current version info
  DOC_EXTRACTION_VERSIONS: 'doc_extractions:', // doc_extractions:{doc_id} → sorted set of versions
  
  // Extraction snapshots
  EXTRACTION_SNAPSHOT: 'extraction:', // extraction:{doc_id}:{version} → full snapshot
  
  // Concept reference tracking
  CONCEPT_REFS: 'concept_refs:', // concept_refs:{concept_id} → set of doc_ids
  CONCEPT_META: 'concept_meta:', // concept_meta:{concept_id} → metadata
  
  // Schema versioning
  SCHEMA_VERSIONS: 'schema:versions', // sorted set of schema versions
  SCHEMA_CURRENT: 'schema:current', // current schema version string
  SCHEMA_DATA: 'schema:data:', // schema:data:{version} → schema definition
  
  // Audit log
  AUDIT_LOG: 'audit:extractions', // list of audit entries
  AUDIT_LOG_MAX: 10000 // max entries to keep
};

class ExtractionVersioningService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
    console.log('✅ ExtractionVersioningService initialized');
  }

  // ============================================================
  // EXTRACTION SNAPSHOTS
  // ============================================================

  /**
   * Create a snapshot before extraction (or re-extraction)
   * Call this BEFORE running extraction to preserve current state
   */
  async createPreExtractionSnapshot(docId) {
    await this.initialize();
    
    // Get current extraction data from Neo4j
    const currentData = await this.getCurrentExtractionFromNeo4j(docId);
    
    if (!currentData || (currentData.concepts.length === 0 && currentData.relations.length === 0)) {
      // No existing extraction, this is first time
      return null;
    }

    // Get current version number
    const meta = await this.getDocumentExtractionMeta(docId);
    const currentVersion = meta?.current_version || 0;

    // Create snapshot of current state
    const snapshotId = `v${currentVersion}`;
    const snapshot = {
      doc_id: docId,
      version: snapshotId,
      version_number: currentVersion,
      created_at: new Date().toISOString(),
      status: 'archived', // Will be superseded by new extraction
      
      // Full extraction data
      concepts: currentData.concepts,
      relations: currentData.relations,
      
      // Metadata
      concept_count: currentData.concepts.length,
      relation_count: currentData.relations.length,
      schema_version: meta?.schema_version || 'unknown',
      ontology_id: meta?.ontology_id || null,
      
      // For reference tracking
      concept_ids: currentData.concepts.map(c => c.concept_id)
    };

    // Store snapshot
    await redisClient.set(
      `${REDIS_KEYS.EXTRACTION_SNAPSHOT}${docId}:${snapshotId}`,
      JSON.stringify(snapshot)
    );

    // Add to version history
    await redisClient.zAdd(
      `${REDIS_KEYS.DOC_EXTRACTION_VERSIONS}${docId}`,
      { score: Date.now(), value: snapshotId }
    );

    console.log(`📸 Created pre-extraction snapshot for doc ${docId}: ${snapshotId}`);
    
    return snapshot;
  }

  /**
   * Save extraction result as new version
   * Call this AFTER extraction completes successfully
   */
  async saveExtractionVersion(docId, extractionData, metadata = {}) {
    await this.initialize();

    // Get next version number
    const meta = await this.getDocumentExtractionMeta(docId);
    const nextVersion = (meta?.current_version || 0) + 1;
    const versionId = `v${nextVersion}`;

    const snapshot = {
      doc_id: docId,
      version: versionId,
      version_number: nextVersion,
      created_at: new Date().toISOString(),
      status: 'current',
      
      // Extraction data
      concepts: extractionData.concepts || [],
      relations: extractionData.relations || [],
      
      // Stats
      concept_count: extractionData.concepts?.length || 0,
      relation_count: extractionData.relations?.length || 0,
      
      // Metadata
      schema_version: metadata.schema_version || await this.getCurrentSchemaVersion(),
      ontology_id: metadata.ontology_id || null,
      created_by: metadata.user_id || 'system',
      llm_model: metadata.llm_model || 'unknown',
      extraction_job_id: metadata.job_id || null,
      
      // LLM output vs user edits (for audit)
      llm_raw_output: metadata.llm_raw_output || null,
      user_modifications: metadata.user_modifications || [],
      
      // Reference tracking
      concept_ids: (extractionData.concepts || []).map(c => c.concept_id)
    };

    // Store snapshot
    await redisClient.set(
      `${REDIS_KEYS.EXTRACTION_SNAPSHOT}${docId}:${versionId}`,
      JSON.stringify(snapshot)
    );

    // Add to version history
    await redisClient.zAdd(
      `${REDIS_KEYS.DOC_EXTRACTION_VERSIONS}${docId}`,
      { score: Date.now(), value: versionId }
    );

    // Update document extraction metadata
    await redisClient.hSet(`${REDIS_KEYS.DOC_EXTRACTION_META}${docId}`, {
      doc_id: docId,
      current_version: String(nextVersion),
      current_version_id: versionId,
      last_extracted_at: new Date().toISOString(),
      schema_version: snapshot.schema_version,
      ontology_id: metadata.ontology_id || '',
      total_versions: String(nextVersion)
    });

    // Update concept references
    await this.updateConceptReferences(docId, extractionData.concepts || []);

    // Audit log
    await this.logAuditEntry({
      action: 'extraction_saved',
      doc_id: docId,
      version: versionId,
      user_id: metadata.user_id,
      details: {
        concept_count: snapshot.concept_count,
        relation_count: snapshot.relation_count,
        ontology_id: metadata.ontology_id
      }
    });

    console.log(`💾 Saved extraction version ${versionId} for doc ${docId}`);
    
    return snapshot;
  }

  /**
   * Get current extraction data from Neo4j
   */
  async getCurrentExtractionFromNeo4j(docId) {
    const session = neo4jService.getSession();
    try {
      // Get concepts
      const conceptsResult = await session.run(`
        MATCH (d:Document {doc_id: $docId})-[:MENTIONS]->(c:Concept)
        RETURN c.concept_id as concept_id, c.label as label, c.type as type,
               c.description as description, c.uri as uri, c.industry as industry,
               c.source as source, c.confidence as confidence
      `, { docId });

      const concepts = conceptsResult.records.map(r => ({
        concept_id: r.get('concept_id'),
        label: r.get('label'),
        type: r.get('type'),
        description: r.get('description'),
        uri: r.get('uri'),
        industry: r.get('industry'),
        source: r.get('source'),
        confidence: r.get('confidence')
      }));

      // Get relations between concepts in this document
      const relationsResult = await session.run(`
        MATCH (d:Document {doc_id: $docId})-[:MENTIONS]->(c1:Concept)
        MATCH (d)-[:MENTIONS]->(c2:Concept)
        MATCH (c1)-[r]->(c2)
        WHERE type(r) <> 'MENTIONS' AND c1 <> c2
        RETURN c1.concept_id as source_id, c1.label as source_label,
               type(r) as predicate, r.confidence as confidence,
               c2.concept_id as target_id, c2.label as target_label
      `, { docId });

      const relations = relationsResult.records.map(r => ({
        source_id: r.get('source_id'),
        source_label: r.get('source_label'),
        predicate: r.get('predicate'),
        confidence: r.get('confidence'),
        target_id: r.get('target_id'),
        target_label: r.get('target_label')
      }));

      return { concepts, relations };
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // VERSION HISTORY & RETRIEVAL
  // ============================================================

  /**
   * Get document extraction metadata
   */
  async getDocumentExtractionMeta(docId) {
    await this.initialize();
    
    const data = await redisClient.hGetAll(`${REDIS_KEYS.DOC_EXTRACTION_META}${docId}`);
    if (!data || Object.keys(data).length === 0) return null;
    
    return {
      ...data,
      current_version: parseInt(data.current_version) || 0,
      total_versions: parseInt(data.total_versions) || 0
    };
  }

  /**
   * Get all extraction versions for a document
   */
  async getExtractionVersions(docId) {
    await this.initialize();
    
    // Get version IDs sorted by timestamp (newest first)
    const versionIds = await redisClient.zRange(
      `${REDIS_KEYS.DOC_EXTRACTION_VERSIONS}${docId}`,
      0, -1,
      { REV: true }
    );

    if (!versionIds || versionIds.length === 0) return [];

    // Get metadata for each version (not full snapshot)
    const versions = [];
    for (const versionId of versionIds) {
      const snapshot = await this.getExtractionSnapshot(docId, versionId);
      if (snapshot) {
        versions.push({
          version: snapshot.version,
          version_number: snapshot.version_number,
          created_at: snapshot.created_at,
          status: snapshot.status,
          concept_count: snapshot.concept_count,
          relation_count: snapshot.relation_count,
          schema_version: snapshot.schema_version,
          ontology_id: snapshot.ontology_id,
          created_by: snapshot.created_by
        });
      }
    }

    return versions;
  }

  /**
   * Get a specific extraction snapshot
   */
  async getExtractionSnapshot(docId, versionId) {
    await this.initialize();
    
    const data = await redisClient.get(`${REDIS_KEYS.EXTRACTION_SNAPSHOT}${docId}:${versionId}`);
    if (!data) return null;
    
    return JSON.parse(data);
  }

  /**
   * Get current extraction snapshot for a document
   */
  async getCurrentExtractionSnapshot(docId) {
    const meta = await this.getDocumentExtractionMeta(docId);
    if (!meta?.current_version_id) return null;
    
    return this.getExtractionSnapshot(docId, meta.current_version_id);
  }

  // ============================================================
  // ROLLBACK
  // ============================================================

  /**
   * Rollback document to a previous extraction version
   */
  async rollbackToVersion(docId, targetVersionId, options = {}) {
    await this.initialize();
    
    const { user_id = 'system', reason = '' } = options;

    console.log(`\n🔄 ROLLBACK: Document ${docId} to version ${targetVersionId}`);
    console.log('-'.repeat(50));

    // Get target snapshot
    const targetSnapshot = await this.getExtractionSnapshot(docId, targetVersionId);
    if (!targetSnapshot) {
      throw new Error(`Snapshot not found: ${docId}:${targetVersionId}`);
    }

    // Get current state
    const currentMeta = await this.getDocumentExtractionMeta(docId);
    const currentSnapshot = currentMeta?.current_version_id 
      ? await this.getExtractionSnapshot(docId, currentMeta.current_version_id)
      : null;

    // Create snapshot of current state before rollback
    if (currentSnapshot && currentSnapshot.version !== targetVersionId) {
      await this.createPreExtractionSnapshot(docId);
    }

    const session = neo4jService.getSession();
    const tx = session.beginTransaction();

    try {
      // Step 1: Remove current concepts (with reference counting)
      if (currentSnapshot) {
        console.log(`   Removing ${currentSnapshot.concept_count} current concepts...`);
        await this.removeDocumentConcepts(docId, currentSnapshot.concept_ids || [], tx);
      }

      // Step 2: Restore target version concepts
      console.log(`   Restoring ${targetSnapshot.concept_count} concepts from ${targetVersionId}...`);
      await this.restoreConceptsFromSnapshot(docId, targetSnapshot, tx);

      // Commit transaction
      await tx.commit();

      // Step 3: Update metadata
      await redisClient.hSet(`${REDIS_KEYS.DOC_EXTRACTION_META}${docId}`, {
        current_version: String(targetSnapshot.version_number),
        current_version_id: targetVersionId,
        last_rollback_at: new Date().toISOString(),
        rollback_from: currentMeta?.current_version_id || '',
        rollback_reason: reason
      });

      // Update target snapshot status
      targetSnapshot.status = 'current';
      targetSnapshot.restored_at = new Date().toISOString();
      await redisClient.set(
        `${REDIS_KEYS.EXTRACTION_SNAPSHOT}${docId}:${targetVersionId}`,
        JSON.stringify(targetSnapshot)
      );

      // Mark old current as superseded
      if (currentSnapshot && currentSnapshot.version !== targetVersionId) {
        currentSnapshot.status = 'superseded';
        currentSnapshot.superseded_at = new Date().toISOString();
        currentSnapshot.superseded_by = targetVersionId;
        await redisClient.set(
          `${REDIS_KEYS.EXTRACTION_SNAPSHOT}${docId}:${currentSnapshot.version}`,
          JSON.stringify(currentSnapshot)
        );
      }

      // Audit log
      await this.logAuditEntry({
        action: 'rollback',
        doc_id: docId,
        version: targetVersionId,
        user_id,
        details: {
          from_version: currentMeta?.current_version_id,
          to_version: targetVersionId,
          reason,
          concepts_restored: targetSnapshot.concept_count,
          relations_restored: targetSnapshot.relation_count
        }
      });

      console.log(`   ✅ Rollback complete!`);
      
      return {
        success: true,
        doc_id: docId,
        rolled_back_to: targetVersionId,
        from_version: currentMeta?.current_version_id,
        concepts_restored: targetSnapshot.concept_count,
        relations_restored: targetSnapshot.relation_count
      };

    } catch (error) {
      await tx.rollback();
      console.error(`   ❌ Rollback failed:`, error.message);
      
      await this.logAuditEntry({
        action: 'rollback_failed',
        doc_id: docId,
        version: targetVersionId,
        user_id,
        details: { error: error.message }
      });
      
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Remove document's concepts from Neo4j (with reference counting)
   */
  async removeDocumentConcepts(docId, conceptIds, tx) {
    for (const conceptId of conceptIds) {
      // Check reference count
      const refCount = await this.getConceptReferenceCount(conceptId);
      
      if (refCount <= 1) {
        // Only this document references it - delete completely
        await tx.run(`
          MATCH (c:Concept {concept_id: $conceptId})
          DETACH DELETE c
        `, { conceptId });
      } else {
        // Other documents reference it - just remove relationship
        await tx.run(`
          MATCH (d:Document {doc_id: $docId})-[r:MENTIONS]->(c:Concept {concept_id: $conceptId})
          DELETE r
        `, { docId, conceptId });
      }
      
      // Update reference tracking
      await this.decrementConceptReference(conceptId, docId);
    }
  }

  /**
   * Restore concepts from a snapshot
   */
  async restoreConceptsFromSnapshot(docId, snapshot, tx) {
    // Restore concepts
    for (const concept of snapshot.concepts) {
      // Check if concept already exists (shared with other docs)
      const existsResult = await tx.run(`
        MATCH (c:Concept {concept_id: $conceptId})
        RETURN c
      `, { conceptId: concept.concept_id });

      if (existsResult.records.length === 0) {
        // Create concept
        await tx.run(`
          CREATE (c:Concept {
            concept_id: $conceptId,
            label: $label,
            type: $type,
            description: $description,
            uri: $uri,
            industry: $industry,
            source: $source,
            confidence: $confidence
          })
        `, {
          conceptId: concept.concept_id,
          label: concept.label || '',
          type: concept.type || 'Concept',
          description: concept.description || '',
          uri: concept.uri || '',
          industry: concept.industry || '',
          source: concept.source || docId,
          confidence: concept.confidence || 0.8
        });
      }

      // Create MENTIONS relationship
      await tx.run(`
        MATCH (d:Document {doc_id: $docId})
        MATCH (c:Concept {concept_id: $conceptId})
        MERGE (d)-[:MENTIONS]->(c)
      `, { docId, conceptId: concept.concept_id });

      // Update reference tracking
      await this.incrementConceptReference(concept.concept_id, docId);
    }

    // Restore relations
    for (const relation of snapshot.relations) {
      await tx.run(`
        MATCH (c1:Concept {concept_id: $sourceId})
        MATCH (c2:Concept {concept_id: $targetId})
        MERGE (c1)-[r:${relation.predicate}]->(c2)
        SET r.confidence = $confidence
      `, {
        sourceId: relation.source_id,
        targetId: relation.target_id,
        confidence: relation.confidence || 0.8
      });
    }
  }


  // ============================================================
  // CONCEPT REFERENCE COUNTING (Phase 2)
  // ============================================================

  /**
   * Update concept references when extraction is saved
   */
  async updateConceptReferences(docId, concepts) {
    for (const concept of concepts) {
      await this.incrementConceptReference(concept.concept_id, docId, concept);
    }
  }

  /**
   * Increment reference count for a concept
   */
  async incrementConceptReference(conceptId, docId, conceptData = null) {
    await this.initialize();
    
    // Add doc to concept's reference set
    await redisClient.sAdd(`${REDIS_KEYS.CONCEPT_REFS}${conceptId}`, docId);
    
    // Update concept metadata if provided
    if (conceptData) {
      const existing = await redisClient.hGetAll(`${REDIS_KEYS.CONCEPT_META}${conceptId}`);
      if (!existing || Object.keys(existing).length === 0) {
        await redisClient.hSet(`${REDIS_KEYS.CONCEPT_META}${conceptId}`, {
          concept_id: conceptId,
          label: conceptData.label || '',
          type: conceptData.type || 'Concept',
          created_from_doc: docId,
          created_at: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Decrement reference count for a concept
   */
  async decrementConceptReference(conceptId, docId) {
    await this.initialize();
    
    // Remove doc from concept's reference set
    await redisClient.sRem(`${REDIS_KEYS.CONCEPT_REFS}${conceptId}`, docId);
    
    // Check if concept is now orphaned
    const refCount = await this.getConceptReferenceCount(conceptId);
    if (refCount === 0) {
      // Clean up metadata
      await redisClient.del(`${REDIS_KEYS.CONCEPT_META}${conceptId}`);
    }
  }

  /**
   * Get reference count for a concept
   */
  async getConceptReferenceCount(conceptId) {
    await this.initialize();
    return await redisClient.sCard(`${REDIS_KEYS.CONCEPT_REFS}${conceptId}`);
  }

  /**
   * Get all documents that reference a concept
   */
  async getConceptReferences(conceptId) {
    await this.initialize();
    return await redisClient.sMembers(`${REDIS_KEYS.CONCEPT_REFS}${conceptId}`);
  }

  /**
   * Check if a concept is shared (referenced by multiple documents)
   */
  async isConceptShared(conceptId) {
    const count = await this.getConceptReferenceCount(conceptId);
    return count > 1;
  }

  /**
   * Get concept metadata
   */
  async getConceptMeta(conceptId) {
    await this.initialize();
    const data = await redisClient.hGetAll(`${REDIS_KEYS.CONCEPT_META}${conceptId}`);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  }

  /**
   * Find orphaned concepts (no document references)
   */
  async findOrphanedConcepts() {
    await this.initialize();
    
    // Get all concept meta keys using SCAN instead of KEYS
    const metaKeys = [];
    let scanCursor = '0';
    do {
      const result = await redisClient.sendCommand(['SCAN', scanCursor, 'MATCH', `${REDIS_KEYS.CONCEPT_META}*`, 'COUNT', '200']);
      scanCursor = result[0];
      metaKeys.push(...result[1]);
    } while (scanCursor !== '0');
    const orphaned = [];
    
    for (const key of metaKeys) {
      const conceptId = key.replace(REDIS_KEYS.CONCEPT_META, '');
      const refCount = await this.getConceptReferenceCount(conceptId);
      
      if (refCount === 0) {
        const meta = await this.getConceptMeta(conceptId);
        orphaned.push({ concept_id: conceptId, ...meta });
      }
    }
    
    return orphaned;
  }

  /**
   * Clean up orphaned concepts from Neo4j
   */
  async cleanupOrphanedConcepts() {
    const orphaned = await this.findOrphanedConcepts();
    
    if (orphaned.length === 0) {
      return { cleaned: 0 };
    }

    const session = neo4jService.getSession();
    try {
      let cleaned = 0;
      
      for (const concept of orphaned) {
        await session.run(`
          MATCH (c:Concept {concept_id: $conceptId})
          DETACH DELETE c
        `, { conceptId: concept.concept_id });
        
        // Clean up Redis metadata
        await redisClient.del(`${REDIS_KEYS.CONCEPT_META}${concept.concept_id}`);
        await redisClient.del(`${REDIS_KEYS.CONCEPT_REFS}${concept.concept_id}`);
        
        cleaned++;
      }

      await this.logAuditEntry({
        action: 'cleanup_orphaned_concepts',
        details: { cleaned, concepts: orphaned.map(c => c.concept_id) }
      });

      return { cleaned, concepts: orphaned };
    } finally {
      await session.close();
    }
  }

  // ============================================================
  // SCHEMA VERSIONING (Phase 3)
  // ============================================================

  /**
   * Get current schema version
   */
  async getCurrentSchemaVersion() {
    await this.initialize();
    return await redisClient.get(REDIS_KEYS.SCHEMA_CURRENT) || '1.0.0';
  }

  /**
   * Save a new schema version
   */
  async saveSchemaVersion(schemaData, metadata = {}) {
    await this.initialize();
    
    const currentVersion = await this.getCurrentSchemaVersion();
    const [major, minor, patch] = currentVersion.split('.').map(Number);
    
    // Determine version bump based on changes
    let newVersion;
    if (metadata.breaking) {
      newVersion = `${major + 1}.0.0`;
    } else if (metadata.newTypes || metadata.newRelations) {
      newVersion = `${major}.${minor + 1}.0`;
    } else {
      newVersion = `${major}.${minor}.${patch + 1}`;
    }

    const versionData = {
      version: newVersion,
      created_at: new Date().toISOString(),
      created_by: metadata.user_id || 'system',
      
      // Schema definition
      node_types: schemaData.nodeTypes || [],
      relationship_types: schemaData.relationshipTypes || [],
      
      // Change tracking
      changes: metadata.changes || [],
      previous_version: currentVersion,
      
      // Stats
      node_type_count: schemaData.nodeTypes?.length || 0,
      relationship_type_count: schemaData.relationshipTypes?.length || 0
    };

    // Store schema version
    await redisClient.set(
      `${REDIS_KEYS.SCHEMA_DATA}${newVersion}`,
      JSON.stringify(versionData)
    );

    // Add to version history
    await redisClient.zAdd(REDIS_KEYS.SCHEMA_VERSIONS, {
      score: Date.now(),
      value: newVersion
    });

    // Update current version
    await redisClient.set(REDIS_KEYS.SCHEMA_CURRENT, newVersion);

    await this.logAuditEntry({
      action: 'schema_version_created',
      details: {
        version: newVersion,
        previous: currentVersion,
        changes: metadata.changes
      }
    });

    return versionData;
  }

  /**
   * Get schema version data
   */
  async getSchemaVersion(version) {
    await this.initialize();
    const data = await redisClient.get(`${REDIS_KEYS.SCHEMA_DATA}${version}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Get all schema versions
   */
  async getSchemaVersionHistory() {
    await this.initialize();
    
    const versions = await redisClient.zRange(REDIS_KEYS.SCHEMA_VERSIONS, 0, -1, { REV: true });
    const history = [];
    
    for (const version of versions) {
      const data = await this.getSchemaVersion(version);
      if (data) {
        history.push({
          version: data.version,
          created_at: data.created_at,
          created_by: data.created_by,
          node_type_count: data.node_type_count,
          relationship_type_count: data.relationship_type_count,
          changes: data.changes
        });
      }
    }
    
    return history;
  }

  /**
   * Get documents that need re-extraction (schema mismatch)
   */
  async getDocumentsNeedingReExtraction(targetSchemaVersion = null) {
    await this.initialize();
    
    const currentSchema = targetSchemaVersion || await this.getCurrentSchemaVersion();
    // Use SCAN instead of KEYS
    const docMetaKeys = [];
    let scanCursor = '0';
    do {
      const result = await redisClient.sendCommand(['SCAN', scanCursor, 'MATCH', `${REDIS_KEYS.DOC_EXTRACTION_META}*`, 'COUNT', '200']);
      scanCursor = result[0];
      docMetaKeys.push(...result[1]);
    } while (scanCursor !== '0');
    
    const needsReExtraction = [];
    
    for (const key of docMetaKeys) {
      const meta = await redisClient.hGetAll(key);
      if (meta && meta.schema_version !== currentSchema) {
        needsReExtraction.push({
          doc_id: meta.doc_id,
          current_schema: meta.schema_version,
          target_schema: currentSchema,
          last_extracted: meta.last_extracted_at
        });
      }
    }
    
    return needsReExtraction;
  }

  // ============================================================
  // AUDIT TRAIL (Phase 3)
  // ============================================================

  /**
   * Log an audit entry
   */
  async logAuditEntry(entry) {
    await this.initialize();
    
    const auditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry
    };

    // Add to list (newest first)
    await redisClient.lPush(REDIS_KEYS.AUDIT_LOG, JSON.stringify(auditEntry));
    
    // Trim to max size
    await redisClient.lTrim(REDIS_KEYS.AUDIT_LOG, 0, REDIS_KEYS.AUDIT_LOG_MAX - 1);
  }

  /**
   * Get audit log entries
   */
  async getAuditLog(options = {}) {
    await this.initialize();
    
    const { limit = 100, offset = 0, doc_id = null, action = null } = options;
    
    // Get entries
    const entries = await redisClient.lRange(REDIS_KEYS.AUDIT_LOG, offset, offset + limit - 1);
    
    let parsed = entries.map(e => JSON.parse(e));
    
    // Filter if needed
    if (doc_id) {
      parsed = parsed.filter(e => e.doc_id === doc_id);
    }
    if (action) {
      parsed = parsed.filter(e => e.action === action);
    }
    
    return parsed;
  }

  /**
   * Get audit log for a specific document
   */
  async getDocumentAuditLog(docId, limit = 50) {
    return this.getAuditLog({ doc_id: docId, limit });
  }

  // ============================================================
  // DIFF & COMPARISON (Phase 4)
  // ============================================================

  /**
   * Compare two extraction versions
   */
  async compareVersions(docId, version1, version2) {
    const snapshot1 = await this.getExtractionSnapshot(docId, version1);
    const snapshot2 = await this.getExtractionSnapshot(docId, version2);

    if (!snapshot1 || !snapshot2) {
      throw new Error('One or both snapshots not found');
    }

    // Compare concepts
    const concepts1 = new Map(snapshot1.concepts.map(c => [c.concept_id, c]));
    const concepts2 = new Map(snapshot2.concepts.map(c => [c.concept_id, c]));

    const addedConcepts = [];
    const removedConcepts = [];
    const modifiedConcepts = [];

    // Find added and modified
    for (const [id, concept] of concepts2) {
      if (!concepts1.has(id)) {
        addedConcepts.push(concept);
      } else {
        const old = concepts1.get(id);
        if (old.label !== concept.label || old.type !== concept.type) {
          modifiedConcepts.push({ old, new: concept });
        }
      }
    }

    // Find removed
    for (const [id, concept] of concepts1) {
      if (!concepts2.has(id)) {
        removedConcepts.push(concept);
      }
    }

    // Compare relations
    const rels1 = new Set(snapshot1.relations.map(r => `${r.source_id}-${r.predicate}-${r.target_id}`));
    const rels2 = new Set(snapshot2.relations.map(r => `${r.source_id}-${r.predicate}-${r.target_id}`));

    const addedRelations = snapshot2.relations.filter(r => 
      !rels1.has(`${r.source_id}-${r.predicate}-${r.target_id}`)
    );
    const removedRelations = snapshot1.relations.filter(r => 
      !rels2.has(`${r.source_id}-${r.predicate}-${r.target_id}`)
    );

    return {
      version1: {
        version: version1,
        created_at: snapshot1.created_at,
        concept_count: snapshot1.concept_count,
        relation_count: snapshot1.relation_count
      },
      version2: {
        version: version2,
        created_at: snapshot2.created_at,
        concept_count: snapshot2.concept_count,
        relation_count: snapshot2.relation_count
      },
      diff: {
        concepts: {
          added: addedConcepts,
          removed: removedConcepts,
          modified: modifiedConcepts
        },
        relations: {
          added: addedRelations,
          removed: removedRelations
        }
      },
      summary: {
        concepts_added: addedConcepts.length,
        concepts_removed: removedConcepts.length,
        concepts_modified: modifiedConcepts.length,
        relations_added: addedRelations.length,
        relations_removed: removedRelations.length
      }
    };
  }

  // ============================================================
  // BULK OPERATIONS (Phase 4)
  // ============================================================

  /**
   * Bulk rollback multiple documents to their previous versions
   */
  async bulkRollback(docIds, options = {}) {
    const results = [];
    
    for (const docId of docIds) {
      try {
        // Get previous version
        const versions = await this.getExtractionVersions(docId);
        if (versions.length < 2) {
          results.push({ doc_id: docId, success: false, error: 'No previous version' });
          continue;
        }
        
        // Current is first, previous is second
        const previousVersion = versions[1].version;
        const result = await this.rollbackToVersion(docId, previousVersion, options);
        results.push({ doc_id: docId, success: true, ...result });
      } catch (error) {
        results.push({ doc_id: docId, success: false, error: error.message });
      }
    }

    await this.logAuditEntry({
      action: 'bulk_rollback',
      user_id: options.user_id,
      details: {
        doc_count: docIds.length,
        success_count: results.filter(r => r.success).length,
        failed_count: results.filter(r => !r.success).length
      }
    });

    return results;
  }

  /**
   * Get statistics about extraction versions
   */
  async getVersioningStats() {
    await this.initialize();
    
    const docMetaKeys = [];
    const conceptMetaKeys = [];
    const snapshotKeys = [];
    // Use SCAN instead of KEYS for all three patterns
    for (const [pattern, arr] of [
      [`${REDIS_KEYS.DOC_EXTRACTION_META}*`, docMetaKeys],
      [`${REDIS_KEYS.CONCEPT_META}*`, conceptMetaKeys],
      [`${REDIS_KEYS.EXTRACTION_SNAPSHOT}*`, snapshotKeys]
    ]) {
      let cursor = '0';
      do {
        const result = await redisClient.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
        cursor = result[0];
        arr.push(...result[1]);
      } while (cursor !== '0');
    }
    
    let totalVersions = 0;
    let docsWithMultipleVersions = 0;
    
    for (const key of docMetaKeys) {
      const meta = await redisClient.hGetAll(key);
      const versions = parseInt(meta.total_versions) || 0;
      totalVersions += versions;
      if (versions > 1) docsWithMultipleVersions++;
    }

    // Count shared concepts
    let sharedConcepts = 0;
    for (const key of conceptMetaKeys) {
      const conceptId = key.replace(REDIS_KEYS.CONCEPT_META, '');
      if (await this.isConceptShared(conceptId)) {
        sharedConcepts++;
      }
    }

    const currentSchema = await this.getCurrentSchemaVersion();
    const schemaVersions = await redisClient.zCard(REDIS_KEYS.SCHEMA_VERSIONS);

    return {
      documents_with_versions: docMetaKeys.length,
      documents_with_multiple_versions: docsWithMultipleVersions,
      total_extraction_versions: totalVersions,
      total_snapshots: snapshotKeys.length,
      tracked_concepts: conceptMetaKeys.length,
      shared_concepts: sharedConcepts,
      current_schema_version: currentSchema,
      schema_version_count: schemaVersions
    };
  }
}

module.exports = new ExtractionVersioningService();
