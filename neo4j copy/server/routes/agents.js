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
      vkg_databases: req.body.vkgDatabases || [],
      search_mode: searchMode || 'hybrid',
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
    // Also delete conversation history
    await redisService.del(`agent_conversations:${req.params.id}`);
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
 */
router.post('/:id/chat', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.headers['x-workspace-id'] || 'default';
    const agentKey = `agent:${tenantId}:${workspaceId}:${req.params.id}`;
    const agentJson = await redisService.get(agentKey);
    if (!agentJson) return res.status(404).json({ success: false, error: 'Agent not found' });

    const agent = JSON.parse(agentJson);
    const { message, history } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'Message is required' });

    const searchMode = agent.search_mode || 'hybrid';
    const topK = agent.settings?.topK || 8;
    const graphDepth = agent.settings?.graphDepth || 2;

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

    // VKG mode uses a different service
    if (searchMode === 'vkg') {
      const vkgQueryService = require('../services/vkgQueryService');
      const result = await vkgQueryService.query(message, tenantId, workspaceId, {
        systemPrompt: agent.perspective,
        databases: agent.vkg_databases || []
      });
      return res.json({
        success: true,
        message: {
          role: 'assistant',
          content: result.answer || 'No response',
          sources: result.citations ? { sql: result.citations.sql, databases: result.citations.databases } : null,
          agent_id: agent.agent_id,
          agent_name: agent.name,
          searchMode: 'vkg'
        }
      });
    }

    // All other modes go through graphRAGService
    const graphRAGService = require('../services/graphRAGService');

    // Prepend agent perspective to the question so the LLM uses it as context
    const perspectivePrefix = agent.perspective
      ? `[Agent Perspective: ${agent.perspective}]\n\n`
      : '';

    const queryOptions = {
      searchMode,
      topK,
      graphDepth,
      tenant_id: tenantId,
      workspace_id: workspaceId,
      history: (history || []).map(m => ({ role: m.role, content: m.content }))
    };

    // Pass document IDs filter for folder-scoped queries
    if (scopedDocumentIds) {
      queryOptions.documentIds = scopedDocumentIds;
    }

    const result = await graphRAGService.query(perspectivePrefix + message, queryOptions);

    // Extract sources from the result
    const sources = [];
    if (result.sources?.chunks) {
      for (const c of result.sources.chunks) {
        sources.push({
          documentId: c.documentId,
          documentName: c.documentName,
          chunkIndex: c.chunkIndex,
          similarity: c.similarity,
          text: (c.text || '').substring(0, 200)
        });
      }
    }

    res.json({
      success: true,
      message: {
        role: 'assistant',
        content: result.answer || 'No response',
        sources,
        metadata: result.metadata,
        agent_id: agent.agent_id,
        agent_name: agent.name,
        searchMode
      }
    });
  } catch (error) {
    logger.error('Agent chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
