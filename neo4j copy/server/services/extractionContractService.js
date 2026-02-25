/**
 * Extraction Contract Service
 * Validates extraction output against active ontology schema
 * 
 * Core principle: "Ontology defines meaning; code enforces it"
 * - Unknown types go to candidate queue, NOT directly to graph
 * - All extractions must conform to active ontology version
 */

const { v4: uuidv4 } = require('uuid');
const { client: redisClient, connectRedis } = require('../config/redis');
const ontologyPackService = require('./ontologyPackService');

// Redis key prefixes
const KEYS = {
  VIOLATION: 'contract:violation:',
  VIOLATIONS_INDEX: 'contract:violations:',
  CONTRACT: 'contract:active:'
};

// Violation types
const ViolationType = {
  UNKNOWN_CLASS: 'UNKNOWN_CLASS',
  UNKNOWN_RELATIONSHIP: 'UNKNOWN_RELATIONSHIP',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  MISSING_REQUIRED_ATTRIBUTE: 'MISSING_REQUIRED_ATTRIBUTE',
  INVALID_ATTRIBUTE_TYPE: 'INVALID_ATTRIBUTE_TYPE'
};

class ExtractionContractService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  /**
   * Validate extraction output against active ontology
   * @param {Object} extractionResult - Result from graphRagExtractionService
   * @param {string} ontologyVersionId - Ontology version to validate against
   * @param {Object} options - Validation options
   * @returns {{ valid: Array, violations: Array, candidates: Array }}
   */
  async validateExtraction(extractionResult, ontologyVersionId, options = {}) {
    await this.initialize();

    const {
      strictMode = true,
      confidenceThreshold = 0.5,
      workspaceId = null,
      extractionRunId = null
    } = options;

    // Get ontology version
    let ontology = null;
    if (ontologyVersionId) {
      ontology = await ontologyPackService.getVersion(ontologyVersionId);
    }

    // If no ontology, all types are allowed (unconstrained mode)
    if (!ontology && !strictMode) {
      return {
        valid: extractionResult.entities || [],
        validRelationships: extractionResult.relationships || [],
        violations: [],
        candidates: [],
        mode: 'unconstrained'
      };
    }

    // Build allowed sets from ontology
    const allowedClasses = new Set(
      (ontology?.classes || []).map(c => c.name.toLowerCase())
    );
    const allowedRelationships = new Set(
      (ontology?.relationships || []).map(r => r.type.toLowerCase())
    );

    // Also add synonyms
    for (const cls of (ontology?.classes || [])) {
      for (const syn of (cls.synonyms || [])) {
        allowedClasses.add(syn.toLowerCase());
      }
    }

    const valid = [];
    const validRelationships = [];
    const violations = [];
    const candidates = [];

    // Validate entities
    for (const entity of (extractionResult.entities || [])) {
      const entityType = (entity.type || 'Unknown').toLowerCase();
      const isAllowed = allowedClasses.has(entityType) || !strictMode;
      const meetsConfidence = (entity.confidence || 0) >= confidenceThreshold;

      if (isAllowed && meetsConfidence) {
        valid.push(entity);
      } else {
        const violation = {
          violation_id: uuidv4(),
          extraction_run_id: extractionRunId,
          workspace_id: workspaceId,
          violation_type: !isAllowed ? ViolationType.UNKNOWN_CLASS : ViolationType.LOW_CONFIDENCE,
          attempted_class: entity.type,
          attempted_data: entity,
          source_span: entity.sourceSpan || '',
          confidence: entity.confidence || 0,
          created_at: new Date().toISOString()
        };

        violations.push(violation);

        // Create candidate concept for unknown classes
        if (!isAllowed) {
          candidates.push({
            candidate_id: uuidv4(),
            term: entity.label,
            suggested_class: entity.type,
            suggested_definition: entity.description || '',
            evidence: [entity.sourceSpan].filter(Boolean),
            frequency: 1,
            workspace_id: workspaceId,
            status: 'pending',
            created_at: new Date().toISOString()
          });
        }
      }
    }

    // Validate relationships
    for (const rel of (extractionResult.relationships || [])) {
      const relType = (rel.predicate || rel.type || 'RELATED_TO').toLowerCase();
      const isAllowed = allowedRelationships.has(relType) || !strictMode;

      if (isAllowed) {
        validRelationships.push(rel);
      } else {
        violations.push({
          violation_id: uuidv4(),
          extraction_run_id: extractionRunId,
          workspace_id: workspaceId,
          violation_type: ViolationType.UNKNOWN_RELATIONSHIP,
          attempted_class: rel.predicate || rel.type,
          attempted_data: rel,
          source_span: rel.sourceSpan || '',
          confidence: rel.confidence || 0,
          created_at: new Date().toISOString()
        });
      }
    }

    // Store violations if any
    if (violations.length > 0 && workspaceId) {
      await this.storeViolations(violations, workspaceId);
    }

    return {
      valid,
      validRelationships,
      violations,
      candidates,
      mode: strictMode ? 'strict' : 'lenient',
      stats: {
        total_entities: (extractionResult.entities || []).length,
        valid_entities: valid.length,
        total_relationships: (extractionResult.relationships || []).length,
        valid_relationships: validRelationships.length,
        violations: violations.length,
        candidates: candidates.length
      }
    };
  }

  /**
   * Store violations in Redis
   */
  async storeViolations(violations, workspaceId) {
    await this.initialize();

    for (const violation of violations) {
      await redisClient.set(
        `${KEYS.VIOLATION}${violation.violation_id}`,
        JSON.stringify(violation)
      );
      await redisClient.sAdd(
        `${KEYS.VIOLATIONS_INDEX}${workspaceId}`,
        violation.violation_id
      );
    }
  }

  /**
   * Get violations for a workspace
   */
  async getViolations(workspaceId, options = {}) {
    await this.initialize();

    const { limit = 50, violationType = null } = options;

    const violationIds = await redisClient.sMembers(`${KEYS.VIOLATIONS_INDEX}${workspaceId}`);
    const violations = [];

    for (const id of violationIds) {
      const data = await redisClient.get(`${KEYS.VIOLATION}${id}`);
      if (data) {
        const violation = JSON.parse(data);
        if (!violationType || violation.violation_type === violationType) {
          violations.push(violation);
        }
      }
    }

    // Sort by created_at descending
    violations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return violations.slice(0, limit);
  }

  /**
   * Get violation by ID
   */
  async getViolation(violationId) {
    await this.initialize();
    const data = await redisClient.get(`${KEYS.VIOLATION}${violationId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Promote violation to candidate concept
   */
  async promoteToCandidate(violationId, tenantId) {
    const violation = await this.getViolation(violationId);
    if (!violation) {
      throw new Error(`Violation not found: ${violationId}`);
    }

    if (violation.violation_type !== ViolationType.UNKNOWN_CLASS) {
      throw new Error('Only UNKNOWN_CLASS violations can be promoted to candidates');
    }

    // Store as candidate concept
    const candidate = await ontologyPackService.storeCandidateConcept({
      tenant_id: tenantId,
      workspace_id: violation.workspace_id,
      term: violation.attempted_data.label,
      suggested_class: violation.attempted_class,
      suggested_definition: violation.attempted_data.description || '',
      evidence: [violation.source_span].filter(Boolean),
      frequency: 1
    });

    // Delete violation
    await this.deleteViolation(violationId, violation.workspace_id);

    return candidate;
  }

  /**
   * Delete a violation
   */
  async deleteViolation(violationId, workspaceId) {
    await this.initialize();
    await redisClient.del(`${KEYS.VIOLATION}${violationId}`);
    if (workspaceId) {
      await redisClient.sRem(`${KEYS.VIOLATIONS_INDEX}${workspaceId}`, violationId);
    }
  }

  /**
   * Get violation statistics
   */
  async getViolationStats(workspaceId) {
    await this.initialize();

    const violations = await this.getViolations(workspaceId, { limit: 1000 });

    const stats = {
      total: violations.length,
      by_type: {}
    };

    for (const v of violations) {
      stats.by_type[v.violation_type] = (stats.by_type[v.violation_type] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clear all violations for a workspace
   */
  async clearViolations(workspaceId) {
    await this.initialize();

    const violationIds = await redisClient.sMembers(`${KEYS.VIOLATIONS_INDEX}${workspaceId}`);
    
    for (const id of violationIds) {
      await redisClient.del(`${KEYS.VIOLATION}${id}`);
    }
    
    await redisClient.del(`${KEYS.VIOLATIONS_INDEX}${workspaceId}`);

    return { cleared: violationIds.length };
  }
}

module.exports = new ExtractionContractService();
module.exports.ViolationType = ViolationType;
