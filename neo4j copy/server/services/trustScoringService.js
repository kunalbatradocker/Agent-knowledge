/**
 * Trust Scoring Service
 * Aggregates confidence from multiple extractions and tracks claim vs fact status
 * 
 * Features:
 * - Weighted confidence aggregation from multiple sources
 * - Source authority weighting
 * - Time decay (optional)
 * - Claim → Fact promotion workflow
 */

const { client: redisClient, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');

// Redis key prefixes
const KEYS = {
  SOURCE_AUTHORITY: 'trust:authority:',
  ENTITY_EXTRACTIONS: 'trust:extractions:',
  VERIFICATION_LOG: 'trust:verifications:'
};

// Claim status
const ClaimStatus = {
  CLAIM: 'CLAIM',
  VERIFIED: 'VERIFIED',
  FACT: 'FACT',
  DISPUTED: 'DISPUTED'
};

// Default source authorities
const DEFAULT_AUTHORITIES = {
  'official_document': 1.0,
  'database': 0.95,
  'api': 0.9,
  'user_upload': 0.8,
  'web_scrape': 0.6,
  'extraction': 0.7,
  'review': 1.0,
  'default': 0.7
};

class TrustScoringService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  /**
   * Calculate trust score for an entity
   * @param {string} entityId - Entity concept_id
   * @param {Object} options - Calculation options
   */
  async calculateTrustScore(entityId, options = {}) {
    await this.initialize();

    const { applyTimeDecay = false, decayHalfLifeDays = 365 } = options;

    // Get all extractions for this entity
    const extractions = await this.getEntityExtractions(entityId);

    if (extractions.length === 0) {
      return {
        trust_score: 0,
        extraction_count: 0,
        sources: [],
        claim_status: ClaimStatus.CLAIM
      };
    }

    // Calculate weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    const sources = [];

    for (const ext of extractions) {
      const authority = await this.getSourceAuthority(ext.source_type || 'default');
      let confidence = ext.confidence || 0.7;

      // Apply time decay if enabled
      if (applyTimeDecay && ext.extracted_at) {
        const ageInDays = (Date.now() - new Date(ext.extracted_at).getTime()) / (1000 * 60 * 60 * 24);
        const decayFactor = Math.pow(0.5, ageInDays / decayHalfLifeDays);
        confidence *= decayFactor;
      }

      weightedSum += confidence * authority;
      totalWeight += authority;

      sources.push({
        source_id: ext.source_id,
        source_type: ext.source_type,
        confidence: ext.confidence,
        authority,
        extracted_at: ext.extracted_at
      });
    }

    const trustScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Determine claim status based on trust score and verification
    let claimStatus = ClaimStatus.CLAIM;
    if (trustScore >= 0.95) {
      claimStatus = ClaimStatus.FACT;
    } else if (trustScore >= 0.8) {
      claimStatus = ClaimStatus.VERIFIED;
    }

    return {
      trust_score: Math.min(Math.max(trustScore, 0), 1),
      extraction_count: extractions.length,
      sources,
      claim_status: claimStatus,
      calculated_at: new Date().toISOString()
    };
  }

  /**
   * Record an extraction for trust tracking
   */
  async recordExtraction(entityId, extractionData) {
    await this.initialize();

    const extraction = {
      extraction_id: extractionData.extraction_id || `ext_${Date.now()}`,
      source_id: extractionData.source_id,
      source_type: extractionData.source_type || 'extraction',
      confidence: extractionData.confidence || 0.7,
      extracted_at: extractionData.extracted_at || new Date().toISOString(),
      document_id: extractionData.document_id,
      chunk_id: extractionData.chunk_id
    };

    // Add to entity's extraction list
    await redisClient.lPush(
      `${KEYS.ENTITY_EXTRACTIONS}${entityId}`,
      JSON.stringify(extraction)
    );

    // Keep only last 100 extractions per entity
    await redisClient.lTrim(`${KEYS.ENTITY_EXTRACTIONS}${entityId}`, 0, 99);

    return extraction;
  }

  /**
   * Get all extractions for an entity
   */
  async getEntityExtractions(entityId) {
    await this.initialize();

    const data = await redisClient.lRange(`${KEYS.ENTITY_EXTRACTIONS}${entityId}`, 0, -1);
    return data.map(d => JSON.parse(d));
  }

  /**
   * Get source authority weight
   */
  async getSourceAuthority(sourceType) {
    await this.initialize();

    // Check for custom authority
    const custom = await redisClient.get(`${KEYS.SOURCE_AUTHORITY}${sourceType}`);
    if (custom) {
      return parseFloat(custom);
    }

    // Return default
    return DEFAULT_AUTHORITIES[sourceType] || DEFAULT_AUTHORITIES.default;
  }

  /**
   * Set custom source authority
   */
  async setSourceAuthority(sourceType, authority) {
    await this.initialize();

    if (authority < 0 || authority > 1) {
      throw new Error('Authority must be between 0 and 1');
    }

    await redisClient.set(`${KEYS.SOURCE_AUTHORITY}${sourceType}`, authority.toString());
    return { source_type: sourceType, authority };
  }

  /**
   * Get all source authorities
   */
  async getAllSourceAuthorities() {
    await this.initialize();

    const authorities = { ...DEFAULT_AUTHORITIES };

    // Get custom authorities using SCAN instead of KEYS
    const keys = [];
    let cursor = '0';
    do {
      const result = await redisClient.sendCommand(['SCAN', cursor, 'MATCH', `${KEYS.SOURCE_AUTHORITY}*`, 'COUNT', '200']);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    for (const key of keys) {
      const sourceType = key.replace(KEYS.SOURCE_AUTHORITY, '');
      const value = await redisClient.get(key);
      authorities[sourceType] = parseFloat(value);
    }

    return authorities;
  }

  /**
   * Promote entity from claim to fact (manual verification)
   */
  async promoteToFact(entityId, verificationData) {
    await this.initialize();

    const { verifiedBy, evidence, notes } = verificationData;

    // Update entity in Neo4j
    const session = neo4jService.getSession();
    try {
      await session.run(`
        MATCH (n) WHERE n.concept_id = $entityId
        SET n.claim_status = 'FACT',
            n.verified_by = $verifiedBy,
            n.verified_at = datetime(),
            n.verification_evidence = $evidence,
            n.trust_score = 1.0
        RETURN n
      `, {
        entityId,
        verifiedBy: verifiedBy || 'system',
        evidence: evidence || ''
      });
    } finally {
      await session.close();
    }

    // Log verification
    const verification = {
      entity_id: entityId,
      verified_by: verifiedBy,
      verified_at: new Date().toISOString(),
      evidence,
      notes,
      previous_status: ClaimStatus.CLAIM,
      new_status: ClaimStatus.FACT
    };

    await redisClient.lPush(
      `${KEYS.VERIFICATION_LOG}${entityId}`,
      JSON.stringify(verification)
    );

    return verification;
  }

  /**
   * Mark entity as disputed
   */
  async markDisputed(entityId, disputeData) {
    await this.initialize();

    const { disputedBy, reason } = disputeData;

    const session = neo4jService.getSession();
    try {
      await session.run(`
        MATCH (n) WHERE n.concept_id = $entityId
        SET n.claim_status = 'DISPUTED',
            n.disputed_by = $disputedBy,
            n.disputed_at = datetime(),
            n.dispute_reason = $reason
        RETURN n
      `, {
        entityId,
        disputedBy: disputedBy || 'system',
        reason: reason || ''
      });
    } finally {
      await session.close();
    }

    return { entity_id: entityId, status: ClaimStatus.DISPUTED };
  }

  /**
   * Update trust scores for all entities in a workspace
   */
  async recalculateWorkspaceTrust(workspaceId, options = {}) {
    const session = neo4jService.getSession();
    let updated = 0;

    try {
      // Get all entities in workspace
      const result = await session.run(`
        MATCH (n)
        WHERE n.workspace_id = $workspaceId
          AND n.concept_id IS NOT NULL
        RETURN n.concept_id as entityId
        LIMIT 10000
      `, { workspaceId });

      for (const record of result.records) {
        const entityId = record.get('entityId');
        const trustData = await this.calculateTrustScore(entityId, options);

        // Update entity with new trust score
        await session.run(`
          MATCH (n) WHERE n.concept_id = $entityId
          SET n.trust_score = $trustScore,
              n.claim_status = $claimStatus,
              n.trust_updated_at = datetime()
        `, {
          entityId,
          trustScore: trustData.trust_score,
          claimStatus: trustData.claim_status
        });

        updated++;
      }

      return { updated, workspace_id: workspaceId };
    } finally {
      await session.close();
    }
  }

  /**
   * Get trust statistics for a workspace
   */
  async getWorkspaceTrustStats(workspaceId) {
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (n)
        WHERE n.workspace_id = $workspaceId
          AND n.concept_id IS NOT NULL
        RETURN 
          avg(coalesce(n.trust_score, 0.5)) as avgTrust,
          count(n) as totalEntities,
          sum(CASE WHEN n.claim_status = 'FACT' THEN 1 ELSE 0 END) as facts,
          sum(CASE WHEN n.claim_status = 'VERIFIED' THEN 1 ELSE 0 END) as verified,
          sum(CASE WHEN n.claim_status = 'DISPUTED' THEN 1 ELSE 0 END) as disputed,
          sum(CASE WHEN n.claim_status = 'CLAIM' OR n.claim_status IS NULL THEN 1 ELSE 0 END) as claims
      `, { workspaceId });

      const record = result.records[0];
      return {
        average_trust_score: record.get('avgTrust') || 0,
        total_entities: neo4jService.toNumber(record.get('totalEntities')),
        by_status: {
          facts: neo4jService.toNumber(record.get('facts')),
          verified: neo4jService.toNumber(record.get('verified')),
          disputed: neo4jService.toNumber(record.get('disputed')),
          claims: neo4jService.toNumber(record.get('claims'))
        }
      };
    } finally {
      await session.close();
    }
  }
}

module.exports = new TrustScoringService();
module.exports.ClaimStatus = ClaimStatus;
