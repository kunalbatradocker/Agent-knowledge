/**
 * Hybrid Document Analysis Service
 * Combines chunk-based retrieval with ontology-based reasoning
 */

const vectorStoreService = require('./vectorStoreService');
const graphDBStore = require('./graphDBStore');
const multiHopReasoningService = require('./multiHopReasoningService');

class HybridDocumentAnalysisService {
  
  /**
   * Analyze long document using both chunks and ontologies
   */
  async analyzeDocument(query, documentId, options = {}) {
    const { tenantId = 'default', workspaceId = 'default' } = options;

    // Step 1: Find relevant chunks (preserves context)
    const relevantChunks = await this.findRelevantChunks(query, documentId);
    
    // Step 2: Extract entities from query and chunks
    const entities = await this.extractEntitiesFromChunks(relevantChunks);
    
    // Step 3: Find ontological relationships
    const ontologyConnections = await this.findOntologyConnections(entities, tenantId, workspaceId);
    
    // Step 4: Multi-hop reasoning for deeper insights
    const reasoningResults = await multiHopReasoningService.multiHopReasoning(query, {
      tenantId, workspaceId, reasoning: 'hybrid'
    });

    return {
      query,
      documentId,
      analysis: {
        // Original context from chunks
        relevantChunks: relevantChunks.map(chunk => ({
          text: chunk.text,
          page: chunk.startPage,
          section: chunk.section_title,
          similarity: chunk.similarity
        })),
        
        // Structured knowledge from ontologies
        extractedEntities: entities,
        ontologyConnections,
        
        // Deep reasoning results
        reasoning: reasoningResults,
        
        // Synthesized insights
        insights: this.generateInsights(relevantChunks, ontologyConnections, reasoningResults)
      }
    };
  }

  /**
   * Find chunks related to query (semantic similarity)
   */
  async findRelevantChunks(query, documentId) {
    const chunks = await vectorStoreService.semanticSearch(query, 10, {
      documentId // Filter by specific document
    });
    
    return chunks.filter(chunk => chunk.similarity > 0.4); // Higher threshold for relevance
  }

  /**
   * Extract entities mentioned in chunks
   */
  async extractEntitiesFromChunks(chunks) {
    const entities = new Set();
    
    // Simple entity extraction (could be enhanced with NER)
    chunks.forEach(chunk => {
      // Look for capitalized terms, dollar amounts, dates, etc.
      const text = chunk.text;
      
      // Company names (capitalized words)
      const companies = text.match(/\b[A-Z][a-z]+ (?:Corporation|Corp|Inc|LLC|Ltd)\b/g) || [];
      companies.forEach(company => entities.add(company));
      
      // Dollar amounts
      const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
      amounts.forEach(amount => entities.add(amount));
      
      // Time periods
      const periods = text.match(/\d+[- ](?:day|month|year)s?/g) || [];
      periods.forEach(period => entities.add(period));
    });
    
    return Array.from(entities);
  }

  /**
   * Find how entities are connected in the ontology
   */
  async findOntologyConnections(entities, tenantId, workspaceId) {
    const connections = [];
    
    for (const entity of entities) {
      const sparqlQuery = `
        PREFIX : <http://purplefabric.ai/ontology#>
        
        SELECT ?subject ?predicate ?object WHERE {
          {
            ?subject ?predicate ?object .
            FILTER(CONTAINS(LCASE(STR(?subject)), LCASE("${entity}")) ||
                   CONTAINS(LCASE(STR(?object)), LCASE("${entity}")))
          }
        }
        LIMIT 20
      `;
      
      try {
        const results = await graphDBStore.executeSPARQL(tenantId, workspaceId, sparqlQuery, 'all');
        
        results.results.bindings.forEach(binding => {
          connections.push({
            entity,
            subject: binding.subject?.value,
            predicate: binding.predicate?.value,
            object: binding.object?.value
          });
        });
      } catch (error) {
        console.warn(`Could not find ontology connections for ${entity}:`, error.message);
      }
    }
    
    return connections;
  }

  /**
   * Generate insights by combining chunk context with ontology reasoning
   */
  generateInsights(chunks, ontologyConnections, reasoningResults) {
    const insights = [];
    
    // Cross-reference insights
    if (chunks.length > 1) {
      insights.push({
        type: 'cross_reference',
        description: `Information about this topic appears in ${chunks.length} different sections`,
        sections: chunks.map(c => c.section_title).filter(Boolean)
      });
    }
    
    // Entity relationship insights
    if (ontologyConnections.length > 0) {
      const entityTypes = [...new Set(ontologyConnections.map(c => c.predicate))];
      insights.push({
        type: 'entity_relationships',
        description: `Found ${ontologyConnections.length} structured relationships`,
        relationshipTypes: entityTypes
      });
    }
    
    // Multi-hop reasoning insights
    if (reasoningResults.combined?.length > 0) {
      insights.push({
        type: 'deep_connections',
        description: `Discovered ${reasoningResults.combined.length} indirect connections`,
        connections: reasoningResults.combined.slice(0, 3) // Top 3
      });
    }
    
    return insights;
  }

  /**
   * Specific use case: Contract analysis
   */
  async analyzeContract(query, contractDocumentId) {
    const analysis = await this.analyzeDocument(query, contractDocumentId);
    
    // Contract-specific enhancements
    const contractInsights = {
      ...analysis,
      contractSpecific: {
        parties: this.findParties(analysis.relevantChunks),
        obligations: this.findObligations(analysis.relevantChunks),
        risks: this.assessRisks(analysis.ontologyConnections),
        compliance: this.checkCompliance(analysis.reasoning)
      }
    };
    
    return contractInsights;
  }

  findParties(chunks) {
    // Extract party information from chunks
    const parties = [];
    chunks.forEach(chunk => {
      const partyMatches = chunk.text.match(/Party [A-Z]|(?:Company|Corporation|Inc|LLC)/g);
      if (partyMatches) {
        parties.push(...partyMatches);
      }
    });
    return [...new Set(parties)];
  }

  findObligations(chunks) {
    // Find obligation-related text
    return chunks.filter(chunk => 
      /shall|must|required|obligation|liable|responsible/i.test(chunk.text)
    ).map(chunk => ({
      text: chunk.text.substring(0, 200) + '...',
      page: chunk.startPage
    }));
  }

  assessRisks(connections) {
    // Identify risk-related connections
    return connections.filter(conn => 
      /liability|penalty|breach|default|termination/i.test(conn.predicate || '')
    );
  }

  checkCompliance(reasoning) {
    // Check for compliance-related reasoning results
    return reasoning.combined?.filter(result => 
      /compliance|regulation|law|requirement/i.test(JSON.stringify(result))
    ) || [];
  }
}

module.exports = new HybridDocumentAnalysisService();
