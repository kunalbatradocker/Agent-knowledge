/**
 * Concept Extraction Service - IMPROVED VERSION
 * Uses LLM to extract semantic concepts and relationships from text chunks
 * Designed for high-quality RAG grounding
 */

const llmService = require('./llmService');
const { v4: uuidv4 } = require('uuid');
const ontologyTemplateService = require('./ontologyTemplateService');
const { sanitizeDocumentText } = require('../utils/promptSanitizer');

class ConceptExtractionService {
  constructor() {
    this.ontologyTemplateService = ontologyTemplateService;
    
    // Parallelism settings (configurable via env)
    this.defaultParallelism = parseInt(process.env.LLM_PARALLELISM) || 5;
    this.maxChunks = parseInt(process.env.MAX_CHUNKS_PER_DOC) || 50;
    
    // Global concept registry for cross-chunk consistency
    this.globalConceptRegistry = new Map();
    
    console.log(`📊 ConceptExtractionService initialized:`);
    console.log(`   Parallelism: ${this.defaultParallelism} concurrent LLM calls`);
    console.log(`   Max chunks per doc: ${this.maxChunks}`);
  }

  /**
   * Reset concept registry for new document
   */
  resetConceptRegistry() {
    this.globalConceptRegistry.clear();
  }

  /**
   * Register a concept for consistent naming across chunks
   */
  registerConcept(label, uri, type) {
    const normalizedKey = this.normalizeForMatching(label);
    if (!this.globalConceptRegistry.has(normalizedKey)) {
      this.globalConceptRegistry.set(normalizedKey, { label, uri, type });
    }
    return this.globalConceptRegistry.get(normalizedKey);
  }

  /**
   * Look up existing concept by label
   */
  findExistingConcept(label) {
    const normalizedKey = this.normalizeForMatching(label);
    return this.globalConceptRegistry.get(normalizedKey);
  }

  /**
   * Normalize label for matching (fuzzy key)
   */
  normalizeForMatching(label) {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/s$/, ''); // Remove plural
  }

  /**
   * Extract concepts from a single chunk with timeout
   */
  async extractConceptsFromChunk(chunk, documentContext = {}, previousConcepts = []) {
    const prompt = this.buildExtractionPrompt(chunk.text, documentContext, previousConcepts);

    try {
      const content = await llmService.chat([
        { role: 'system', content: this.getSystemPrompt(documentContext) },
        { role: 'user', content: prompt }
      ], { temperature: 0.1 });

      // Extract and clean JSON from response
      const cleanedContent = this.extractJSON(content);
      const extraction = JSON.parse(cleanedContent);
      
      // Debug: Log raw extraction before normalization
      console.log(`      📋 Raw LLM extraction: ${extraction.concepts?.length || 0} concepts, ${extraction.relations?.length || 0} relations`);
      if (extraction.concepts?.length > 0) {
        console.log(`      📝 Concepts: ${extraction.concepts.map(c => `${c.label}(${c.type})`).join(', ')}`);
      }
      
      return this.normalizeExtraction(extraction, chunk, documentContext);
    } catch (error) {
      console.error('Error extracting concepts from chunk:', error.message);
      return { concepts: [], relations: [] };
    }
  }

  /**
   * Extract concepts from multiple chunks (PARALLEL batch processing)
   */
  async extractConceptsFromChunks(chunks, documentContext = {}, options = {}) {
    const parallelism = options.parallelism || this.defaultParallelism;
    const maxChunks = options.maxChunks || this.maxChunks;
    const allConcepts = new Map(); // uri -> concept
    const allRelations = [];
    const conceptMentions = []; // Track which concepts appear in which chunks
    const allUnmatchedTypes = new Map(); // Track unmatched entity types
    const allUnmatchedPredicates = new Map(); // Track unmatched predicates

    // Reset concept registry for new document
    this.resetConceptRegistry();

    // Limit chunks to prevent timeout
    const chunksToProcess = chunks.slice(0, maxChunks);
    if (chunks.length > maxChunks) {
      console.log(`   ⚠️ Limiting to first ${maxChunks} chunks (out of ${chunks.length}) to prevent timeout`);
    }

    console.log(`\n🔍 Extracting concepts from ${chunksToProcess.length} chunks (parallelism: ${parallelism})...`);

    // Track previously extracted concept labels for consistency hints
    let previousConceptLabels = [];
    let processedCount = 0;
    let errorCount = 0;

    // Process chunks in parallel batches
    for (let i = 0; i < chunksToProcess.length; i += parallelism) {
      const batch = chunksToProcess.slice(i, i + parallelism);
      const batchStart = i + 1;
      const batchEnd = Math.min(i + parallelism, chunksToProcess.length);
      console.log(`   🚀 Processing chunks ${batchStart}-${batchEnd} in parallel...`);

      // Process all chunks in this batch concurrently
      const batchPromises = batch.map(async (chunk, batchIndex) => {
        try {
          const extraction = await this.extractConceptsFromChunk(chunk, documentContext, previousConceptLabels);
          return { success: true, extraction, chunk, index: i + batchIndex };
        } catch (chunkError) {
          console.error(`   ❌ Error processing chunk ${i + batchIndex}: ${chunkError.message}`);
          return { success: false, error: chunkError.message, chunk, index: i + batchIndex };
        }
      });

      // Wait for all parallel extractions to complete
      const batchResults = await Promise.all(batchPromises);

      // Process results (merge concepts, relations, mentions)
      for (const result of batchResults) {
        if (result.success) {
          processedCount++;
          const { extraction, chunk } = result;

          // Merge concepts (dedupe by URI)
          for (const concept of extraction.concepts) {
            // Ensure type is a string for registration
            const typeForRegister = typeof concept.type === 'string' 
              ? concept.type 
              : (concept.type?.type || concept.type?.label || 'Concept');
            
            // Register concept for consistency
            this.registerConcept(concept.label, concept.uri, typeForRegister);
            
            if (allConcepts.has(concept.uri)) {
              // Merge - take higher confidence and combine mentions
              const existing = allConcepts.get(concept.uri);
              if (concept.confidence > existing.confidence) {
                existing.confidence = concept.confidence;
              }
              if (concept.description && concept.description.length > (existing.description || '').length) {
                existing.description = concept.description;
              }
            } else {
              allConcepts.set(concept.uri, concept);
              previousConceptLabels.push(concept.label);
            }

            // Track mention
            conceptMentions.push({
              conceptUri: concept.uri,
              chunkId: chunk.chunk_id || chunk.id,
              chunkUri: chunk.uri,
              relevance: concept.relevance || 0.8,
              startChar: concept.startChar,
              endChar: concept.endChar
            });
          }

          // Add relations
          allRelations.push(...extraction.relations);
          
          // Aggregate unmatched types
          if (extraction.unmatchedTypes) {
            for (const ut of extraction.unmatchedTypes) {
              const key = ut.suggestedType;
              if (allUnmatchedTypes.has(key)) {
                const existing = allUnmatchedTypes.get(key);
                existing.examples.push(...ut.examples);
                existing.count += ut.count;
              } else {
                allUnmatchedTypes.set(key, { ...ut });
              }
            }
          }
          
          // Aggregate unmatched predicates
          if (extraction.unmatchedPredicates) {
            for (const up of extraction.unmatchedPredicates) {
              const key = up.suggestedPredicate;
              if (allUnmatchedPredicates.has(key)) {
                const existing = allUnmatchedPredicates.get(key);
                existing.examples.push(...up.examples);
                existing.count += up.count;
              } else {
                allUnmatchedPredicates.set(key, { ...up });
              }
            }
          }
        } else {
          errorCount++;
        }
      }
      
      // Log progress every batch
      console.log(`   ✓ Completed batch: ${batchEnd}/${chunksToProcess.length} chunks, ${allConcepts.size} concepts, ${errorCount} errors`);
    }

    // Deduplicate relations
    const uniqueRelations = this.deduplicateRelations(allRelations);
    
    // Convert unmatched maps to arrays and limit examples
    const unmatchedTypesArray = Array.from(allUnmatchedTypes.values()).map(ut => ({
      ...ut,
      examples: ut.examples.slice(0, 5) // Limit to 5 examples
    }));
    const unmatchedPredicatesArray = Array.from(allUnmatchedPredicates.values()).map(up => ({
      ...up,
      examples: up.examples.slice(0, 5) // Limit to 5 examples
    }));

    // Log extracted concepts for debugging
    console.log(`\n   📊 EXTRACTION SUMMARY:`);
    console.log(`   ✅ Extracted ${allConcepts.size} unique concepts`);
    console.log(`   ✅ Found ${uniqueRelations.length} relationships`);
    
    if (unmatchedTypesArray.length > 0) {
      console.log(`\n   ⚠️ UNMATCHED ENTITY TYPES (not in ontology):`);
      for (const ut of unmatchedTypesArray) {
        console.log(`      • "${ut.suggestedType}" (${ut.count}x) → assigned to "${ut.assignedType}"`);
        console.log(`        Examples: ${ut.examples.join(', ')}`);
      }
    }
    
    if (unmatchedPredicatesArray.length > 0) {
      console.log(`\n   ⚠️ UNMATCHED PREDICATES (not in ontology):`);
      for (const up of unmatchedPredicatesArray) {
        console.log(`      • "${up.suggestedPredicate}" (${up.count}x) → assigned to "${up.assignedPredicate}"`);
      }
    }
    
    if (allConcepts.size > 0) {
      console.log(`\n   📝 TOP CONCEPTS EXTRACTED:`);
      const sortedConcepts = Array.from(allConcepts.values())
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10);
      for (const c of sortedConcepts) {
        console.log(`      • ${c.label} (${c.type}) [confidence: ${c.confidence.toFixed(2)}]`);
      }
    }

    if (uniqueRelations.length > 0) {
      console.log(`\n   🔗 SAMPLE RELATIONSHIPS:`);
      const sampleRels = uniqueRelations.slice(0, 5);
      for (const r of sampleRels) {
        console.log(`      • ${r.sourceLabel} --[${r.predicate}]--> ${r.targetLabel}`);
      }
    }

    return {
      concepts: Array.from(allConcepts.values()),
      relations: uniqueRelations,
      mentions: conceptMentions,
      unmatchedTypes: unmatchedTypesArray.length > 0 ? unmatchedTypesArray : undefined,
      unmatchedPredicates: unmatchedPredicatesArray.length > 0 ? unmatchedPredicatesArray : undefined
    };
  }

  /**
   * IMPROVED System Prompt - Industry-agnostic, focused on quality extraction
   */
  getSystemPrompt(context = {}) {
    const template = context.ontologyTemplate || this.ontologyTemplateService.getTemplate(context.templateId || 'auto');
    const isAuto = template.isAutoGenerated || !template.conceptTypes || template.conceptTypes.length === 0;

    console.log(`\n   🎯 EXTRACTION MODE: ${isAuto ? 'AUTO (free types)' : 'STRICT (user-approved types)'}`);
    if (!isAuto && template.conceptTypes) {
      console.log(`   📋 Allowed Types: ${template.conceptTypes.join(', ')}`);
    }
    if (!isAuto && template.predicates) {
      console.log(`   🔗 Allowed Predicates: ${template.predicates.join(', ')}`);
    }

    const basePrompt = `You are a PRECISE knowledge extraction system for building searchable knowledge graphs.

YOUR GOAL: Extract MEANINGFUL entities and relationships that help users find information.

═══════════════════════════════════════════════════════════════
QUALITY RULES - FOLLOW STRICTLY
═══════════════════════════════════════════════════════════════

✅ EXTRACT THESE (HIGH VALUE):
• Named entities: People, organizations, products, places
• Specific terms: Technical terms, proper nouns, brand names
• Compound concepts: "Machine Learning", "New York City", "API Gateway"
• Domain-specific terminology relevant to the document

❌ NEVER EXTRACT THESE (GARBAGE):
• Generic words: system, data, user, process, information, value
• Single letters or short codes: A, B, X, ID
• Pure numbers without context: 123, 4567, 2024
• OCR artifacts: random character sequences, font names
• PDF metadata: encoding names, font descriptors
• Common words: the, and, for, with, total, amount

═══════════════════════════════════════════════════════════════
LABEL QUALITY REQUIREMENTS
═══════════════════════════════════════════════════════════════

1. Labels must be MEANINGFUL and SEARCHABLE
   ✓ "John Smith" (specific person)
   ✓ "Newark Airport" (specific place)
   ✓ "Uber Technologies" (specific company)
   ✗ "User" (too generic)
   ✗ "4153" (meaningless number)
   ✗ "wagiberty" (OCR garbage)

2. Labels must be PROPERLY FORMATTED
   ✓ "New York City" (proper capitalization)
   ✓ "API Gateway" (consistent format)
   ✗ "new york city" (wrong case)
   ✗ "API_GATEWAY" (wrong format)

3. Numbers need CONTEXT to be valid concepts
   ✓ "$45.99 Fare" or "Fare: $45.99" (amount with context)
   ✓ "Flight 1234" (number with meaning)
   ✗ "45.99" (bare number)
   ✗ "1234" (meaningless)`;

    if (isAuto) {
      return basePrompt + `

═══════════════════════════════════════════════════════════════
AUTO MODE - CHOOSE APPROPRIATE TYPES
═══════════════════════════════════════════════════════════════

Select the most specific type that fits:
• Person - Named individuals (John Smith, Dr. Jane Doe)
• Organization - Companies, institutions (Google, MIT, WHO)
• Location - Places, addresses (New York, 123 Main St)
• Product - Products, services (iPhone, AWS Lambda)
• Technology - Tech terms, tools (Kubernetes, Python)
• Event - Named events (World Cup 2024, Annual Meeting)
• Publication - Named documents, standards (RFC 7231, ISO 9001)
• Date - Specific dates (January 15, 2024)
• Amount - Money with context (Total Fare: $50)

Return ONLY valid JSON with high-quality extractions.`;
    } else {
      // STRICT MODE with user-approved types
      const typeGuide = template.conceptTypes.map(t => `• "${t}"`).join('\n');
      
      return basePrompt + `

═══════════════════════════════════════════════════════════════
⚠️  STRICT MODE - USE ONLY THESE TYPES ⚠️
═══════════════════════════════════════════════════════════════

ALLOWED TYPES (use EXACTLY these, no variations):
${typeGuide}

ALLOWED PREDICATES:
${(template.predicates || ['RELATED_TO']).map(p => `• "${p}"`).join('\n')}

🚫 FORBIDDEN - DO NOT USE:
• Any type not listed above
• Generic types: "Concept", "Entity", "Thing", "Item"
• Variations of allowed types (use exact spelling)

If unsure which type fits, pick the CLOSEST match from allowed types.
Every concept.type MUST be exactly one of the allowed types.`;
    }
  }

  /**
   * IMPROVED Extraction Prompt - Cleaner, more focused
   */
  buildExtractionPrompt(text, context, previousConcepts = []) {
    const template = context.ontologyTemplate || this.ontologyTemplateService.getTemplate(context.templateId || 'auto');
    const docType = context.doc_type || 'document';
    const isAuto = template.isAutoGenerated || !template.conceptTypes || template.conceptTypes.length === 0;

    // Build consistency hint from previous concepts (only high-quality ones)
    let consistencyHint = '';
    if (previousConcepts.length > 0) {
      const recentConcepts = previousConcepts.slice(-15).join(', ');
      consistencyHint = `\nPREVIOUSLY EXTRACTED (use same labels for same entities): ${recentConcepts}\n`;
    }

    // Type constraints with examples
    let typeConstraint;
    let typeExamples = '';
    if (isAuto) {
      // Note: "Document" removed to prevent creating :Document nodes that conflict with system Document nodes
      typeConstraint = 'Use appropriate types: Person, Organization, Location, Product, Technology, Event, Publication, Date, Amount';
    } else {
      typeConstraint = `STRICT TYPE CONSTRAINT - You MUST use ONLY these types: ${template.conceptTypes.join(', ')}

⚠️ CRITICAL: Match each entity to the MOST APPROPRIATE type from the list above.
- Courts, tribunals, judicial bodies → use Court/Organization type if available
- Judges, justices, registrars → use Person/Judge type if available  
- Parties, petitioners, respondents → use Party/Person type if available
- Legal cases, matters → use Case type if available
- Laws, acts, statutes → use Legislation/Law type if available
- Dates, time periods → use Date type if available
- Locations, addresses → use Location type if available

DO NOT default everything to one type. Analyze each entity carefully.`;
    }

    return `Extract entities and relationships from this ${docType}.
${consistencyHint}
${typeConstraint}

═══════════════════════════════════════════════════════════════
TEXT TO ANALYZE:
═══════════════════════════════════════════════════════════════
${sanitizeDocumentText(text, 15000)}
═══════════════════════════════════════════════════════════════

Extract ALL meaningful named entities. Return JSON:

{
  "concepts": [
    {
      "label": "Entity Name (properly formatted)",
      "type": "EntityType (MUST be from allowed types)",
      "description": "Brief description",
      "confidence": 0.9
    }
  ],
  "relations": [
    {
      "source": "Source Entity Label",
      "target": "Target Entity Label",
      "predicate": "RELATIONSHIP_TYPE",
      "confidence": 0.8
    }
  ]
}

REMEMBER:
• Extract SPECIFIC named entities only (people, places, organizations, products)
• CAREFULLY select the correct type for each entity - don't use the same type for everything
• NO generic words (system, data, user, process)
• NO pure numbers without context
• NO OCR garbage or random characters
• Labels in relations MUST match labels in concepts exactly`;
  }

  normalizeExtraction(extraction, chunk, documentContext) {
    const concepts = [];
    const relations = [];
    const unmatchedTypes = []; // Track entity types not in ontology
    const unmatchedPredicates = []; // Track predicates not in ontology
    const template = documentContext.ontologyTemplate || this.ontologyTemplateService.getTemplate(documentContext.templateId || 'auto');
    const sourceUri = documentContext.uri || `doc://${documentContext.doc_id || 'unknown'}`;
    const isAuto = template.isAutoGenerated || !template.conceptTypes || template.conceptTypes.length === 0;

    // Build a map of label -> URI for consistent relationship linking
    const labelToUri = new Map();
    const labelToType = new Map();

    // Pre-filter concepts using post-processing
    const filteredConcepts = this.postProcessConcepts(extraction.concepts || [], 0.5);

    // Normalize concepts
    for (const concept of filteredConcepts) {
      if (!concept.label) continue;

      // Check if we already have this concept registered
      const existing = this.findExistingConcept(concept.label);
      
      // Normalize label and validate type against template
      const normalizedLabel = existing?.label || this.ontologyTemplateService.normalizeLabel(concept.label);
      
      // Ensure concept.type is a string (LLM might return object)
      let conceptTypeStr = '';
      if (typeof concept.type === 'string') {
        conceptTypeStr = concept.type;
      } else if (concept.type && typeof concept.type === 'object') {
        conceptTypeStr = concept.type.type || concept.type.label || concept.type.name || '';
      }
      
      // Get type info - returns { baseType: 'Concept', specificType: 'Person' | null, isUnmatched: bool, originalType: string }
      const typeInfo = isAuto 
        ? { baseType: 'Concept', specificType: conceptTypeStr || null, isUnmatched: false, originalType: conceptTypeStr }
        : this.ontologyTemplateService.validateConceptType(template, conceptTypeStr, concept.label);
      
      // Track unmatched types for user review
      if (!isAuto && typeInfo.isUnmatched && conceptTypeStr) {
        const existingUnmatched = unmatchedTypes.find(u => u.suggestedType === conceptTypeStr);
        if (existingUnmatched) {
          existingUnmatched.examples.push(concept.label);
          existingUnmatched.count++;
        } else {
          unmatchedTypes.push({
            suggestedType: conceptTypeStr,
            assignedType: typeInfo.specificType || typeInfo.baseType,
            examples: [concept.label],
            count: 1
          });
        }
      }
      
      // validType for URI generation - use specificType if available, else baseType
      const validType = typeInfo.specificType || typeInfo.baseType;
      
      const conceptId = uuidv4();
      const conceptUri = existing?.uri || this.ontologyTemplateService.generateConceptUri(template, validType, normalizedLabel);

      // Store mapping for relationship resolution
      labelToUri.set(normalizedLabel.toLowerCase(), conceptUri);
      labelToUri.set(this.normalizeForMatching(concept.label), conceptUri);
      labelToType.set(normalizedLabel.toLowerCase(), validType);

      concepts.push({
        concept_id: conceptId,
        uri: conceptUri,
        label: normalizedLabel,
        baseType: typeInfo.baseType,  // Always 'Concept'
        specificType: typeInfo.specificType,  // User-approved type or null
        type: validType,  // For backwards compatibility (specificType || baseType)
        originalType: typeInfo.originalType || conceptTypeStr,  // What LLM originally suggested
        isUnmatched: typeInfo.isUnmatched || false,  // Whether type was not in ontology
        description: concept.description || '',
        source: sourceUri,
        confidence: Math.min(concept.confidence || 0.7, 1.0),
        relevance: concept.relevance || 0.8,
        startChar: concept.mentions?.[0]?.startChar,
        endChar: concept.mentions?.[0]?.endChar
      });
    }

    // Helper to get URI for a label
    const getConceptUri = (label, defaultType = 'Concept') => {
      // Check our local map first
      const normalizedLabel = this.ontologyTemplateService.normalizeLabel(label);
      const lowerLabel = normalizedLabel.toLowerCase();
      const fuzzyKey = this.normalizeForMatching(label);
      
      if (labelToUri.has(lowerLabel)) {
        return { uri: labelToUri.get(lowerLabel), label: normalizedLabel };
      }
      if (labelToUri.has(fuzzyKey)) {
        return { uri: labelToUri.get(fuzzyKey), label: normalizedLabel };
      }
      
      // Check global registry
      const existing = this.findExistingConcept(label);
      if (existing) {
        return { uri: existing.uri, label: existing.label };
      }
      
      // Generate new URI
      const type = isAuto ? defaultType : this.ontologyTemplateService.validateConceptType(template, defaultType, normalizedLabel);
      return { 
        uri: this.ontologyTemplateService.generateConceptUri(template, type, normalizedLabel),
        label: normalizedLabel
      };
    };

    // Normalize relations
    if (Array.isArray(extraction.relations)) {
      for (const rel of extraction.relations) {
        if (!rel.source || !rel.target) continue;
        if (rel.source === rel.target) continue; // Skip self-references

        const sourceInfo = getConceptUri(rel.source, 'Concept');
        const targetInfo = getConceptUri(rel.target, 'Concept');
        
        const originalPredicate = (rel.predicate || 'related_to').toUpperCase().replace(/\s+/g, '_');
        const predicateInfo = isAuto 
          ? { predicate: originalPredicate, isUnmatched: false, originalPredicate }
          : this.ontologyTemplateService.validatePredicateWithInfo(template, rel.predicate);
        
        // Track unmatched predicates for user review
        if (!isAuto && predicateInfo.isUnmatched && originalPredicate) {
          const existingUnmatched = unmatchedPredicates.find(u => u.suggestedPredicate === originalPredicate);
          if (existingUnmatched) {
            existingUnmatched.examples.push(`${rel.source} → ${rel.target}`);
            existingUnmatched.count++;
          } else {
            unmatchedPredicates.push({
              suggestedPredicate: originalPredicate,
              assignedPredicate: predicateInfo.predicate,
              examples: [`${rel.source} → ${rel.target}`],
              count: 1
            });
          }
        }

        // Extract properties from relationship if provided
        const relProperties = {};
        if (rel.properties && typeof rel.properties === 'object') {
          // Copy properties, ensuring values are strings/numbers/booleans
          for (const [key, value] of Object.entries(rel.properties)) {
            if (value !== null && value !== undefined) {
              relProperties[key] = value;
            }
          }
        }
        // Always include confidence and source_uri as defaults
        if (!relProperties.confidence) {
          relProperties.confidence = Math.min(rel.confidence || 0.7, 1.0);
        }
        if (!relProperties.source_uri) {
          relProperties.source_uri = sourceUri;
        }

        relations.push({
          type: 'RELATED_TO',
          sourceLabel: sourceInfo.label,
          sourceUri: sourceInfo.uri,
          targetLabel: targetInfo.label,
          targetUri: targetInfo.uri,
          predicate: predicateInfo.predicate,
          originalPredicate: predicateInfo.originalPredicate || originalPredicate,
          isUnmatched: predicateInfo.isUnmatched || false,
          confidence: Math.min(rel.confidence || 0.7, 1.0),
          relevance: rel.relevance || 0.7,
          source_uri: sourceUri,
          properties: Object.keys(relProperties).length > 0 ? relProperties : undefined
        });
      }
    }

    // Normalize taxonomies (IS_A)
    if (Array.isArray(extraction.taxonomies)) {
      for (const tax of extraction.taxonomies) {
        if (!tax.child || !tax.parent) continue;
        if (tax.child === tax.parent) continue;

        const childInfo = getConceptUri(tax.child, 'Concept');
        const parentInfo = getConceptUri(tax.parent, 'Concept');

        relations.push({
          type: 'IS_A',
          sourceLabel: childInfo.label,
          sourceUri: childInfo.uri,
          targetLabel: parentInfo.label,
          targetUri: parentInfo.uri,
          predicate: 'IS_A',
          confidence: tax.confidence || 0.8,
          relevance: 1.0,
          source_uri: sourceUri
        });
      }
    }

    return { 
      concepts, 
      relations,
      unmatchedTypes: unmatchedTypes.length > 0 ? unmatchedTypes : undefined,
      unmatchedPredicates: unmatchedPredicates.length > 0 ? unmatchedPredicates : undefined
    };
  }

  /**
   * Check if a concept is too generic, garbage, or PDF metadata to be useful
   * IMPROVED: More comprehensive filtering for all industries
   */
  isGenericConcept(label) {
    if (!label || typeof label !== 'string') return true;
    
    const trimmed = label.trim();
    
    // Length checks
    if (trimmed.length < 2) return true;
    if (trimmed.length > 100) return true; // Too long to be a useful concept
    
    // Numeric-only or mostly numeric (like "4153", "2794")
    const alphaCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
    const digitCount = (trimmed.match(/[0-9]/g) || []).length;
    if (digitCount > 0 && alphaCount === 0) return true; // Pure numbers
    if (digitCount > alphaCount * 2 && trimmed.length > 3) return true; // Mostly numbers
    
    // Single word generic terms
    const genericTerms = new Set([
      // System/tech generic
      'system', 'data', 'user', 'users', 'component', 'components',
      'process', 'service', 'application', 'information', 'function',
      'method', 'object', 'element', 'item', 'thing', 'entity',
      'value', 'result', 'output', 'input', 'parameter', 'variable',
      'type', 'class', 'instance', 'model', 'document', 'file',
      'example', 'case', 'scenario', 'step', 'action', 'operation',
      'record', 'entry', 'field', 'column', 'row', 'table',
      // Common words
      'the', 'and', 'for', 'with', 'from', 'this', 'that', 'which',
      'total', 'amount', 'number', 'count', 'sum', 'average',
      'name', 'date', 'time', 'year', 'month', 'day', 'hour',
      'start', 'end', 'begin', 'finish', 'first', 'last',
      'new', 'old', 'current', 'previous', 'next',
      'true', 'false', 'yes', 'no', 'none', 'null', 'undefined',
      // OCR garbage patterns
      'page', 'pages', 'copy', 'receipt', 'invoice', 'statement'
    ]);

    const normalized = trimmed.toLowerCase();
    if (genericTerms.has(normalized)) return true;
    
    // PDF metadata patterns to filter out
    const pdfMetadataPatterns = [
      /^font/i, /serif/i, /sans[-\s]?serif/i, /liberation/i, /helvetica/i, /arial/i, /times/i,
      /flatedecode/i, /asciihexdecode/i, /lzwdecode/i, /dctdecode/i,
      /pdf\s*document/i, /fontdescriptor/i, /fontfile/i, /truetype/i,
      /opentype/i, /cmap/i, /encoding/i, /baseencoding/i,
      /^[A-Z]{6}\+/,  // Font subset prefix like ABCDEF+FontName
      /^\d+\s*\d+\s*obj$/i,  // PDF object references
      /^\/\w+$/,  // PDF dictionary keys
      /^stream$/i, /^endstream$/i, /^endobj$/i,
    ];
    
    for (const pattern of pdfMetadataPatterns) {
      if (pattern.test(trimmed)) return true;
    }
    
    // OCR garbage patterns (random character sequences)
    const garbagePatterns = [
      /^[^a-zA-Z]*$/,  // No letters at all
      /^[a-z]{1,2}$/i,  // Single or double letter
      /^[^a-zA-Z0-9\s]+$/,  // Only special characters
      /^[\W_]+$/,  // Only non-word characters
      /(.)\1{3,}/,  // Same character repeated 4+ times
      /^[A-Z]{10,}$/,  // All caps 10+ chars (likely garbage)
      /^\d{1,4}$/,  // Short numbers (1-4 digits)
      /^[a-z]\d+$/i,  // Single letter + numbers
      /^\d+[a-z]$/i,  // Numbers + single letter
    ];
    
    for (const pattern of garbagePatterns) {
      if (pattern.test(trimmed)) return true;
    }
    
    // Check for reasonable word structure
    // A valid concept should have at least one word-like segment
    const words = trimmed.split(/[\s\-_]+/);
    const validWords = words.filter(w => /^[a-zA-Z]{2,}/.test(w));
    if (validWords.length === 0 && trimmed.length > 4) return true;
    
    return false;
  }

  /**
   * Post-process and validate extracted concepts
   * Filters out low-quality extractions
   */
  postProcessConcepts(concepts, minConfidence = 0.5) {
    if (!Array.isArray(concepts)) return [];
    
    return concepts.filter(concept => {
      // Must have a label
      if (!concept.label) return false;
      
      // Filter generic concepts
      if (this.isGenericConcept(concept.label)) {
        console.log(`      🚫 Filtered generic concept: "${concept.label}"`);
        return false;
      }
      
      // Filter low confidence
      if (concept.confidence && concept.confidence < minConfidence) {
        console.log(`      🚫 Filtered low confidence (${concept.confidence.toFixed(2)}): "${concept.label}"`);
        return false;
      }
      
      // Filter concepts that are just currency amounts without context
      if (/^\$?\d+\.?\d*$/.test(concept.label.trim())) {
        console.log(`      🚫 Filtered bare number: "${concept.label}"`);
        return false;
      }
      
      return true;
    });
  }

  /**
   * Extract and clean JSON from LLM response
   */
  extractJSON(content) {
    if (!content) {
      return '{"concepts":[],"relations":[],"taxonomies":[]}';
    }

    let cleaned = content.trim();

    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    // Find first { and matching }
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) {
      cleaned = cleaned.substring(firstBrace);
    }

    // Find matching closing brace
    let braceCount = 0;
    let lastValidIndex = -1;
    
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') braceCount++;
      else if (cleaned[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastValidIndex = i;
          break;
        }
      }
    }

    if (lastValidIndex > 0) {
      cleaned = cleaned.substring(0, lastValidIndex + 1);
    }

    // Try parsing
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      // Fix common issues
      cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
      cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');
      
      try {
        JSON.parse(cleaned);
        return cleaned;
      } catch (e2) {
        console.warn('Could not parse concept extraction JSON, returning empty');
        return '{"concepts":[],"relations":[],"taxonomies":[]}';
      }
    }
  }

  deduplicateRelations(relations) {
    const seen = new Map();

    for (const rel of relations) {
      const key = `${rel.sourceUri}|${rel.type}|${rel.predicate}|${rel.targetUri}`;
      if (!seen.has(key) || rel.confidence > seen.get(key).confidence) {
        seen.set(key, rel);
      }
    }

    return Array.from(seen.values());
  }
}

module.exports = new ConceptExtractionService();
