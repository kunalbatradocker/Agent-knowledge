/**
 * Graph Events - Canonical Output Format
 * 
 * ALL extractors must emit GraphEvents (never write directly to graph DB).
 * This ensures auditability, replay capability, and consistent provenance.
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Claim Status - distinguishes between claims and verified facts
 */
const ClaimStatus = {
  CLAIM: 'CLAIM',     // Extracted but not verified
  FACT: 'FACT'        // Verified from authoritative source
};

/**
 * Source Type - origin of the data
 */
const SourceType = {
  STRUCTURED: 'structured',       // Database, CSV, API
  UNSTRUCTURED: 'unstructured'    // PDF, DOCX, HTML, TXT
};

/**
 * Event Types
 */
const EventType = {
  UPSERT_NODE: 'UpsertNode',
  UPSERT_EDGE: 'UpsertEdge',
  EVIDENCE_LINK: 'EvidenceLink',
  UPSERT_ASSERTION: 'UpsertAssertion',
  CANDIDATE_CONCEPT: 'CandidateConcept',
  QUARANTINE_RECORD: 'QuarantineRecord'
};

/**
 * Base GraphEvent - all events inherit from this
 */
class GraphEvent {
  constructor(options) {
    this.event_id = uuidv4();
    this.event_type = options.event_type;
    this.tenant_id = options.tenant_id;
    this.workspace_id = options.workspace_id;
    this.ontology_version_id = options.ontology_version_id;
    this.source_type = options.source_type;
    this.source_id = options.source_id;
    this.ingested_at = new Date().toISOString();
    this.observed_at = options.observed_at || null;
    this.confidence = options.confidence ?? 1.0;
    this.claim_status = options.claim_status || ClaimStatus.CLAIM;
    this.provenance = options.provenance || {};
    this.extraction_run_id = options.extraction_run_id;
    this.extraction_profile_id = options.extraction_profile_id;
  }

  validate() {
    const required = ['tenant_id', 'workspace_id', 'source_type', 'source_id'];
    for (const field of required) {
      if (!this[field]) {
        throw new Error(`GraphEvent missing required field: ${field}`);
      }
    }
    if (this.confidence < 0 || this.confidence > 1) {
      throw new Error('Confidence must be between 0 and 1');
    }
    return true;
  }

  toJSON() {
    return {
      event_id: this.event_id,
      event_type: this.event_type,
      tenant_id: this.tenant_id,
      workspace_id: this.workspace_id,
      ontology_version_id: this.ontology_version_id,
      source_type: this.source_type,
      source_id: this.source_id,
      ingested_at: this.ingested_at,
      observed_at: this.observed_at,
      confidence: this.confidence,
      claim_status: this.claim_status,
      provenance: this.provenance,
      extraction_run_id: this.extraction_run_id,
      extraction_profile_id: this.extraction_profile_id
    };
  }
}

/**
 * UpsertNode - Create or update a node (entity instance)
 */
class UpsertNodeEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.UPSERT_NODE });
    
    this.class_name = options.class_name;           // Ontology class
    this.canonical_id = options.canonical_id;       // Deterministic ID
    this.identity_keys = options.identity_keys || {}; // Keys used for resolution
    this.attributes = options.attributes || {};     // Node properties
    this.display_name = options.display_name;       // Human-readable name
    this.pii_attributes = options.pii_attributes || []; // List of PII attribute names
    this.status = options.status || 'active';       // active | archived | disputed
    this.source_doc_ids = options.source_doc_ids || []; // Multi-document evidence tracking
  }

  validate() {
    super.validate();
    if (!this.class_name) {
      throw new Error('UpsertNodeEvent requires class_name');
    }
    if (!this.canonical_id) {
      throw new Error('UpsertNodeEvent requires canonical_id');
    }
    return true;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      class_name: this.class_name,
      canonical_id: this.canonical_id,
      identity_keys: this.identity_keys,
      attributes: this.attributes,
      display_name: this.display_name,
      pii_attributes: this.pii_attributes,
      status: this.status,
      source_doc_ids: this.source_doc_ids
    };
  }
}

/**
 * UpsertEdge - Create or update a relationship
 */
class UpsertEdgeEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.UPSERT_EDGE });
    
    this.relationship_type = options.relationship_type;
    this.from_canonical_id = options.from_canonical_id;
    this.from_class = options.from_class;
    this.to_canonical_id = options.to_canonical_id;
    this.to_class = options.to_class;
    this.attributes = options.attributes || {};
    this.effective_from = options.effective_from || null;
    this.effective_to = options.effective_to || null;
    this.extracted_at = options.extracted_at || new Date().toISOString();
  }

  validate() {
    super.validate();
    if (!this.relationship_type) {
      throw new Error('UpsertEdgeEvent requires relationship_type');
    }
    if (!this.from_canonical_id || !this.to_canonical_id) {
      throw new Error('UpsertEdgeEvent requires from_canonical_id and to_canonical_id');
    }
    return true;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      relationship_type: this.relationship_type,
      from_canonical_id: this.from_canonical_id,
      from_class: this.from_class,
      to_canonical_id: this.to_canonical_id,
      to_class: this.to_class,
      attributes: this.attributes,
      effective_from: this.effective_from,
      effective_to: this.effective_to,
      extracted_at: this.extracted_at
    };
  }
}

/**
 * EvidenceLink - Link an entity/relationship to source evidence
 */
/**
 * EvidenceLink - Link an entity/relationship to source evidence
 * Creates first-class EvidenceChunk nodes with span-level granularity
 */
class EvidenceLinkEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.EVIDENCE_LINK });

    this.target_type = options.target_type;         // 'node' or 'assertion'
    this.target_canonical_id = options.target_canonical_id;
    this.assertion_id = options.assertion_id || null; // For linking to assertions
    this.chunk_id = options.chunk_id;
    this.document_id = options.document_id;
    this.char_start = options.char_start;
    this.char_end = options.char_end;
    this.span_start = options.span_start ?? options.char_start; // Alias for clarity
    this.span_end = options.span_end ?? options.char_end;
    this.page_number = options.page_number;
    this.quote = options.quote;                     // Extracted text snippet
    this.section_heading = options.section_heading;
    this.section_path = options.section_path || null;
    this.text_hash = options.text_hash || null;     // For dedup of identical evidence
    this.access_label = options.access_label || null; // Security scoping
    this.method = options.method || 'llm_extraction'; // How evidence was identified
  }

  toJSON() {
    return {
      ...super.toJSON(),
      target_type: this.target_type,
      target_canonical_id: this.target_canonical_id,
      assertion_id: this.assertion_id,
      chunk_id: this.chunk_id,
      document_id: this.document_id,
      char_start: this.char_start,
      char_end: this.char_end,
      span_start: this.span_start,
      span_end: this.span_end,
      page_number: this.page_number,
      quote: this.quote,
      section_heading: this.section_heading,
      section_path: this.section_path,
      text_hash: this.text_hash,
      access_label: this.access_label,
      method: this.method
    };
  }
}

/**
 * UpsertAssertion - Reification pattern for relationship evidence
 * Creates an intermediate Assertion node:
 *   (Subject)-[:ASSERTS]->(Assertion {predicate, confidence})-[:TARGET]->(Object)
 *   (Assertion)-[:EVIDENCED_BY]->(EvidenceChunk)
 * 
 * Deterministic assertion_id = hash(subject_iri + predicate + object_iri + chunk_id + span_start + span_end)
 */
class UpsertAssertionEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.UPSERT_ASSERTION });
    
    this.assertion_id = options.assertion_id;       // Deterministic hash key
    this.subject_canonical_id = options.subject_canonical_id;
    this.subject_class = options.subject_class;
    this.predicate = options.predicate;             // Relationship type
    this.object_canonical_id = options.object_canonical_id;
    this.object_class = options.object_class;
    this.chunk_id = options.chunk_id;
    this.document_id = options.document_id;
    this.span_start = options.span_start;
    this.span_end = options.span_end;
    this.quote = options.quote;
    this.method = options.method || 'llm_extraction';
    this.extracted_at = options.extracted_at || new Date().toISOString();
  }

  validate() {
    super.validate();
    if (!this.assertion_id) {
      throw new Error('UpsertAssertionEvent requires assertion_id');
    }
    if (!this.subject_canonical_id || !this.object_canonical_id) {
      throw new Error('UpsertAssertionEvent requires subject and object canonical IDs');
    }
    if (!this.predicate) {
      throw new Error('UpsertAssertionEvent requires predicate');
    }
    return true;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      assertion_id: this.assertion_id,
      subject_canonical_id: this.subject_canonical_id,
      subject_class: this.subject_class,
      predicate: this.predicate,
      object_canonical_id: this.object_canonical_id,
      object_class: this.object_class,
      chunk_id: this.chunk_id,
      document_id: this.document_id,
      span_start: this.span_start,
      span_end: this.span_end,
      quote: this.quote,
      method: this.method,
      extracted_at: this.extracted_at
    };
  }
}

/**
 * CandidateConcept - Unknown concept encountered during extraction
 * These are NOT auto-created in the ontology
 */
class CandidateConceptEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.CANDIDATE_CONCEPT });
    
    this.term = options.term;
    this.suggested_class = options.suggested_class;
    this.suggested_definition = options.suggested_definition;
    this.context = options.context;                 // Surrounding text
    this.frequency = options.frequency || 1;        // How often seen
    this.evidence_chunks = options.evidence_chunks || [];
  }

  toJSON() {
    return {
      ...super.toJSON(),
      term: this.term,
      suggested_class: this.suggested_class,
      suggested_definition: this.suggested_definition,
      context: this.context,
      frequency: this.frequency,
      evidence_chunks: this.evidence_chunks
    };
  }
}

/**
 * QuarantineRecord - Invalid extraction that failed validation
 */
class QuarantineRecordEvent extends GraphEvent {
  constructor(options) {
    super({ ...options, event_type: EventType.QUARANTINE_RECORD });
    
    this.original_event = options.original_event;   // The failed event
    this.failure_reason = options.failure_reason;
    this.validation_errors = options.validation_errors || [];
    this.recoverable = options.recoverable ?? true;
    this.suggested_fix = options.suggested_fix;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      original_event: this.original_event,
      failure_reason: this.failure_reason,
      validation_errors: this.validation_errors,
      recoverable: this.recoverable,
      suggested_fix: this.suggested_fix
    };
  }
}

/**
 * GraphEventBatch - Collection of events from a single extraction run
 */
class GraphEventBatch {
  constructor(options) {
    this.batch_id = uuidv4();
    this.extraction_run_id = options.extraction_run_id;
    this.tenant_id = options.tenant_id;
    this.workspace_id = options.workspace_id;
    this.ontology_version_id = options.ontology_version_id;
    this.source_type = options.source_type;
    this.source_id = options.source_id;
    this.created_at = new Date().toISOString();
    this.events = [];
    this.stats = {
      nodes: 0,
      edges: 0,
      assertions: 0,
      evidence_links: 0,
      candidate_concepts: 0,
      quarantined: 0
    };
  }

  addEvent(event) {
    event.validate();
    this.events.push(event);
    
    // Update stats
    switch (event.event_type) {
      case EventType.UPSERT_NODE:
        this.stats.nodes++;
        break;
      case EventType.UPSERT_EDGE:
        this.stats.edges++;
        break;
      case EventType.UPSERT_ASSERTION:
        this.stats.assertions++;
        break;
      case EventType.EVIDENCE_LINK:
        this.stats.evidence_links++;
        break;
      case EventType.CANDIDATE_CONCEPT:
        this.stats.candidate_concepts++;
        break;
      case EventType.QUARANTINE_RECORD:
        this.stats.quarantined++;
        break;
    }
  }

  toJSON() {
    return {
      batch_id: this.batch_id,
      extraction_run_id: this.extraction_run_id,
      tenant_id: this.tenant_id,
      workspace_id: this.workspace_id,
      ontology_version_id: this.ontology_version_id,
      source_type: this.source_type,
      source_id: this.source_id,
      created_at: this.created_at,
      events: this.events.map(e => e.toJSON()),
      stats: this.stats
    };
  }
}

module.exports = {
  ClaimStatus,
  SourceType,
  EventType,
  GraphEvent,
  UpsertNodeEvent,
  UpsertEdgeEvent,
  UpsertAssertionEvent,
  EvidenceLinkEvent,
  CandidateConceptEvent,
  QuarantineRecordEvent,
  GraphEventBatch
};
