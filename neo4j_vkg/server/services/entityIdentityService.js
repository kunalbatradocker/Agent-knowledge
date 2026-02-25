/**
 * Entity Identity Service
 * Manages entity identity governance: deterministic IDs, merge/split operations
 * 
 * Key features:
 * - Deterministic canonical ID generation from identity keys
 * - Merge operations (combine two entities into one)
 * - Split operations (separate one entity into multiple)
 * - Alias tracking for merged entities
 * - Full audit trail
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { client: redisClient, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');

// Redis key prefixes
const KEYS = {
  IDENTITY: 'identity:',
  ALIASES: 'identity:aliases:',
  CHANGE_LOG: 'identity:changes:',
  CHANGE_INDEX: 'identity:changes:index:'
};

// Change types
const ChangeType = {
  MERGE: 'MERGE',
  SPLIT: 'SPLIT',
  RENAME: 'RENAME',
  RETYPE: 'RETYPE'
};

class EntityIdentityService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  /**
   * Generate deterministic canonical ID from class name and identity keys
   * @param {string} className - Entity class/type
   * @param {Object} identityKeys - Key-value pairs that uniquely identify the entity
   * @returns {string} - 32-character hex hash
   */
  generateCanonicalId(className, identityKeys) {
    if (!className) {
      throw new Error('className is required for canonical ID generation');
    }

    // Sort keys for deterministic ordering
    const sortedKeys = Object.keys(identityKeys || {}).sort();
    const keyString = sortedKeys.map(k => `${k}:${identityKeys[k]}`).join('|');
    const input = `${className.toLowerCase()}|${keyString.toLowerCase()}`;
    
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
  }

  /**
   * Merge two entities into one
   * @param {string} sourceEntityId - Entity to merge FROM (will be deleted)
   * @param {string} targetEntityId - Entity to merge INTO (will be kept)
   * @param {Object} options - Merge options
   */
  async mergeEntities(sourceEntityId, targetEntityId, options = {}) {
    await this.initialize();

    const { reason = '', performedBy = 'system', workspaceId, tenantId } = options;

    console.log(`\n🔀 MERGE: ${sourceEntityId} → ${targetEntityId}`);

    const session = neo4jService.getSession();
    const tx = session.beginTransaction();

    try {
      // 1. Get both entities
      const sourceResult = await tx.run(`
        MATCH (n) WHERE n.concept_id = $sourceId OR n.canonical_id = $sourceId
        RETURN n, labels(n) as labels, id(n) as nodeId
      `, { sourceId: sourceEntityId });

      const targetResult = await tx.run(`
        MATCH (n) WHERE n.concept_id = $targetId OR n.canonical_id = $targetId
        RETURN n, labels(n) as labels, id(n) as nodeId
      `, { targetId: targetEntityId });

      if (sourceResult.records.length === 0) {
        throw new Error(`Source entity not found: ${sourceEntityId}`);
      }
      if (targetResult.records.length === 0) {
        throw new Error(`Target entity not found: ${targetEntityId}`);
      }

      const sourceNode = sourceResult.records[0].get('n');
      const targetNode = targetResult.records[0].get('n');
      const sourceNodeId = neo4jService.toNumber(sourceResult.records[0].get('nodeId'));
      const targetNodeId = neo4jService.toNumber(targetResult.records[0].get('nodeId'));

      // 2. Merge properties (target wins on conflict, but keep source values as _merged_*)
      const mergedProps = { ...sourceNode.properties };
      for (const [key, value] of Object.entries(targetNode.properties)) {
        if (mergedProps[key] !== undefined && mergedProps[key] !== value) {
          // Keep source value as backup
          mergedProps[`_merged_${key}`] = mergedProps[key];
        }
        mergedProps[key] = value;
      }

      // Add merge metadata
      mergedProps.merged_from = sourceEntityId;
      mergedProps.merged_at = new Date().toISOString();
      mergedProps.merged_by = performedBy;

      // 3. Update target with merged properties
      await tx.run(`
        MATCH (n) WHERE id(n) = $nodeId
        SET n += $props
      `, { nodeId: targetNodeId, props: mergedProps });

      // 4. Redirect all relationships from source to target
      // Outgoing relationships
      await tx.run(`
        MATCH (source)-[r]->(other)
        WHERE id(source) = $sourceNodeId AND id(other) <> $targetNodeId
        MATCH (target) WHERE id(target) = $targetNodeId
        CALL {
          WITH r, target, other
          CREATE (target)-[newR:RELATED_TO]->(other)
          SET newR = properties(r)
          SET newR.redirected_from = $sourceId
          RETURN newR
        }
        DELETE r
      `, { sourceNodeId, targetNodeId, sourceId: sourceEntityId });

      // Incoming relationships
      await tx.run(`
        MATCH (other)-[r]->(source)
        WHERE id(source) = $sourceNodeId AND id(other) <> $targetNodeId
        MATCH (target) WHERE id(target) = $targetNodeId
        CALL {
          WITH r, target, other
          CREATE (other)-[newR:RELATED_TO]->(target)
          SET newR = properties(r)
          SET newR.redirected_from = $sourceId
          RETURN newR
        }
        DELETE r
      `, { sourceNodeId, targetNodeId, sourceId: sourceEntityId });

      // 5. Delete source entity
      await tx.run(`
        MATCH (n) WHERE id(n) = $nodeId
        DETACH DELETE n
      `, { nodeId: sourceNodeId });

      await tx.commit();

      // 6. Store alias mapping
      await this.addAlias(targetEntityId, sourceEntityId);

      // 7. Log the change
      const changeRecord = await this.logIdentityChange({
        change_type: ChangeType.MERGE,
        source_ids: [sourceEntityId],
        target_ids: [targetEntityId],
        reason,
        performed_by: performedBy,
        workspace_id: workspaceId,
        tenant_id: tenantId,
        rollback_data: {
          source_properties: sourceNode.properties,
          source_labels: sourceResult.records[0].get('labels')
        }
      });

      console.log(`   ✅ Merge complete. Source deleted, target updated.`);

      return {
        success: true,
        merged_into: targetEntityId,
        source_deleted: sourceEntityId,
        aliases_added: [sourceEntityId],
        change_id: changeRecord.change_id
      };

    } catch (error) {
      await tx.rollback();
      console.error(`   ❌ Merge failed:`, error.message);
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Split one entity into multiple entities
   * @param {string} sourceEntityId - Entity to split
   * @param {Array} splitDefinitions - Array of { className, identityKeys, attributes, relationships }
   * @param {Object} options - Split options
   */
  async splitEntity(sourceEntityId, splitDefinitions, options = {}) {
    await this.initialize();

    const { reason = '', performedBy = 'system', workspaceId, tenantId, deleteSource = true } = options;

    console.log(`\n✂️ SPLIT: ${sourceEntityId} → ${splitDefinitions.length} entities`);

    const session = neo4jService.getSession();
    const tx = session.beginTransaction();

    try {
      // 1. Get source entity
      const sourceResult = await tx.run(`
        MATCH (n) WHERE n.concept_id = $sourceId OR n.canonical_id = $sourceId
        RETURN n, labels(n) as labels, id(n) as nodeId
      `, { sourceId: sourceEntityId });

      if (sourceResult.records.length === 0) {
        throw new Error(`Source entity not found: ${sourceEntityId}`);
      }

      const sourceNode = sourceResult.records[0].get('n');
      const sourceLabels = sourceResult.records[0].get('labels');
      const sourceNodeId = neo4jService.toNumber(sourceResult.records[0].get('nodeId'));

      const newEntityIds = [];

      // 2. Create new entities from split definitions
      for (const def of splitDefinitions) {
        const newId = def.canonical_id || this.generateCanonicalId(def.className, def.identityKeys || {});
        const newConceptId = uuidv4();

        // Merge source properties with definition attributes
        const newProps = {
          ...sourceNode.properties,
          ...def.attributes,
          concept_id: newConceptId,
          canonical_id: newId,
          split_from: sourceEntityId,
          split_at: new Date().toISOString(),
          split_by: performedBy,
          workspace_id: workspaceId,
          tenant_id: tenantId
        };

        // Remove properties that shouldn't be copied
        delete newProps.merged_from;
        delete newProps.merged_at;

        const sanitizedClass = (def.className || 'Entity').replace(/[^a-zA-Z0-9_]/g, '');

        await tx.run(`
          CREATE (n:\`${sanitizedClass}\`)
          SET n = $props
          RETURN n
        `, { props: newProps });

        newEntityIds.push({
          concept_id: newConceptId,
          canonical_id: newId,
          class_name: def.className
        });
      }

      // 3. Optionally delete source
      if (deleteSource) {
        await tx.run(`
          MATCH (n) WHERE id(n) = $nodeId
          DETACH DELETE n
        `, { nodeId: sourceNodeId });
      }

      await tx.commit();

      // 4. Log the change
      const changeRecord = await this.logIdentityChange({
        change_type: ChangeType.SPLIT,
        source_ids: [sourceEntityId],
        target_ids: newEntityIds.map(e => e.canonical_id),
        reason,
        performed_by: performedBy,
        workspace_id: workspaceId,
        tenant_id: tenantId,
        rollback_data: {
          source_properties: sourceNode.properties,
          source_labels: sourceLabels,
          source_deleted: deleteSource
        }
      });

      console.log(`   ✅ Split complete. Created ${newEntityIds.length} new entities.`);

      return {
        success: true,
        source_entity: sourceEntityId,
        source_deleted: deleteSource,
        new_entities: newEntityIds,
        change_id: changeRecord.change_id
      };

    } catch (error) {
      await tx.rollback();
      console.error(`   ❌ Split failed:`, error.message);
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Add an alias for an entity
   */
  async addAlias(entityId, aliasId) {
    await this.initialize();
    await redisClient.sAdd(`${KEYS.ALIASES}${entityId}`, aliasId);
    
    // Also store reverse lookup
    await redisClient.set(`${KEYS.IDENTITY}${aliasId}`, entityId);
  }

  /**
   * Get all aliases for an entity
   */
  async getAliases(entityId) {
    await this.initialize();
    return await redisClient.sMembers(`${KEYS.ALIASES}${entityId}`);
  }

  /**
   * Resolve an ID (returns canonical ID if this is an alias)
   */
  async resolveId(id) {
    await this.initialize();
    const canonical = await redisClient.get(`${KEYS.IDENTITY}${id}`);
    return canonical || id;
  }

  /**
   * Find potential duplicates using fuzzy matching
   */
  async findDuplicates(workspaceId, className, options = {}) {
    const { threshold = 0.8, limit = 50 } = options;

    const session = neo4jService.getSession();
    try {
      const sanitizedClass = className ? className.replace(/[^a-zA-Z0-9_]/g, '') : null;
      
      let matchClause = sanitizedClass 
        ? `MATCH (n:\`${sanitizedClass}\`)` 
        : `MATCH (n)`;

      const query = `
        ${matchClause}
        WHERE n.workspace_id = $workspaceId
          AND n.label IS NOT NULL
        WITH n
        ORDER BY n.label
        WITH collect({
          id: n.concept_id,
          label: n.label,
          type: labels(n)[0]
        }) as entities
        UNWIND range(0, size(entities)-2) as i
        UNWIND range(i+1, size(entities)-1) as j
        WITH entities[i] as e1, entities[j] as e2
        WHERE toLower(e1.label) = toLower(e2.label)
           OR apoc.text.levenshteinSimilarity(toLower(e1.label), toLower(e2.label)) > $threshold
        RETURN e1, e2, 
               apoc.text.levenshteinSimilarity(toLower(e1.label), toLower(e2.label)) as similarity
        ORDER BY similarity DESC
        LIMIT $limit
      `;

      try {
        const result = await session.run(query, { workspaceId, threshold, limit });
        return result.records.map(r => ({
          entity1: r.get('e1'),
          entity2: r.get('e2'),
          similarity: r.get('similarity')
        }));
      } catch (apocError) {
        // APOC not installed, fall back to simple exact match
        console.warn('APOC not available, using simple duplicate detection');
        
        const simpleQuery = `
          ${matchClause}
          WHERE n.workspace_id = $workspaceId
            AND n.label IS NOT NULL
          WITH toLower(n.label) as lowerLabel, collect(n) as nodes
          WHERE size(nodes) > 1
          RETURN lowerLabel, [node IN nodes | {
            id: node.concept_id,
            label: node.label,
            type: labels(node)[0]
          }] as duplicates
          LIMIT $limit
        `;

        const simpleResult = await session.run(simpleQuery, { workspaceId, limit });
        const duplicates = [];
        
        for (const record of simpleResult.records) {
          const dups = record.get('duplicates');
          for (let i = 0; i < dups.length - 1; i++) {
            duplicates.push({
              entity1: dups[i],
              entity2: dups[i + 1],
              similarity: 1.0
            });
          }
        }
        
        return duplicates;
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Log identity change for audit trail
   */
  async logIdentityChange(change) {
    await this.initialize();

    const changeRecord = {
      change_id: uuidv4(),
      change_type: change.change_type,
      source_ids: change.source_ids,
      target_ids: change.target_ids,
      reason: change.reason || '',
      performed_by: change.performed_by || 'system',
      performed_at: new Date().toISOString(),
      workspace_id: change.workspace_id,
      tenant_id: change.tenant_id,
      rollback_data: change.rollback_data || null
    };

    // Store change record
    await redisClient.set(
      `${KEYS.CHANGE_LOG}${changeRecord.change_id}`,
      JSON.stringify(changeRecord)
    );

    // Add to workspace index
    if (change.workspace_id) {
      await redisClient.lPush(
        `${KEYS.CHANGE_INDEX}${change.workspace_id}`,
        changeRecord.change_id
      );
      // Keep only last 1000 changes per workspace
      await redisClient.lTrim(`${KEYS.CHANGE_INDEX}${change.workspace_id}`, 0, 999);
    }

    return changeRecord;
  }

  /**
   * Get identity change history
   */
  async getChangeHistory(workspaceId, options = {}) {
    await this.initialize();

    const { limit = 50, offset = 0 } = options;

    const changeIds = await redisClient.lRange(
      `${KEYS.CHANGE_INDEX}${workspaceId}`,
      offset,
      offset + limit - 1
    );

    const changes = [];
    for (const id of changeIds) {
      const data = await redisClient.get(`${KEYS.CHANGE_LOG}${id}`);
      if (data) {
        changes.push(JSON.parse(data));
      }
    }

    return changes;
  }

  /**
   * Get a specific change record
   */
  async getChange(changeId) {
    await this.initialize();
    const data = await redisClient.get(`${KEYS.CHANGE_LOG}${changeId}`);
    return data ? JSON.parse(data) : null;
  }
}

module.exports = new EntityIdentityService();
module.exports.ChangeType = ChangeType;
