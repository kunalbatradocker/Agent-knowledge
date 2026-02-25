/**
 * Multi-Hop Reasoning Service
 * Combines GraphDB semantic reasoning with Neo4j graph traversals
 */

const graphDBStore = require('./graphDBStore');
const neo4jService = require('./neo4jService');
const logger = require('../utils/logger');

class MultiHopReasoningService {
  constructor() {
    this.maxHops = 5;
    this.maxResults = 100;
  }

  /**
   * Multi-hop reasoning combining GraphDB + Neo4j
   */
  async multiHopReasoning(query, options = {}) {
    const { 
      tenantId = 'default', 
      workspaceId = 'default',
      maxHops = this.maxHops,
      reasoning = 'hybrid' // 'semantic', 'graph', 'hybrid'
    } = options;

    try {
      logger.info(`🧠 Multi-hop reasoning: "${query}" (${reasoning})`);

      switch (reasoning) {
        case 'semantic':
          return await this.semanticReasoning(query, tenantId, workspaceId, maxHops);
        case 'graph':
          return await this.graphTraversal(query, maxHops);
        case 'hybrid':
        default:
          return await this.hybridReasoning(query, tenantId, workspaceId, maxHops);
      }

    } catch (error) {
      logger.error('Multi-hop reasoning failed:', error);
      throw error;
    }
  }

  /**
   * Semantic reasoning using GraphDB SPARQL with inference
   */
  async semanticReasoning(query, tenantId, workspaceId, maxHops) {
    // Extract entities from query (simplified - could use NER)
    const entities = this.extractEntities(query);
    
    const sparqlQuery = `
      PREFIX : <http://purplefabric.ai/ontology#>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      
      SELECT DISTINCT ?entity1 ?relation ?entity2 ?path WHERE {
        # Multi-hop path with inference
        ?entity1 ?relation ?entity2 .
        
        # Optional: Find paths up to ${maxHops} hops
        OPTIONAL {
          ?entity1 (?relation/${maxHops > 1 ? '?rel*' : ''}) ?entity2 .
          BIND(CONCAT(STR(?entity1), " -> ", STR(?entity2)) as ?path)
        }
        
        # Filter by query entities if found
        ${entities.length > 0 ? `
        FILTER(
          ${entities.map(e => `CONTAINS(LCASE(STR(?entity1)), LCASE("${e}")) || 
                              CONTAINS(LCASE(STR(?entity2)), LCASE("${e}"))`).join(' || ')}
        )` : ''}
        
        # Inferred relationships through OWL reasoning
        FILTER(?relation != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
      }
      LIMIT ${this.maxResults}
    `;

    const results = await graphDBStore.executeSPARQL(tenantId, workspaceId, sparqlQuery, 'all');
    
    return {
      type: 'semantic',
      query,
      results: this.formatSparqlResults(results),
      reasoning: 'OWL inference + SPARQL paths'
    };
  }

  /**
   * Graph traversal using Neo4j for complex path finding
   */
  async graphTraversal(query, maxHops) {
    const session = neo4jService.getSession();
    
    try {
      // Extract key terms for node matching
      const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      
      const cypherQuery = `
        // Find starting nodes matching query terms
        MATCH (start)
        WHERE ANY(term IN $terms WHERE 
          toLower(start.name) CONTAINS term OR 
          toLower(start.label) CONTAINS term OR
          toLower(start.id) CONTAINS term
        )
        
        // Multi-hop traversal
        MATCH path = (start)-[*1..${maxHops}]-(end)
        WHERE start <> end
        
        // Return paths with metrics
        RETURN 
          start, end, path,
          length(path) as hops,
          [n in nodes(path) | n.name] as nodeNames,
          [r in relationships(path) | type(r)] as relationTypes
        ORDER BY hops ASC
        LIMIT ${this.maxResults}
      `;

      const result = await session.run(cypherQuery, { terms });
      
      return {
        type: 'graph',
        query,
        results: result.records.map(record => ({
          start: record.get('start').properties,
          end: record.get('end').properties,
          hops: record.get('hops').toNumber(),
          nodeNames: record.get('nodeNames'),
          relationTypes: record.get('relationTypes'),
          path: record.get('path')
        })),
        reasoning: 'Neo4j graph traversal'
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Hybrid reasoning: GraphDB semantic + Neo4j traversal
   */
  async hybridReasoning(query, tenantId, workspaceId, maxHops) {
    // Run both approaches in parallel
    const [semanticResults, graphResults] = await Promise.all([
      this.semanticReasoning(query, tenantId, workspaceId, maxHops),
      this.graphTraversal(query, maxHops)
    ]);

    // Combine and rank results
    const combinedResults = this.combineResults(semanticResults, graphResults);

    return {
      type: 'hybrid',
      query,
      semantic: semanticResults,
      graph: graphResults,
      combined: combinedResults,
      reasoning: 'GraphDB inference + Neo4j traversal'
    };
  }

  /**
   * Advanced multi-hop queries for specific use cases
   */
  async findConnectionPath(entityA, entityB, options = {}) {
    const { maxHops = 3, tenantId = 'default', workspaceId = 'default' } = options;

    // GraphDB: Semantic path
    const semanticPath = await graphDBStore.executeSPARQL(tenantId, workspaceId, `
      PREFIX : <http://purplefabric.ai/ontology#>
      
      SELECT ?path WHERE {
        ?entityA ?relation ?entityB .
        FILTER(CONTAINS(LCASE(STR(?entityA)), LCASE("${entityA}")))
        FILTER(CONTAINS(LCASE(STR(?entityB)), LCASE("${entityB}")))
        BIND(CONCAT(STR(?entityA), " -> ", STR(?relation), " -> ", STR(?entityB)) as ?path)
      }
    `, 'all');

    // Neo4j: Shortest path
    const session = neo4jService.getSession();
    try {
      const shortestPath = await session.run(`
        MATCH (a), (b)
        WHERE toLower(a.name) CONTAINS toLower($entityA) 
          AND toLower(b.name) CONTAINS toLower($entityB)
        MATCH path = shortestPath((a)-[*1..${maxHops}]-(b))
        RETURN path, length(path) as hops
        ORDER BY hops ASC
        LIMIT 1
      `, { entityA, entityB });

      return {
        semantic: this.formatSparqlResults(semanticPath),
        graph: shortestPath.records.map(r => ({
          path: r.get('path'),
          hops: r.get('hops').toNumber()
        }))
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Extract entities from natural language query (simplified)
   */
  extractEntities(query) {
    // Simple keyword extraction - could be enhanced with NER
    const stopWords = ['who', 'what', 'where', 'when', 'how', 'is', 'are', 'the', 'a', 'an'];
    return query.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.includes(word))
      .slice(0, 5); // Limit to 5 key terms
  }

  /**
   * Format SPARQL results for consistency
   */
  formatSparqlResults(sparqlResults) {
    return sparqlResults.results.bindings.map(binding => {
      const formatted = {};
      Object.keys(binding).forEach(key => {
        formatted[key] = binding[key]?.value || binding[key];
      });
      return formatted;
    });
  }

  /**
   * Combine and rank results from both approaches
   */
  combineResults(semanticResults, graphResults) {
    const combined = [];
    
    // Add semantic results with reasoning score
    semanticResults.results.forEach(result => {
      combined.push({
        ...result,
        source: 'semantic',
        score: 0.8 // Higher score for inferred relationships
      });
    });

    // Add graph results with traversal score
    graphResults.results.forEach(result => {
      combined.push({
        ...result,
        source: 'graph',
        score: 0.6 + (1 / result.hops) * 0.3 // Shorter paths get higher scores
      });
    });

    // Sort by score and remove duplicates
    return combined
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxResults);
  }
}

module.exports = new MultiHopReasoningService();
