/**
 * Application Constants
 * Centralized configuration values to avoid magic numbers
 */

module.exports = {
  // Pagination
  PAGINATION: {
    DEFAULT_PAGE_SIZE: 50,
    MAX_PAGE_SIZE: 100,
    DEFAULT_OFFSET: 0
  },

  // Query limits
  QUERY: {
    MAX_RESULTS: 100,
    DEFAULT_LIMIT: 50,
    GRAPH_DEFAULT_LIMIT: 100,
    RELATIONSHIP_DEFAULT_LIMIT: 20,
    ENTITY_GRAPH_DEFAULT_LIMIT: 50,
    AUDIT_LOG_DEFAULT_LIMIT: 100
  },

  // Extraction
  EXTRACTION: {
    DEFAULT_CONFIDENCE_THRESHOLD: 0.7,
    MIN_CONFIDENCE_THRESHOLD: 0.5,
    MAX_CONFIDENCE_THRESHOLD: 1.0,
    QUARANTINE_DEFAULT_LIMIT: 100
  },

  // File upload
  UPLOAD: {
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    ALLOWED_EXTENSIONS: ['.pdf', '.docx', '.doc', '.txt', '.html', '.md']
  },

  // Graph traversal
  GRAPH: {
    DEFAULT_DEPTH: 1,
    MAX_DEPTH: 3,
    DEFAULT_NODE_LIMIT: 50,
    MAX_NODE_LIMIT: 200
  },

  // Cache
  CACHE: {
    CONNECTION_STATUS_TTL: 30, // seconds
    ENTITY_CACHE_TTL: 300 // 5 minutes
  },

  // Versioning
  VERSIONING: {
    MAX_VERSIONS_TO_KEEP: 50,
    AUDIT_LOG_DEFAULT_LIMIT: 100,
    DOCUMENT_AUDIT_DEFAULT_LIMIT: 50
  },

  // Tenant/Workspace
  TENANT: {
    DEFAULT_TENANT_NAME: 'Default Tenant',
    DEFAULT_WORKSPACE_NAME: 'Default Workspace'
  },

  // Ontology
  ONTOLOGY: {
    MAX_CLASSES_PER_VERSION: 500,
    MAX_RELATIONSHIPS_PER_VERSION: 1000,
    MAX_SLICES_PER_VERSION: 50
  }
};
