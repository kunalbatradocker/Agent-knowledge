/**
 * Ontology Models - Core data structures for ontology management
 * 
 * Ontology defines MEANING, graph DB stores INSTANCES
 * Ontology objects are CLASSES, not Entities
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Ontology Version States
 */
const VersionState = {
  DRAFT: 'DRAFT',           // Being edited
  REVIEW: 'REVIEW',         // Submitted for review
  ACTIVE: 'ACTIVE',         // Currently in use
  DEPRECATED: 'DEPRECATED', // Superseded but still valid
  RETIRED: 'RETIRED'        // No longer usable
};

/**
 * Pack Types
 */
const PackType = {
  FOUNDATION: 'foundation',   // Global core concepts
  INDUSTRY: 'industry',       // Industry-specific (BFSI, Healthcare, etc.)
  TENANT: 'tenant'            // Tenant-specific extensions
};

/**
 * Attribute Data Types
 */
const DataType = {
  STRING: 'string',
  INTEGER: 'integer',
  FLOAT: 'float',
  BOOLEAN: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  ENUM: 'enum',
  JSON: 'json',
  ARRAY: 'array'
};

/**
 * Relationship Direction
 */
const RelationshipDirection = {
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
  BIDIRECTIONAL: 'bidirectional'
};

/**
 * OntologyPack - Container for related ontology versions
 */
class OntologyPack {
  constructor(options = {}) {
    this.pack_id = options.pack_id || uuidv4();
    this.name = options.name;
    this.description = options.description;
    this.pack_type = options.pack_type || PackType.TENANT;
    this.industry = options.industry;               // e.g., 'banking', 'aml', 'insurance'
    this.scope = options.scope;                     // e.g., 'customer', 'transaction', 'risk'
    this.tenant_id = options.tenant_id;             // null for foundation/industry packs
    this.workspace_id = options.workspace_id;       // Workspace isolation
    this.parent_pack_id = options.parent_pack_id;   // For extensions
    this.created_at = options.created_at || new Date().toISOString();
    this.created_by = options.created_by;
    this.metadata = options.metadata || {};
  }

  toJSON() {
    return {
      pack_id: this.pack_id,
      name: this.name,
      description: this.description,
      pack_type: this.pack_type,
      industry: this.industry,
      scope: this.scope,
      tenant_id: this.tenant_id,
      workspace_id: this.workspace_id,
      parent_pack_id: this.parent_pack_id,
      created_at: this.created_at,
      created_by: this.created_by,
      metadata: this.metadata
    };
  }
}

/**
 * OntologyVersion - Immutable snapshot of an ontology
 */
class OntologyVersion {
  constructor(options = {}) {
    this.version_id = options.version_id || uuidv4();
    this.pack_id = options.pack_id;
    this.version = options.version || '1.0.0';      // SemVer
    this.state = options.state || VersionState.DRAFT;
    this.classes = options.classes || [];           // ClassDefinition[]
    this.relationships = options.relationships || []; // RelationshipDefinition[]
    this.slices = options.slices || [];             // OntologySlice[]
    this.extraction_profiles = options.extraction_profiles || [];
    this.created_at = options.created_at || new Date().toISOString();
    this.created_by = options.created_by;
    this.published_at = options.published_at;
    this.published_by = options.published_by;
    this.deprecated_at = options.deprecated_at;
    this.change_notes = options.change_notes || [];
    this.compatibility_report = options.compatibility_report;
    this.validation_report = options.validation_report;
  }

  /**
   * Parse SemVer version
   */
  parseSemVer() {
    const parts = this.version.split('.');
    return {
      major: parseInt(parts[0]) || 0,
      minor: parseInt(parts[1]) || 0,
      patch: parseInt(parts[2]) || 0
    };
  }

  /**
   * Increment version based on change type
   */
  incrementVersion(changeType) {
    const { major, minor, patch } = this.parseSemVer();
    switch (changeType) {
      case 'major':
        return `${major + 1}.0.0`;
      case 'minor':
        return `${major}.${minor + 1}.0`;
      case 'patch':
        return `${major}.${minor}.${patch + 1}`;
      default:
        return this.version;
    }
  }

  /**
   * Check if version can be edited
   */
  isEditable() {
    return this.state === VersionState.DRAFT;
  }

  /**
   * Get class by name
   */
  getClass(className) {
    return this.classes.find(c => c.name === className);
  }

  /**
   * Get relationship by type
   */
  getRelationship(relType) {
    return this.relationships.find(r => r.type === relType);
  }

  toJSON() {
    return {
      version_id: this.version_id,
      pack_id: this.pack_id,
      version: this.version,
      state: this.state,
      classes: this.classes.map(c => c.toJSON ? c.toJSON() : c),
      relationships: this.relationships.map(r => r.toJSON ? r.toJSON() : r),
      slices: this.slices.map(s => s.toJSON ? s.toJSON() : s),
      extraction_profiles: this.extraction_profiles,
      created_at: this.created_at,
      created_by: this.created_by,
      published_at: this.published_at,
      published_by: this.published_by,
      deprecated_at: this.deprecated_at,
      change_notes: this.change_notes,
      compatibility_report: this.compatibility_report,
      validation_report: this.validation_report
    };
  }
}

/**
 * ClassDefinition - Defines an entity type in the ontology
 */
class ClassDefinition {
  constructor(options = {}) {
    this.class_id = options.class_id || uuidv4();
    this.name = options.name;                       // PascalCase, e.g., 'Customer'
    this.display_name = options.display_name;       // Human-readable
    this.description = options.description;
    this.parent_class = options.parent_class;       // For inheritance
    this.attributes = options.attributes || [];     // AttributeDefinition[]
    this.identity_keys = options.identity_keys || []; // Attributes that form unique ID
    this.synonyms = options.synonyms || [];         // Alternative names
    this.is_abstract = options.is_abstract || false; // Cannot be instantiated directly
    this.is_core = options.is_core || false;        // Part of foundation, cannot be deleted
    this.extraction_hints = options.extraction_hints || {}; // LLM guidance
    this.validation_rules = options.validation_rules || [];
    this.created_at = options.created_at || new Date().toISOString();
  }

  /**
   * Get attribute by name
   */
  getAttribute(attrName) {
    return this.attributes.find(a => a.name === attrName);
  }

  /**
   * Get required attributes
   */
  getRequiredAttributes() {
    return this.attributes.filter(a => a.required);
  }

  /**
   * Get PII attributes
   */
  getPIIAttributes() {
    return this.attributes.filter(a => a.is_pii);
  }

  toJSON() {
    return {
      class_id: this.class_id,
      name: this.name,
      display_name: this.display_name,
      description: this.description,
      parent_class: this.parent_class,
      attributes: this.attributes.map(a => a.toJSON ? a.toJSON() : a),
      identity_keys: this.identity_keys,
      synonyms: this.synonyms,
      is_abstract: this.is_abstract,
      is_core: this.is_core,
      extraction_hints: this.extraction_hints,
      validation_rules: this.validation_rules,
      created_at: this.created_at
    };
  }
}

/**
 * AttributeDefinition - Defines a property of a class
 */
class AttributeDefinition {
  constructor(options = {}) {
    this.attribute_id = options.attribute_id || uuidv4();
    this.name = options.name;                       // snake_case
    this.display_name = options.display_name;
    this.description = options.description;
    this.data_type = options.data_type || DataType.STRING;
    this.required = options.required || false;
    this.is_pii = options.is_pii || false;          // Personal Identifiable Information
    this.is_identity = options.is_identity || false; // Part of entity identity
    this.default_value = options.default_value;
    this.enum_values = options.enum_values || [];   // For enum type
    this.validation_pattern = options.validation_pattern; // Regex
    this.min_value = options.min_value;
    this.max_value = options.max_value;
    this.synonyms = options.synonyms || [];
    this.extraction_hints = options.extraction_hints || {};
  }

  toJSON() {
    return {
      attribute_id: this.attribute_id,
      name: this.name,
      display_name: this.display_name,
      description: this.description,
      data_type: this.data_type,
      required: this.required,
      is_pii: this.is_pii,
      is_identity: this.is_identity,
      default_value: this.default_value,
      enum_values: this.enum_values,
      validation_pattern: this.validation_pattern,
      min_value: this.min_value,
      max_value: this.max_value,
      synonyms: this.synonyms,
      extraction_hints: this.extraction_hints
    };
  }
}

/**
 * RelationshipDefinition - Defines a relationship type between classes
 */
class RelationshipDefinition {
  constructor(options = {}) {
    this.relationship_id = options.relationship_id || uuidv4();
    this.type = options.type;                       // UPPER_SNAKE_CASE
    this.display_name = options.display_name;
    this.description = options.description;
    this.from_class = options.from_class;           // Source class name
    this.to_class = options.to_class;               // Target class name
    this.direction = options.direction || RelationshipDirection.OUTGOING;
    this.cardinality = options.cardinality || 'many-to-many'; // one-to-one, one-to-many, etc.
    this.attributes = options.attributes || [];     // Relationship properties
    this.evidence_required = options.evidence_required || false;
    this.synonyms = options.synonyms || [];
    this.inverse_type = options.inverse_type;       // Name of inverse relationship
    this.extraction_hints = options.extraction_hints || {};
  }

  toJSON() {
    return {
      relationship_id: this.relationship_id,
      type: this.type,
      display_name: this.display_name,
      description: this.description,
      from_class: this.from_class,
      to_class: this.to_class,
      direction: this.direction,
      cardinality: this.cardinality,
      attributes: this.attributes.map(a => a.toJSON ? a.toJSON() : a),
      evidence_required: this.evidence_required,
      synonyms: this.synonyms,
      inverse_type: this.inverse_type,
      extraction_hints: this.extraction_hints
    };
  }
}

/**
 * OntologySlice - A view/subset of the ontology for specific use cases
 */
class OntologySlice {
  constructor(options = {}) {
    this.slice_id = options.slice_id || uuidv4();
    this.name = options.name;
    this.description = options.description;
    this.included_classes = options.included_classes || [];
    this.included_relationships = options.included_relationships || [];
    this.document_types = options.document_types || []; // Document types this slice applies to
    this.use_case = options.use_case;               // e.g., 'kyc', 'aml_screening', 'risk_assessment'
  }

  toJSON() {
    return {
      slice_id: this.slice_id,
      name: this.name,
      description: this.description,
      included_classes: this.included_classes,
      included_relationships: this.included_relationships,
      document_types: this.document_types,
      use_case: this.use_case
    };
  }
}

/**
 * ExtractionProfile - Configuration for extraction runs
 */
class ExtractionProfile {
  constructor(options = {}) {
    this.profile_id = options.profile_id || uuidv4();
    this.name = options.name;
    this.description = options.description;
    this.slice_id = options.slice_id;               // Which ontology slice to use
    this.llm_model = options.llm_model;             // Model identifier
    this.llm_prompt_version = options.llm_prompt_version;
    this.confidence_threshold = options.confidence_threshold || 0.7;
    this.require_evidence = options.require_evidence || true;
    this.pii_handling = options.pii_handling || 'mask'; // mask, redact, allow
    this.entity_resolution_strategy = options.entity_resolution_strategy || 'deterministic';
    this.max_entities_per_chunk = options.max_entities_per_chunk || 20;
    this.max_relationships_per_chunk = options.max_relationships_per_chunk || 30;
  }

  toJSON() {
    return {
      profile_id: this.profile_id,
      name: this.name,
      description: this.description,
      slice_id: this.slice_id,
      llm_model: this.llm_model,
      llm_prompt_version: this.llm_prompt_version,
      confidence_threshold: this.confidence_threshold,
      require_evidence: this.require_evidence,
      pii_handling: this.pii_handling,
      entity_resolution_strategy: this.entity_resolution_strategy,
      max_entities_per_chunk: this.max_entities_per_chunk,
      max_relationships_per_chunk: this.max_relationships_per_chunk
    };
  }
}

/**
 * CandidateConcept - Proposed new concept from extraction
 */
class CandidateConcept {
  constructor(options = {}) {
    this.candidate_id = options.candidate_id || uuidv4();
    this.tenant_id = options.tenant_id;
    this.workspace_id = options.workspace_id;
    this.term = options.term;
    this.suggested_class = options.suggested_class;
    this.suggested_definition = options.suggested_definition;
    this.frequency = options.frequency || 1;
    this.evidence = options.evidence || [];         // Document references
    this.status = options.status || 'pending';      // pending, approved, rejected
    this.reviewed_by = options.reviewed_by;
    this.reviewed_at = options.reviewed_at;
    this.converted_to_class_id = options.converted_to_class_id;
    this.created_at = options.created_at || new Date().toISOString();
  }

  toJSON() {
    return {
      candidate_id: this.candidate_id,
      tenant_id: this.tenant_id,
      workspace_id: this.workspace_id,
      term: this.term,
      suggested_class: this.suggested_class,
      suggested_definition: this.suggested_definition,
      frequency: this.frequency,
      evidence: this.evidence,
      status: this.status,
      reviewed_by: this.reviewed_by,
      reviewed_at: this.reviewed_at,
      converted_to_class_id: this.converted_to_class_id,
      created_at: this.created_at
    };
  }
}

module.exports = {
  VersionState,
  PackType,
  DataType,
  RelationshipDirection,
  OntologyPack,
  OntologyVersion,
  ClassDefinition,
  AttributeDefinition,
  RelationshipDefinition,
  OntologySlice,
  ExtractionProfile,
  CandidateConcept
};
