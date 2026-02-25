/**
 * Entity/Concept Editing Routes
 * CRUD operations for entities in the knowledge graph
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const neo4jService = require('../../services/neo4jService');
const { sanitizeLabel } = require('./shared');
const { requireMember } = require('../../middleware/auth');

/**
 * GET /api/ontology/entity-types
 * Get available entity types
 */
router.get('/types', async (_req, res) => {
  try {
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        CALL db.labels() YIELD label
        WHERE NOT label IN ['Document', 'Chunk', 'Folder', 'Workspace', 'Tenant', 'Provenance']
        RETURN label ORDER BY label
      `);
      const types = result.records.map(r => r.get('label'));
      res.json({ success: true, types });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error fetching entity types:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/entities/:id
 * Update an entity/concept
 */
router.put('/:id', requireMember, async (req, res) => {
  try {
    const conceptId = req.params.id;
    const { label, type, description, confidence } = req.body;
    const sanitizedType = type ? sanitizeLabel(type) : null;
    
    const session = neo4jService.getSession();
    try {
      // Get current entity
      const getResult = await session.run(`
        MATCH (c) WHERE c.concept_id = $conceptId
        RETURN c, labels(c) as currentLabels
      `, { conceptId });
      
      if (getResult.records.length === 0) {
        return res.status(404).json({ success: false, error: 'Entity not found' });
      }
      
      const currentNode = getResult.records[0].get('c');
      const currentLabels = getResult.records[0].get('currentLabels');
      const currentType = currentLabels.find(l => l !== 'Concept') || 'Concept';
      const currentProps = currentNode.properties;
      
      // If type is changing, delete and recreate
      if (sanitizedType && sanitizedType !== currentType) {
        // Get relationships
        const relsResult = await session.run(`
          MATCH (c)-[r]-(other) WHERE c.concept_id = $conceptId
          RETURN type(r) as relType, startNode(r) = c as isOutgoing, other, r
        `, { conceptId });
        
        // Delete old node
        await session.run(`MATCH (c) WHERE c.concept_id = $conceptId DETACH DELETE c`, { conceptId });
        
        // Create new node
        const newProps = {
          ...currentProps,
          label: label !== undefined ? label : currentProps.label,
          description: description !== undefined ? description : currentProps.description,
          confidence: confidence !== undefined ? confidence : currentProps.confidence,
          updated_at: new Date().toISOString()
        };
        
        const createResult = await session.run(
          `CREATE (c:\`${sanitizedType}\` $props) RETURN c`,
          { props: newProps }
        );
        
        // Recreate relationships
        for (const record of relsResult.records) {
          const relType = record.get('relType');
          const isOutgoing = record.get('isOutgoing');
          const otherNode = record.get('other');
          const relProps = record.get('r').properties;
          
          const query = isOutgoing
            ? `MATCH (c), (other) WHERE c.concept_id = $conceptId AND id(other) = $otherId CREATE (c)-[r:\`${relType}\` $relProps]->(other)`
            : `MATCH (c), (other) WHERE c.concept_id = $conceptId AND id(other) = $otherId CREATE (other)-[r:\`${relType}\` $relProps]->(c)`;
          
          await session.run(query, { conceptId, otherId: otherNode.identity.toNumber(), relProps });
        }
        
        const updated = createResult.records[0].get('c').properties;
        res.json({ success: true, entity: { ...updated, type: sanitizedType } });
      } else {
        // Just update properties
        const updates = [];
        const params = { conceptId };
        
        if (label !== undefined) { updates.push('c.label = $label'); params.label = label; }
        if (description !== undefined) { updates.push('c.description = $description'); params.description = description; }
        if (confidence !== undefined) { updates.push('c.confidence = $confidence'); params.confidence = confidence; }
        updates.push('c.updated_at = datetime()');
        
        const result = await session.run(`
          MATCH (c) WHERE c.concept_id = $conceptId
          SET ${updates.join(', ')}
          RETURN c, labels(c) as nodeLabels
        `, params);
        
        if (result.records.length === 0) {
          return res.status(404).json({ success: false, error: 'Entity not found' });
        }
        
        const updated = result.records[0].get('c').properties;
        const nodeLabels = result.records[0].get('nodeLabels');
        res.json({ success: true, entity: { ...updated, type: nodeLabels.find(l => l !== 'Concept') || 'Concept' } });
      }
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error updating entity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/entities/:id
 * Delete an entity/concept
 */
router.delete('/:id', requireMember, async (req, res) => {
  try {
    const conceptId = req.params.id;
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (c) WHERE c.concept_id = $conceptId
        DETACH DELETE c RETURN count(c) as deleted
      `, { conceptId });
      
      res.json({ success: true, deleted: neo4jService.toNumber(result.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error deleting entity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/entities/bulk-delete
 * Bulk delete entities
 */
router.post('/bulk-delete', requireMember, async (req, res) => {
  try {
    const { conceptIds } = req.body;
    
    if (!conceptIds || !Array.isArray(conceptIds)) {
      return res.status(400).json({ success: false, error: 'conceptIds array is required' });
    }
    
    const session = neo4jService.getSession();
    try {
      const result = await session.run(`
        MATCH (c) WHERE c.concept_id IN $conceptIds
        DETACH DELETE c RETURN count(c) as deleted
      `, { conceptIds });
      
      res.json({ success: true, deleted: neo4jService.toNumber(result.records[0].get('deleted')) });
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error('Error bulk deleting entities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
