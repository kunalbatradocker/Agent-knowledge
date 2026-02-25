/**
 * Extraction Service
 * Handles extraction from structured and unstructured sources
 * 
 * Key principles:
 * - ALL extractors emit GraphEvents (never write directly to graph DB)
 * - LLMs may PROPOSE, never ASSERT truth
 * - Every extracted relationship must have PROVENANCE
 * - Ontology mismatch must FAIL SAFELY, never force-map
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { client, connectRedis } = require('../config/redis');
const {
  ClaimStatus,
  SourceType,
  UpsertNodeEvent,
  UpsertEdgeEvent,
  UpsertAssertionEvent,
  EvidenceLinkEvent,
  CandidateConceptEvent,
  QuarantineRecordEvent,
  GraphEventBatch
} = require('../models/graphEvents');
const ontologyPackService = require('./ontologyPackService');
const llmService = require('./llmService');
const chunkingService = require('./chunkingService');
const pdfParser = require('./pdfParser');
const neo4jService = require('./neo4jService');
const { sanitizeDocumentText } = require('../utils/promptSanitizer');
const llmOutputValidator = require('./llmOutputValidator');

// Redis keys
const KEYS = {
  RUN: 'extraction:run:',
  RUNS_INDEX: 'extraction:runs:',
  EVENTS: 'extraction:events:',
  QUARANTINE: 'extraction:quarantine:'
};

// Extraction run states
const RunState = {
  PENDING: 'pending',
  CHUNKING: 'chunking',
  CLASSIFYING: 'classifying',
  EXTRACTING: 'extracting',
  VALIDATING: 'validating',
  RESOLVING: 'resolving',
  WRITING: 'writing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

class ExtractionService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }


  // ============================================================
  // EXTRACTION RUN MANAGEMENT
  // ============================================================

  /**
   * Create a new extraction run
   */
  async createRun(options) {
    await this.initialize();

    const run = {
      run_id: uuidv4(),
      tenant_id: options.tenant_id,
      workspace_id: options.workspace_id,
      source_type: options.source_type,
      source_id: options.source_id,
      document_id: options.document_id,
      ontology_version_id: options.ontology_version_id,
      extraction_profile_id: options.extraction_profile_id,
      state: RunState.PENDING,
      created_at: new Date().toISOString(),
      created_by: options.created_by,
      stats: {
        chunks_processed: 0,
        entities_extracted: 0,
        relationships_extracted: 0,
        evidence_links: 0,
        candidate_concepts: 0,
        quarantined: 0
      },
      errors: [],
      metadata: options.metadata || {}
    };

    await client.set(`${KEYS.RUN}${run.run_id}`, JSON.stringify(run));
    await client.sAdd(`${KEYS.RUNS_INDEX}${options.tenant_id}`, run.run_id);

    return run;
  }

  /**
   * Format XSD range to human-readable type
   */
  formatRange(range) {
    if (!range) return 'string';
    const typeMap = {
      'string': 'string', 'xsd:string': 'string',
      'integer': 'integer', 'xsd:integer': 'integer', 'int': 'integer',
      'decimal': 'decimal', 'xsd:decimal': 'decimal', 'float': 'decimal', 'xsd:float': 'decimal', 'double': 'decimal',
      'date': 'date', 'xsd:date': 'date',
      'dateTime': 'dateTime', 'xsd:dateTime': 'dateTime',
      'boolean': 'boolean', 'xsd:boolean': 'boolean',
      'anyURI': 'anyURI', 'xsd:anyURI': 'anyURI'
    };
    return typeMap[range] || typeMap[range.split(/[#/]/).pop()] || 'string';
  }

  /**
   * Validate a value against its expected data type
   */
  validateDataType(value, expectedType) {
    if (value === null || value === undefined) return { valid: true };
    const type = this.formatRange(expectedType);
    switch (type) {
      case 'integer':
        return { valid: Number.isInteger(Number(value)) || /^-?\d+$/.test(String(value)), expected: 'integer (whole number)' };
      case 'decimal':
        return { valid: !isNaN(parseFloat(value)), expected: 'decimal number' };
      case 'date':
        return { valid: /^\d{4}-\d{2}-\d{2}$/.test(String(value)), expected: 'date (YYYY-MM-DD)' };
      case 'dateTime':
        return { valid: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(value)), expected: 'dateTime (YYYY-MM-DDTHH:MM:SS)' };
      case 'boolean':
        return { valid: ['true', 'false', true, false].includes(value), expected: 'boolean (true/false)' };
      case 'anyURI':
        return { valid: /^https?:\/\//.test(String(value)), expected: 'URI (http://...)' };
      default:
        return { valid: true };
    }
  }

  /**
   * Update run state
   */
  async updateRunState(runId, state, updates = {}) {
    const runData = await client.get(`${KEYS.RUN}${runId}`);
    if (!runData) throw new Error(`Run not found: ${runId}`);

    const run = JSON.parse(runData);
    run.state = state;
    run.updated_at = new Date().toISOString();
    
    if (updates.stats) {
      run.stats = { ...run.stats, ...updates.stats };
    }
    if (updates.error) {
      run.errors.push({
        message: updates.error,
        timestamp: new Date().toISOString()
      });
    }
    if (state === RunState.COMPLETED) {
      run.completed_at = new Date().toISOString();
    }

    await client.set(`${KEYS.RUN}${runId}`, JSON.stringify(run));
    return run;
  }

  /**
   * Get run by ID
   */
  async getRun(runId) {
    await this.initialize();
    const data = await client.get(`${KEYS.RUN}${runId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * List runs for a tenant
   */
  async listRuns(tenantId, options = {}) {
    await this.initialize();
    const runIds = await client.sMembers(`${KEYS.RUNS_INDEX}${tenantId}`);
    const runs = [];

    for (const runId of runIds) {
      const run = await this.getRun(runId);
      if (!run) continue;
      if (options.state && run.state !== options.state) continue;
      if (options.document_id && run.document_id !== options.document_id) continue;
      runs.push(run);
    }

    return runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }


  // ============================================================
  // UNSTRUCTURED EXTRACTION PIPELINE
  // ============================================================

  /**
   * Process an unstructured document
   * Pipeline: Parse → Chunk → Classify → Extract → Validate → Resolve → Write
   */
  async processDocument(documentId, options = {}) {
    await this.initialize();

    const {
      tenant_id,
      workspace_id,
      ontology_version_id,
      extraction_profile_id,
      file_path,
      file_type,
      document_name
    } = options;

    // Create extraction run
    const run = await this.createRun({
      tenant_id,
      workspace_id,
      source_type: SourceType.UNSTRUCTURED,
      source_id: documentId,
      document_id: documentId,
      ontology_version_id,
      extraction_profile_id,
      created_by: options.created_by
    });

    try {
      // Get ontology version
      const ontologyVersion = ontology_version_id 
        ? await ontologyPackService.getVersion(ontology_version_id)
        : null;

      // Step 1: Parse + Chunk
      await this.updateRunState(run.run_id, RunState.CHUNKING);
      const chunks = await this.parseAndChunk(file_path, file_type, documentId, document_name);
      
      // Step 2: Document Classification
      await this.updateRunState(run.run_id, RunState.CLASSIFYING);
      const classification = await this.classifyDocument(chunks, ontologyVersion);
      
      // Step 3: Ontology-Constrained LLM Extraction
      await this.updateRunState(run.run_id, RunState.EXTRACTING);
      const eventBatch = new GraphEventBatch({
        extraction_run_id: run.run_id,
        tenant_id,
        workspace_id,
        ontology_version_id,
        source_type: SourceType.UNSTRUCTURED,
        source_id: documentId
      });

      for (const chunk of chunks) {
        const chunkEvents = await this.extractFromChunk(
          chunk,
          ontologyVersion,
          classification,
          {
            tenant_id,
            workspace_id,
            document_id: documentId,
            extraction_run_id: run.run_id,
            extraction_profile_id
          }
        );
        
        for (const event of chunkEvents) {
          eventBatch.addEvent(event);
        }
      }

      // Step 4: Validation
      await this.updateRunState(run.run_id, RunState.VALIDATING);
      const validatedBatch = await this.validateEvents(eventBatch, ontologyVersion);

      // Step 5: Entity Resolution (within batch + cross-document)
      await this.updateRunState(run.run_id, RunState.RESOLVING);
      const resolvedBatch = await this.resolveEntities(validatedBatch);

      // Step 6: Confidence Gating
      // >= 0.85: auto-publish (write to serving graph)
      // 0.65-0.85: write but mark as CLAIM for review
      // < 0.65: quarantine (don't write to serving graph)
      const publishBatch = new GraphEventBatch({
        extraction_run_id: run.run_id,
        tenant_id,
        workspace_id,
        ontology_version_id,
        source_type: SourceType.UNSTRUCTURED,
        source_id: documentId
      });

      let quarantinedCount = 0;
      for (const event of resolvedBatch.events) {
        if (event.confidence !== undefined && event.confidence < 0.65 && 
            (event.event_type === 'UpsertNode' || event.event_type === 'UpsertEdge' || event.event_type === 'UpsertAssertion')) {
          // Low confidence — quarantine
          const quarantineEvent = new QuarantineRecordEvent({
            tenant_id, workspace_id,
            source_type: SourceType.UNSTRUCTURED,
            source_id: documentId,
            extraction_run_id: run.run_id,
            original_event: event.toJSON(),
            failure_reason: 'low_confidence',
            validation_errors: [`Confidence ${event.confidence} below threshold 0.65`],
            recoverable: true,
            suggested_fix: 'Review and manually approve or reject',
            confidence: event.confidence
          });
          publishBatch.addEvent(quarantineEvent);
          quarantinedCount++;
        } else {
          // Auto-publish (>= 0.85) or review queue (0.65-0.85)
          if (event.confidence !== undefined && event.confidence >= 0.85) {
            event.claim_status = ClaimStatus.FACT;
          }
          publishBatch.addEvent(event);
        }
      }

      // Step 7: Write to Graph
      await this.updateRunState(run.run_id, RunState.WRITING);
      await this.writeEventsToGraph(publishBatch);

      // Store events for audit
      await this.storeEventBatch(publishBatch);

      // Complete
      await this.updateRunState(run.run_id, RunState.COMPLETED, {
        stats: { ...publishBatch.stats, quarantined_by_confidence: quarantinedCount }
      });

      return {
        run_id: run.run_id,
        status: 'completed',
        stats: { ...publishBatch.stats, quarantined_by_confidence: quarantinedCount }
      };

    } catch (error) {
      await this.updateRunState(run.run_id, RunState.FAILED, {
        error: error.message
      });
      throw error;
    }
  }


  /**
   * Step 1: Parse and chunk document
   */
  async parseAndChunk(filePath, fileType, documentId, documentName) {
    let text = '';
    let numPages = 1;
    let pageBreaks = [];
    let pageTexts = [];

    if (fileType === 'pdf') {
      const pdfData = await pdfParser.extractText(filePath);
      text = pdfData.text;
      numPages = pdfData.numPages || 1;
      pageBreaks = pdfData.pageBreaks || [];
      pageTexts = pdfData.pageTexts || [];
    } else {
      const fs = require('fs');
      text = fs.readFileSync(filePath, 'utf-8');
    }

    // Chunk the document
    const chunkResult = chunkingService.chunkDocumentWithMethod(text, {
      id: documentId,
      name: documentName,
      doc_type: fileType,
      chunkingMethod: 'semantic',
      numPages,
      pageBreaks,
      pageTexts
    });

    // Add stable IDs and metadata to chunks
    return chunkResult.chunks.map((chunk, index) => ({
      chunk_id: `${documentId}_chunk_${index}`,
      doc_id: documentId,
      text: chunk.text,
      order: index,
      page_start: chunk.metadata?.startPage || chunk.start_page || Math.floor(index / 2) + 1,
      page_end: chunk.metadata?.endPage || chunk.end_page || Math.floor(index / 2) + 1,
      section_heading: chunk.metadata?.heading || null,
      char_start: chunk.startChar || 0,
      char_end: chunk.endChar || chunk.text.length
    }));
  }

  /**
   * Step 2: Classify document to determine applicable ontology
   */
  async classifyDocument(chunks, ontologyVersion) {
    // Sample first few chunks for classification
    const sampleText = chunks.slice(0, 3).map(c => c.text).join('\n\n');

    const prompt = `Analyze this document and determine:
1. Document type (e.g., contract, report, form, correspondence)
2. Industry domain (e.g., banking, insurance, legal, healthcare)
3. Key topics covered
4. Confidence score (0-1)

Document sample:
${sanitizeDocumentText(sampleText, 2000)}

Respond in JSON format:
{
  "document_type": "string",
  "industry": "string",
  "topics": ["string"],
  "confidence": 0.0
}`;

    try {
      const response = await llmService.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 500
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const classification = JSON.parse(jsonMatch[0]);
        
        // Determine applicable ontology slice
        let applicableSlice = null;
        if (ontologyVersion) {
          applicableSlice = ontologyVersion.slices.find(s => 
            s.document_types.includes(classification.document_type) ||
            s.use_case === classification.industry
          );
        }

        return {
          ...classification,
          applicable_slice: applicableSlice,
          ontology_version_id: ontologyVersion?.version_id
        };
      }
    } catch (error) {
      console.warn('Document classification failed:', error.message);
    }

    return {
      document_type: 'unknown',
      industry: 'general',
      topics: [],
      confidence: 0.5,
      applicable_slice: null
    };
  }


  /**
   * Step 3: Extract entities and relationships from a chunk
   * Uses ontology-constrained extraction with property types and cardinality
   */
  async extractFromChunk(chunk, ontologyVersion, classification, context) {
      const events = [];

      // Build extraction prompt based on ontology
      let allowedClasses = [];
      let allowedRelationships = [];
      let dataProperties = [];

      if (ontologyVersion) {
        if (classification.applicable_slice) {
          allowedClasses = classification.applicable_slice.included_classes
            .map(name => ontologyVersion.getClass(name))
            .filter(Boolean);
          allowedRelationships = classification.applicable_slice.included_relationships
            .map(type => ontologyVersion.getRelationship(type))
            .filter(Boolean);
        } else {
          allowedClasses = ontologyVersion.classes || [];
          allowedRelationships = ontologyVersion.relationships || [];
          dataProperties = ontologyVersion.dataProperties || ontologyVersion.properties?.filter(p => p.type === 'datatypeProperty') || [];
        }
      }

      const classDescriptions = allowedClasses.map(c => {
        const classProps = dataProperties.filter(p => p.domain === c.name || p.domain === c.localName);
        const propsDesc = classProps.length > 0 
          ? `\n    Properties: ${classProps.map(p => `${p.localName || p.name}(${this.formatRange(p.range)})`).join(', ')}`
          : '';
        return `- ${c.name || c.localName}: ${c.description || c.comment || 'No description'}${propsDesc}`;
      }).join('\n');

      const relDescriptions = allowedRelationships.map(r => {
        const domain = r.from_class || r.domain || 'Any';
        const range = r.to_class || r.range || 'Any';
        return `- ${r.type || r.localName}: ${domain} → ${range}${r.description ? `. ${r.description}` : ''}`;
      }).join('\n');

      const propDescriptions = dataProperties.map(p => 
        `- ${p.localName || p.name}: domain=${p.domain || 'Any'}, type=${this.formatRange(p.range)}, cardinality=${p.cardinality || '0..*'}`
      ).join('\n');

      const prompt = `Extract entities and relationships from this text using the ontology schema below.

  ENTITY CLASSES:
  ${classDescriptions || 'Any entity type'}

  RELATIONSHIPS (Object Properties):
  ${relDescriptions || 'Any relationship type'}

  DATA PROPERTIES (with types):
  ${propDescriptions || 'Any attributes'}

  DATA TYPE FORMATS:
  - string: Plain text
  - date: ISO format YYYY-MM-DD
  - dateTime: ISO format YYYY-MM-DDTHH:MM:SS
  - integer: Whole numbers only
  - decimal/float: Numbers with decimals
  - boolean: true/false
  - anyURI: Valid URL

  RULES:
  1. Only extract entities of the allowed classes
  2. Only use relationships where domain/range match the entity classes
  3. Format attribute values according to their data types
  4. Include evidence (exact quote) for each extraction
  5. Mark unknown concepts as "candidate_concept"
  6. Assign confidence scores (0-1)
  7. Never hallucinate - only extract what's explicitly stated

  TEXT:
  ${sanitizeDocumentText(chunk.text, 10000)}

  Respond in JSON:
  {
    "entities": [{"class": "ClassName", "name": "entity name", "attributes": {"propName": "typed value"}, "evidence": "quote", "confidence": 0.9}],
    "relationships": [{"type": "REL_TYPE", "from_entity": "name", "from_class": "Class", "to_entity": "name", "to_class": "Class", "evidence": "quote", "confidence": 0.8}],
    "candidate_concepts": [{"term": "unknown", "suggested_class": "Class", "context": "text"}]
  }`;

      try {
        const response = await llmService.generateCompletion(prompt, {
          temperature: 0.1,
          max_tokens: 2000
        });

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return events;

        const extraction = JSON.parse(jsonMatch[0]);

        // Validate extraction output against ontology
        const validated = llmOutputValidator.validateEntityExtraction(extraction, { classes: allowedClasses });
        if (validated.warnings.length > 0) {
          console.warn(`Extraction validation: ${validated.warnings.length} warnings for chunk ${chunk.chunk_id}`);
        }

        // Process entities
        for (const entity of (validated.cleaned.entities || [])) {
          const canonicalId = this.generateCanonicalId(entity.class, entity.name, entity.attributes);

          const nodeEvent = new UpsertNodeEvent({
            tenant_id: context.tenant_id,
            workspace_id: context.workspace_id,
            ontology_version_id: context.ontology_version_id,
            source_type: SourceType.UNSTRUCTURED,
            source_id: context.document_id,
            extraction_run_id: context.extraction_run_id,
            extraction_profile_id: context.extraction_profile_id,
            class_name: entity.class,
            canonical_id: canonicalId,
            identity_keys: entity.attributes,
            attributes: entity.attributes,
            display_name: entity.name,
            confidence: entity.confidence || 0.7,
            claim_status: ClaimStatus.CLAIM,
            status: 'active',
            source_doc_ids: [context.document_id],
            provenance: {
              chunk_id: chunk.chunk_id,
              evidence: entity.evidence
            }
          });
          events.push(nodeEvent);

          // Create evidence link with span-level detail
          if (entity.evidence) {
            const textHash = crypto.createHash('sha256')
              .update(entity.evidence).digest('hex').slice(0, 16);

            const evidenceEvent = new EvidenceLinkEvent({
              tenant_id: context.tenant_id,
              workspace_id: context.workspace_id,
              ontology_version_id: context.ontology_version_id,
              source_type: SourceType.UNSTRUCTURED,
              source_id: context.document_id,
              extraction_run_id: context.extraction_run_id,
              target_type: 'node',
              target_canonical_id: canonicalId,
              chunk_id: chunk.chunk_id,
              document_id: context.document_id,
              span_start: chunk.startChar || 0,
              span_end: chunk.endChar || 0,
              page_number: chunk.start_page || chunk.metadata?.startPage || null,
              section_path: chunk.heading_path || chunk.section_title || null,
              quote: entity.evidence,
              text_hash: textHash,
              confidence: entity.confidence || 0.7,
              method: 'llm_extraction'
            });
            events.push(evidenceEvent);
          }
        }

        // Process relationships — create both edge AND assertion for reification
        for (const rel of (validated.cleaned.relationships || [])) {
          const fromId = this.generateCanonicalId(rel.from_class, rel.from_entity, {});
          const toId = this.generateCanonicalId(rel.to_class, rel.to_entity, {});

          // Direct edge (for fast traversal in Neo4j)
          const edgeEvent = new UpsertEdgeEvent({
            tenant_id: context.tenant_id,
            workspace_id: context.workspace_id,
            ontology_version_id: context.ontology_version_id,
            source_type: SourceType.UNSTRUCTURED,
            source_id: context.document_id,
            extraction_run_id: context.extraction_run_id,
            extraction_profile_id: context.extraction_profile_id,
            relationship_type: rel.type,
            from_canonical_id: fromId,
            to_canonical_id: toId,
            from_class: rel.from_class,
            to_class: rel.to_class,
            confidence: rel.confidence || 0.7,
            claim_status: ClaimStatus.CLAIM,
            extracted_at: new Date().toISOString(),
            provenance: {
              chunk_id: chunk.chunk_id,
              evidence: rel.evidence
            }
          });
          events.push(edgeEvent);

          // Assertion node (reification — attaches evidence to the relationship)
          const assertionId = this.generateAssertionId(
            fromId, rel.type, toId,
            chunk.chunk_id, chunk.startChar, chunk.endChar
          );

          const assertionEvent = new UpsertAssertionEvent({
            tenant_id: context.tenant_id,
            workspace_id: context.workspace_id,
            ontology_version_id: context.ontology_version_id,
            source_type: SourceType.UNSTRUCTURED,
            source_id: context.document_id,
            extraction_run_id: context.extraction_run_id,
            assertion_id: assertionId,
            subject_canonical_id: fromId,
            subject_class: rel.from_class,
            predicate: rel.type,
            object_canonical_id: toId,
            object_class: rel.to_class,
            chunk_id: chunk.chunk_id,
            document_id: context.document_id,
            span_start: chunk.startChar || 0,
            span_end: chunk.endChar || 0,
            quote: rel.evidence,
            confidence: rel.confidence || 0.7,
            claim_status: ClaimStatus.CLAIM,
            method: 'llm_extraction'
          });
          events.push(assertionEvent);

          // Evidence link for the assertion
          if (rel.evidence) {
            const textHash = crypto.createHash('sha256')
              .update(rel.evidence).digest('hex').slice(0, 16);

            const evidenceEvent = new EvidenceLinkEvent({
              tenant_id: context.tenant_id,
              workspace_id: context.workspace_id,
              ontology_version_id: context.ontology_version_id,
              source_type: SourceType.UNSTRUCTURED,
              source_id: context.document_id,
              extraction_run_id: context.extraction_run_id,
              target_type: 'assertion',
              target_canonical_id: assertionId,
              assertion_id: assertionId,
              chunk_id: chunk.chunk_id,
              document_id: context.document_id,
              span_start: chunk.startChar || 0,
              span_end: chunk.endChar || 0,
              page_number: chunk.start_page || chunk.metadata?.startPage || null,
              section_path: chunk.heading_path || chunk.section_title || null,
              quote: rel.evidence,
              text_hash: textHash,
              confidence: rel.confidence || 0.7,
              method: 'llm_extraction'
            });
            events.push(evidenceEvent);
          }
        }

        // Process candidate concepts
        for (const candidate of (validated.cleaned.candidate_concepts || [])) {
          const candidateEvent = new CandidateConceptEvent({
            tenant_id: context.tenant_id,
            workspace_id: context.workspace_id,
            ontology_version_id: context.ontology_version_id,
            source_type: SourceType.UNSTRUCTURED,
            source_id: context.document_id,
            extraction_run_id: context.extraction_run_id,
            term: candidate.term,
            suggested_class: candidate.suggested_class,
            suggested_definition: candidate.definition,
            context: candidate.context,
            evidence_chunks: [chunk.chunk_id]
          });
          events.push(candidateEvent);
        }

      } catch (error) {
        console.error('Extraction failed for chunk:', chunk.chunk_id, error.message);
      }

      return events;
    }


  /**
   * Step 4: Validate events against ontology
   */
  async validateEvents(eventBatch, ontologyVersion) {
    const validatedBatch = new GraphEventBatch({
      ...eventBatch,
      batch_id: eventBatch.batch_id
    });

    for (const event of eventBatch.events) {
      try {
        const validationResult = await this.validateEvent(event, ontologyVersion);
        
        if (validationResult.valid) {
          validatedBatch.addEvent(event);
        } else if (validationResult.recoverable) {
          // Downgrade to CLAIM if validation fails but recoverable
          event.claim_status = ClaimStatus.CLAIM;
          event.confidence = Math.min(event.confidence, 0.5);
          validatedBatch.addEvent(event);
        } else {
          // Quarantine invalid events
          const quarantineEvent = new QuarantineRecordEvent({
            tenant_id: event.tenant_id,
            workspace_id: event.workspace_id,
            ontology_version_id: event.ontology_version_id,
            source_type: event.source_type,
            source_id: event.source_id,
            extraction_run_id: event.extraction_run_id,
            original_event: event.toJSON(),
            failure_reason: validationResult.reason,
            validation_errors: validationResult.errors,
            recoverable: false
          });
          validatedBatch.addEvent(quarantineEvent);
        }
      } catch (error) {
        console.error('Validation error:', error.message);
      }
    }

    return validatedBatch;
  }

  /**
   * Validate a single event against ontology constraints
   */
  async validateEvent(event, ontologyVersion) {
    const errors = [];

    if (event.event_type === 'UpsertNode') {
      if (ontologyVersion) {
        // Check class exists
        const classes = ontologyVersion.classes || [];
        const classDef = classes.find(c => c.name === event.class_name || c.localName === event.class_name);
        if (!classDef) {
          errors.push(`Class not found: ${event.class_name}`);
        } else {
          // Validate attribute data types
          const dataProps = ontologyVersion.dataProperties || ontologyVersion.properties?.filter(p => p.type === 'datatypeProperty') || [];
          for (const [attrName, attrValue] of Object.entries(event.attributes || {})) {
            const propDef = dataProps.find(p => (p.localName === attrName || p.name === attrName) && 
              (p.domain === event.class_name || p.domain === classDef.localName || !p.domain));
            if (propDef && propDef.range) {
              const typeCheck = this.validateDataType(attrValue, propDef.range);
              if (!typeCheck.valid) {
                errors.push(`${attrName}: expected ${typeCheck.expected}, got "${attrValue}"`);
              }
            }
          }

          // Check identity keys if defined
          if (classDef.identity_keys) {
            for (const key of classDef.identity_keys) {
              if (!event.identity_keys?.[key] && !event.attributes?.[key]) {
                errors.push(`Missing identity key: ${key}`);
              }
            }
          }
        }
      }
    }

    if (event.event_type === 'UpsertEdge') {
      if (ontologyVersion) {
        const relationships = ontologyVersion.relationships || ontologyVersion.properties?.filter(p => p.type === 'objectProperty') || [];
        const relDef = relationships.find(r => r.type === event.relationship_type || r.localName === event.relationship_type);
        
        if (!relDef) {
          errors.push(`Relationship not found: ${event.relationship_type}`);
        } else {
          // Validate domain/range constraints
          const domain = relDef.from_class || relDef.domain;
          const range = relDef.to_class || relDef.range;
          
          if (domain && event.from_class && domain !== event.from_class) {
            errors.push(`${event.relationship_type} domain mismatch: expected ${domain}, got ${event.from_class}`);
          }
          if (range && event.to_class && range !== event.to_class) {
            errors.push(`${event.relationship_type} range mismatch: expected ${range}, got ${event.to_class}`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      reason: errors.join('; '),
      recoverable: errors.length > 0 && !errors.some(e => e.includes('not found'))
    };
  }

  /**
   * Step 5: Entity Resolution (MVP - deterministic only)
   */
  async resolveEntities(eventBatch) {
      const entityMap = new Map(); // canonical_id -> merged entity

      // Phase 1: Deduplicate within the batch
      for (const event of eventBatch.events) {
        if (event.event_type !== 'UpsertNode') continue;

        const existing = entityMap.get(event.canonical_id);
        if (existing) {
          // Merge: keep higher confidence, merge source_doc_ids
          if (event.confidence > existing.confidence) {
            const mergedDocIds = [...new Set([...(existing.source_doc_ids || []), ...(event.source_doc_ids || [])])];
            event.source_doc_ids = mergedDocIds;
            entityMap.set(event.canonical_id, event);
          } else {
            existing.source_doc_ids = [...new Set([...(existing.source_doc_ids || []), ...(event.source_doc_ids || [])])];
          }
        } else {
          entityMap.set(event.canonical_id, event);
        }
      }

      // Phase 2: Cross-document resolution — check Neo4j for existing entities with similar names
      const session = neo4jService.getSession();
      try {
        for (const [canonicalId, event] of entityMap) {
          if (!event.display_name) continue;

          // Check if an entity with the same name but different canonical_id exists
          const result = await session.run(`
            MATCH (n)
            WHERE n.display_name = $name
              AND n.tenant_id = $tenantId
              AND n.workspace_id = $workspaceId
              AND n.canonical_id <> $canonicalId
              AND $className IN labels(n)
            RETURN n.canonical_id AS existingId, n.confidence AS existingConfidence
            LIMIT 1
          `, {
            name: event.display_name,
            tenantId: event.tenant_id,
            workspaceId: event.workspace_id,
            canonicalId: canonicalId,
            className: event.class_name
          });

          if (result.records.length > 0) {
            // Found existing entity — rewrite canonical_id to merge
            const existingId = result.records[0].get('existingId');
            event.canonical_id = existingId;
            event.concept_id = existingId;

            // Also update any edges/assertions/evidence that reference the old ID
            for (const otherEvent of eventBatch.events) {
              if (otherEvent.from_canonical_id === canonicalId) {
                otherEvent.from_canonical_id = existingId;
              }
              if (otherEvent.to_canonical_id === canonicalId) {
                otherEvent.to_canonical_id = existingId;
              }
              if (otherEvent.target_canonical_id === canonicalId) {
                otherEvent.target_canonical_id = existingId;
              }
              if (otherEvent.subject_canonical_id === canonicalId) {
                otherEvent.subject_canonical_id = existingId;
              }
              if (otherEvent.object_canonical_id === canonicalId) {
                otherEvent.object_canonical_id = existingId;
              }
            }
          }
        }
      } catch (error) {
        // Cross-doc resolution is best-effort — don't fail the pipeline
        console.warn('Cross-document entity resolution failed:', error.message);
      } finally {
        await session.close();
      }

      // Rebuild batch with resolved entities
      const resolvedBatch = new GraphEventBatch({
        ...eventBatch,
        batch_id: eventBatch.batch_id
      });

      // Re-deduplicate after cross-doc resolution (canonical IDs may have changed)
      const finalEntityMap = new Map();
      for (const event of entityMap.values()) {
        const existing = finalEntityMap.get(event.canonical_id);
        if (existing) {
          if (event.confidence > existing.confidence) {
            event.source_doc_ids = [...new Set([...(existing.source_doc_ids || []), ...(event.source_doc_ids || [])])];
            finalEntityMap.set(event.canonical_id, event);
          }
        } else {
          finalEntityMap.set(event.canonical_id, event);
        }
      }

      for (const event of finalEntityMap.values()) {
        resolvedBatch.addEvent(event);
      }

      // Add non-node events
      for (const event of eventBatch.events) {
        if (event.event_type !== 'UpsertNode') {
          resolvedBatch.addEvent(event);
        }
      }

      return resolvedBatch;
    }


  /**
   * Step 6: Write events to graph database
   */
  async writeEventsToGraph(eventBatch) {
      const session = neo4jService.getSession();

      try {
        for (const event of eventBatch.events) {
          switch (event.event_type) {
            case 'UpsertNode':
              await this.writeNodeToGraph(session, event);
              break;
            case 'UpsertEdge':
              await this.writeEdgeToGraph(session, event);
              break;
            case 'UpsertAssertion':
              await this.writeAssertionToGraph(session, event);
              break;
            case 'EvidenceLink':
              await this.writeEvidenceLinkToGraph(session, event);
              break;
            case 'CandidateConcept':
              await ontologyPackService.storeCandidateConcept({
                tenant_id: event.tenant_id,
                workspace_id: event.workspace_id,
                term: event.term,
                suggested_class: event.suggested_class,
                suggested_definition: event.suggested_definition,
                frequency: event.frequency,
                evidence: event.evidence_chunks
              });
              break;
            case 'QuarantineRecord':
              await this.storeQuarantineRecord(event);
              break;
          }
        }
      } finally {
        await session.close();
      }
    }

  /**
   * Write a node to Neo4j
   */
  async writeNodeToGraph(session, event) {
      const query = `
        MERGE (n:${event.class_name} {canonical_id: $canonical_id})
        ON CREATE SET
          n.concept_id = $canonical_id,
          n.tenant_id = $tenant_id,
          n.workspace_id = $workspace_id,
          n.created_at = datetime(),
          n.claim_status = $claim_status,
          n.confidence = $confidence,
          n.source_type = $source_type,
          n.source_id = $source_id,
          n.extraction_run_id = $extraction_run_id,
          n.status = $status,
          n.source_doc_ids = $source_doc_ids
        ON MATCH SET
          n.updated_at = datetime(),
          n.confidence = CASE WHEN $confidence > n.confidence THEN $confidence ELSE n.confidence END,
          n.source_doc_ids = CASE 
            WHEN n.source_doc_ids IS NULL THEN $source_doc_ids
            ELSE [x IN n.source_doc_ids WHERE NOT x IN $source_doc_ids] + $source_doc_ids
          END
        SET n += $attributes
        SET n.display_name = $display_name
        RETURN n
      `;

      await session.run(query, {
        canonical_id: event.canonical_id,
        tenant_id: event.tenant_id,
        workspace_id: event.workspace_id,
        claim_status: event.claim_status,
        confidence: event.confidence,
        source_type: event.source_type,
        source_id: event.source_id,
        extraction_run_id: event.extraction_run_id,
        attributes: event.attributes,
        display_name: event.display_name,
        status: event.status || 'active',
        source_doc_ids: event.source_doc_ids || []
      });
    }

  /**
   * Write an edge to Neo4j
   */
  async writeEdgeToGraph(session, event) {
      const query = `
        MATCH (from {canonical_id: $from_id, tenant_id: $tenant_id})
        MATCH (to {canonical_id: $to_id, tenant_id: $tenant_id})
        MERGE (from)-[r:${event.relationship_type}]->(to)
        ON CREATE SET
          r.created_at = datetime(),
          r.claim_status = $claim_status,
          r.confidence = $confidence,
          r.source_id = $source_id,
          r.extraction_run_id = $extraction_run_id,
          r.extracted_at = $extracted_at
        ON MATCH SET
          r.updated_at = datetime(),
          r.confidence = CASE WHEN $confidence > r.confidence THEN $confidence ELSE r.confidence END
        SET r += $attributes
        RETURN r
      `;

      await session.run(query, {
        from_id: event.from_canonical_id,
        to_id: event.to_canonical_id,
        tenant_id: event.tenant_id,
        claim_status: event.claim_status,
        confidence: event.confidence,
        source_id: event.source_id,
        extraction_run_id: event.extraction_run_id,
        extracted_at: event.extracted_at || new Date().toISOString(),
        attributes: event.attributes || {}
      });
    }

  /**
   * Write assertion node to Neo4j (reification pattern)
   * (Subject)-[:ASSERTS]->(Assertion)-[:TARGET]->(Object)
   */
  async writeAssertionToGraph(session, event) {
    const query = `
      MATCH (subject {canonical_id: $subject_id, tenant_id: $tenant_id})
      MATCH (object {canonical_id: $object_id, tenant_id: $tenant_id})
      MERGE (a:Assertion {assertion_id: $assertion_id})
      ON CREATE SET
        a.predicate = $predicate,
        a.confidence = $confidence,
        a.claim_status = $claim_status,
        a.tenant_id = $tenant_id,
        a.workspace_id = $workspace_id,
        a.source_id = $source_id,
        a.extraction_run_id = $extraction_run_id,
        a.chunk_id = $chunk_id,
        a.document_id = $document_id,
        a.span_start = $span_start,
        a.span_end = $span_end,
        a.quote = $quote,
        a.method = $method,
        a.extracted_at = $extracted_at,
        a.created_at = datetime()
      ON MATCH SET
        a.confidence = CASE WHEN $confidence > a.confidence THEN $confidence ELSE a.confidence END,
        a.updated_at = datetime()
      MERGE (subject)-[:ASSERTS]->(a)
      MERGE (a)-[:TARGET]->(object)
      RETURN a
    `;

    try {
      await session.run(query, {
        assertion_id: event.assertion_id,
        subject_id: event.subject_canonical_id,
        object_id: event.object_canonical_id,
        predicate: event.predicate,
        confidence: event.confidence,
        claim_status: event.claim_status,
        tenant_id: event.tenant_id,
        workspace_id: event.workspace_id,
        source_id: event.source_id,
        extraction_run_id: event.extraction_run_id,
        chunk_id: event.chunk_id || null,
        document_id: event.document_id || null,
        span_start: event.span_start || 0,
        span_end: event.span_end || 0,
        quote: event.quote || '',
        method: event.method || 'llm_extraction',
        extracted_at: event.extracted_at || new Date().toISOString()
      });
    } catch (error) {
      console.warn('Could not create assertion:', error.message);
    }
  }

  /**
   * Write evidence link to Neo4j
   */
  async writeEvidenceLinkToGraph(session, event) {
      if (event.target_type === 'assertion') {
        // Link assertion to EvidenceChunk
        const query = `
          MATCH (a:Assertion {assertion_id: $assertion_id, tenant_id: $tenant_id})
          MERGE (ec:EvidenceChunk {chunk_id: $chunk_id, text_hash: $text_hash})
          ON CREATE SET
            ec.doc_id = $document_id,
            ec.page = $page_number,
            ec.section_path = $section_path,
            ec.span_start = $span_start,
            ec.span_end = $span_end,
            ec.quote = $quote,
            ec.access_label = $access_label,
            ec.tenant_id = $tenant_id,
            ec.workspace_id = $workspace_id,
            ec.created_at = datetime()
          MERGE (a)-[r:EVIDENCED_BY]->(ec)
          SET r.method = $method,
              r.confidence = $confidence,
              r.created_at = datetime()
          RETURN r
        `;

        try {
          await session.run(query, {
            assertion_id: event.assertion_id,
            tenant_id: event.tenant_id,
            workspace_id: event.workspace_id,
            chunk_id: event.chunk_id,
            document_id: event.document_id,
            page_number: event.page_number || null,
            section_path: event.section_path || null,
            span_start: event.span_start || 0,
            span_end: event.span_end || 0,
            quote: event.quote || '',
            text_hash: event.text_hash || event.chunk_id,
            access_label: event.access_label || null,
            method: event.method || 'llm_extraction',
            confidence: event.confidence
          });
        } catch (error) {
          console.warn('Could not create assertion evidence link:', error.message);
        }
      } else {
        // Link entity node to EvidenceChunk
        const query = `
          MATCH (entity {canonical_id: $target_id, tenant_id: $tenant_id})
          MERGE (ec:EvidenceChunk {chunk_id: $chunk_id, text_hash: $text_hash})
          ON CREATE SET
            ec.doc_id = $document_id,
            ec.page = $page_number,
            ec.section_path = $section_path,
            ec.span_start = $span_start,
            ec.span_end = $span_end,
            ec.quote = $quote,
            ec.access_label = $access_label,
            ec.tenant_id = $tenant_id,
            ec.workspace_id = $workspace_id,
            ec.created_at = datetime()
          MERGE (entity)-[r:EVIDENCED_BY]->(ec)
          SET r.method = $method,
              r.confidence = $confidence,
              r.created_at = datetime()
          RETURN r
        `;

        try {
          await session.run(query, {
            target_id: event.target_canonical_id,
            tenant_id: event.tenant_id,
            workspace_id: event.workspace_id,
            chunk_id: event.chunk_id,
            document_id: event.document_id,
            page_number: event.page_number || null,
            section_path: event.section_path || null,
            span_start: event.span_start || 0,
            span_end: event.span_end || 0,
            quote: event.quote || '',
            text_hash: event.text_hash || event.chunk_id,
            access_label: event.access_label || null,
            method: event.method || 'llm_extraction',
            confidence: event.confidence
          });
        } catch (error) {
          console.warn('Could not create entity evidence link:', error.message);
        }
      }
    }

  /**
   * Store quarantine record
   */
  async storeQuarantineRecord(event) {
    await client.lPush(
      `${KEYS.QUARANTINE}${event.tenant_id}`,
      JSON.stringify(event.toJSON())
    );
  }

  /**
   * Store event batch for audit
   */
  async storeEventBatch(eventBatch) {
    await client.set(
      `${KEYS.EVENTS}${eventBatch.batch_id}`,
      JSON.stringify(eventBatch.toJSON()),
      { EX: 86400 * 30 } // 30 days retention
    );
  }


  // ============================================================
  // STRUCTURED EXTRACTION (Postgres MVP)
  // ============================================================

  /**
   * Process structured data source with mapping spec
   */
  async processStructuredSource(datasourceId, mappingSpec, options = {}) {
    await this.initialize();

    const {
      tenant_id,
      workspace_id,
      ontology_version_id
    } = options;

    // Create extraction run
    const run = await this.createRun({
      tenant_id,
      workspace_id,
      source_type: SourceType.STRUCTURED,
      source_id: datasourceId,
      ontology_version_id,
      created_by: options.created_by,
      metadata: { mapping_spec: mappingSpec }
    });

    try {
      // Validate mapping spec against ontology
      await this.updateRunState(run.run_id, RunState.VALIDATING);
      const ontologyVersion = ontology_version_id
        ? await ontologyPackService.getVersion(ontology_version_id)
        : null;

      if (ontologyVersion) {
        this.validateMappingSpec(mappingSpec, ontologyVersion);
      }

      // Create event batch
      const eventBatch = new GraphEventBatch({
        extraction_run_id: run.run_id,
        tenant_id,
        workspace_id,
        ontology_version_id,
        source_type: SourceType.STRUCTURED,
        source_id: datasourceId
      });

      // Process each table mapping
      await this.updateRunState(run.run_id, RunState.EXTRACTING);
      
      for (const tableMapping of mappingSpec.tables) {
        const events = await this.processTableMapping(
          tableMapping,
          {
            tenant_id,
            workspace_id,
            datasource_id: datasourceId,
            extraction_run_id: run.run_id,
            ontology_version_id
          }
        );

        for (const event of events) {
          eventBatch.addEvent(event);
        }
      }

      // Write to graph
      await this.updateRunState(run.run_id, RunState.WRITING);
      await this.writeEventsToGraph(eventBatch);

      // Store events
      await this.storeEventBatch(eventBatch);

      // Complete
      await this.updateRunState(run.run_id, RunState.COMPLETED, {
        stats: eventBatch.stats
      });

      return {
        run_id: run.run_id,
        status: 'completed',
        stats: eventBatch.stats
      };

    } catch (error) {
      await this.updateRunState(run.run_id, RunState.FAILED, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate mapping spec against ontology
   */
  validateMappingSpec(mappingSpec, ontologyVersion) {
    for (const tableMapping of mappingSpec.tables) {
      // Check class exists
      const classDef = ontologyVersion.getClass(tableMapping.target_class);
      if (!classDef) {
        throw new Error(`Mapping references unknown class: ${tableMapping.target_class}`);
      }

      // Check attribute mappings
      for (const attrMapping of tableMapping.attributes) {
        if (attrMapping.target_attribute !== '_ignore') {
          const attr = classDef.getAttribute(attrMapping.target_attribute);
          if (!attr) {
            throw new Error(
              `Mapping references unknown attribute: ${tableMapping.target_class}.${attrMapping.target_attribute}`
            );
          }
        }
      }
    }

    // Check relationship mappings
    for (const relMapping of (mappingSpec.relationships || [])) {
      const relDef = ontologyVersion.getRelationship(relMapping.relationship_type);
      if (!relDef) {
        throw new Error(`Mapping references unknown relationship: ${relMapping.relationship_type}`);
      }
    }
  }

  /**
   * Process a single table mapping
   * Note: This is a simplified version - real implementation would connect to actual database
   */
  async processTableMapping(tableMapping, context) {
    const events = [];

    // In a real implementation, this would:
    // 1. Connect to the database
    // 2. Execute incremental query based on watermark
    // 3. Transform rows to events

    // For now, we'll create a placeholder that shows the structure
    console.log(`Processing table mapping: ${tableMapping.source_table} → ${tableMapping.target_class}`);

    // Example of how events would be created from rows:
    // for (const row of rows) {
    //   const canonicalId = this.buildCanonicalIdFromMapping(row, tableMapping);
    //   const attributes = this.transformAttributes(row, tableMapping.attributes);
    //   
    //   const nodeEvent = new UpsertNodeEvent({
    //     ...context,
    //     source_type: SourceType.STRUCTURED,
    //     class_name: tableMapping.target_class,
    //     canonical_id: canonicalId,
    //     identity_keys: this.extractIdentityKeys(row, tableMapping),
    //     attributes,
    //     display_name: attributes[tableMapping.display_name_column],
    //     confidence: 1.0,  // Structured data is authoritative
    //     claim_status: ClaimStatus.FACT
    //   });
    //   events.push(nodeEvent);
    // }

    return events;
  }


  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Generate a canonical ID for an entity
   */
  generateCanonicalId(className, name, attributes) {
    // Build deterministic key from identity attributes
    const keyParts = [
      className || 'Entity',
      name
    ];

    // Add identity attributes in sorted order
    const sortedKeys = Object.keys(attributes).sort();
    for (const key of sortedKeys) {
      if (attributes[key]) {
        keyParts.push(`${key}:${attributes[key]}`);
      }
    }

    const keyString = keyParts.join('|').toLowerCase();
    const hash = crypto.createHash('sha256').update(keyString).digest('hex').substring(0, 16);
    
    return `${(className || 'entity').toLowerCase()}_${hash}`;
  }
  /**
   * Generate deterministic assertion ID from subject+predicate+object+chunk+span
   * Prevents duplicate assertions across reruns
   */
  generateAssertionId(subjectId, predicate, objectId, chunkId, spanStart, spanEnd) {
    const keyString = [subjectId, predicate, objectId, chunkId, spanStart || 0, spanEnd || 0].join('|');
    const hash = crypto.createHash('sha256').update(keyString).digest('hex').substring(0, 20);
    return `assertion_${hash}`;
  }

  /**
   * Get quarantined records for a tenant
   */
  async getQuarantinedRecords(tenantId, options = {}) {
    await this.initialize();

    const records = await client.lRange(
      `${KEYS.QUARANTINE}${tenantId}`,
      0,
      options.limit || 100
    );

    return records.map(r => JSON.parse(r));
  }

  /**
   * Retry a quarantined record
   */
  async retryQuarantinedRecord(tenantId, recordIndex) {
    // Implementation would re-process the quarantined event
    // with updated ontology or manual corrections
  }

  /**
   * Get extraction statistics
   */
  async getExtractionStats(tenantId) {
    await this.initialize();

    const runs = await this.listRuns(tenantId);
    
    const stats = {
      total_runs: runs.length,
      completed: runs.filter(r => r.state === RunState.COMPLETED).length,
      failed: runs.filter(r => r.state === RunState.FAILED).length,
      in_progress: runs.filter(r => ![RunState.COMPLETED, RunState.FAILED].includes(r.state)).length,
      total_entities: 0,
      total_relationships: 0,
      total_quarantined: 0
    };

    for (const run of runs) {
      if (run.stats) {
        stats.total_entities += run.stats.entities_extracted || 0;
        stats.total_relationships += run.stats.relationships_extracted || 0;
        stats.total_quarantined += run.stats.quarantined || 0;
      }
    }

    return stats;
  }
}

module.exports = new ExtractionService();
