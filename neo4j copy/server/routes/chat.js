const express = require('express');
const graphRAGService = require('../services/graphRAGService');
const vectorStoreService = require('../services/vectorStoreService');
const { client, connectRedis } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const { optionalTenantContext, useDefaultTenantIfMissing } = require('../middleware/tenantContext');
const { requireMember } = require('../middleware/auth');

const router = express.Router();

// Conversation storage with Redis persistence
const CONVERSATION_PREFIX = 'conv:';
const CONVERSATION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// In-memory cache for active conversations (backed by Redis)
const conversationCache = new Map();

/**
 * Get conversation from Redis or cache
 */
async function getConversation(convId) {
  // Check cache first
  if (conversationCache.has(convId)) {
    return conversationCache.get(convId);
  }
  
  // Try Redis
  try {
    await connectRedis();
    const data = await client.get(`${CONVERSATION_PREFIX}${convId}`);
    if (data) {
      const conversation = JSON.parse(data);
      conversationCache.set(convId, conversation);
      return conversation;
    }
  } catch (error) {
    console.warn('Redis unavailable for conversation storage:', error.message);
  }
  
  return null;
}

/**
 * Save conversation to Redis and cache
 */
async function saveConversation(conversation) {
  conversationCache.set(conversation.id, conversation);
  
  try {
    await connectRedis();
    await client.setEx(
      `${CONVERSATION_PREFIX}${conversation.id}`,
      CONVERSATION_TTL,
      JSON.stringify(conversation)
    );
  } catch (error) {
    console.warn('Could not persist conversation to Redis:', error.message);
  }
}

/**
 * Delete conversation from Redis and cache
 */
async function deleteConversation(convId) {
  conversationCache.delete(convId);
  
  try {
    await connectRedis();
    await client.del(`${CONVERSATION_PREFIX}${convId}`);
    return true;
  } catch (error) {
    console.warn('Could not delete conversation from Redis:', error.message);
    return false;
  }
}

/**
 * List all conversations from Redis
 */
async function listConversations() {
  try {
    await connectRedis();
    // Use SCAN instead of KEYS
    const keys = [];
    let cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${CONVERSATION_PREFIX}*`, 'COUNT', '200']);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    const conversations = [];
    
    for (const key of keys) {
      const data = await client.get(key);
      if (data) {
        const conv = JSON.parse(data);
        conversations.push({
          id: conv.id,
          createdAt: conv.createdAt,
          messageCount: conv.messages?.length || 0,
          lastMessage: conv.messages?.[conv.messages.length - 1]?.content?.substring(0, 100) || ''
        });
      }
    }
    
    return conversations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    console.warn('Could not list conversations from Redis:', error.message);
    // Fallback to cache
    return Array.from(conversationCache.values()).map(conv => ({
      id: conv.id,
      createdAt: conv.createdAt,
      messageCount: conv.messages?.length || 0,
      lastMessage: conv.messages?.[conv.messages.length - 1]?.content?.substring(0, 100) || ''
    }));
  }
}

// Chat endpoint - main conversational interface
// Uses optional tenant context for workspace-scoped queries
router.post('/message', optionalTenantContext, async (req, res) => {
  try {
    const { message, conversationId, history = [], options = {} } = req.body;
    const tenantContext = req.tenantContext || {};

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get or create conversation
    const convId = conversationId || uuidv4();
    let conversation = await getConversation(convId);
    if (!conversation) {
      conversation = {
        id: convId,
        messages: [],
        createdAt: new Date().toISOString(),
        tenant_id: tenantContext.tenant_id,
        workspace_id: tenantContext.workspace_id
      };
    }

    // Add user message to history
    conversation.messages.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    });

    // Build query with conversation context if history provided
    let queryMessage = message;
    if (history && history.length > 0) {
      // Build context from recent conversation history
      const historyContext = history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n');
      
      queryMessage = `Previous conversation:\n${historyContext}\n\nCurrent question: ${message}`;
      console.log(`   Including ${history.length} messages of conversation history`);
    }

    // Perform query based on search mode
    // Merge tenant context from middleware with options from request body
    const searchMode = options.searchMode || 'hybrid';
    const effectiveTenantId = options.tenant_id || tenantContext.tenant_id;
    const effectiveWorkspaceId = options.workspace_id || tenantContext.workspace_id;
    
    console.log(`\nChat message: "${message}" [Mode: ${searchMode}]${effectiveWorkspaceId ? ` [Workspace: ${effectiveWorkspaceId}]` : ''}`);
    
    // Per-user Bedrock token is handled by injectUserLLMToken middleware
    // via AsyncLocalStorage. Also pass explicitly as fallback for graphRAGService.
    let bedrockToken = null;

    const result = await graphRAGService.query(queryMessage, {
      searchMode: searchMode,
      topK: options.topK || 50,
      graphDepth: options.graphDepth || 2,
      // Pass through filter options (prefer explicit options, fall back to tenant context)
      tenant_id: effectiveTenantId,
      workspace_id: effectiveWorkspaceId,
      doc_type: options.doc_type,
      context_type: options.context_type,
      // Pass schema from UI for GraphDB mode
      schema: options.schema,
      graphId: options.graphId,
      graphIRI: options.graphIRI,
      // Per-user Bedrock token
      bedrockToken
    });

    // Add assistant response to history
    const historyContent = result.compare 
      ? `RAG: ${result.compare.rag.answer}\n\nGraphDB: ${result.compare.graphdb.answer}`
      : result.answer;
    conversation.messages.push({
      role: 'assistant',
      content: historyContent,
      sources: result.sources,
      metadata: result.metadata,
      timestamp: new Date().toISOString()
    });

    // Cap conversation history to prevent unbounded Redis/memory growth
    if (conversation.messages.length > 100) {
      conversation.messages = conversation.messages.slice(-100);
    }

    // Save conversation
    await saveConversation(conversation);

    res.json({
      conversationId: convId,
      message: {
        role: 'assistant',
        content: result.answer,
        sources: result.sources,
        compare: result.compare || null,
        metadata: {
          ...result.metadata,
          tenant_id: effectiveTenantId,
          workspace_id: effectiveWorkspaceId
        }
      }
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to process message',
      message: error.message
    });
  }
});

// Get conversation history
router.get('/conversation/:id', async (req, res) => {
  const conversation = await getConversation(req.params.id);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(conversation);
});

// List all conversations
router.get('/conversations', async (req, res) => {
  const convList = await listConversations();
  res.json(convList);
});

// Delete conversation
router.delete('/conversation/:id', requireMember, async (req, res) => {
  const deleted = await deleteConversation(req.params.id);
  res.json({ success: deleted });
});

// Clear all conversations
router.delete('/conversations', requireMember, async (req, res) => {
  try {
    await connectRedis();
    // Use SCAN instead of KEYS
    let cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${CONVERSATION_PREFIX}*`, 'COUNT', '200']);
      cursor = result[0];
      if (result[1].length > 0) {
        await client.del(result[1]);
      }
    } while (cursor !== '0');
    conversationCache.clear();
    res.json({ success: true, message: 'All conversations cleared' });
  } catch (error) {
    conversationCache.clear();
    res.json({ success: true, message: 'Conversations cleared from cache' });
  }
});

// Get Graph RAG statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await graphRAGService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
});

// Semantic search endpoint (for debugging/testing)
// Supports workspace-scoped search via tenant context
router.post('/search', optionalTenantContext, async (req, res) => {
  try {
    const { query, topK = 5 } = req.body;
    const tenantContext = req.tenantContext || {};

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Build filters from tenant context
    const filters = {};
    if (tenantContext.tenant_id) filters.tenant_id = tenantContext.tenant_id;
    if (tenantContext.workspace_id) filters.workspace_id = tenantContext.workspace_id;

    const results = await vectorStoreService.semanticSearch(query, topK, Object.keys(filters).length > 0 ? filters : undefined);
    res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

// Get stored documents
router.get('/documents', async (req, res) => {
  try {
    const documents = await vectorStoreService.getDocuments();
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({
      error: 'Failed to fetch documents',
      message: error.message
    });
  }
});

// Delete a document (workspace-scoped)
router.delete('/document/:id', async (req, res) => {
  try {
    const workspaceId = req.headers['x-workspace-id'] || req.query.workspace_id || null;
    
    // Verify document belongs to this workspace before deleting
    if (workspaceId) {
      const redisService = require('../services/redisService');
      const docJson = await redisService.get(`doc:${req.params.id}`);
      if (docJson) {
        const doc = JSON.parse(docJson);
        if (doc.workspace_id && doc.workspace_id !== workspaceId) {
          return res.status(404).json({ error: 'Document not found' });
        }
      }
    }
    
    const result = await vectorStoreService.deleteDocument(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({
      error: 'Failed to delete document',
      message: error.message
    });
  }
});

module.exports = router;

