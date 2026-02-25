/**
 * Lineage Service
 * Data provenance and lineage tracking for enterprise knowledge graphs
 * Tracks source, transformations, and dependencies for all data
 */

const neo4jService = require('./neo4jService');
const driver = require('../config/neo4j');
const neo4j = require('neo4j-driver');
const { v4: uuidv4 } = require('uuid');

class LineageService {
  constructor() {
    this.sourceTypes = {
      DOCUMENT: 'document',
      CSV: 'csv',
      JSON: 'json',
      DATABASE: 'database',
      API: 'api',
      MANUAL: 'manual',
      LLM_EXTRACTION: 'llm_extraction',
      MERGE: 'merge',
      TRANSFORMATION: 'transformation'
    };

    this.reliabilityScores = {
      document: 0.9,
      csv: 0.95,
      json: 0.95,
      database: 0.98,
      api: 0.85,
      manual: 0.7,
      llm_extraction: 0.75,
      merge: 0.8,
      transformation: 0.85
    };
  }

  /**
   * Record provenance for an entity
   */
  async recordProvenance(provenanceData) {
    const session = neo4jService.getSession();
    
    try {
      const provenanceId = uuidv4();
      const reliability = this.reliabilityScores[provenanceData.sourceType] || 0.5;

      const query = `
        MATCH (e {uri: $entityUri})
        CREATE (p:Provenance {
          provenance_id: $provenanceId,
          source_type: $sourceType,
          source_id: $sourceId,
          source_file: $sourceFile,
          source_location: $sourceLocation,
          extracted_at: datetime($extractedAt),
          confidence: $confidence,
          reliability_score: $reliability,
          extraction_method: $extractionMethod,
          extractor_version: $extractorVersion,
          raw_text: $rawText
        })
        CREATE (e)-[:HAS_PROVENANCE]->(p)
        WITH e, p
        OPTIONAL MATCH (s:Source {source_id: $sourceId})
        FOREACH (x IN CASE WHEN s IS NOT NULL THEN [1] ELSE [] END |
          CREATE (p)-[:FROM_SOURCE]->(s)
        )
        RETURN p
      `;

      const result = await session.run(query, {
        entityUri: provenanceData.entityUri,
        provenanceId,
        sourceType: provenanceData.sourceType,
        sourceId: provenanceData.sourceId || null,
        sourceFile: provenanceData.sourceFile || null,
        sourceLocation: provenanceData.sourceLocation ? String(provenanceData.sourceLocation) : null,
        extractedAt: provenanceData.extractedAt || new Date().toISOString(),
        confidence: provenanceData.confidence || 0.8,
        reliability: reliability * (provenanceData.confidence || 0.8),
        extractionMethod: provenanceData.extractionMethod || null,
        extractorVersion: provenanceData.extractorVersion || '1.0',
        rawText: provenanceData.rawText ? provenanceData.rawText.substring(0, 1000) : null
      });

      return {
        provenanceId,
        reliability,
        recorded: result.records.length > 0
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Record relationship provenance
   */
  async recordRelationshipProvenance(relationshipData) {
    const session = neo4jService.getSession();
    
    try {
      const provenanceId = uuidv4();

      const query = `
        MATCH (source {uri: $sourceUri})-[r]->(target {uri: $targetUri})
        WHERE type(r) = $relType OR r.predicate = $predicate
        SET r.provenance_id = $provenanceId,
            r.source_type = $sourceType,
            r.source_id = $sourceId,
            r.extracted_at = datetime($extractedAt),
            r.confidence = $confidence,
            r.extraction_method = $extractionMethod
        RETURN r
      `;

      await session.run(query, {
        sourceUri: relationshipData.sourceUri,
        targetUri: relationshipData.targetUri,
        relType: relationshipData.relationType || 'RELATED_TO',
        predicate: relationshipData.predicate,
        provenanceId,
        sourceType: relationshipData.sourceType,
        sourceId: relationshipData.sourceId,
        extractedAt: relationshipData.extractedAt || new Date().toISOString(),
        confidence: relationshipData.confidence || 0.8,
        extractionMethod: relationshipData.extractionMethod
      });

      return { provenanceId };
    } finally {
      await session.close();
    }
  }

  /**
   * Get full lineage for an entity
   */
  async getEntityLineage(entityUri, depth = 3) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (e {uri: $uri})
        OPTIONAL MATCH (e)-[:HAS_PROVENANCE]->(p:Provenance)
        OPTIONAL MATCH (p)-[:FROM_SOURCE]->(s:Source)
        OPTIONAL MATCH (e)<-[:MENTIONED_IN]-(chunk:Chunk)-[:PART_OF]->(doc:Document)
        OPTIONAL MATCH (e)-[:DERIVED_FROM*1..${depth}]->(ancestor)
        OPTIONAL MATCH (descendant)-[:DERIVED_FROM*1..${depth}]->(e)
        RETURN e as entity,
               collect(DISTINCT p) as provenances,
               collect(DISTINCT s) as sources,
               collect(DISTINCT {chunk: chunk, document: doc}) as documentSources,
               collect(DISTINCT ancestor) as ancestors,
               collect(DISTINCT descendant) as descendants
      `;

      const result = await session.run(query, { uri: entityUri });
      
      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const entity = record.get('entity')?.properties;
      const provenances = record.get('provenances').map(p => p?.properties).filter(Boolean);
      const sources = record.get('sources').map(s => s?.properties).filter(Boolean);
      const documentSources = record.get('documentSources')
        .filter(ds => ds.chunk && ds.document)
        .map(ds => ({
          chunk: ds.chunk.properties,
          document: ds.document.properties
        }));

      return {
        entity,
        provenance: {
          records: provenances,
          sources,
          documentSources,
          totalSources: provenances.length + documentSources.length
        },
        lineage: {
          ancestors: record.get('ancestors').map(a => a?.properties).filter(Boolean),
          descendants: record.get('descendants').map(d => d?.properties).filter(Boolean)
        },
        qualityScore: this.calculateQualityScore(provenances, documentSources)
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate data quality score based on provenance
   */
  calculateQualityScore(provenances, documentSources) {
    if (provenances.length === 0 && documentSources.length === 0) {
      return { score: 0.5, level: 'unknown', factors: ['No provenance data'] };
    }

    let totalScore = 0;
    let count = 0;
    const factors = [];

    // Score from provenance records
    for (const p of provenances) {
      const reliability = p.reliability_score || this.reliabilityScores[p.source_type] || 0.5;
      const confidence = p.confidence || 0.8;
      totalScore += reliability * confidence;
      count++;
    }

    // Score from document sources
    for (const ds of documentSources) {
      totalScore += 0.85; // Documents are generally reliable
      count++;
    }

    const avgScore = count > 0 ? totalScore / count : 0.5;

    // Determine quality level
    let level;
    if (avgScore >= 0.9) {
      level = 'excellent';
      factors.push('High-confidence sources');
    } else if (avgScore >= 0.75) {
      level = 'good';
      factors.push('Reliable sources');
    } else if (avgScore >= 0.6) {
      level = 'moderate';
      factors.push('Mixed source reliability');
    } else {
      level = 'low';
      factors.push('Low-confidence sources');
    }

    // Add factors based on source count
    if (count >= 3) {
      factors.push('Multiple corroborating sources');
    } else if (count === 1) {
      factors.push('Single source');
    }

    return {
      score: Math.round(avgScore * 100) / 100,
      level,
      factors,
      sourceCount: count
    };
  }

  /**
   * Get impact analysis - what depends on this entity/source
   */
  async getImpactAnalysis(entityUri) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (e {uri: $uri})
        
        // Find entities that reference this one
        OPTIONAL MATCH (e)<-[r1]-(dependent)
        WHERE NOT dependent:Chunk AND NOT dependent:Document AND NOT dependent:Provenance
        
        // Find entities derived from this one
        OPTIONAL MATCH (derived)-[:DERIVED_FROM*1..3]->(e)
        
        // Find chunks that mention this entity
        OPTIONAL MATCH (e)-[:MENTIONED_IN]->(chunk:Chunk)-[:PART_OF]->(doc:Document)
        
        RETURN e as entity,
               collect(DISTINCT {entity: dependent, relationship: type(r1)}) as dependents,
               collect(DISTINCT derived) as derivedEntities,
               collect(DISTINCT {chunk: chunk, document: doc}) as mentions
      `;

      const result = await session.run(query, { uri: entityUri });
      
      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      
      return {
        entity: record.get('entity')?.properties,
        impact: {
          dependentEntities: record.get('dependents')
            .filter(d => d.entity)
            .map(d => ({
              ...d.entity.properties,
              relationshipType: d.relationship
            })),
          derivedEntities: record.get('derivedEntities')
            .map(d => d?.properties)
            .filter(Boolean),
          documentMentions: record.get('mentions')
            .filter(m => m.chunk && m.document)
            .map(m => ({
              documentTitle: m.document.properties.title,
              documentUri: m.document.properties.uri,
              chunkUri: m.chunk.properties.uri
            }))
        },
        riskLevel: this.calculateImpactRisk(record)
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate risk level for changes to an entity
   */
  calculateImpactRisk(record) {
    const dependents = record.get('dependents').filter(d => d.entity).length;
    const derived = record.get('derivedEntities').filter(Boolean).length;
    const mentions = record.get('mentions').filter(m => m.chunk).length;
    
    const totalImpact = dependents + derived + mentions;
    
    if (totalImpact >= 20) return { level: 'critical', score: 1.0, affectedCount: totalImpact };
    if (totalImpact >= 10) return { level: 'high', score: 0.8, affectedCount: totalImpact };
    if (totalImpact >= 5) return { level: 'medium', score: 0.5, affectedCount: totalImpact };
    if (totalImpact >= 1) return { level: 'low', score: 0.3, affectedCount: totalImpact };
    return { level: 'none', score: 0, affectedCount: 0 };
  }

  /**
   * Record a transformation/derivation
   */
  async recordDerivation(sourceUri, targetUri, transformationInfo) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (source {uri: $sourceUri})
        MATCH (target {uri: $targetUri})
        MERGE (target)-[r:DERIVED_FROM]->(source)
        SET r.transformation_type = $transformationType,
            r.transformation_rule = $transformationRule,
            r.derived_at = datetime(),
            r.confidence = $confidence
        RETURN r
      `;

      await session.run(query, {
        sourceUri,
        targetUri,
        transformationType: transformationInfo.type || 'unknown',
        transformationRule: transformationInfo.rule || null,
        confidence: transformationInfo.confidence || 0.9
      });

      return { success: true };
    } finally {
      await session.close();
    }
  }

  /**
   * Register a data source
   */
  async registerSource(sourceInfo) {
    const session = neo4jService.getSession();
    
    try {
      const sourceId = sourceInfo.id || uuidv4();

      const query = `
        MERGE (s:Source {source_id: $sourceId})
        SET s.name = $name,
            s.type = $type,
            s.uri = $uri,
            s.reliability = $reliability,
            s.description = $description,
            s.metadata = $metadata,
            s.registered_at = datetime(),
            s.last_updated = datetime()
        RETURN s
      `;

      const result = await session.run(query, {
        sourceId,
        name: sourceInfo.name,
        type: sourceInfo.type,
        uri: sourceInfo.uri || `source://${sourceId}`,
        reliability: sourceInfo.reliability || this.reliabilityScores[sourceInfo.type] || 0.7,
        description: sourceInfo.description || null,
        metadata: JSON.stringify(sourceInfo.metadata || {})
      });

      return result.records[0]?.get('s').properties;
    } finally {
      await session.close();
    }
  }

  /**
   * Get all registered sources
   */
  async getSources() {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (s:Source)
        OPTIONAL MATCH (p:Provenance)-[:FROM_SOURCE]->(s)
        RETURN s, count(p) as usageCount
        ORDER BY usageCount DESC
      `;

      const result = await session.run(query);
      
      return result.records.map(r => ({
        ...r.get('s').properties,
        usageCount: neo4jService.toNumber(r.get('usageCount'))
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get lineage graph for visualization
   */
  async getLineageGraph(entityUri, depth = 2) {
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH (e {uri: $uri})
        
        // Get provenance chain
        OPTIONAL MATCH provPath = (e)-[:HAS_PROVENANCE|DERIVED_FROM*1..${depth}]->(related)
        
        // Get dependent chain
        OPTIONAL MATCH depPath = (dependent)-[:DERIVED_FROM*1..${depth}]->(e)
        
        WITH e, 
             collect(DISTINCT nodes(provPath)) as provNodes,
             collect(DISTINCT relationships(provPath)) as provRels,
             collect(DISTINCT nodes(depPath)) as depNodes,
             collect(DISTINCT relationships(depPath)) as depRels
        
        RETURN e,
               provNodes, provRels,
               depNodes, depRels
      `;

      const result = await session.run(query, { uri: entityUri });
      
      if (result.records.length === 0) {
        return { nodes: [], edges: [] };
      }

      const record = result.records[0];
      const nodes = new Map();
      const edges = [];

      // Process entity
      const entity = record.get('e');
      nodes.set(entity.properties.uri, {
        id: entity.properties.uri,
        label: entity.properties.label || entity.properties.uri,
        type: 'entity',
        properties: entity.properties
      });

      // Process provenance nodes
      const provNodes = record.get('provNodes').flat().filter(Boolean);
      for (const node of provNodes) {
        if (!nodes.has(node.properties.uri || node.properties.provenance_id)) {
          const id = node.properties.uri || node.properties.provenance_id;
          nodes.set(id, {
            id,
            label: node.properties.label || node.properties.source_type || id,
            type: node.labels?.[0] || 'unknown',
            properties: node.properties
          });
        }
      }

      // Process relationships
      const provRels = record.get('provRels').flat().filter(Boolean);
      for (const rel of provRels) {
        edges.push({
          source: rel.start?.properties?.uri || rel.startNodeElementId,
          target: rel.end?.properties?.uri || rel.endNodeElementId,
          type: rel.type,
          properties: rel.properties
        });
      }

      return {
        nodes: Array.from(nodes.values()),
        edges
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Validate data against its provenance
   */
  async validateProvenance(entityUri) {
    const lineage = await this.getEntityLineage(entityUri);
    
    if (!lineage) {
      return {
        valid: false,
        issues: ['Entity not found'],
        score: 0
      };
    }

    const issues = [];
    let score = 100;

    // Check for provenance records
    if (lineage.provenance.totalSources === 0) {
      issues.push('No provenance records found');
      score -= 30;
    }

    // Check source reliability
    for (const p of lineage.provenance.records) {
      if ((p.reliability_score || 0) < 0.5) {
        issues.push(`Low reliability source: ${p.source_type}`);
        score -= 10;
      }
    }

    // Check for stale data
    for (const p of lineage.provenance.records) {
      if (p.extracted_at) {
        const extractedDate = new Date(p.extracted_at);
        const daysSinceExtraction = (Date.now() - extractedDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceExtraction > 365) {
          issues.push('Data may be stale (>1 year old)');
          score -= 15;
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      score: Math.max(0, score),
      qualityLevel: lineage.qualityScore.level
    };
  }
}

module.exports = new LineageService();
