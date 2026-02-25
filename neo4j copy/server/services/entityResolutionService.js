/**
 * Entity Resolution Service
 * Handles entity deduplication, fuzzy matching, and merge operations
 * Enterprise-grade entity resolution comparable to Palantir/C3 AI
 */

const neo4jService = require('./neo4jService');
const driver = require('../config/neo4j');
const neo4j = require('neo4j-driver');
const { v4: uuidv4 } = require('uuid');

class EntityResolutionService {
  constructor() {
    // Default matching thresholds
    this.defaultThresholds = {
      exactMatch: 1.0,
      highConfidence: 0.85,
      mediumConfidence: 0.70,
      lowConfidence: 0.55,
      minimumScore: 0.50
    };
    
    // Matching weights by attribute type
    this.attributeWeights = {
      name: 0.4,
      type: 0.2,
      description: 0.15,
      properties: 0.15,
      relationships: 0.1
    };
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }
    return dp[m][n];
  }

  /**
   * Calculate Jaro-Winkler similarity (0-1, higher is more similar)
   */
  jaroWinklerSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;

    const len1 = s1.length;
    const len2 = s2.length;
    const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;

    const s1Matches = new Array(len1).fill(false);
    const s2Matches = new Array(len2).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matches
    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, len2);

      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

    // Winkler modification - boost for common prefix
    let prefix = 0;
    for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Calculate normalized similarity score (0-1)
   */
  calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1.0;
    
    // Use Jaro-Winkler as primary metric
    const jaroWinkler = this.jaroWinklerSimilarity(s1, s2);
    
    // Also calculate Levenshtein-based similarity
    const maxLen = Math.max(s1.length, s2.length);
    const levenshtein = 1 - (this.levenshteinDistance(s1, s2) / maxLen);
    
    // Weighted average (Jaro-Winkler is better for names)
    return jaroWinkler * 0.7 + levenshtein * 0.3;
  }

  /**
   * Calculate token-based similarity (for longer text)
   */
  calculateTokenSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const tokenize = (text) => {
      return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
    };
    
    const tokens1 = new Set(tokenize(text1));
    const tokens2 = new Set(tokenize(text2));
    
    if (tokens1.size === 0 || tokens2.size === 0) return 0;
    
    const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
    const union = new Set([...tokens1, ...tokens2]);
    
    return intersection.size / union.size; // Jaccard similarity
  }

  /**
   * Calculate overall entity similarity score
   */
  calculateEntitySimilarity(entity1, entity2, config = {}) {
    const weights = { ...this.attributeWeights, ...config.weights };
    let totalScore = 0;
    let totalWeight = 0;

    // Name similarity (highest weight)
    if (entity1.label && entity2.label) {
      const nameSim = this.calculateStringSimilarity(entity1.label, entity2.label);
      totalScore += nameSim * weights.name;
      totalWeight += weights.name;
    }

    // Type similarity
    if (entity1.type && entity2.type) {
      const typeSim = entity1.type.toLowerCase() === entity2.type.toLowerCase() ? 1.0 : 0.0;
      totalScore += typeSim * weights.type;
      totalWeight += weights.type;
    }

    // Description similarity
    if (entity1.description && entity2.description) {
      const descSim = this.calculateTokenSimilarity(entity1.description, entity2.description);
      totalScore += descSim * weights.description;
      totalWeight += weights.description;
    }

    // Property similarity
    if (entity1.properties && entity2.properties) {
      const propSim = this.calculatePropertySimilarity(entity1.properties, entity2.properties);
      totalScore += propSim * weights.properties;
      totalWeight += weights.properties;
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  /**
   * Calculate property-level similarity
   */
  calculatePropertySimilarity(props1, props2) {
    if (!props1 || !props2) return 0;
    
    const keys1 = Object.keys(props1);
    const keys2 = Object.keys(props2);
    const commonKeys = keys1.filter(k => keys2.includes(k));
    
    if (commonKeys.length === 0) return 0;
    
    let matchScore = 0;
    for (const key of commonKeys) {
      const val1 = String(props1[key] || '');
      const val2 = String(props2[key] || '');
      matchScore += this.calculateStringSimilarity(val1, val2);
    }
    
    return matchScore / Math.max(keys1.length, keys2.length);
  }

  /**
   * Find potential duplicate entities in the graph
   */
  async findDuplicateCandidates(options = {}) {
    const {
      entityType = null,
      minScore = this.defaultThresholds.minimumScore,
      limit = 100,
      includeResolved = false
    } = options;

    const session = neo4jService.getSession();
    
    try {
      // Build query to get entities
      let typeFilter = '';
      if (entityType) {
        typeFilter = `AND any(label IN labels(e) WHERE label = $entityType)`;
      }

      const query = `
        MATCH (e)
        WHERE e.label IS NOT NULL 
          AND NOT e:Document AND NOT e:Chunk AND NOT e:Folder
          ${typeFilter}
          ${includeResolved ? '' : 'AND NOT exists(e.merged_into)'}
        RETURN e, labels(e) as nodeLabels
        ORDER BY e.label
        LIMIT $limit
      `;

      const result = await session.run(query, {
        entityType: entityType,
        limit: neo4j.int(limit * 2) // Get more to find pairs
      });

      const entities = result.records.map(r => ({
        ...r.get('e').properties,
        nodeLabels: r.get('nodeLabels'),
        elementId: r.get('e').elementId
      }));

      // Find duplicate candidates using blocking + comparison
      const candidates = [];
      const processed = new Set();

      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const e1 = entities[i];
          const e2 = entities[j];
          
          // Skip if already processed this pair
          const pairKey = [e1.uri, e2.uri].sort().join('|');
          if (processed.has(pairKey)) continue;
          processed.add(pairKey);

          // Quick blocking: skip if first 3 chars of name don't match
          const prefix1 = (e1.label || '').toLowerCase().substring(0, 3);
          const prefix2 = (e2.label || '').toLowerCase().substring(0, 3);
          if (prefix1 !== prefix2 && this.levenshteinDistance(prefix1, prefix2) > 2) {
            continue;
          }

          // Calculate similarity
          const score = this.calculateEntitySimilarity(e1, e2);
          
          if (score >= minScore) {
            candidates.push({
              entity1: e1,
              entity2: e2,
              score: score,
              confidence: this.getConfidenceLevel(score),
              matchDetails: this.getMatchDetails(e1, e2)
            });
          }
        }
      }

      // Sort by score descending
      candidates.sort((a, b) => b.score - a.score);

      return {
        candidates: candidates.slice(0, limit),
        totalFound: candidates.length,
        thresholds: this.defaultThresholds
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get confidence level label from score
   */
  getConfidenceLevel(score) {
    if (score >= this.defaultThresholds.exactMatch) return 'exact';
    if (score >= this.defaultThresholds.highConfidence) return 'high';
    if (score >= this.defaultThresholds.mediumConfidence) return 'medium';
    if (score >= this.defaultThresholds.lowConfidence) return 'low';
    return 'uncertain';
  }

  /**
   * Get detailed match breakdown
   */
  getMatchDetails(e1, e2) {
    return {
      nameSimilarity: this.calculateStringSimilarity(e1.label || '', e2.label || ''),
      typeMatch: (e1.type || '').toLowerCase() === (e2.type || '').toLowerCase(),
      descriptionSimilarity: this.calculateTokenSimilarity(e1.description || '', e2.description || ''),
      sharedLabels: (e1.nodeLabels || []).filter(l => (e2.nodeLabels || []).includes(l))
    };
  }

  /**
   * Merge two entities into a canonical record
   */
  async mergeEntities(sourceUri, targetUri, options = {}) {
    const {
      keepSource = false,
      mergeStrategy = 'prefer_target', // prefer_target, prefer_source, merge_all
      userId = 'system'
    } = options;

    const session = neo4jService.getSession();
    
    try {
      // Get both entities
      const getQuery = `
        MATCH (source {uri: $sourceUri})
        MATCH (target {uri: $targetUri})
        RETURN source, target, labels(source) as sourceLabels, labels(target) as targetLabels
      `;
      
      const result = await session.run(getQuery, { sourceUri, targetUri });
      
      if (result.records.length === 0) {
        throw new Error('One or both entities not found');
      }

      const source = result.records[0].get('source').properties;
      const target = result.records[0].get('target').properties;
      const sourceLabels = result.records[0].get('sourceLabels');
      const targetLabels = result.records[0].get('targetLabels');

      // Merge properties based on strategy
      const mergedProps = this.mergeProperties(source, target, mergeStrategy);

      // Create merge record for lineage
      const mergeRecord = {
        merge_id: uuidv4(),
        merged_at: new Date().toISOString(),
        merged_by: userId,
        source_uri: sourceUri,
        target_uri: targetUri,
        strategy: mergeStrategy,
        source_snapshot: JSON.stringify(source),
        target_snapshot: JSON.stringify(target)
      };

      // Update target with merged properties
      const updateQuery = `
        MATCH (target {uri: $targetUri})
        SET target += $mergedProps,
            target.last_merged_at = datetime(),
            target.merge_count = coalesce(target.merge_count, 0) + 1
        RETURN target
      `;
      
      await session.run(updateQuery, { targetUri, mergedProps });

      // Transfer all relationships from source to target
      const transferRelsQuery = `
        MATCH (source {uri: $sourceUri})-[r]->(other)
        WHERE other.uri <> $targetUri
        WITH source, r, other, type(r) as relType, properties(r) as relProps
        MATCH (target {uri: $targetUri})
        CALL {
          WITH target, other, relType, relProps
          MERGE (target)-[newR:RELATED_TO]->(other)
          SET newR = relProps, newR.transferred_from = $sourceUri
          RETURN newR
        }
        RETURN count(*) as transferred
      `;
      
      const transferResult1 = await session.run(transferRelsQuery, { sourceUri, targetUri });

      // Transfer incoming relationships
      const transferInRelsQuery = `
        MATCH (other)-[r]->(source {uri: $sourceUri})
        WHERE other.uri <> $targetUri
        WITH source, r, other, type(r) as relType, properties(r) as relProps
        MATCH (target {uri: $targetUri})
        CALL {
          WITH target, other, relType, relProps
          MERGE (other)-[newR:RELATED_TO]->(target)
          SET newR = relProps, newR.transferred_from = $sourceUri
          RETURN newR
        }
        RETURN count(*) as transferred
      `;
      
      const transferResult2 = await session.run(transferInRelsQuery, { sourceUri, targetUri });

      // Handle source entity
      if (keepSource) {
        // Mark as merged but keep for reference
        const markMergedQuery = `
          MATCH (source {uri: $sourceUri})
          SET source.merged_into = $targetUri,
              source.merged_at = datetime(),
              source.is_canonical = false
          RETURN source
        `;
        await session.run(markMergedQuery, { sourceUri, targetUri });
      } else {
        // Delete source entity
        const deleteQuery = `
          MATCH (source {uri: $sourceUri})
          DETACH DELETE source
        `;
        await session.run(deleteQuery, { sourceUri });
      }

      // Store merge record
      await this.storeMergeRecord(mergeRecord);

      return {
        success: true,
        mergeId: mergeRecord.merge_id,
        targetUri: targetUri,
        sourceDeleted: !keepSource,
        relationshipsTransferred: neo4jService.toNumber(transferResult1.records[0]?.get('transferred') || 0) +
                                  neo4jService.toNumber(transferResult2.records[0]?.get('transferred') || 0)
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Merge properties based on strategy
   */
  mergeProperties(source, target, strategy) {
    const merged = { ...target };
    
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith('_') || ['uri', 'concept_id', 'created_at'].includes(key)) {
        continue; // Skip system properties
      }
      
      const targetValue = target[key];
      
      switch (strategy) {
        case 'prefer_source':
          if (value !== null && value !== undefined && value !== '') {
            merged[key] = value;
          }
          break;
          
        case 'prefer_target':
          if (!targetValue && value) {
            merged[key] = value;
          }
          break;
          
        case 'merge_all':
          if (value && targetValue && value !== targetValue) {
            // Concatenate different values
            if (typeof value === 'string' && typeof targetValue === 'string') {
              merged[key] = `${targetValue}; ${value}`;
            } else {
              merged[key] = targetValue; // Default to target for non-strings
            }
          } else if (value && !targetValue) {
            merged[key] = value;
          }
          break;
      }
    }
    
    return merged;
  }

  /**
   * Store merge record for audit/lineage
   */
  async storeMergeRecord(record) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        CREATE (m:MergeRecord {
          merge_id: $merge_id,
          merged_at: datetime($merged_at),
          merged_by: $merged_by,
          source_uri: $source_uri,
          target_uri: $target_uri,
          strategy: $strategy,
          source_snapshot: $source_snapshot,
          target_snapshot: $target_snapshot
        })
        RETURN m
      `;
      
      await session.run(query, record);
    } finally {
      await session.close();
    }
  }

  /**
   * Get merge history for an entity
   */
  async getMergeHistory(entityUri) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (m:MergeRecord)
        WHERE m.target_uri = $uri OR m.source_uri = $uri
        RETURN m
        ORDER BY m.merged_at DESC
      `;
      
      const result = await session.run(query, { uri: entityUri });
      
      return result.records.map(r => r.get('m').properties);
    } finally {
      await session.close();
    }
  }

  /**
   * Undo a merge operation
   */
  async undoMerge(mergeId) {
    const session = neo4jService.getSession();
    
    try {
      // Get merge record
      const getQuery = `
        MATCH (m:MergeRecord {merge_id: $mergeId})
        RETURN m
      `;
      
      const result = await session.run(getQuery, { mergeId });
      
      if (result.records.length === 0) {
        throw new Error('Merge record not found');
      }

      const record = result.records[0].get('m').properties;
      const sourceSnapshot = JSON.parse(record.source_snapshot);
      
      // Recreate source entity from snapshot
      const recreateQuery = `
        CREATE (e:Entity)
        SET e = $props
        RETURN e
      `;
      
      await session.run(recreateQuery, { props: sourceSnapshot });

      // Mark merge record as undone
      const markUndoneQuery = `
        MATCH (m:MergeRecord {merge_id: $mergeId})
        SET m.undone_at = datetime(), m.is_undone = true
        RETURN m
      `;
      
      await session.run(markUndoneQuery, { mergeId });

      return {
        success: true,
        restoredUri: sourceSnapshot.uri,
        message: 'Merge undone successfully'
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Auto-resolve duplicates above a confidence threshold
   */
  async autoResolveDuplicates(options = {}) {
    const {
      minScore = this.defaultThresholds.highConfidence,
      maxMerges = 50,
      dryRun = true
    } = options;

    const candidates = await this.findDuplicateCandidates({
      minScore,
      limit: maxMerges * 2
    });

    const results = {
      processed: 0,
      merged: 0,
      skipped: 0,
      errors: [],
      merges: []
    };

    for (const candidate of candidates.candidates) {
      if (results.merged >= maxMerges) break;
      
      results.processed++;
      
      if (candidate.score < minScore) {
        results.skipped++;
        continue;
      }

      if (dryRun) {
        results.merges.push({
          source: candidate.entity1.uri,
          target: candidate.entity2.uri,
          score: candidate.score,
          wouldMerge: true
        });
        results.merged++;
      } else {
        try {
          const mergeResult = await this.mergeEntities(
            candidate.entity1.uri,
            candidate.entity2.uri,
            { keepSource: false }
          );
          results.merges.push({
            ...mergeResult,
            score: candidate.score
          });
          results.merged++;
        } catch (error) {
          results.errors.push({
            source: candidate.entity1.uri,
            target: candidate.entity2.uri,
            error: error.message
          });
        }
      }
    }

    return results;
  }
}

module.exports = new EntityResolutionService();
