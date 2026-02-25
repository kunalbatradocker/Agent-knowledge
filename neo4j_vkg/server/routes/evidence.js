/**
 * Evidence Retrieval API
 * Endpoints for searching and retrieving evidence chunks
 * 
 * POST /api/evidence/search — semantic search via Redis vectors + filters
 * GET  /api/evidence/chunks — fetch chunk text by IDs
 * GET  /api/evidence/for-entity/:canonicalId — evidence for a specific entity
 * GET  /api/evidence/for-assertion/:assertionId — evidence for a specific assertion
 */

const express = require('express');
const router = express.Router();
const vectorStoreService = require('../services/vectorStoreService');
const neo4jService = require('../services/neo4jService');
const redisService = require('../services/redisService');
const { requireMember } = require('../middleware/auth');
const { queryLimiter } = require('../middleware/rateLimiter');

/**
 * POST /api/evidence/search
 * Semantic search over evidence chunks via Redis vector index
 * 
 * Body:
 * - query: search text
 * - topK: number of results (default 10)
 * - tenantId, workspaceId: required
 * - filters: { doc_type, access_label }
 */
router.post('/search', queryLimiter, requireMember, async (req, res) => {
  try {
    const { query, topK = 10, tenantId, workspaceId, filters = {} } = req.body;

    if (!query || !tenantId || !workspaceId) {
      return res.status(400).json({ error: 'query, tenantId, and workspaceId are required' });
    }

    const results = await vectorStoreService.semanticSearch(query, topK, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      ...filters
    });

    res.json({
      success: true,
      results,
      total: results.length
    });
  } catch (error) {
    console.error('[POST /evidence/search] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evidence/chunks
 * Fetch chunk text by IDs from Redis
 * 
 * Query: ids=chunk1,chunk2,chunk3
 */
router.get('/chunks', requireMember, async (req, res) => {
  try {
    const { ids, tenantId, workspaceId } = req.query;

    if (!ids) {
      return res.status(400).json({ error: 'ids parameter is required' });
    }

    const chunkIds = ids.split(',').map(id => id.trim()).filter(Boolean);
    const chunks = [];

    for (const chunkId of chunkIds) {
      try {
        const chunkData = await vectorStoreService.getChunkById(chunkId);
        if (chunkData) {
          // Filter by tenant/workspace if provided
          if (tenantId && chunkData.tenant_id && chunkData.tenant_id !== tenantId) continue;
          if (workspaceId && chunkData.workspace_id && chunkData.workspace_id !== workspaceId) continue;
          chunks.push(chunkData);
        }
      } catch (e) {
        // Skip individual failures
      }
    }

    res.json({ success: true, chunks, total: chunks.length });
  } catch (error) {
    console.error('[GET /evidence/chunks] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evidence/for-entity/:canonicalId
 * Get all evidence chunks linked to an entity via EVIDENCED_BY in Neo4j
 */
router.get('/for-entity/:canonicalId', requireMember, async (req, res) => {
  try {
    const { canonicalId } = req.params;
    const { tenantId, workspaceId } = req.query;

    if (!tenantId || !workspaceId) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (n {canonical_id: $canonicalId, tenant_id: $tenantId, workspace_id: $workspaceId})
              -[r:EVIDENCED_BY]->(ec:EvidenceChunk)
        RETURN ec {
          .chunk_id, .doc_id, .page, .section_path,
          .span_start, .span_end, .quote, .text_hash,
          .access_label, .created_at,
          method: r.method,
          confidence: r.confidence
        } AS evidence
        ORDER BY r.confidence DESC
        LIMIT 20
      `, { canonicalId: decodeURIComponent(canonicalId), tenantId, workspaceId });

      const evidence = result.records.map(r => r.get('evidence'));

      res.json({ success: true, evidence, total: evidence.length });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('[GET /evidence/for-entity] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evidence/for-assertion/:assertionId
 * Get evidence for a specific assertion (reified relationship)
 */
router.get('/for-assertion/:assertionId', requireMember, async (req, res) => {
  try {
    const { assertionId } = req.params;
    const { tenantId } = req.query;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (a:Assertion {assertion_id: $assertionId, tenant_id: $tenantId})
              -[r:EVIDENCED_BY]->(ec:EvidenceChunk)
        OPTIONAL MATCH (subject)-[:ASSERTS]->(a)-[:TARGET]->(object)
        RETURN a {
          .assertion_id, .predicate, .confidence, .claim_status,
          .method, .extracted_at, .quote,
          subject_id: subject.canonical_id,
          subject_name: subject.display_name,
          subject_class: labels(subject)[0],
          object_id: object.canonical_id,
          object_name: object.display_name,
          object_class: labels(object)[0]
        } AS assertion,
        collect(ec {
          .chunk_id, .doc_id, .page, .section_path,
          .span_start, .span_end, .quote, .text_hash,
          .access_label,
          method: r.method,
          confidence: r.confidence
        }) AS evidence
        LIMIT 1
      `, { assertionId: decodeURIComponent(assertionId), tenantId });

      if (result.records.length === 0) {
        return res.status(404).json({ error: 'Assertion not found' });
      }

      const record = result.records[0];
      res.json({
        success: true,
        assertion: record.get('assertion'),
        evidence: record.get('evidence')
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('[GET /evidence/for-assertion] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
