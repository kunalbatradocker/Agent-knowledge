/**
 * GraphDB Configuration
 * Handles connection and configuration for GraphDB RDF triplestore
 */

require('dotenv').config();

const GRAPHDB_URL = process.env.GRAPHDB_URL || 'http://localhost:7200';
const GRAPHDB_REPOSITORY = process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1';

const graphdbConfig = {
  url: GRAPHDB_URL,
  repository: GRAPHDB_REPOSITORY,
  
  // Connection settings
  timeout: 30000, // 30 seconds
  retries: 3,
  
  // Repository endpoints
  endpoints: {
    sparql: `${GRAPHDB_URL}/repositories/${GRAPHDB_REPOSITORY}`,
    statements: `${GRAPHDB_URL}/repositories/${GRAPHDB_REPOSITORY}/statements`,
    rdf: `${GRAPHDB_URL}/repositories/${GRAPHDB_REPOSITORY}/rdf-graphs/service`,
    size: `${GRAPHDB_URL}/repositories/${GRAPHDB_REPOSITORY}/size`,
    health: `${GRAPHDB_URL}/rest/repositories/${GRAPHDB_REPOSITORY}`
  },
  
  // Standard prefixes
  prefixes: {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    dc: 'http://purl.org/dc/elements/1.1/',
    dcterms: 'http://purl.org/dc/terms/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    skos: 'http://www.w3.org/2004/02/skos/core#'
  }
};

/**
 * Check GraphDB connection and repository availability
 */
async function checkConnection() {
  try {
    const response = await fetch(graphdbConfig.endpoints.health, {
      method: 'GET',
      timeout: graphdbConfig.timeout
    });
    
    if (response.ok) {
      return {
        connected: true,
        message: 'GraphDB connection successful',
        repository: GRAPHDB_REPOSITORY,
        url: GRAPHDB_URL
      };
    } else {
      return {
        connected: false,
        message: `GraphDB repository not accessible: HTTP ${response.status}`,
        repository: GRAPHDB_REPOSITORY,
        url: GRAPHDB_URL
      };
    }
  } catch (error) {
    return {
      connected: false,
      message: error.code === 'ECONNREFUSED' 
        ? 'GraphDB server not running. Start GraphDB and ensure repository exists.'
        : error.message,
      repository: GRAPHDB_REPOSITORY,
      url: GRAPHDB_URL
    };
  }
}

module.exports = {
  config: graphdbConfig,
  checkConnection,
  GRAPHDB_URL,
  GRAPHDB_REPOSITORY
};
