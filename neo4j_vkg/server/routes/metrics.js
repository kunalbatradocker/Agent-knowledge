/**
 * Metrics Routes
 * Health metrics and observability endpoints
 */

const express = require('express');
const router = express.Router();
const metricsService = require('../services/metricsService');
const trustScoringService = require('../services/trustScoringService');
const reviewQueueService = require('../services/reviewQueueService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { requireManager, requireAdmin } = require('../middleware/auth');

/**
 * GET /api/metrics/health
 * Get health dashboard metrics
 */
router.get('/health', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const metrics = await metricsService.getHealthMetrics(workspaceId);

    // Add review queue stats
    const queueStats = await reviewQueueService.getQueueStats(workspaceId);
    metrics.review_queue = queueStats;

    // Add trust stats
    const trustStats = await trustScoringService.getWorkspaceTrustStats(workspaceId);
    metrics.trust = trustStats;

    res.json({ success: true, metrics });
  } catch (error) {
    console.error('Error fetching health metrics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/timeseries/:metric
 * Get timeseries data for a metric
 */
router.get('/timeseries/:metric', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const days = parseInt(req.query.days) || 30;
    const metricName = req.params.metric;

    const data = await metricsService.getTimeseries(metricName, workspaceId, days);
    res.json({ success: true, metric: metricName, data });
  } catch (error) {
    console.error('Error fetching timeseries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/timeseries
 * Get timeseries data for a metric (query param version)
 */
router.get('/timeseries', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const days = parseInt(req.query.days) || 30;
    const metricName = req.query.metric || 'extraction_success';

    const data = await metricsService.getTimeseries(metricName, workspaceId, days);
    res.json({ success: true, metric: metricName, data });
  } catch (error) {
    console.error('Error fetching timeseries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/coverage
 * Get ontology coverage details
 */
router.get('/coverage', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const coverage = await metricsService.getOntologyCoverage(workspaceId);
    res.json({ success: true, coverage });
  } catch (error) {
    console.error('Error fetching coverage:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/export
 * Export all metrics
 */
router.get('/export', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const data = await metricsService.exportMetrics(workspaceId);
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error exporting metrics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/metrics/reset
 * Reset metrics for a workspace (admin only)
 */
router.post('/reset', requireAdmin, optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const result = await metricsService.resetMetrics(workspaceId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error resetting metrics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/trust
 * Get trust statistics
 */
router.get('/trust', optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.tenantContext?.workspace_id;
    const stats = await trustScoringService.getWorkspaceTrustStats(workspaceId);
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching trust stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/metrics/trust/recalculate
 * Recalculate trust scores for workspace
 */
router.post('/trust/recalculate', requireManager, optionalTenantContext, async (req, res) => {
  try {
    const workspaceId = req.body.workspace_id || req.tenantContext?.workspace_id;
    
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const result = await trustScoringService.recalculateWorkspaceTrust(workspaceId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error recalculating trust:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metrics/source-authorities
 * Get source authority weights
 */
router.get('/source-authorities', async (req, res) => {
  try {
    const authorities = await trustScoringService.getAllSourceAuthorities();
    res.json({ success: true, authorities });
  } catch (error) {
    console.error('Error fetching authorities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/metrics/source-authorities
 * Set source authority weight
 */
router.post('/source-authorities', requireManager, async (req, res) => {
  try {
    const { source_type, authority } = req.body;
    
    if (!source_type || authority === undefined) {
      return res.status(400).json({ success: false, error: 'source_type and authority are required' });
    }

    const result = await trustScoringService.setSourceAuthority(source_type, authority);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error setting authority:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
