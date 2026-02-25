/**
 * Chunk Management Routes
 * CRUD operations for document chunks
 */

const express = require('express');
const router = express.Router();

const neo4jService = require('../../services/neo4jService');
const vectorStoreService = require('../../services/vectorStoreService');
const { requireMember } = require('../../middleware/auth');

/**
 * GET /api/ontology/chunks/:id
 * Get a specific chunk
 */
router.get('/:id', async (req, res) => {
  try {
    const chunkId = req.params.id;
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (ch:Chunk)
        WHERE ch.chunk_id = $chunkId OR ch.uri = $chunkId
        OPTIONAL MATCH (ch)-[:PART_OF]->(d:Document)
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(ch)
        RETURN ch, d.title as docTitle, d.doc_id as docId, collect(c) as concepts
      `, { chunkId });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Chunk not found' });
      }
      
      const record = result.records[0];
      const chunk = record.get('ch').properties;
      const concepts = record.get('concepts').map(c => c?.properties).filter(Boolean);
      
      res.json({
        success: true,
        chunk: {
          ...chunk,
          docTitle: record.get('docTitle'),
          docId: record.get('docId'),
          concepts
        }
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error getting chunk:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/chunks/:id
 * Update a chunk's text
 */
router.put('/:id', requireMember, async (req, res) => {
  try {
    const chunkId = req.params.id;
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (ch:Chunk)
        WHERE ch.chunk_id = $chunkId OR ch.uri = $chunkId
        SET ch.text = $text, ch.char_count = size($text), ch.updated_at = datetime()
        RETURN ch
      `, { chunkId, text });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Chunk not found' });
      }
      
      const chunk = result.records[0].get('ch').properties;
      
      // Update embedding in Redis
      try {
        const vectorKey = chunk.vector_key;
        if (vectorKey) {
          const embedding = await vectorStoreService.getEmbedding(text);
          if (embedding) {
            await vectorStoreService.storeChunkWithEmbedding(vectorKey, {
              text, embedding, metadata: chunk
            });
          }
        }
      } catch (e) {
        console.warn('Could not update embedding:', e.message);
      }
      
      res.json({ success: true, chunk });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error updating chunk:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/chunks/:id
 * Delete a chunk and its related data
 */
router.delete('/:id', requireMember, async (req, res) => {
  try {
    const chunkId = req.params.id;
    const session = neo4jService.getSession();
    
    try {
      // Get chunk info first
      const chunkResult = await session.run(`
        MATCH (ch:Chunk)
        WHERE ch.chunk_id = $chunkId OR ch.uri = $chunkId
        RETURN ch.vector_key as vectorKey, ch.chunk_id as id
      `, { chunkId });
      
      if (chunkResult.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Chunk not found' });
      }
      
      const vectorKey = chunkResult.records[0].get('vectorKey');
      const actualChunkId = chunkResult.records[0].get('id');
      
      // Delete concepts only linked to this chunk
      await session.run(`
        MATCH (c)-[:MENTIONED_IN]->(ch:Chunk)
        WHERE ch.chunk_id = $chunkId OR ch.uri = $chunkId
        WITH c, ch
        OPTIONAL MATCH (c)-[:MENTIONED_IN]->(otherChunk:Chunk)
        WHERE otherChunk.chunk_id <> ch.chunk_id
        WITH c, count(otherChunk) as otherChunkCount
        WHERE otherChunkCount = 0
        DETACH DELETE c
      `, { chunkId });
      
      // Delete the chunk
      const deleteResult = await session.run(`
        MATCH (ch:Chunk)
        WHERE ch.chunk_id = $chunkId OR ch.uri = $chunkId
        DETACH DELETE ch RETURN count(ch) as deleted
      `, { chunkId });
      
      // Delete from Redis
      try {
        if (vectorKey) {
          const { client } = require('../../config/redis');
          await client.del(`graphrag:chunk:${actualChunkId}`);
          await client.del(`graphrag:vector:${vectorKey}`);
        }
      } catch (e) {
        console.warn('Could not delete from Redis:', e.message);
      }
      
      res.json({ success: true, deleted: neo4jService.toNumber(deleteResult.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error deleting chunk:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/chunks/:chunkId/entities/:entityId
 * Link an existing entity to a chunk
 */
router.post('/:chunkId/entities/:entityId', requireMember, async (req, res) => {
  try {
    const { chunkId, entityId } = req.params;
    const session = neo4jService.getSession();
    
    try {
      const result = await session.run(`
        MATCH (ch:Chunk), (c)
        WHERE (ch.chunk_id = $chunkId OR ch.uri = $chunkId) AND c.concept_id = $entityId
        MERGE (c)-[r:MENTIONED_IN]->(ch)
        ON CREATE SET r.created_at = datetime()
        RETURN c, ch
      `, { chunkId, entityId });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Chunk or entity not found' });
      }
      
      res.json({ success: true, message: 'Entity linked to chunk' });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error linking entity to chunk:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/chunks/:chunkId/entities/:entityId
 * Unlink an entity from a chunk
 */
router.delete('/:chunkId/entities/:entityId', requireMember, async (req, res) => {
  try {
    const { chunkId, entityId } = req.params;
    const session = neo4jService.getSession();
    
    try {
      const result = await session.run(`
        MATCH (c)-[r:MENTIONED_IN]->(ch:Chunk)
        WHERE (ch.chunk_id = $chunkId OR ch.uri = $chunkId) AND c.concept_id = $entityId
        DELETE r RETURN count(r) as deleted
      `, { chunkId, entityId });
      
      res.json({ success: true, deleted: neo4jService.toNumber(result.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error unlinking entity from chunk:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
