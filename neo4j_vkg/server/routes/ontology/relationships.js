/**
 * Relationship Editing Routes
 * CRUD operations for relationships between entities
 */

const express = require('express');
const router = express.Router();

const neo4jService = require('../../services/neo4jService');
const { requireMember } = require('../../middleware/auth');

/**
 * GET /api/ontology/predicates
 * Get all unique relationship predicates from the database
 */
router.get('/predicates', async (_req, res) => {
  try {
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        CALL db.relationshipTypes() YIELD relationshipType
        WHERE NOT relationshipType IN ['PART_OF', 'IN_FOLDER', 'CONTAINS', 'OWNS', 'CHILD_OF', 'MENTIONED_IN']
        RETURN relationshipType ORDER BY relationshipType
      `);
      const predicates = result.records.map(r => r.get('relationshipType'));
      res.json({ success: true, predicates });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error fetching predicates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/relationships
 * Add a relationship between entities
 */
router.post('/', requireMember, async (req, res) => {
  try {
    const { sourceId, targetId, predicate } = req.body;
    
    if (!sourceId || !targetId || !predicate) {
      return res.status(400).json({ 
        success: false, 
        error: 'sourceId, targetId, and predicate are required' 
      });
    }
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (source), (target)
        WHERE source.concept_id = $sourceId AND target.concept_id = $targetId
        CREATE (source)-[r:RELATED_TO {predicate: $predicate, created_at: datetime()}]->(target)
        RETURN source.label as sourceLabel, target.label as targetLabel, r.predicate as predicate
      `, { sourceId, targetId, predicate });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Source or target entity not found' });
      }
      
      const record = result.records[0];
      res.json({
        success: true,
        relationship: {
          source: record.get('sourceLabel'),
          target: record.get('targetLabel'),
          predicate: record.get('predicate')
        }
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error adding relationship:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/relationships
 * Update a relationship predicate
 */
router.put('/', requireMember, async (req, res) => {
  try {
    const { sourceLabel, targetLabel, oldPredicate, newPredicate } = req.body;
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (source)-[r:RELATED_TO]->(target)
        WHERE source.label = $sourceLabel 
          AND target.label = $targetLabel 
          AND r.predicate = $oldPredicate
        SET r.predicate = $newPredicate, r.updated_at = datetime()
        RETURN source.label as sourceLabel, target.label as targetLabel, r.predicate as predicate
      `, { sourceLabel, targetLabel, oldPredicate, newPredicate });
      
      if (result.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Relationship not found' });
      }
      
      const record = result.records[0];
      res.json({
        success: true,
        relationship: {
          source: record.get('sourceLabel'),
          target: record.get('targetLabel'),
          predicate: record.get('predicate')
        }
      });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error updating relationship:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/relationships
 * Delete a relationship
 */
router.delete('/', requireMember, async (req, res) => {
  try {
    const { sourceLabel, targetLabel, predicate } = req.body;
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (source)-[r:RELATED_TO]->(target)
        WHERE source.label = $sourceLabel 
          AND target.label = $targetLabel 
          AND (r.predicate = $predicate OR $predicate IS NULL)
        DELETE r RETURN count(r) as deleted
      `, { sourceLabel, targetLabel, predicate: predicate || null });
      
      res.json({ success: true, deleted: neo4jService.toNumber(result.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error deleting relationship:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
