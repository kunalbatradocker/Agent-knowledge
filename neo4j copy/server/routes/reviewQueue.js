/**
 * Review Queue Routes
 * Human review workflow for low-confidence extractions, candidates, and quarantined records
 */

const express = require('express');
const router = express.Router();
const reviewQueueService = require('../services/reviewQueueService');
const { ReviewItemType } = require('../services/reviewQueueService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireMember, requireManager } = require('../middleware/auth');

/**
 * GET /api/review-queue
 * Get review queue items
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const queueType = req.query.type; // LOW_CONFIDENCE, CANDIDATE, QUARANTINED
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;

    const result = await reviewQueueService.getQueue(workspaceId, queueType, {
      limit,
      offset,
      status
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching review queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/review-queue/stats
 * Get queue statistics
 */
router.get('/stats', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const stats = await reviewQueueService.getQueueStats(workspaceId);
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching queue stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/review-queue/:id
 * Get a specific review item
 */
router.get('/:id', async (req, res) => {
  try {
    const item = await reviewQueueService.getItem(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }
    res.json({ success: true, item });
  } catch (error) {
    console.error('Error fetching review item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/review-queue/:id/approve
 * Approve a review item
 */
router.post('/:id/approve', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const reviewerId = req.body.reviewer_id || req.tenantContext?.user_id || 'anonymous';
    const modifications = req.body.modifications || {};

    const result = await reviewQueueService.approveItem(req.params.id, reviewerId, modifications);
    res.json(result);
  } catch (error) {
    console.error('Error approving item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/review-queue/:id/reject
 * Reject a review item
 */
router.post('/:id/reject', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const reviewerId = req.body.reviewer_id || req.tenantContext?.user_id || 'anonymous';
    const reason = req.body.reason || '';

    const result = await reviewQueueService.rejectItem(req.params.id, reviewerId, reason);
    res.json(result);
  } catch (error) {
    console.error('Error rejecting item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/review-queue/bulk
 * Bulk approve/reject items
 */
router.post('/bulk', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const { item_ids, action, reason, modifications } = req.body;
    const reviewerId = req.body.reviewer_id || req.tenantContext?.user_id || 'anonymous';

    if (!item_ids || !Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'item_ids array is required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
    }

    const result = await reviewQueueService.bulkAction(item_ids, action, reviewerId, {
      reason,
      modifications
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error in bulk action:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/review-queue/:id
 * Delete a review item
 */
router.delete('/:id', requireMember, async (req, res) => {
  try {
    const result = await reviewQueueService.deleteItem(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/review-queue/clear
 * Clear all items from a queue type
 */
router.post('/clear', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    const queueType = req.body.type;

    const result = await reviewQueueService.clearQueue(workspaceId, queueType);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/review-queue
 * Add item to review queue (internal use)
 */
router.post('/', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const item = {
      item_type: req.body.item_type || ReviewItemType.LOW_CONFIDENCE,
      workspace_id: req.body.workspace_id || req.tenantContext?.workspace_id,
      tenant_id: req.body.tenant_id || req.tenantContext?.tenant_id,
      entity_data: req.body.entity_data,
      confidence: req.body.confidence,
      source_document_id: req.body.source_document_id,
      source_span: req.body.source_span,
      suggested_action: req.body.suggested_action
    };

    const result = await reviewQueueService.addToQueue(item);
    res.json({ success: true, item: result });
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
