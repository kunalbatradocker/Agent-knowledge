/**
 * Agents API — CRUD for workspace-scoped AI agents
 * Each agent has a name, perspective/system prompt, and attached knowledge graphs.
 * Stored in Redis: agent:{tenantId}:{workspaceId}:{agentId}
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const redisService = require('../services/redisService');
const logger = require('../utils/logger');
const { optionalTenantContext } = require('../middleware/tenantContext');

/**
 * GET /api/agents — list all agents for the current workspace
 */
router.get('/', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const pattern = `agent:${tenantId}:${workspaceId}:*`;
    const keys = await redisService.keys(pattern);
    const agents = [];
    for (const key of keys) {
      try {
        const json = await redisService.get(key);
        if (json) agents.push(JSON.parse(json));
      } catch (e) { /* skip corrupt */ }
    }
    agents.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
    res.json({ success: true, agents });
  } catch (error) {
    logger.error('List agents error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:id — get a single agent
 */
router.get('/:id', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const json = await redisService.get(`agent:${tenantId}:${workspaceId}:${req.params.id}`);
    if (!json) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, agent: JSON.parse(json) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents — create a new agent
 */
router.post('/', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const { name, description, perspective, knowledgeGraphs, searchMode, settings } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'Agent name is required' });

    const agentId = uuidv4();
    const agent = {
      agent_id: agentId,
      name: name.trim(),
      description: (description || '').trim(),
      perspective: (perspective || '').trim(),
      knowledge_graphs: knowledgeGraphs || [],
      folders: req.body.folders || [],
      ontologies: req.body.ontologies || [],
      vkg_databases: req.body.vkgDatabases || [],
      search_mode: searchMode || 'hybrid', // kept for backward compat, planner ignores it
      settings: settings || { topK: 8, graphDepth: 2 },
      tenant_id: tenantId,
      workspace_id: workspaceId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: req.user?.email || 'unknown'
    };

    await redisService.set(`agent:${tenantId}:${workspaceId}:${agentId}`, JSON.stringify(agent), 0);
    logger.info(`🤖 Agent created: ${name} (${agentId}) in workspace ${workspaceId}`);
    res.json({ success: true, agent });
  } catch (error) {
    logger.error('Create agent error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/agents/:id — update an agent
 */
router.put('/:id', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const key = `agent:${tenantId}:${workspaceId}:${req.params.id}`;
    const existing = await redisService.get(key);
    if (!existing) return res.status(404).json({ success: false, error: 'Agent not found' });

    const agent = JSON.parse(existing);
    const { name, description, perspective, knowledgeGraphs, searchMode, settings } = req.body;
    if (name !== undefined) agent.name = name.trim();
    if (description !== undefined) agent.description = description.trim();
    if (perspective !== undefined) agent.perspective = perspective.trim();
    if (knowledgeGraphs !== undefined) agent.knowledge_graphs = knowledgeGraphs;
    if (req.body.folders !== undefined) agent.folders = req.body.folders;
    if (req.body.ontologies !== undefined) agent.ontologies = req.body.ontologies;
    if (req.body.vkgDatabases !== undefined) agent.vkg_databases = req.body.vkgDatabases;
    if (searchMode !== undefined) agent.search_mode = searchMode;
    if (settings !== undefined) agent.settings = { ...agent.settings, ...settings };
    agent.updated_at = new Date().toISOString();

    await redisService.set(key, JSON.stringify(agent), 0);
    res.json({ success: true, agent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/agents/:id — delete an agent
 */
router.delete('/:id', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const key = `agent:${tenantId}:${workspaceId}:${req.params.id}`;
    const existing = await redisService.get(key);
    if (!existing) return res.status(404).json({ success: false, error: 'Agent not found' });
    await redisService.del(key);
    // Also delete conversation history and memories (all users)
    await redisService.del(`agent_conversations:${req.params.id}`);
    try {
      const memoryService = require('../services/memoryService');
      await memoryService.clearAllAgentData(req.params.id);
    } catch (e) { logger.warn(`⚠️ Memory cleanup on agent delete failed: ${e.message}`); }
    res.json({ success: true, message: 'Agent deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents/:id/chat — send a message to an agent
 * Uses the agent's perspective as system prompt and routes through graphRAGService
 * so all search modes (hybrid, rag, graph, graphdb, vkg) work.
 * When folders are attached, queries are scoped to documents in those folders.
 * When memory is enabled, injects long-term memory context and extracts new memories async.
 */
router.post('/:id/chat', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const userId = req.user?.email || req.headers['x-user-id'] || 'default';
    const agentKey = `agent:${tenantId}:${workspaceId}:${req.params.id}`;
    const agentJson = await redisService.get(agentKey);
    if (!agentJson) return res.status(404).json({ success: false, error: 'Agent not found' });

    const agent = JSON.parse(agentJson);
    const { message, history, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'Message is required' });

    const searchMode = agent.search_mode || 'hybrid'; // backward compat
    const memoryEnabled = agent.settings?.memoryEnabled !== false; // enabled by default

    // ── Assemble memory context (if enabled) ──
    let memoryContext = null;
    if (memoryEnabled) {
      try {
        const memoryService = require('../services/memoryService');
        memoryContext = await memoryService.assembleMemoryContext(agent.agent_id, userId, message);
      } catch (e) {
        logger.warn(`⚠️ Memory context assembly failed (non-blocking): ${e.message}`);
      }
    }

    // ── Resolve folder-scoped document IDs ──
    // If agent has folders attached, find all document IDs in those folders
    let scopedDocumentIds = null;
    const agentFolders = agent.folders || [];
    if (agentFolders.length > 0) {
      scopedDocumentIds = [];
      const folderIds = new Set(agentFolders.map(f => f.id));
      // Scan doc:* keys in Redis to find documents belonging to these folders
      const docKeys = await redisService.keys('doc:*');
      for (const key of docKeys) {
        if (key.includes(':chunks')) continue;
        try {
          const raw = await redisService.get(key);
          if (!raw) continue;
          const doc = JSON.parse(raw);
          if (doc.folder_id && folderIds.has(doc.folder_id)) {
            const docId = doc.doc_id || doc.id || key.replace('doc:', '');
            scopedDocumentIds.push(docId);
          }
        } catch (e) { /* skip */ }
      }
      logger.info(`🤖 Agent "${agent.name}" scoped to ${scopedDocumentIds.length} documents from ${agentFolders.length} folder(s)`);

      if (scopedDocumentIds.length === 0) {
        return res.json({
          success: true,
          message: {
            role: 'assistant',
            content: 'No documents found in the attached folders. Please upload documents to the folders first.',
            sources: [],
            agent_id: agent.agent_id,
            agent_name: agent.name,
            searchMode
          }
        });
      }
    }

    // ── Unified Agent Query Pipeline ──
    // Routes through the planner which decides which sources to consult
    // (vector, graph, vkg, memory) based on the query + context.
    // GraphDB provides ontology schema to guide Neo4j and VKG queries.
    const graphRAGService = require('../services/graphRAGService');

    const result = await graphRAGService.unifiedAgentQuery(message, {
      agent,
      memoryContext,
      scopedDocumentIds,
      tenant_id: tenantId,
      workspace_id: workspaceId,
      userId,
      history: (history || []).map(m => ({ role: m.role, content: m.content }))
    });

    const assistantContent = result.answer || 'No response';

    // Fire-and-forget: memory extraction + session persistence
    if (memoryEnabled) {
      _asyncMemoryWork(agent.agent_id, userId, message, assistantContent, sessionId);
    }

    res.json({
      success: true,
      message: {
        role: 'assistant',
        content: assistantContent,
        sources: result.sources || {},
        metadata: result.metadata,
        context_graph: result.context_graph,
        reasoning_trace: result.reasoning_trace,
        agent_id: agent.agent_id,
        agent_name: agent.name,
        searchMode: result.metadata?.searchMode || searchMode
      }
    });
  } catch (error) {
    logger.error('Agent chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Async background work after a chat response:
 * 1. Extract memories from the conversation turn
 * 2. Persist messages to the session
 * This never blocks the response.
 */
function _asyncMemoryWork(agentId, userId, userMessage, assistantResponse, sessionId) {
  setImmediate(async () => {
    try {
      const memoryService = require('../services/memoryService');

      // Persist to session if sessionId provided — lazily create if it doesn't exist yet
      if (sessionId) {
        const existing = await memoryService.getSession(agentId, userId, sessionId);
        if (!existing) {
          await memoryService.createSession(agentId, userId, sessionId);
        }
        await memoryService.appendToSession(agentId, userId, sessionId, { role: 'user', content: userMessage, timestamp: Date.now() });
        await memoryService.appendToSession(agentId, userId, sessionId, { role: 'assistant', content: assistantResponse, timestamp: Date.now() });
      }

      // Extract and consolidate memories
      await memoryService.extractMemories(agentId, userId, userMessage, assistantResponse, sessionId);
    } catch (e) {
      logger.warn(`⚠️ Async memory work failed (non-critical): ${e.message}`);
    }
  });
}

module.exports = router;
