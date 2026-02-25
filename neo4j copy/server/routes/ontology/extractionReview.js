/**
 * Extraction Review Routes
 * Staging and review flow for unstructured document extractions
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const redisService = require('../../services/redisService');
const neo4jService = require('../../services/neo4jService');
const graphDBStore = require('../../services/graphDBStore');
const ontologyJobService = require('../../services/ontologyJobService');
const logger = require('../../utils/logger');
const { requireMember } = require('../../middleware/auth');
const {
  ClaimStatus,
  SourceType,
  UpsertNodeEvent,
  UpsertEdgeEvent,
  UpsertAssertionEvent,
  EvidenceLinkEvent,
  GraphEventBatch
} = require('../../models/graphEvents');

const STAGED_EXTRACTION_TTL = 48 * 60 * 60; // 48 hours
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * POST /api/ontology/extraction-review/stage
 * Stage extraction results for review (called after extraction job completes)
 */
router.post('/stage', requireMember, async (req, res) => {
  try {
    const { jobId } = req.body;
    
    if (!jobId) {
      return res.status(400).json({ success: false, error: 'jobId required' });
    }

    const job = await ontologyJobService.getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Job not completed yet' });
    }

    const stageId = uuidv4();
    const staged = {
      stageId,
      jobId,
      documentId: job.document_id,
      fileName: job.file_name,
      ontologyId: job.ontology_id,
      entities: job.extracted_entities || [],
      relationships: job.extracted_relationships || [],
      suggestedOntology: job.suggested_ontology,
      tenantId: job.tenant_id,
      workspaceId: job.workspace_id,
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + STAGED_EXTRACTION_TTL * 1000).toISOString()
    };

    await redisService.set(
      `staged-extraction:${stageId}`,
      JSON.stringify(staged),
      STAGED_EXTRACTION_TTL
    );

    res.json({
      success: true,
      stageId,
      entityCount: staged.entities.length,
      relationshipCount: staged.relationships.length,
      expiresAt: staged.expiresAt
    });
  } catch (error) {
    logger.error('Stage extraction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ontology/extraction-review/:stageId
 * Get staged extraction for review
 */
router.get('/:stageId', async (req, res) => {
  try {
    const { stageId } = req.params;
    const stagedJson = await redisService.get(`staged-extraction:${stageId}`);
    
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged extraction not found or expired' });
    }

    const staged = JSON.parse(stagedJson);
    res.json({ success: true, staged });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ontology/extraction-review/:stageId
 * Update staged extraction (edit entities/relationships)
 */
router.put('/:stageId', requireMember, async (req, res) => {
  try {
    const { stageId } = req.params;
    const { entities, relationships } = req.body;
    
    const stagedJson = await redisService.get(`staged-extraction:${stageId}`);
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged extraction not found' });
    }

    const staged = JSON.parse(stagedJson);
    
    if (entities) staged.entities = entities;
    if (relationships) staged.relationships = relationships;
    staged.updatedAt = new Date().toISOString();

    await redisService.set(
      `staged-extraction:${stageId}`,
      JSON.stringify(staged),
      STAGED_EXTRACTION_TTL
    );

    res.json({ success: true, entityCount: staged.entities.length, relationshipCount: staged.relationships.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ontology/extraction-review/:stageId/commit
 * Commit reviewed extraction to GraphDB and Neo4j via GraphEvent pipeline
 * This ensures assertions, evidence chunks, and provenance are created consistently
 */
router.post('/:stageId/commit', requireMember, async (req, res) => {
  try {
    const { stageId } = req.params;
    const stagedJson = await redisService.get(`staged-extraction:${stageId}`);
    
    if (!stagedJson) {
      return res.status(404).json({ success: false, error: 'Staged extraction not found' });
    }

    const staged = JSON.parse(stagedJson);
    const { entities, relationships, tenantId, workspaceId, documentId } = staged;

    // Build a GraphEventBatch from the reviewed data
    const eventBatch = new GraphEventBatch({
      extraction_run_id: `commit_${stageId}`,
      tenant_id: tenantId,
      workspace_id: workspaceId,
      source_type: SourceType.UNSTRUCTURED,
      source_id: documentId
    });

    const entityCanonicalMap = new Map(); // label -> canonical_id

    // Generate canonical IDs for entities
    for (const entity of entities) {
      const className = (entity.type || 'Entity').replace(/[^a-zA-Z0-9_]/g, '_');
      const entityLabel = entity.label || entity.name || 'Unknown';
      const keyString = [className, entityLabel].join('|').toLowerCase();
      const hash = crypto.createHash('sha256').update(keyString).digest('hex').substring(0, 16);
      const canonicalId = `${className.toLowerCase()}_${hash}`;
      
      entityCanonicalMap.set(entityLabel, canonicalId);

      const nodeEvent = new UpsertNodeEvent({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        source_type: SourceType.UNSTRUCTURED,
        source_id: documentId,
        extraction_run_id: `commit_${stageId}`,
        class_name: className,
        canonical_id: canonicalId,
        identity_keys: {},
        attributes: entity.attributes || {},
        display_name: entityLabel,
        confidence: entity.confidence || 1.0,
        claim_status: ClaimStatus.FACT, // Reviewed = verified
        status: 'active',
        source_doc_ids: [documentId]
      });
      eventBatch.addEvent(nodeEvent);

      // Create evidence link for entity
      if (entity.evidence || entity.quote) {
        const quote = entity.evidence || entity.quote || '';
        const textHash = crypto.createHash('sha256').update(quote).digest('hex').slice(0, 16);
        
        const evidenceEvent = new EvidenceLinkEvent({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          source_type: SourceType.UNSTRUCTURED,
          source_id: documentId,
          extraction_run_id: `commit_${stageId}`,
          target_type: 'node',
          target_canonical_id: canonicalId,
          chunk_id: entity.chunk_id || `${documentId}_commit`,
          document_id: documentId,
          quote: quote,
          text_hash: textHash,
          confidence: entity.confidence || 1.0,
          method: 'human_review'
        });
        eventBatch.addEvent(evidenceEvent);
      }
    }

    // Create relationship events with assertions
    for (const rel of relationships) {
      const fromId = entityCanonicalMap.get(rel.sourceLabel);
      const toId = entityCanonicalMap.get(rel.targetLabel);
      
      if (!fromId || !toId) continue;

      const relType = (rel.predicate || rel.type || 'RELATED_TO').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();

      // Direct edge
      const edgeEvent = new UpsertEdgeEvent({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        source_type: SourceType.UNSTRUCTURED,
        source_id: documentId,
        extraction_run_id: `commit_${stageId}`,
        relationship_type: relType,
        from_canonical_id: fromId,
        to_canonical_id: toId,
        confidence: rel.confidence || 1.0,
        claim_status: ClaimStatus.FACT,
        extracted_at: new Date().toISOString()
      });
      eventBatch.addEvent(edgeEvent);

      // Assertion (reification)
      const assertionKeyString = [fromId, relType, toId, documentId, 0, 0].join('|');
      const assertionHash = crypto.createHash('sha256').update(assertionKeyString).digest('hex').substring(0, 20);
      const assertionId = `assertion_${assertionHash}`;

      const assertionEvent = new UpsertAssertionEvent({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        source_type: SourceType.UNSTRUCTURED,
        source_id: documentId,
        extraction_run_id: `commit_${stageId}`,
        assertion_id: assertionId,
        subject_canonical_id: fromId,
        predicate: relType,
        object_canonical_id: toId,
        chunk_id: rel.chunk_id || `${documentId}_commit`,
        document_id: documentId,
        quote: rel.evidence || '',
        confidence: rel.confidence || 1.0,
        claim_status: ClaimStatus.FACT,
        method: 'human_review'
      });
      eventBatch.addEvent(assertionEvent);

      // Evidence for assertion
      if (rel.evidence) {
        const textHash = crypto.createHash('sha256').update(rel.evidence).digest('hex').slice(0, 16);
        const evidenceEvent = new EvidenceLinkEvent({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          source_type: SourceType.UNSTRUCTURED,
          source_id: documentId,
          extraction_run_id: `commit_${stageId}`,
          target_type: 'assertion',
          target_canonical_id: assertionId,
          assertion_id: assertionId,
          chunk_id: rel.chunk_id || `${documentId}_commit`,
          document_id: documentId,
          quote: rel.evidence,
          text_hash: textHash,
          confidence: rel.confidence || 1.0,
          method: 'human_review'
        });
        eventBatch.addEvent(evidenceEvent);
      }
    }

    // Write to Neo4j via the extraction service pipeline
    const extractionService = require('../../services/extractionService');
    await extractionService.writeEventsToGraph(eventBatch);

    // Also write to GraphDB (RDF triplestore — authoritative store)
    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    const triples = [];
    const entityUris = new Map();

    for (const entity of entities) {
      const entityLabel = entity.label || entity.name || 'Unknown';
      const canonicalId = entityCanonicalMap.get(entityLabel);
      const entityUri = entity.uri || `${dataGraphIRI}/entity/${canonicalId}`;
      const entityType = sanitizeForUri(entity.type || 'Entity');
      
      entityUris.set(entityLabel, entityUri);
      
      triples.push(`<${entityUri}> <${RDF}type> <${dataGraphIRI}/class/${entityType}> .`);
      triples.push(`<${entityUri}> <${RDFS}label> "${escapeTurtle(entityLabel)}"^^<${XSD}string> .`);
      triples.push(`<${entityUri}> <http://purplefabric.ai/ontology#canonicalId> "${escapeTurtle(canonicalId)}"^^<${XSD}string> .`);
      triples.push(`<${entityUri}> <http://purplefabric.ai/ontology#claimStatus> "FACT"^^<${XSD}string> .`);
      
      if (entity.confidence) {
        triples.push(`<${entityUri}> <http://purplefabric.ai/ontology#confidence> "${entity.confidence}"^^<${XSD}decimal> .`);
      }
      if (documentId) {
        triples.push(`<${entityUri}> <http://purplefabric.ai/ontology#sourceDocument> "${escapeTurtle(documentId)}"^^<${XSD}string> .`);
      }
    }

    for (const rel of relationships) {
      const sourceUri = entityUris.get(rel.sourceLabel);
      const targetUri = entityUris.get(rel.targetLabel);
      
      if (sourceUri && targetUri) {
        const predicate = sanitizeForUri(rel.predicate || rel.type || 'RELATED_TO');
        triples.push(`<${sourceUri}> <${dataGraphIRI}/property/${predicate}> <${targetUri}> .`);
      }
    }

    // Write to GraphDB
    let triplesWritten = 0;
    if (triples.length > 0) {
      const turtle = [
        `@prefix rdf: <${RDF}> .`,
        `@prefix rdfs: <${RDFS}> .`,
        `@prefix xsd: <${XSD}> .`,
        '',
        ...triples
      ].join('\n');

      const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(dataGraphIRI)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle
      });

      if (!response.ok) {
        throw new Error(`GraphDB write failed: ${response.status}`);
      }
      triplesWritten = triples.length;
    }

    // Clean up staged data
    await redisService.del(`staged-extraction:${stageId}`);

    res.json({
      success: true,
      committed: {
        entities: entities.length,
        relationships: relationships.length,
        assertions: eventBatch.stats.assertions,
        evidenceLinks: eventBatch.stats.evidence_links,
        triplesWritten
      }
    });
  } catch (error) {
    logger.error('Commit extraction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ontology/extraction-review/:stageId
 * Discard staged extraction
 */
router.delete('/:stageId', requireMember, async (req, res) => {
  try {
    const { stageId } = req.params;
    await redisService.del(`staged-extraction:${stageId}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function sanitizeLabel(label) {
  return (label || 'Entity').replace(/[^a-zA-Z0-9_]/g, '_');
}

function sanitizeForUri(value) {
  return encodeURIComponent((value || '').replace(/\s+/g, '_'));
}

function escapeTurtle(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

module.exports = router;
