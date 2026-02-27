/**
 * Agent Long-Term Memory Service — Dual-Pool Architecture
 *
 * Two independent memory pools:
 *
 * 1. AGENT pool — domain knowledge tied to a specific agent+user pair.
 *    Types: semantic (facts/knowledge), event (notable events).
 *    Lifecycle: deleted when the agent is deleted.
 *    Key pattern: memory:agent:{agentId}:{userId}:{memoryId}
 *
 * 2. USER pool — personal preferences/decisions that follow the user.
 *    Types: preference (user preferences), decision (decisions made).
 *    Lifecycle: deleted when the user is deleted. Survives agent deletion.
 *    Key pattern: memory:user:{userId}:{memoryId}
 *
 * At query time both pools are searched and merged so the agent sees
 * the full picture: domain knowledge + personal preferences.
 *
 * Sessions and core memory remain scoped to agent+user (conversations
 * happen in the context of a specific agent).
 *
 * Key patterns:
 *   memory:agent:{agentId}:{userId}:{memoryId}   — agent-scoped memory (JSON)
 *   memory:user:{userId}:{memoryId}               — user-scoped memory (JSON)
 *   idx:agent_memories                             — RediSearch index for agent pool
 *   idx:user_memories                              — RediSearch index for user pool
 *   agent_core_memory:{agentId}:{userId}           — always-in-context core memory
 *   agent_session:{agentId}:{userId}:{sessionId}   — conversation session
 *   agent_sessions:{agentId}:{userId}              — sorted set of session IDs
 *   memory_graph:{agentId}:{userId}                — cached memory graph
 */

const { v4: uuidv4 } = require('uuid');
const { client, connectRedis } = require('../config/redis');
const embeddingService = require('./embeddingService');
const llmService = require('./llmService');
const logger = require('../utils/logger');

const AGENT_MEMORY_PREFIX = 'memory:agent:';
const USER_MEMORY_PREFIX = 'memory:user:';
const CORE_MEMORY_PREFIX = 'agent_core_memory:';
const SESSION_PREFIX = 'agent_session:';
const SESSION_LIST_PREFIX = 'agent_sessions:';
const AGENT_INDEX = 'idx:agent_memories';
const USER_INDEX = 'idx:user_memories';

// Types that go to the user pool (survive agent deletion)
const USER_MEMORY_TYPES = new Set(['preference', 'decision']);

class MemoryService {
  constructor() {
    this._agentIndexReady = false;
    this._userIndexReady = false;
    this._agentIndexPromise = null;
    this._userIndexPromise = null;
  }

  // ─── Helpers ────────────────────────────────────────────────

  _scope(agentId, userId) {
    return `${agentId}:${userId || 'default'}`;
  }

  _float32Buffer(arr) {
    const buf = Buffer.alloc(arr.length * 4);
    for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
    return buf;
  }

  _escapeTag(value) {
    return String(value).replace(/[-@.,:;!?+&|~*^${}()\[\]\\/<>='"#%\s]/g, '\\$&');
  }

  /** Determine which pool a memory type belongs to */
  _isUserMemory(type) {
    return USER_MEMORY_TYPES.has(type);
  }

  /** Build the Redis key for a memory record */
  _memoryKey(type, agentId, userId, memoryId) {
    if (this._isUserMemory(type)) {
      return `${USER_MEMORY_PREFIX}${userId || 'default'}:${memoryId}`;
    }
    return `${AGENT_MEMORY_PREFIX}${agentId}:${userId || 'default'}:${memoryId}`;
  }

  _parseJSON(text) {
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try { return JSON.parse(match[1].trim()); } catch { /* fall through */ }
      }
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
      }
      return [];
    }
  }

  // ─── Vector Indexes ─────────────────────────────────────────

  async _ensurePoolIndex(indexName, prefix, readyFlag, promiseField, dim) {
    if (this[readyFlag]) return;
    if (this[promiseField]) return this[promiseField];

    this[promiseField] = (async () => {
      try {
        await connectRedis();
        const info = await client.ft.info(indexName);
        const attrs = info.attributes || [];
        const hasUserId = attrs.some(a => {
          const name = a.attribute || a.identifier || a.AS || '';
          return name === '$.user_id' || name === 'user_id';
        });
        if (!hasUserId) {
          logger.info(`🔧 Index ${indexName} missing user_id field, recreating...`);
          await client.ft.dropIndex(indexName);
          throw new Error('recreate');
        }
        this[readyFlag] = true;
        logger.info(`✅ Memory index "${indexName}" already exists`);
      } catch (err) {
        const dimension = dim || parseInt(process.env.EMBEDDING_DIMENSION) || 1024;
        logger.info(`🔧 Creating memory index "${indexName}" (dim=${dimension})...`);
        try {
          await client.ft.create(indexName, {
            '$.embedding': { type: 'VECTOR', ALGORITHM: 'HNSW', TYPE: 'FLOAT32', DIM: dimension, DISTANCE_METRIC: 'COSINE', AS: 'embedding' },
            '$.content': { type: 'TEXT', AS: 'content' },
            '$.agent_id': { type: 'TAG', AS: 'agent_id' },
            '$.user_id': { type: 'TAG', AS: 'user_id' },
            '$.type': { type: 'TAG', AS: 'type' },
            '$.status': { type: 'TAG', AS: 'status' },
            '$.importance': { type: 'NUMERIC', AS: 'importance' },
            '$.created_at': { type: 'NUMERIC', AS: 'created_at' },
            '$.last_accessed': { type: 'NUMERIC', AS: 'last_accessed' }
          }, { ON: 'JSON', PREFIX: prefix });
          this[readyFlag] = true;
          logger.info(`✅ Memory index "${indexName}" created`);
        } catch (createErr) {
          if (createErr.message?.includes('Index already exists')) {
            this[readyFlag] = true;
          } else {
            logger.error(`❌ Failed to create index ${indexName}:`, createErr.message);
            throw createErr;
          }
        }
      }
      this[promiseField] = null;
    })();
    return this[promiseField];
  }

  async ensureAgentIndex(dim) {
    return this._ensurePoolIndex(AGENT_INDEX, AGENT_MEMORY_PREFIX, '_agentIndexReady', '_agentIndexPromise', dim);
  }

  async ensureUserIndex(dim) {
    return this._ensurePoolIndex(USER_INDEX, USER_MEMORY_PREFIX, '_userIndexReady', '_userIndexPromise', dim);
  }

  async ensureIndexes(dim) {
    await Promise.all([this.ensureAgentIndex(dim), this.ensureUserIndex(dim)]);
  }

  // ─── Memory CRUD ────────────────────────────────────────────

  async addMemory(agentId, userId, { type, content, importance = 0.5, sourceSessionId = null, tags = [] }) {
    await connectRedis();
    const memoryId = uuidv4();
    const isUser = this._isUserMemory(type);
    const key = this._memoryKey(type, agentId, userId, memoryId);
    const now = Date.now();

    let embedding;
    try {
      embedding = await embeddingService.generateEmbedding(content);
      if (isUser) await this.ensureUserIndex(embedding.length);
      else await this.ensureAgentIndex(embedding.length);
    } catch (e) {
      logger.warn(`⚠️ Memory embedding failed, storing without vector: ${e.message}`);
      embedding = null;
    }

    const record = {
      memory_id: memoryId,
      agent_id: agentId,
      user_id: userId || 'default',
      type,
      pool: isUser ? 'user' : 'agent',
      content,
      importance,
      tags,
      source_session_id: sourceSessionId || '',
      status: 'active',
      created_at: now,
      last_accessed: now,
      access_count: 0,
      embedding: embedding ? Array.from(embedding) : []
    };

    await client.json.set(key, '$', record);
    logger.info(`🧠 [${isUser ? 'USER' : 'AGENT'}] Memory added: [${type}] ${content.substring(0, 80)}...`);
    return record;
  }

  async getMemory(agentId, userId, memoryId) {
    await connectRedis();
    // Try agent pool first, then user pool
    const agentKey = `${AGENT_MEMORY_PREFIX}${agentId}:${userId || 'default'}:${memoryId}`;
    try {
      const result = await client.json.get(agentKey);
      if (result) return result;
    } catch { /* not in agent pool */ }
    const userKey = `${USER_MEMORY_PREFIX}${userId || 'default'}:${memoryId}`;
    try {
      return await client.json.get(userKey);
    } catch { return null; }
  }

  async updateMemory(agentId, userId, memoryId, updates) {
    await connectRedis();
    // Find the memory in either pool
    const memory = await this.getMemory(agentId, userId, memoryId);
    if (!memory) return null;

    const key = this._memoryKey(memory.type, memory.agent_id || agentId, userId, memoryId);

    if (updates.content && updates.content !== memory.content) {
      try {
        const embedding = await embeddingService.generateEmbedding(updates.content);
        updates.embedding = Array.from(embedding);
      } catch (e) {
        logger.warn(`⚠️ Re-embedding failed: ${e.message}`);
      }
    }

    const updated = { ...memory, ...updates, last_accessed: Date.now() };
    await client.json.set(key, '$', updated);
    return updated;
  }

  async invalidateMemory(agentId, userId, memoryId) {
    return this.updateMemory(agentId, userId, memoryId, { status: 'invalid' });
  }

  async deleteMemory(agentId, userId, memoryId) {
    await connectRedis();
    // Try both pools
    const agentKey = `${AGENT_MEMORY_PREFIX}${agentId}:${userId || 'default'}:${memoryId}`;
    const userKey = `${USER_MEMORY_PREFIX}${userId || 'default'}:${memoryId}`;
    await client.del(agentKey);
    await client.del(userKey);
  }

  /**
   * List memories from both pools for a given agent+user.
   * Agent pool: filtered by agentId + userId.
   * User pool: filtered by userId only (shared across agents).
   */
  async listMemories(agentId, userId, { type = null, status = 'active', limit = 50, offset = 0 } = {}) {
    await connectRedis();
    await this.ensureIndexes();

    const uid = userId || 'default';
    const results = [];

    // Search agent pool (scoped to this agent + user)
    try {
      const agentFilter = [
        `@agent_id:{${this._escapeTag(agentId)}}`,
        `@user_id:{${this._escapeTag(uid)}}`
      ];
      if (status) agentFilter.push(`@status:{${this._escapeTag(status)}}`);
      if (type) agentFilter.push(`@type:{${this._escapeTag(type)}}`);

      const agentRes = await client.ft.search(AGENT_INDEX, agentFilter.join(' '), {
        SORTBY: { BY: 'created_at', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit },
        DIALECT: 2
      });
      if (agentRes?.documents) {
        results.push(...agentRes.documents.map(d => d.value));
      }
    } catch (e) {
      if (!e.message?.includes('no such index')) logger.warn('Agent memory list error:', e.message);
    }

    // Search user pool (scoped to user only — shared across agents)
    try {
      const userFilter = [`@user_id:{${this._escapeTag(uid)}}`];
      if (status) userFilter.push(`@status:{${this._escapeTag(status)}}`);
      if (type) {
        userFilter.push(`@type:{${this._escapeTag(type)}}`);
      }

      const userRes = await client.ft.search(USER_INDEX, userFilter.join(' '), {
        SORTBY: { BY: 'created_at', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit },
        DIALECT: 2
      });
      if (userRes?.documents) {
        results.push(...userRes.documents.map(d => d.value));
      }
    } catch (e) {
      if (!e.message?.includes('no such index')) logger.warn('User memory list error:', e.message);
    }

    // Sort combined results by created_at DESC, apply offset/limit
    results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return results.slice(offset, offset + limit);
  }

  /**
   * Clear agent-scoped memories for a specific agent+user.
   * User-scoped memories are NOT touched.
   */
  async clearAgentMemories(agentId, userId) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    let cursor = '0';
    const pattern = `${AGENT_MEMORY_PREFIX}${scope}:*`;
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    // Also clear core memory (it's agent-scoped)
    await client.del(`${CORE_MEMORY_PREFIX}${scope}`);
    logger.info(`🧹 Cleared agent memories for agent ${agentId} user ${userId}`);
  }

  /**
   * Clear ALL memories for a user+agent context (both pools).
   * Called from the "Clear All Memories" button in the UI.
   */
  async clearMemories(agentId, userId) {
    await this.clearAgentMemories(agentId, userId);
    // Also clear user-scoped memories for this user
    await this.clearUserMemories(userId);
  }

  /**
   * Clear user-scoped memories only (preferences, decisions).
   * Called when a user is deleted.
   */
  async clearUserMemories(userId) {
    await connectRedis();
    const uid = userId || 'default';
    let cursor = '0';
    const pattern = `${USER_MEMORY_PREFIX}${uid}:*`;
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');
    logger.info(`🧹 Cleared user memories for user ${userId}`);
  }

  // ─── Semantic Search (Recall) ───────────────────────────────

  /**
   * Search both pools and merge results.
   * Agent pool: filtered by agentId + userId.
   * User pool: filtered by userId (preferences travel with the user).
   */
  async searchMemories(agentId, userId, query, topK = 5) {
    await connectRedis();

    let queryEmbedding;
    try {
      queryEmbedding = await embeddingService.generateEmbedding(query);
      await this.ensureIndexes(queryEmbedding.length);
    } catch (e) {
      logger.warn(`⚠️ Memory search embedding failed: ${e.message}`);
      return [];
    }

    const queryBlob = this._float32Buffer(queryEmbedding);
    const uid = userId || 'default';
    const allMemories = [];

    // Search agent pool
    try {
      const agentFilter = `@agent_id:{${this._escapeTag(agentId)}} @user_id:{${this._escapeTag(uid)}} @status:{active}`;
      const agentKnn = `(${agentFilter})=>[KNN ${topK} @embedding $BLOB AS score]`;
      const agentRes = await client.ft.search(AGENT_INDEX, agentKnn, {
        PARAMS: { BLOB: queryBlob },
        SORTBY: 'score',
        LIMIT: { from: 0, size: topK },
        DIALECT: 2
      });
      if (agentRes?.documents) {
        for (const doc of agentRes.documents) {
          const d = doc.value;
          const similarity = 1 - parseFloat(d.score ?? '1');
          if (similarity >= 0.3) allMemories.push({ ...d, similarity });
        }
      }
    } catch (e) {
      if (!e.message?.includes('no such index')) logger.warn('Agent memory search error:', e.message);
    }

    // Search user pool
    try {
      const userFilter = `@user_id:{${this._escapeTag(uid)}} @status:{active}`;
      const userKnn = `(${userFilter})=>[KNN ${topK} @embedding $BLOB AS score]`;
      const userRes = await client.ft.search(USER_INDEX, userKnn, {
        PARAMS: { BLOB: queryBlob },
        SORTBY: 'score',
        LIMIT: { from: 0, size: topK },
        DIALECT: 2
      });
      if (userRes?.documents) {
        for (const doc of userRes.documents) {
          const d = doc.value;
          const similarity = 1 - parseFloat(d.score ?? '1');
          if (similarity >= 0.3) allMemories.push({ ...d, similarity });
        }
      }
    } catch (e) {
      if (!e.message?.includes('no such index')) logger.warn('User memory search error:', e.message);
    }

    // Sort by similarity DESC, take topK
    allMemories.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const topResults = allMemories.slice(0, topK);

    // Update access counts (fire-and-forget)
    for (const m of topResults) {
      const key = this._memoryKey(m.type, m.agent_id || agentId, uid, m.memory_id);
      client.json.numIncrBy(key, '$.access_count', 1).catch(() => {});
      client.json.set(key, '$.last_accessed', Date.now()).catch(() => {});
    }

    return topResults;
  }

  // ─── Core Memory Block ──────────────────────────────────────

  async getCoreMemory(agentId, userId) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const raw = await client.get(`${CORE_MEMORY_PREFIX}${scope}`);
    if (!raw) return { content: '', updated_at: null };
    try { return JSON.parse(raw); } catch { return { content: raw, updated_at: null }; }
  }

  async setCoreMemory(agentId, userId, content) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const trimmed = content.length > 2000 ? content.substring(0, 2000) : content;
    const record = { content: trimmed, updated_at: Date.now() };
    await client.set(`${CORE_MEMORY_PREFIX}${scope}`, JSON.stringify(record));
    return record;
  }

  // ─── Conversation Sessions ──────────────────────────────────

  async createSession(agentId, userId, sessionId = null) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const sid = sessionId || uuidv4();
    const session = {
      session_id: sid,
      agent_id: agentId,
      user_id: userId || 'default',
      messages: [],
      created_at: Date.now(),
      updated_at: Date.now()
    };
    await client.set(`${SESSION_PREFIX}${scope}:${sid}`, JSON.stringify(session));
    await client.sendCommand(['ZADD', `${SESSION_LIST_PREFIX}${scope}`, String(Date.now()), sid]);
    return session;
  }

  async getSession(agentId, userId, sessionId) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const raw = await client.get(`${SESSION_PREFIX}${scope}:${sessionId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async appendToSession(agentId, userId, sessionId, message) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const key = `${SESSION_PREFIX}${scope}:${sessionId}`;
    const raw = await client.get(key);
    if (!raw) return null;

    const session = JSON.parse(raw);
    session.messages.push(message);
    if (session.messages.length > 100) {
      session.messages = session.messages.slice(-100);
    }
    session.updated_at = Date.now();
    await client.set(key, JSON.stringify(session));
    return session;
  }

  async listSessions(agentId, userId, limit = 20) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    try {
      // Fetch more than requested to account for filtering out empty sessions
      const ids = await client.sendCommand([
        'ZREVRANGE', `${SESSION_LIST_PREFIX}${scope}`, '0', String((limit * 2) - 1)
      ]);
      if (!ids || ids.length === 0) return [];

      const sessions = [];
      const emptyIds = []; // track empty sessions for cleanup
      for (const id of ids) {
        if (sessions.length >= limit) break;
        const raw = await client.get(`${SESSION_PREFIX}${scope}:${id}`);
        if (raw) {
          try {
            const s = JSON.parse(raw);
            const msgCount = s.messages?.length || 0;
            // Skip sessions with 0 messages — they were never used
            if (msgCount === 0) {
              emptyIds.push(id);
              continue;
            }
            sessions.push({
              session_id: s.session_id,
              message_count: msgCount,
              created_at: s.created_at,
              updated_at: s.updated_at,
              preview: s.messages?.[0]?.content?.substring(0, 100) || ''
            });
          } catch { /* skip corrupt */ }
        }
      }

      // Cleanup empty sessions in background (fire-and-forget)
      if (emptyIds.length > 0) {
        setImmediate(async () => {
          try {
            for (const id of emptyIds) {
              await client.del(`${SESSION_PREFIX}${scope}:${id}`);
              await client.sendCommand(['ZREM', `${SESSION_LIST_PREFIX}${scope}`, id]);
            }
          } catch { /* non-critical */ }
        });
      }

      return sessions;
    } catch { return []; }
  }

  async deleteSession(agentId, userId, sessionId) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    await client.del(`${SESSION_PREFIX}${scope}:${sessionId}`);
    await client.sendCommand(['ZREM', `${SESSION_LIST_PREFIX}${scope}`, sessionId]);
  }

  async clearSessions(agentId, userId) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const ids = await client.sendCommand(['ZRANGE', `${SESSION_LIST_PREFIX}${scope}`, '0', '-1']);
    if (ids?.length > 0) {
      await Promise.all(ids.map(id => client.del(`${SESSION_PREFIX}${scope}:${id}`)));
    }
    await client.del(`${SESSION_LIST_PREFIX}${scope}`);
  }

  // ─── Memory Extraction ──────────────────────────────────────

  async extractMemories(agentId, userId, userMessage, assistantResponse, sessionId = null) {
    try {
      const extractionPrompt = `You are a memory extraction system. Analyze this conversation turn and extract any facts, decisions, user preferences, or notable events worth remembering for future conversations.

CONVERSATION TURN:
User: ${userMessage}
Assistant: ${assistantResponse}

Return a JSON array of memory objects. Each object must have:
- "type": one of "semantic" (facts/knowledge), "preference" (user preferences), "decision" (decisions made), "event" (notable events)
- "content": a concise statement of the memory (1-2 sentences max)
- "importance": a number from 0.0 to 1.0 (how important is this to remember?)

Rules:
- Only extract information worth remembering across sessions
- Skip routine chatter, greetings, and filler
- Be concise — each memory should be a single clear statement
- Return an empty array [] if nothing is worth remembering
- "preference" and "decision" are about the USER personally (e.g. "User prefers EUR currency", "User decided to use monthly reports")
- "semantic" and "event" are about the DOMAIN/TOPIC being discussed (e.g. "Q3 revenue was $2.1M", "Data migration completed on Jan 15")

Return ONLY the JSON array, no other text.`;

      const result = await llmService.chat([
        { role: 'user', content: extractionPrompt }
      ], { temperature: 0.1, maxTokens: 1000 });

      const content = typeof result === 'string' ? result : (result?.content || result?.choices?.[0]?.message?.content || '');
      const memories = this._parseJSON(content);
      if (!Array.isArray(memories) || memories.length === 0) return [];

      const userCount = memories.filter(m => this._isUserMemory(m.type)).length;
      const agentCount = memories.length - userCount;
      logger.info(`🧠 Extracted ${memories.length} memories (${agentCount} agent, ${userCount} user) from conversation`);

      // Phase 2: Consolidate each memory
      const stored = [];
      for (const mem of memories) {
        if (!mem.content || !mem.type) continue;
        const consolidated = await this._consolidateMemory(agentId, userId, mem);
        if (consolidated) stored.push(consolidated);
      }

      // Check if any high-importance memories should go to core memory
      const highImportance = stored.filter(m => m.importance >= 0.8);
      if (highImportance.length > 0) {
        await this._updateCoreMemory(agentId, userId, highImportance);
      }

      return stored;
    } catch (e) {
      logger.error('Memory extraction failed:', e.message);
      return [];
    }
  }

  // ─── Memory Consolidation ───────────────────────────────────

  async _consolidateMemory(agentId, userId, candidate) {
    let similar = [];
    try {
      similar = await this.searchMemories(agentId, userId, candidate.content, 3);
    } catch { /* no existing memories yet */ }

    if (similar.length === 0) {
      return this.addMemory(agentId, userId, {
        type: candidate.type,
        content: candidate.content,
        importance: candidate.importance || 0.5
      });
    }

    try {
      const consolidationPrompt = `You manage a memory store. Given a new fact and existing memories, decide what to do.

NEW FACT: ${candidate.content}

EXISTING MEMORIES:
${similar.map((m, i) => `${i + 1}. [${m.type}] ${m.content} (importance: ${m.importance})`).join('\n')}

Decide ONE action:
- ADD: The new fact is distinct from all existing memories
- UPDATE <number>: The new fact updates/refines existing memory #<number>
- NOOP: The new fact is redundant (already captured)

Return ONLY one line: ADD, UPDATE <number>, or NOOP`;

      const result = await llmService.chat([
        { role: 'user', content: consolidationPrompt }
      ], { temperature: 0, maxTokens: 50 });

      const decision = (typeof result === 'string' ? result : (result?.content || result?.choices?.[0]?.message?.content || '')).trim().toUpperCase();

      if (decision === 'NOOP') {
        logger.info(`🧠 Consolidation: NOOP — "${candidate.content.substring(0, 60)}..." is redundant`);
        return null;
      }

      if (decision.startsWith('UPDATE')) {
        const idx = parseInt(decision.split(/\s+/)[1]) - 1;
        if (idx >= 0 && idx < similar.length) {
          const old = similar[idx];
          await this.invalidateMemory(old.agent_id || agentId, userId, old.memory_id);
          const updated = await this.addMemory(agentId, userId, {
            type: candidate.type || old.type,
            content: candidate.content,
            importance: Math.max(candidate.importance || 0.5, old.importance || 0.5)
          });
          logger.info(`🧠 Consolidation: UPDATE — replaced "${old.content.substring(0, 40)}..." with "${candidate.content.substring(0, 40)}..."`);
          return updated;
        }
      }

      const added = await this.addMemory(agentId, userId, {
        type: candidate.type,
        content: candidate.content,
        importance: candidate.importance || 0.5
      });
      logger.info(`🧠 Consolidation: ADD — "${candidate.content.substring(0, 60)}..."`);
      return added;
    } catch (e) {
      logger.warn(`⚠️ Consolidation LLM failed, adding directly: ${e.message}`);
      return this.addMemory(agentId, userId, {
        type: candidate.type,
        content: candidate.content,
        importance: candidate.importance || 0.5
      });
    }
  }

  // ─── Core Memory Update ─────────────────────────────────────

  async _updateCoreMemory(agentId, userId, newMemories) {
    try {
      const current = await this.getCoreMemory(agentId, userId);
      const currentContent = current.content || '';
      const newFacts = newMemories.map(m => `- [${m.type}] ${m.content}`).join('\n');

      const prompt = `You manage an agent's core memory block — a small, always-present summary of the most important facts.
Current core memory block (may be empty):
${currentContent || '(empty)'}

New high-importance facts to consider adding:
${newFacts}

Rewrite the core memory block incorporating the new facts. Rules:
- Keep it under 500 words
- Only include the most important, persistent facts
- Remove outdated info if new facts supersede it
- Use bullet points, one fact per line
- Prefix each with the type: [semantic], [preference], [decision], [event]

Return ONLY the updated core memory block text.`;

      const result = await llmService.chat([
        { role: 'user', content: prompt }
      ], { temperature: 0.1, maxTokens: 600 });

      const updatedContent = typeof result === 'string' ? result : (result?.content || result?.choices?.[0]?.message?.content || '');
      if (updatedContent.trim()) {
        await this.setCoreMemory(agentId, userId, updatedContent.trim());
        logger.info(`🧠 Core memory updated for agent ${agentId} user ${userId}`);
      }
    } catch (e) {
      logger.error('Core memory update failed:', e.message);
    }
  }

  // ─── Context Assembly ───────────────────────────────────────

  async assembleMemoryContext(agentId, userId, query) {
    const parts = [];

    // Tier 1: Core memory (always present)
    try {
      const core = await this.getCoreMemory(agentId, userId);
      if (core.content) {
        parts.push(`[Core Memory — persistent knowledge:]\n${core.content}`);
      }
    } catch { /* no core memory */ }

    // Tier 2: Semantic recall (query-relevant memories from both pools)
    try {
      const recalled = await this.searchMemories(agentId, userId, query, 5);
      if (recalled.length > 0) {
        const recallLines = recalled.map(m =>
          `- [${m.type}/${m.pool || 'agent'}] ${m.content} (${new Date(m.created_at).toLocaleDateString()})`
        );
        parts.push(`[Recalled Memories — relevant past context:]\n${recallLines.join('\n')}`);
      }
    } catch { /* no recalled memories */ }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  // ─── Memory Decay ───────────────────────────────────────────

  async decayMemories(agentId, userId) {
    const memories = await this.listMemories(agentId, userId, { status: 'active', limit: 200 });
    const now = Date.now();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    let decayed = 0;

    for (const m of memories) {
      const age = now - (m.last_accessed || m.created_at);
      if (age > NINETY_DAYS && (m.importance || 0) < 0.3 && (m.access_count || 0) < 2) {
        await this.invalidateMemory(m.agent_id || agentId, userId, m.memory_id);
        decayed++;
      } else if (age > 30 * 24 * 60 * 60 * 1000 && (m.access_count || 0) === 0) {
        const newImportance = Math.max(0.1, (m.importance || 0.5) * 0.9);
        await this.updateMemory(m.agent_id || agentId, userId, m.memory_id, { importance: newImportance });
      }
    }

    if (decayed > 0) logger.info(`🧹 Decayed ${decayed} stale memories for agent ${agentId} user ${userId}`);
    return decayed;
  }

  // ─── Stats ──────────────────────────────────────────────────

  async getStats(agentId, userId) {
    const active = await this.listMemories(agentId, userId, { status: 'active', limit: 1000 });
    const sessions = await this.listSessions(agentId, userId);
    const core = await this.getCoreMemory(agentId, userId);

    const byType = {};
    let agentCount = 0, userCount = 0;
    for (const m of active) {
      byType[m.type] = (byType[m.type] || 0) + 1;
      if (m.pool === 'user') userCount++;
      else agentCount++;
    }

    return {
      total_memories: active.length,
      agent_memories: agentCount,
      user_memories: userCount,
      by_type: byType,
      total_sessions: sessions.length,
      has_core_memory: !!core.content,
      core_memory_length: core.content?.length || 0
    };
  }

  // ─── Lifecycle Cleanup ──────────────────────────────────────

  /**
   * Delete all AGENT-scoped data for an agent (all users).
   * User-scoped memories (preferences, decisions) are preserved.
   * Called when an agent is deleted.
   */
  async clearAllAgentData(agentId) {
    await connectRedis();
    const prefixes = [
      `${AGENT_MEMORY_PREFIX}${agentId}:`,
      `${CORE_MEMORY_PREFIX}${agentId}:`,
      `${SESSION_PREFIX}${agentId}:`,
      `${SESSION_LIST_PREFIX}${agentId}:`,
      `memory_graph:${agentId}:`
    ];
    for (const prefix of prefixes) {
      let cursor = '0';
      do {
        const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']);
        cursor = reply[0];
        if (reply[1].length > 0) {
          await Promise.all(reply[1].map(k => client.del(k)));
        }
      } while (cursor !== '0');
    }
    logger.info(`🧹 Cleared agent data for agent ${agentId} (all users). User memories preserved.`);
  }

  /**
   * Delete all USER-scoped data for a user.
   * Agent-scoped memories are preserved.
   * Called when a user is deleted.
   */
  async clearAllUserData(userId) {
    await connectRedis();
    const uid = userId || 'default';

    // 1. Clear user-pool memories (preferences, decisions)
    await this.clearUserMemories(uid);

    // 2. Clear sessions across all agents for this user
    //    Sessions are keyed as agent_session:{agentId}:{userId}:{sessionId}
    //    We scan for the userId portion
    let cursor = '0';
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${SESSION_PREFIX}*:${uid}:*`, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    // 3. Clear session lists
    cursor = '0';
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${SESSION_LIST_PREFIX}*:${uid}`, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    // 4. Clear core memories across all agents for this user
    cursor = '0';
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${CORE_MEMORY_PREFIX}*:${uid}`, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    // 5. Clear memory graph caches
    cursor = '0';
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `memory_graph:*:${uid}`, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    // 6. Clear agent-pool memories that belong to this user (across all agents)
    cursor = '0';
    do {
      const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${AGENT_MEMORY_PREFIX}*:${uid}:*`, 'COUNT', '200']);
      cursor = reply[0];
      if (reply[1].length > 0) {
        await Promise.all(reply[1].map(k => client.del(k)));
      }
    } while (cursor !== '0');

    logger.info(`🧹 Cleared all memory data for user ${userId} (across all agents)`);
  }

  // ─── Memory Graph ───────────────────────────────────────────

  async getMemoryGraph(agentId, userId, { forceRefresh = false } = {}) {
    await connectRedis();
    const scope = this._scope(agentId, userId);
    const cacheKey = `memory_graph:${scope}`;

    if (!forceRefresh) {
      try {
        const cached = await client.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed._ts && Date.now() - parsed._ts < 10 * 60 * 1000) {
            return { nodes: parsed.nodes, edges: parsed.edges };
          }
        }
      } catch { /* cache miss */ }
    }

    // List from both pools
    const memories = await this.listMemories(agentId, userId, { status: 'active', limit: 200 });
    if (memories.length === 0) return { nodes: [], edges: [] };

    const memoryText = memories.map((m, i) =>
      `${i + 1}. [${m.type}/${m.pool || 'agent'}] ${m.content}`
    ).join('\n');

    try {
      const prompt = `You are a knowledge graph extraction system. Given these agent memories, extract entities and relationships to form a knowledge graph.

MEMORIES:
${memoryText}

Extract entities and relationships. Return a JSON object with:
{
  "entities": [
    { "id": "unique_short_id", "label": "Display Name", "type": "person|concept|data|preference|system|event|location|organization" }
  ],
  "relationships": [
    { "source": "entity_id", "target": "entity_id", "label": "relationship description" }
  ]
}

Rules:
- Extract meaningful entities (people, concepts, data sources, systems, preferences, topics)
- Create relationships that show how entities connect based on the memories
- Use short, clear labels
- The "type" determines the node color in the graph
- Keep entity IDs short and lowercase (e.g., "user", "q3_revenue", "apac_region")
- Include a central "agent" node that connects to the main topics
- Aim for 5-30 entities depending on memory count
- Return ONLY the JSON object, no other text.`;

      const result = await llmService.chat([
        { role: 'user', content: prompt }
      ], { temperature: 0.1, maxTokens: 2000 });

      const content = typeof result === 'string' ? result : (result?.content || result?.choices?.[0]?.message?.content || '');
      const graph = this._parseJSON(content);

      if (!graph || !Array.isArray(graph.entities)) {
        return { nodes: [], edges: [] };
      }

      const nodeMap = new Map();
      const nodes = [];
      const edges = [];

      for (const e of (graph.entities || [])) {
        if (!e.id || !e.label) continue;
        if (!nodeMap.has(e.id)) {
          nodeMap.set(e.id, true);
          nodes.push({ id: e.id, label: e.label, type: e.type || 'concept' });
        }
      }

      for (const r of (graph.relationships || [])) {
        if (!r.source || !r.target || !nodeMap.has(r.source) || !nodeMap.has(r.target)) continue;
        edges.push({ source: r.source, target: r.target, label: r.label || '' });
      }

      const cacheData = { nodes, edges, _ts: Date.now() };
      await client.set(cacheKey, JSON.stringify(cacheData));

      logger.info(`🧠 Memory graph built for agent ${agentId} user ${userId}: ${nodes.length} nodes, ${edges.length} edges`);
      return { nodes, edges };
    } catch (e) {
      logger.error('Memory graph extraction failed:', e.message);
      return { nodes: [], edges: [] };
    }
  }
}

module.exports = new MemoryService();
