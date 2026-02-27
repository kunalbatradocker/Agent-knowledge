/**
 * Agent Memory API Routes
 * CRUD for long-term memories, core memory, and conversation sessions.
 * Mounted at /api/agents/:agentId/memories
 * 
 * All memory is scoped per-agent AND per-user (from JWT).
 */
const express = require('express');
const router = express.Router({ mergeParams: true });
const memoryService = require('../services/memoryService');
const logger = require('../utils/logger');

/** Extract userId from authenticated request */
function getUserId(req) {
  return req.user?.email || req.headers['x-user-id'] || 'default';
}

/**
 * GET /api/agents/:agentId/memories
 */
router.get('/', async (req, res) => {
  try {
    const { agentId } = req.params;
    const userId = getUserId(req);
    const { type, status, limit, offset } = req.query;
    const memories = await memoryService.listMemories(agentId, userId, {
      type: type || null,
      status: status || 'active',
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json({ success: true, memories });
  } catch (error) {
    logger.error('List memories error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/memories/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await memoryService.getStats(req.params.agentId, getUserId(req));
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/memories/graph
 */
router.get('/graph', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const graph = await memoryService.getMemoryGraph(req.params.agentId, getUserId(req), { forceRefresh });
    res.json({ success: true, graph });
  } catch (error) {
    logger.error('Memory graph error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/memories/core
 */
router.get('/core', async (req, res) => {
  try {
    const core = await memoryService.getCoreMemory(req.params.agentId, getUserId(req));
    res.json({ success: true, core });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/agents/:agentId/memories/core
 */
router.put('/core', async (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ success: false, error: 'content is required' });
    const core = await memoryService.setCoreMemory(req.params.agentId, getUserId(req), content);
    res.json({ success: true, core });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/agents/:agentId/memories/:memoryId
 */
router.put('/:memoryId', async (req, res) => {
  try {
    const { agentId, memoryId } = req.params;
    const userId = getUserId(req);
    const { content, type, importance } = req.body;
    const updates = {};
    if (content !== undefined) updates.content = content;
    if (type !== undefined) updates.type = type;
    if (importance !== undefined) updates.importance = importance;

    const updated = await memoryService.updateMemory(agentId, userId, memoryId, updates);
    if (!updated) return res.status(404).json({ success: false, error: 'Memory not found' });
    res.json({ success: true, memory: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/agents/:agentId/memories/:memoryId
 */
router.delete('/:memoryId', async (req, res) => {
  try {
    const { agentId, memoryId } = req.params;
    await memoryService.invalidateMemory(agentId, getUserId(req), memoryId);
    res.json({ success: true, message: 'Memory invalidated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents/:agentId/memories/clear
 */
router.post('/clear', async (req, res) => {
  try {
    await memoryService.clearMemories(req.params.agentId, getUserId(req));
    res.json({ success: true, message: 'All memories cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents/:agentId/memories/decay
 */
router.post('/decay', async (req, res) => {
  try {
    const decayed = await memoryService.decayMemories(req.params.agentId, getUserId(req));
    res.json({ success: true, decayed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Session Routes ───────────────────────────────────────────

/**
 * GET /api/agents/:agentId/memories/sessions
 */
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await memoryService.listSessions(req.params.agentId, getUserId(req), parseInt(req.query.limit) || 20);
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents/:agentId/memories/sessions
 * Returns a new session ID. Session is NOT persisted until the first message
 * is appended (lazy creation via _asyncMemoryWork in agents.js).
 */
router.post('/sessions', async (req, res) => {
  try {
    const sessionId = require('crypto').randomUUID();
    res.json({ success: true, session: { session_id: sessionId, messages: [], created_at: Date.now(), updated_at: Date.now() } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/memories/sessions/:sessionId
 */
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const session = await memoryService.getSession(req.params.agentId, getUserId(req), req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/agents/:agentId/memories/sessions/:sessionId
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    await memoryService.deleteSession(req.params.agentId, getUserId(req), req.params.sessionId);
    res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/agents/:agentId/memories/sessions — clear all sessions
 */
router.delete('/sessions', async (req, res) => {
  try {
    await memoryService.clearSessions(req.params.agentId, getUserId(req));
    res.json({ success: true, message: 'All sessions cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
