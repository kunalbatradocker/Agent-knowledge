const express = require('express');
const router = express.Router();
const graphDBNeo4jSyncService = require('../services/graphDBNeo4jSyncService');
const { optionalTenantContext } = require('../middleware/tenantContext');
const { client: redisClient } = require('../config/redis');

const SYNC_KEY = 'sync:status';

const defaultStatus = {
  status: 'idle',
  progress: 0,
  message: '',
  startedAt: null,
  completedAt: null,
  error: null,
  stats: null
};

async function getStatus() {
  try {
    if (!redisClient.isOpen) return { ...defaultStatus };
    const data = await redisClient.get(SYNC_KEY);
    return data ? JSON.parse(data) : { ...defaultStatus };
  } catch {
    return { ...defaultStatus };
  }
}

async function setStatus(updates) {
  const current = await getStatus();
  const updated = { ...current, ...updates };
  try {
    if (redisClient.isOpen) {
      await redisClient.set(SYNC_KEY, JSON.stringify(updated), { EX: 86400 });
    }
  } catch { /* ignore */ }
  return updated;
}

// GET /api/sync/status
router.get('/status', async (_req, res) => {
  res.json(await getStatus());
});

// POST /api/sync/trigger
router.post('/trigger', optionalTenantContext, async (req, res) => {
  const tenantId = req.tenantContext?.tenant_id || req.body.tenantId;
  const workspaceId = req.tenantContext?.workspace_id || req.body.workspaceId;

  if (!tenantId || !workspaceId) {
    return res.status(400).json({ error: 'tenantId and workspaceId are required' });
  }

  const { type = 'all', mode = 'full' } = req.body;

  const current = await getStatus();
  if (current.status === 'running') {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  const status = await setStatus({
    status: 'running',
    progress: 0,
    message: `Starting ${mode} sync...`,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    stats: null
  });

  res.json({ message: 'Sync started', status });

  setImmediate(async () => {
    try {
      await setStatus({ message: 'Syncing data...', progress: 50 });

      let result;
      if (type === 'schema') {
        await graphDBNeo4jSyncService.syncOntologySchema(tenantId, workspaceId);
        result = { type: 'schema' };
      } else if (type === 'instances') {
        const synced = await graphDBNeo4jSyncService.syncInstanceData(tenantId, workspaceId);
        result = { type: 'instances', synced };
      } else {
        result = await graphDBNeo4jSyncService.syncAll(tenantId, workspaceId, { mode });
      }

      await setStatus({
        status: 'completed',
        progress: 100,
        message: `${mode} sync completed`,
        completedAt: new Date().toISOString(),
        stats: result
      });
    } catch (error) {
      await setStatus({
        status: 'failed',
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
    }
  });
});

// POST /api/sync/reset
router.post('/reset', async (_req, res) => {
  await setStatus(defaultStatus);
  res.json({ message: 'Status reset' });
});

// POST /api/sync/remove-orphans
router.post('/remove-orphans', optionalTenantContext, async (req, res) => {
  const tenantId = req.tenantContext?.tenant_id || req.body.tenantId;
  const workspaceId = req.tenantContext?.workspace_id || req.body.workspaceId;

  if (!tenantId || !workspaceId) {
    return res.status(400).json({ error: 'tenantId and workspaceId are required' });
  }
  
  try {
    const result = await graphDBNeo4jSyncService.removeOrphans(tenantId, workspaceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
