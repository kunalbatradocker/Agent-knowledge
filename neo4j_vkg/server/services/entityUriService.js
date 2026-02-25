/**
 * Entity URI Service
 * SINGLE SOURCE OF TRUTH for entity URI generation
 * 
 * This service ensures consistent URI generation across the entire system.
 * All entity URIs should be generated through this service.
 * 
 * URI Format: entity://{workspace_id}/{type}/{identity_hash}
 * 
 * Identity Resolution Strategy:
 * 1. If entity type has identity_keys defined in ontology → use those property values
 * 2. If no identity_keys → fall back to normalized_label
 * 
 * This ensures:
 * 1. Same entity always gets same URI (deterministic)
 * 2. Entities are scoped to workspace
 * 3. MERGE operations work correctly
 * 4. Deduplication is reliable
 * 5. Two "John Smith" with different emails are different entities
 */

class EntityUriService {
  /**
   * Generate a deterministic URI for an entity
   * @param {string} label - Entity label/name
   * @param {string} type - Entity type (Person, Organization, etc.)
   * @param {string} workspaceId - Workspace ID for scoping
   * @param {Object} options - Additional options
   * @param {Object} options.properties - Entity properties for identity resolution
   * @param {Array} options.identityKeys - Property names that form unique identity
   * @returns {string} Deterministic URI
   */
  generateUri(label, type, workspaceId, options = {}) {
    const normalizedType = this.normalizeType(type);
    const wsId = workspaceId || 'global';
    
    // Generate identity hash based on identity keys or label
    const identityHash = this.generateIdentityHash(label, options.properties, options.identityKeys);
    
    return `entity://${wsId}/${normalizedType}/${identityHash}`;
  }

  /**
   * Generate identity hash for an entity
   * Uses identity keys if provided, otherwise falls back to normalized label
   * @param {string} label - Entity label
   * @param {Object} properties - Entity properties
   * @param {Array} identityKeys - Property names that form unique identity
   * @returns {string} Identity hash
   */
  generateIdentityHash(label, properties = {}, identityKeys = []) {
    // If identity keys are defined and have values, use them
    if (identityKeys && identityKeys.length > 0 && properties) {
      const identityValues = identityKeys
        .map(key => {
          const value = properties[key];
          return value ? this.normalizeLabel(String(value)) : null;
        })
        .filter(v => v !== null);
      
      // Only use identity keys if we have values for at least one
      if (identityValues.length > 0) {
        return identityValues.join('_');
      }
    }
    
    // Fall back to normalized label
    return this.normalizeLabel(label);
  }

  /**
   * Generate a composite identity key for Neo4j MERGE
   * This is used as the unique identifier in the graph
   * @param {string} label - Entity label
   * @param {string} type - Entity type
   * @param {string} workspaceId - Workspace ID
   * @param {Object} properties - Entity properties
   * @param {Array} identityKeys - Property names that form unique identity
   * @returns {string} Composite identity key
   */
  generateCompositeIdentity(label, type, workspaceId, properties = {}, identityKeys = []) {
    const identityHash = this.generateIdentityHash(label, properties, identityKeys);
    const normalizedType = this.normalizeType(type);
    const wsId = workspaceId || 'global';
    
    return `${wsId}:${normalizedType}:${identityHash}`;
  }

  /**
   * Normalize a label for URI generation
   * This is the CANONICAL normalization used everywhere
   * @param {string} label - Raw label
   * @returns {string} Normalized label slug
   */
  normalizeLabel(label) {
    if (!label) return 'unknown';
    
    return label
      .toString()
      .toLowerCase()
      .trim()
      // Replace accented characters with ASCII equivalents
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Replace spaces and special chars with underscore
      .replace(/[^a-z0-9]+/g, '_')
      // Remove leading/trailing underscores
      .replace(/^_+|_+$/g, '')
      // Collapse multiple underscores
      .replace(/_+/g, '_')
      || 'unknown';
  }

  /**
   * Normalize entity type for URI generation
   * @param {string} type - Raw type
   * @returns {string} Normalized type
   */
  normalizeType(type) {
    if (!type) return 'entity';
    
    return type
      .toString()
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'entity';
  }

  /**
   * Normalize label for fuzzy matching (search)
   * More aggressive normalization for finding similar entities
   * @param {string} label - Raw label
   * @returns {string} Normalized key for matching
   */
  normalizeForMatching(label) {
    if (!label) return '';
    
    return label
      .toString()
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Remove ALL non-alphanumeric
      .replace(/[^a-z0-9]/g, '')
      // Remove common suffixes for fuzzy matching
      .replace(/s$/, '')  // plurals
      .replace(/ing$/, '')  // gerunds
      .replace(/ed$/, '');  // past tense
  }

  /**
   * Generate a concept_id (unique identifier)
   * Uses label+type+workspace to create deterministic ID
   * @param {string} label - Entity label
   * @param {string} type - Entity type
   * @param {string} workspaceId - Workspace ID
   * @param {Object} properties - Entity properties
   * @param {Array} identityKeys - Property names that form unique identity
   * @returns {string} Deterministic concept_id
   */
  generateConceptId(label, type, workspaceId, properties = {}, identityKeys = []) {
    const compositeIdentity = this.generateCompositeIdentity(label, type, workspaceId, properties, identityKeys);
    return this.hashString(compositeIdentity);
  }

  /**
   * Simple string hash for concept_id generation
   * @param {string} str - String to hash
   * @returns {string} Hash string
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to positive hex string
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Parse a URI to extract components
   * @param {string} uri - Entity URI
   * @returns {Object} Parsed components {workspaceId, type, identityHash}
   */
  parseUri(uri) {
    if (!uri || !uri.startsWith('entity://')) {
      return null;
    }
    
    const parts = uri.replace('entity://', '').split('/');
    if (parts.length < 3) {
      return null;
    }
    
    return {
      workspaceId: parts[0],
      type: parts[1],
      identityHash: parts.slice(2).join('/')  // In case identity has slashes
    };
  }

  /**
   * Check if two entities are the same based on identity keys
   * @param {Object} entity1 - First entity with label and properties
   * @param {Object} entity2 - Second entity with label and properties
   * @param {Array} identityKeys - Property names that form unique identity
   * @returns {boolean} True if same entity
   */
  isSameEntity(entity1, entity2, identityKeys = []) {
    // If identity keys are defined, compare by those
    if (identityKeys && identityKeys.length > 0) {
      for (const key of identityKeys) {
        const val1 = entity1.properties?.[key];
        const val2 = entity2.properties?.[key];
        
        // If both have the key and values match, they're the same
        if (val1 && val2 && this.normalizeLabel(String(val1)) === this.normalizeLabel(String(val2))) {
          return true;
        }
      }
    }
    
    // Fall back to label comparison
    const norm1 = this.normalizeForMatching(entity1.label);
    const norm2 = this.normalizeForMatching(entity2.label);
    return norm1 === norm2;
  }

  /**
   * Sanitize a Neo4j label name
   * @param {string} name - Raw type name
   * @returns {string} Valid Neo4j label
   */
  sanitizeNeo4jLabel(name) {
    if (!name) return 'Entity';
    
    let sanitized = name
      .toString()
      .trim()
      // Remove special characters but keep spaces for now
      .replace(/[^a-zA-Z0-9\s_]/g, '')
      // Convert to PascalCase
      .split(/[\s_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('')
      // Ensure starts with letter
      .replace(/^[0-9]+/, '');
    
    return sanitized || 'Entity';
  }

  /**
   * Get identity keys for an entity type from ontology
   * @param {Object} ontology - Ontology with entityTypes/classes
   * @param {string} entityType - Entity type name
   * @returns {Array} Identity key property names
   */
  getIdentityKeysForType(ontology, entityType) {
    if (!ontology || !entityType) return [];
    
    // Check entityTypes array
    const entityTypes = ontology.entityTypes || ontology.classes || [];
    const typeDefinition = entityTypes.find(et => {
      const typeName = typeof et === 'string' ? et : (et.name || et.label || et.type || et.userLabel);
      return typeName?.toLowerCase() === entityType.toLowerCase();
    });
    
    if (!typeDefinition || typeof typeDefinition === 'string') return [];
    
    // Get identity_keys from type definition
    if (typeDefinition.identity_keys && Array.isArray(typeDefinition.identity_keys)) {
      return typeDefinition.identity_keys;
    }
    
    // Or find attributes marked as is_identity
    if (typeDefinition.properties || typeDefinition.attributes) {
      const attrs = typeDefinition.properties || typeDefinition.attributes;
      return attrs
        .filter(attr => attr.is_identity === true)
        .map(attr => attr.name || attr.label);
    }
    
    return [];
  }
}

module.exports = new EntityUriService();
