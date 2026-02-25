/**
 * Review Queue Service
 * Human review workflow for low-confidence extractions, candidates, and quarantined records
 * 
 * Three queue types:
 * - LOW_CONFIDENCE: Entities below confidence threshold
 * - CANDIDATES: Unknown types suggested by extraction
 * - QUARANTINED: Failed validations or errors
 */

const { v4: uuidv4 } = require('uuid');
const { client: redisClient, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');
const ontologyPackService = require('./ontologyPackService');

// Redis key prefixes
const KEYS = {
  LOW_CONFIDENCE: 'review:low_confidence:',
  CANDIDATES: 'review:candidates:',
  QUARANTINED: 'review:quarantined:',
  ITEM: 'review:item:'
};

// Review item types
const ReviewItemType = {
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  CANDIDATE: 'CANDIDATE',
  QUARANTINED: 'QUARANTINED'
};

// Review item status
const ReviewStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  MERGED: 'merged'
};

class ReviewQueueService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  /**
   * Add item to review queue
   */
  async addToQueue(item) {
    await this.initialize();

    const reviewItem = {
      item_id: item.item_id || uuidv4(),
      item_type: item.item_type,
      workspace_id: item.workspace_id,
      tenant_id: item.tenant_id,
      entity_data: item.entity_data,
      confidence: item.confidence || 0,
      source_document_id: item.source_document_id,
      source_span: item.source_span,
      suggested_action: item.suggested_action || 'REVIEW',
      status: ReviewStatus.PENDING,
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
      created_at: new Date().toISOString()
    };

    // Store item
    await redisClient.set(
      `${KEYS.ITEM}${reviewItem.item_id}`,
      JSON.stringify(reviewItem)
    );

    // Add to appropriate queue
    const workspaceKey = reviewItem.workspace_id || 'global';
    
    switch (reviewItem.item_type) {
      case ReviewItemType.LOW_CONFIDENCE:
        await redisClient.zAdd(
          `${KEYS.LOW_CONFIDENCE}${workspaceKey}`,
          { score: reviewItem.confidence, value: reviewItem.item_id }
        );
        break;
      case ReviewItemType.CANDIDATE:
        await redisClient.sAdd(
          `${KEYS.CANDIDATES}${workspaceKey}`,
          reviewItem.item_id
        );
        break;
      case ReviewItemType.QUARANTINED:
        await redisClient.sAdd(
          `${KEYS.QUARANTINED}${workspaceKey}`,
          reviewItem.item_id
        );
        break;
    }

    return reviewItem;
  }

  /**
   * Get review item by ID
   */
  async getItem(itemId) {
    await this.initialize();
    const data = await redisClient.get(`${KEYS.ITEM}${itemId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Get queue items with pagination
   */
  async getQueue(workspaceId, queueType, options = {}) {
    await this.initialize();

    const {
      limit = 50,
      offset = 0,
      minConfidence = 0,
      maxConfidence = 1,
      status = null
    } = options;

    const workspaceKey = workspaceId || 'global';
    let itemIds = [];

    switch (queueType) {
      case ReviewItemType.LOW_CONFIDENCE:
        // Get from sorted set (sorted by confidence ascending)
        itemIds = await redisClient.zRange(
          `${KEYS.LOW_CONFIDENCE}${workspaceKey}`,
          minConfidence,
          maxConfidence,
          { BY: 'SCORE' }
        );
        break;
      case ReviewItemType.CANDIDATE:
        itemIds = await redisClient.sMembers(`${KEYS.CANDIDATES}${workspaceKey}`);
        break;
      case ReviewItemType.QUARANTINED:
        itemIds = await redisClient.sMembers(`${KEYS.QUARANTINED}${workspaceKey}`);
        break;
      default:
        // Get all types
        const lowConf = await redisClient.zRange(`${KEYS.LOW_CONFIDENCE}${workspaceKey}`, 0, -1);
        const candidates = await redisClient.sMembers(`${KEYS.CANDIDATES}${workspaceKey}`);
        const quarantined = await redisClient.sMembers(`${KEYS.QUARANTINED}${workspaceKey}`);
        itemIds = [...lowConf, ...candidates, ...quarantined];
    }

    // Fetch items
    const items = [];
    for (const id of itemIds) {
      const item = await this.getItem(id);
      if (item) {
        // Apply status filter
        if (status && item.status !== status) continue;
        items.push(item);
      }
    }

    // Sort by created_at descending
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Apply pagination
    const paginated = items.slice(offset, offset + limit);

    return {
      items: paginated,
      total: items.length,
      offset,
      limit,
      hasMore: offset + limit < items.length
    };
  }

  /**
   * Approve item - create entity in graph
   */
  async approveItem(itemId, reviewerId, modifications = {}) {
    await this.initialize();

    const item = await this.getItem(itemId);
    if (!item) {
      throw new Error(`Review item not found: ${itemId}`);
    }

    if (item.status !== ReviewStatus.PENDING) {
      throw new Error(`Item already processed: ${item.status}`);
    }

    // Merge modifications with original data
    const entityData = {
      ...item.entity_data,
      ...modifications
    };

    let result = null;

    // Handle based on item type
    switch (item.item_type) {
      case ReviewItemType.LOW_CONFIDENCE:
      case ReviewItemType.QUARANTINED:
        // Create entity in graph
        result = await this.createEntityFromReview(entityData, item);
        break;
      case ReviewItemType.CANDIDATE:
        // Add to ontology as new class
        result = await this.addCandidateToOntology(entityData, item);
        break;
    }

    // Update item status
    item.status = ReviewStatus.APPROVED;
    item.reviewed_by = reviewerId;
    item.reviewed_at = new Date().toISOString();
    item.review_notes = modifications.notes || null;
    item.result = result;

    await redisClient.set(`${KEYS.ITEM}${itemId}`, JSON.stringify(item));

    // Remove from queue
    await this.removeFromQueue(item);

    return { success: true, item, result };
  }

  /**
   * Reject item
   */
  async rejectItem(itemId, reviewerId, reason = '') {
    await this.initialize();

    const item = await this.getItem(itemId);
    if (!item) {
      throw new Error(`Review item not found: ${itemId}`);
    }

    if (item.status !== ReviewStatus.PENDING) {
      throw new Error(`Item already processed: ${item.status}`);
    }

    // Update item status
    item.status = ReviewStatus.REJECTED;
    item.reviewed_by = reviewerId;
    item.reviewed_at = new Date().toISOString();
    item.review_notes = reason;

    await redisClient.set(`${KEYS.ITEM}${itemId}`, JSON.stringify(item));

    // Remove from queue
    await this.removeFromQueue(item);

    return { success: true, item };
  }

  /**
   * Bulk approve/reject
   */
  async bulkAction(itemIds, action, reviewerId, options = {}) {
    const results = [];

    for (const itemId of itemIds) {
      try {
        let result;
        if (action === 'approve') {
          result = await this.approveItem(itemId, reviewerId, options.modifications || {});
        } else if (action === 'reject') {
          result = await this.rejectItem(itemId, reviewerId, options.reason || '');
        } else {
          throw new Error(`Unknown action: ${action}`);
        }
        results.push({ item_id: itemId, success: true, ...result });
      } catch (error) {
        results.push({ item_id: itemId, success: false, error: error.message });
      }
    }

    return {
      total: itemIds.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(workspaceId) {
    await this.initialize();

    const workspaceKey = workspaceId || 'global';

    const lowConfidenceCount = await redisClient.zCard(`${KEYS.LOW_CONFIDENCE}${workspaceKey}`);
    const candidatesCount = await redisClient.sCard(`${KEYS.CANDIDATES}${workspaceKey}`);
    const quarantinedCount = await redisClient.sCard(`${KEYS.QUARANTINED}${workspaceKey}`);

    return {
      low_confidence: lowConfidenceCount,
      candidates: candidatesCount,
      quarantined: quarantinedCount,
      total: lowConfidenceCount + candidatesCount + quarantinedCount
    };
  }

  /**
   * Remove item from queue (internal)
   */
  async removeFromQueue(item) {
    const workspaceKey = item.workspace_id || 'global';

    switch (item.item_type) {
      case ReviewItemType.LOW_CONFIDENCE:
        await redisClient.zRem(`${KEYS.LOW_CONFIDENCE}${workspaceKey}`, item.item_id);
        break;
      case ReviewItemType.CANDIDATE:
        await redisClient.sRem(`${KEYS.CANDIDATES}${workspaceKey}`, item.item_id);
        break;
      case ReviewItemType.QUARANTINED:
        await redisClient.sRem(`${KEYS.QUARANTINED}${workspaceKey}`, item.item_id);
        break;
    }
  }

  /**
   * Create entity from approved review item
   */
  async createEntityFromReview(entityData, item) {
    const concepts = [{
      uri: `entity://${item.workspace_id}/${uuidv4()}`,
      concept_id: uuidv4(),
      label: entityData.label || entityData.name,
      type: entityData.type,
      specificType: entityData.type,
      description: entityData.description || '',
      confidence: 1.0, // Approved by human
      source: `review:${item.item_id}`,
      properties: {
        ...entityData.properties,
        tenant_id: item.tenant_id,
        workspace_id: item.workspace_id,
        approved_from_review: true,
        original_confidence: item.confidence
      }
    }];

    const result = await neo4jService.createConcepts(concepts, {
      industry: entityData.industry || 'general'
    });

    return {
      created: true,
      concept_id: concepts[0].concept_id,
      ...result
    };
  }

  /**
   * Add candidate concept to ontology
   */
  async addCandidateToOntology(entityData, item) {
    // This would typically create a new class in a draft ontology version
    // For now, store as a candidate concept
    const candidate = await ontologyPackService.storeCandidateConcept({
      tenant_id: item.tenant_id,
      workspace_id: item.workspace_id,
      term: entityData.label || entityData.term,
      suggested_class: entityData.type || entityData.suggested_class,
      suggested_definition: entityData.description || entityData.suggested_definition || '',
      evidence: entityData.evidence || [],
      frequency: 1,
      status: 'approved'
    });

    return {
      candidate_created: true,
      candidate_id: candidate.candidate_id
    };
  }

  /**
   * Delete review item
   */
  async deleteItem(itemId) {
    await this.initialize();

    const item = await this.getItem(itemId);
    if (!item) return { success: false, error: 'Item not found' };

    await this.removeFromQueue(item);
    await redisClient.del(`${KEYS.ITEM}${itemId}`);

    return { success: true };
  }

  /**
   * Clear all items from a queue
   */
  async clearQueue(workspaceId, queueType) {
    await this.initialize();

    const workspaceKey = workspaceId || 'global';
    let cleared = 0;

    const { items } = await this.getQueue(workspaceId, queueType, { limit: 10000 });

    for (const item of items) {
      await this.deleteItem(item.item_id);
      cleared++;
    }

    return { cleared };
  }
}

module.exports = new ReviewQueueService();
module.exports.ReviewItemType = ReviewItemType;
module.exports.ReviewStatus = ReviewStatus;
