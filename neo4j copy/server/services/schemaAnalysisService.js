/**
 * Schema Analysis Service
 * Analyzes documents and suggests labels/types before creating nodes
 * Allows user to review and edit before committing to database
 */

const { v4: uuidv4 } = require('uuid');
const llmService = require('./llmService');
const csvParser = require('./csvParser');

// Redis for persistence (optional - falls back to in-memory if unavailable)
let redisClient = null;
let redisConnected = false;
const ANALYSIS_PREFIX = 'analysis:';
const ANALYSIS_TTL = 60 * 60; // 1 hour in seconds

async function initRedis() {
  try {
    const { client, connectRedis } = require('../config/redis');
    await connectRedis();
    redisClient = client;
    redisConnected = true;
    console.log('✅ SchemaAnalysisService: Redis persistence enabled');
  } catch (error) {
    console.warn('⚠️ SchemaAnalysisService: Redis unavailable, using in-memory storage only');
    redisConnected = false;
  }
}

// Initialize Redis connection
initRedis();

class SchemaAnalysisService {
  constructor() {
    // Store pending analyses (in-memory cache, backed by Redis if available)
    this.pendingAnalyses = new Map();
    
    // Clean up old analyses every hour
    setInterval(() => this.cleanupOldAnalyses(), 60 * 60 * 1000);
  }

  /**
   * Store analysis in both memory and Redis
   */
  async storeAnalysis(analysisId, analysis) {
    this.pendingAnalyses.set(analysisId, analysis);
    
    if (redisConnected && redisClient) {
      try {
        await redisClient.setEx(
          `${ANALYSIS_PREFIX}${analysisId}`,
          ANALYSIS_TTL,
          JSON.stringify(analysis)
        );
      } catch (error) {
        console.warn('Could not persist analysis to Redis:', error.message);
      }
    }
  }

  /**
   * Get analysis — checks in-memory cache first, then Redis.
   * Always async to ensure Redis-backed retrieval works after server restart.
   */
  async getAnalysis(analysisId) {
    // Check memory cache first
    if (this.pendingAnalyses.has(analysisId)) {
      return this.pendingAnalyses.get(analysisId);
    }

    // Fall through to Redis
    if (redisConnected && redisClient) {
      try {
        const data = await redisClient.get(`${ANALYSIS_PREFIX}${analysisId}`);
        if (data) {
          const analysis = JSON.parse(data);
          // Restore to memory cache
          this.pendingAnalyses.set(analysisId, analysis);
          return analysis;
        }
      } catch (error) {
        console.warn('Could not retrieve analysis from Redis:', error.message);
      }
    }

    return null;
  }

  /**
   * @deprecated Use getAnalysis() instead — it is now async and checks Redis.
   * Kept for backward compatibility.
   */
  async getAnalysisAsync(analysisId) {
    return this.getAnalysis(analysisId);
  }

  /**
   * Analyze a CSV file and suggest schema
   */
  async analyzeCSV(filePath, options = {}) {
    const { industry = 'general', documentName = 'document' } = options;
    
    console.log('\n📊 SCHEMA ANALYSIS: Analyzing CSV structure');
    console.log('-'.repeat(50));

    // Parse CSV
    const csvData = await csvParser.parse(filePath, {
      hasHeader: true,
      delimiter: ','
    });

    const { headers, rows, columnAnalysis } = csvData;
    
    console.log(`   Found ${headers.length} columns and ${rows.length} rows`);

    // Analyze each column
    const columnSuggestions = [];
    
    for (const header of headers) {
      const analysis = columnAnalysis?.columns?.[header] || {};
      const sampleValues = this.getSampleValues(rows, header, 5);
      
      // Use LLM to suggest label type for this column
      const suggestion = await this.suggestColumnType(header, sampleValues, analysis, industry);
      
      columnSuggestions.push({
        column: header,
        suggestedLabel: suggestion.label,
        suggestedType: suggestion.type,
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        sampleValues: sampleValues,
        stats: {
          uniqueCount: analysis.uniqueCount || sampleValues.length,
          fillRate: analysis.fillRate || 100,
          isNumeric: analysis.isNumeric || false,
          isDate: analysis.isDate || false
        },
        // User can change these
        userLabel: suggestion.label,
        userType: suggestion.type,
        includeAsNode: suggestion.includeAsNode,
        includeAsProperty: !suggestion.includeAsNode
      });
    }

    // Suggest relationships between columns
    const relationshipSuggestions = await this.suggestRelationships(columnSuggestions, rows.slice(0, 5), industry);

    // Generate analysis ID for tracking
    const analysisId = uuidv4();
    
    const analysis = {
      id: analysisId,
      documentName,
      industry,
      filePath,
      fileType: 'csv',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min expiry
      
      // Schema suggestions
      columns: columnSuggestions,
      relationships: relationshipSuggestions,
      
      // Summary
      summary: {
        totalColumns: headers.length,
        totalRows: rows.length,
        suggestedNodeColumns: columnSuggestions.filter(c => c.includeAsNode).length,
        suggestedPropertyColumns: columnSuggestions.filter(c => c.includeAsProperty).length,
        suggestedRelationships: relationshipSuggestions.length
      },
      
      // Raw data for later processing - sample rows from throughout file
      rawData: {
        headers,
        rowCount: rows.length,
        sampleRows: this.sampleRows(rows, 10)
      }
    };

    // Store for later retrieval (with Redis persistence)
    await this.storeAnalysis(analysisId, analysis);
    
    console.log(`   ✅ Analysis complete: ${analysisId}`);
    console.log(`      Node columns: ${analysis.summary.suggestedNodeColumns}`);
    console.log(`      Property columns: ${analysis.summary.suggestedPropertyColumns}`);
    console.log(`      Relationships: ${analysis.summary.suggestedRelationships}`);

    return analysis;
  }

  /**
   * Analyze text document and suggest schema
   * This is the "Analyze" flow - discovers ontology from document when no ontology is assigned
   * 
   * @param {string} text - Full document text
   * @param {Object} options - Analysis options
   * @param {string} options.analysisMode - 'auto' | 'full' | 'sampled'
   *   - 'auto': Automatically choose based on document size (default)
   *   - 'full': Always analyze full document (slower, more thorough)
   *   - 'sampled': Always sample from beginning/middle/end (faster, good for large docs)
   * @param {number} options.maxChars - Max chars for full mode (default: 100000)
   * @param {number} options.sampleSize - Total chars for sampled mode (default: 20000)
   */
  async analyzeText(text, options = {}) {
    const { 
      industry = 'general', 
      documentName = 'document', 
      docType = 'text', 
      filePath = null,
      chunkingMethod = 'fixed',
      numPages = 1,
      existingOntology = null,  // Optional existing ontology for comparison
      analysisMode = 'auto',    // 'auto' | 'full' | 'sampled'
      maxChars = 100000,        // Max chars for full mode
      sampleSize = 20000        // Total chars for sampled mode
    } = options;
    
    console.log('\n📄 ONTOLOGY ANALYSIS: Analyzing document for ontology discovery');
    console.log('-'.repeat(50));
    console.log(`   📊 Analysis mode: ${analysisMode}`);

    // Detect document type for better defaults
    const detectedType = this.detectDocumentType(text, documentName);
    console.log(`   📋 Detected document type: ${detectedType}`);

    // Determine actual mode based on analysisMode setting
    let textSample;
    let actualMode;
    
    if (analysisMode === 'full') {
      // User requested full analysis
      actualMode = 'full';
      if (text.length > maxChars) {
        textSample = text.substring(0, maxChars) + '\n\n[TRUNCATED - Document exceeds max length]';
        console.log(`   📄 FULL MODE: Using first ${maxChars} chars (document has ${text.length} chars)`);
      } else {
        textSample = text;
        console.log(`   📄 FULL MODE: Using entire document (${text.length} chars)`);
      }
    } else if (analysisMode === 'sampled') {
      // User requested sampled analysis
      actualMode = 'sampled';
      textSample = this.sampleDocument(text, sampleSize);
      console.log(`   📄 SAMPLED MODE: Using ${sampleSize} chars from beginning/middle/end`);
    } else {
      // Auto mode - choose based on document size
      const autoThreshold = sampleSize; // Use sampling if doc exceeds sample size
      
      if (text.length <= autoThreshold) {
        actualMode = 'full';
        textSample = text;
        console.log(`   📄 AUTO MODE → FULL: Document is small (${text.length} chars)`);
      } else {
        actualMode = 'sampled';
        textSample = this.sampleDocument(text, sampleSize);
        console.log(`   📄 AUTO MODE → SAMPLED: Large document (${text.length} chars, ~${numPages} pages)`);
      }
    }

    // Build existing ontology summary if provided
    let existingOntologySummary = '';
    if (existingOntology && (existingOntology.entityTypes?.length > 0 || existingOntology.relationships?.length > 0)) {
      existingOntologySummary = `
## EXISTING ONTOLOGY (for comparison):
### Classes:
${existingOntology.entityTypes?.map(et => {
  const label = typeof et === 'string' ? et : (et.userLabel || et.label || et.type);
  const desc = typeof et === 'object' && et.description ? ` - ${et.description}` : '';
  return `• ${label}${desc}`;
}).join('\n') || 'None'}

### Relationships:
${existingOntology.relationships?.map(r => {
  const type = typeof r === 'string' ? r : (r.type || r.predicate || r.label);
  return `• ${type}`;
}).join('\n') || 'None'}
`;
    }

    // New ontology analysis prompt - focuses on discovering ontology, NOT extracting entities
    const prompt = `# Document Ontology Analysis & Discovery

You are an **ontology analyst**, NOT an extractor.
Your task is to analyze the document and identify the **ontology implied by the text**.

## YOU MUST NOT:
- Extract entities or relationships as facts
- Invent ontology terms not supported by the document
- Assume an existing ontology fits

Your job is to **analyze concepts**, not data.

---

## INPUTS

1. Document text (or chunk):
"""
${textSample}
"""

2. Domain hint: ${industry !== 'general' ? industry : 'Not specified'}
${existingOntologySummary}

---

## TASKS

### 1. Identify Core Concepts
Identify **distinct conceptual nouns** that represent:
- Things
- Roles
- Events
- Obligations
- Artifacts

For each concept:
- Name
- Short definition (1–2 lines, grounded in document language)
- Evidence quote (exact sentence or paragraph)

DO NOT normalize yet.

---

### 2. Classify Concept Type
For each concept, classify as one of:
- Entity-like (long-lived thing)
- Event-like (time-bound occurrence)
- Policy / Obligation
- Artifact / Document
- Attribute-like (likely NOT a class)

---

### 3. Identify Relationships (Conceptual, NOT factual)
Identify **conceptual relationships**, phrased generically:
- "X requires Y"
- "X is associated with Y"
- "X is triggered by Y"

For each relationship:
- Source concept
- Target concept
- Relationship verb (neutral, not ontology-specific)
- Evidence quote

---

### 4. Compare With Existing Ontology (if provided)
For each discovered concept:
- Is it already covered?
  - Exact match
  - Synonym
  - Partial overlap
- If not covered:
  - Is it a **candidate new class**?
  - Or an **attribute of an existing class**?

---

### 5. Ontology Recommendations
Output:
- Recommended new classes (if any)
- Recommended new relationships (if any)
- Concepts that should NOT be modeled as classes
- Areas of ambiguity or uncertainty

---

## OUTPUT FORMAT (STRICT JSON)

Return ONLY valid JSON in this exact format:
{
  "domain_summary": "Brief description of the document's domain and main topics",
  "candidate_classes": [
    {
      "name": "ConceptName",
      "type": "entity | event | obligation | artifact",
      "definition": "Short definition grounded in document language",
      "evidence": "Exact quote from document supporting this concept"
    }
  ],
  "candidate_relationships": [
    {
      "from": "SourceConcept",
      "to": "TargetConcept",
      "relation": "RELATIONSHIP_VERB",
      "evidence": "Exact quote from document supporting this relationship"
    }
  ],
  "attribute_candidates": ["concept names that should be attributes, not classes"],
  "ontology_gaps": ["concepts not covered by existing ontology (if provided)"],
  "uncertainties": ["areas of ambiguity or concepts that need clarification"]
}

CRITICAL: Return ONLY valid JSON. No explanations, no markdown code blocks, just the JSON object.`;

    let suggestions;
    try {
      const response = await llmService.chat([
        { 
          role: 'system', 
          content: `You are an expert ontology analyst. Your task is to analyze documents and discover the ontology implied by the text.

Key principles:
- Analyze CONCEPTS, not extract data
- Ground all definitions in document language
- Provide evidence quotes for every concept and relationship
- Distinguish between entity-like concepts and attribute-like concepts
- Be conservative - only suggest concepts clearly supported by the document
- Return ONLY valid JSON, no explanations or markdown` 
        },
        { role: 'user', content: prompt }
      ], { temperature: 0.2, maxTokens: 4000 });

      suggestions = JSON.parse(this.extractJSON(response));
      
      // Normalize the new format to our internal format
      suggestions = this.normalizeOntologyAnalysis(suggestions);
      
    } catch (error) {
      console.error('   ⚠️ LLM analysis failed, using smart defaults:', error.message);
      suggestions = this.getSmartDefaults(text, documentName, detectedType, industry);
    }
    
    // If LLM returned too few results, augment with smart defaults
    if (suggestions.entityTypes.length < 3) {
      console.log('   📊 Augmenting with additional entity types...');
      const augmented = this.getSmartDefaults(text, documentName, detectedType, industry);
      
      // Add missing entity types
      const existingLabels = new Set(suggestions.entityTypes.map(e => e.label.toLowerCase()));
      for (const et of augmented.entityTypes) {
        if (!existingLabels.has(et.label.toLowerCase())) {
          suggestions.entityTypes.push(et);
        }
      }
      
      // Add missing relationships (case-insensitive comparison)
      const existingRels = new Set(suggestions.suggestedRelationships.map(r => 
        `${r.from.toLowerCase()}-${r.predicate.toLowerCase()}-${r.to.toLowerCase()}`
      ));
      for (const rel of augmented.suggestedRelationships) {
        const key = `${rel.from.toLowerCase()}-${rel.predicate.toLowerCase()}-${rel.to.toLowerCase()}`;
        if (!existingRels.has(key)) {
          suggestions.suggestedRelationships.push(rel);
        }
      }
      
      // Final deduplication pass
      suggestions.suggestedRelationships = this.deduplicateRelationships(suggestions.suggestedRelationships);
    }

    const analysisId = uuidv4();
    
    // Use LLM-detected domain if input industry is 'general' or 'auto'
    const detectedIndustry = (industry === 'general' || industry === 'auto') 
      ? (suggestions.primaryDomain || detectedType || 'general')
      : industry;
    
    console.log(`   🏭 Industry: ${industry === 'general' ? `auto-detected as "${detectedIndustry}"` : industry}`);
    
    const analysis = {
      id: analysisId,
      documentName,
      industry: detectedIndustry,
      filePath,
      fileType: docType,
      chunkingMethod,
      numPages,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      
      // Analysis mode info
      analysisMode: actualMode,
      analyzedChars: textSample.length,
      totalChars: text.length,
      coveragePercent: Math.round((textSample.length / text.length) * 100),
      
      // Schema suggestions with enhanced data
      entityTypes: suggestions.entityTypes.map(et => ({
        ...et,
        userLabel: et.label,
        include: true,
        suggestedProperties: et.suggestedProperties || [],
        category: et.category || et.type || 'general'
      })),
      relationships: suggestions.suggestedRelationships.map(r => ({
        ...r,
        userPredicate: r.predicate,
        include: true,
        direction: r.direction || 'directional',
        cardinality: r.cardinality || 'many-to-many'
      })),
      
      // Additional analysis results from new prompt
      attributeCandidates: suggestions.attributeCandidates || [],
      ontologyGaps: suggestions.ontologyGaps || [],
      uncertainties: suggestions.uncertainties || [],
      
      // Summary with enhanced info
      summary: {
        suggestedEntityTypes: suggestions.entityTypes.length,
        suggestedRelationships: suggestions.suggestedRelationships.length,
        documentType: suggestions.documentType || detectedType,
        primaryDomain: detectedIndustry,
        subDomains: suggestions.subDomains || [],
        documentSummary: suggestions.domainSummary || suggestions.summary || '',
        analysisMode: actualMode,
        analyzedChars: textSample.length,
        totalChars: text.length
      },
      
      // Store full extracted text for Phase 2 (important for PDFs!)
      extractedText: text,
      
      // Text preview for UI
      textPreview: text.substring(0, 1000)
    };

    // Store with Redis persistence
    await this.storeAnalysis(analysisId, analysis);
    
    console.log(`   ✅ Ontology analysis complete: ${analysisId}`);
    console.log(`      Candidate classes: ${analysis.summary.suggestedEntityTypes}`);
    console.log(`      Candidate relationships: ${analysis.summary.suggestedRelationships}`);
    console.log(`      Attribute candidates: ${analysis.attributeCandidates?.length || 0}`);
    console.log(`      Uncertainties: ${analysis.uncertainties?.length || 0}`);

    return analysis;
  }

  /**
   * Normalize the new ontology analysis format to our internal format
   */
  normalizeOntologyAnalysis(analysis) {
    const result = {
      entityTypes: [],
      suggestedRelationships: [],
      attributeCandidates: analysis.attribute_candidates || [],
      ontologyGaps: analysis.ontology_gaps || [],
      uncertainties: analysis.uncertainties || [],
      domainSummary: analysis.domain_summary || '',
      primaryDomain: ''
    };

    // Convert candidate_classes to entityTypes
    if (analysis.candidate_classes && Array.isArray(analysis.candidate_classes)) {
      result.entityTypes = analysis.candidate_classes.map(cc => ({
        label: this.toPascalCase(cc.name),
        description: cc.definition || '',
        examples: cc.evidence ? [cc.evidence] : [],
        confidence: 0.8,
        estimatedCount: 0,
        type: cc.type || 'entity',
        evidence: cc.evidence || '',
        category: cc.type || 'entity'
      }));
    }

    // Convert candidate_relationships to suggestedRelationships
    if (analysis.candidate_relationships && Array.isArray(analysis.candidate_relationships)) {
      result.suggestedRelationships = analysis.candidate_relationships.map(cr => ({
        from: this.toPascalCase(cr.from),
        to: this.toPascalCase(cr.to),
        predicate: cr.relation ? cr.relation.toUpperCase().replace(/\s+/g, '_') : 'RELATED_TO',
        description: cr.evidence || '',
        evidence: cr.evidence || '',
        direction: 'directional',
        cardinality: 'many-to-many'
      }));
    }

    // Extract domain from summary
    if (analysis.domain_summary) {
      // Try to extract a domain keyword from the summary
      const domainKeywords = ['legal', 'medical', 'financial', 'technical', 'educational', 'business', 'scientific'];
      const lowerSummary = analysis.domain_summary.toLowerCase();
      for (const keyword of domainKeywords) {
        if (lowerSummary.includes(keyword)) {
          result.primaryDomain = keyword;
          break;
        }
      }
    }

    return result;
  }

  /**
   * Update analysis with user edits
   */
  updateAnalysis(analysisId, updates) {
    console.log(`[SchemaAnalysisService] updateAnalysis called for: ${analysisId}`);
    console.log(`[SchemaAnalysisService] Updates received:`, {
      hasColumns: !!updates.columns,
      columnsCount: updates.columns?.length,
      hasEntityTypes: !!updates.entityTypes,
      entityTypesCount: updates.entityTypes?.length,
      hasRelationships: !!updates.relationships,
      relationshipsCount: updates.relationships?.length
    });
    
    const analysis = this.pendingAnalyses.get(analysisId);
    if (!analysis) {
      console.error(`[SchemaAnalysisService] Analysis not found: ${analysisId}`);
      console.error(`[SchemaAnalysisService] Available analysis IDs:`, Array.from(this.pendingAnalyses.keys()));
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    console.log(`[SchemaAnalysisService] Found analysis: ${analysis.id}, updating...`);

    // Apply updates
    if (updates.columns) {
      analysis.columns = updates.columns;
      console.log(`[SchemaAnalysisService] Updated columns: ${updates.columns.length}`);
    }
    if (updates.entityTypes) {
      analysis.entityTypes = updates.entityTypes;
      console.log(`[SchemaAnalysisService] Updated entityTypes: ${updates.entityTypes.length}`);
    }
    if (updates.relationships) {
      analysis.relationships = updates.relationships;
      console.log(`[SchemaAnalysisService] Updated relationships: ${updates.relationships.length}`);
    }

    // Recalculate summary
    if (analysis.columns) {
      analysis.summary.suggestedNodeColumns = analysis.columns.filter(c => c.includeAsNode).length;
      analysis.summary.suggestedPropertyColumns = analysis.columns.filter(c => c.includeAsProperty).length;
    }
    if (analysis.entityTypes) {
      analysis.summary.suggestedEntityTypes = analysis.entityTypes.filter(e => e.include !== false).length;
    }
    if (analysis.relationships) {
      analysis.summary.suggestedRelationships = analysis.relationships.filter(r => r.include !== false).length;
    }

    analysis.updatedAt = new Date().toISOString();
    
    // Store in memory
    this.pendingAnalyses.set(analysisId, analysis);
    
    // Also persist to Redis (async, don't wait)
    if (redisConnected && redisClient) {
      redisClient.setEx(
        `${ANALYSIS_PREFIX}${analysisId}`,
        ANALYSIS_TTL,
        JSON.stringify(analysis)
      ).catch(err => console.warn('Could not persist updated analysis to Redis:', err.message));
    }

    console.log(`[SchemaAnalysisService] ✅ Analysis updated successfully`);
    console.log(`[SchemaAnalysisService] Updated analysis:`, {
      id: analysis.id,
      entityTypesCount: analysis.entityTypes?.length || 0,
      relationshipsCount: analysis.relationships?.length || 0,
      columnsCount: analysis.columns?.length || 0
    });

    return analysis;
  }

  /**
   * Delete an analysis (user cancelled)
   */
  async deleteAnalysis(analysisId) {
    this.pendingAnalyses.delete(analysisId);
    
    // Also delete from Redis
    if (redisConnected && redisClient) {
      try {
        await redisClient.del(`${ANALYSIS_PREFIX}${analysisId}`);
      } catch (error) {
        console.warn('Could not delete analysis from Redis:', error.message);
      }
    }
    
    return true;
  }

  /**
   * Get approved schema from analysis
   */
  getApprovedSchema(analysisId) {
    const analysis = this.pendingAnalyses.get(analysisId);
    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    if (analysis.fileType === 'csv') {
      return {
        nodeColumns: analysis.columns
          .filter(c => c.includeAsNode)
          .map(c => ({
            column: c.column,
            label: c.userLabel || c.suggestedLabel,
            type: c.userType || c.suggestedType
          })),
        propertyColumns: analysis.columns
          .filter(c => c.includeAsProperty)
          .map(c => c.column),
        relationships: analysis.relationships
          .filter(r => r.include)
          .map(r => ({
            from: r.fromColumn,
            to: r.toColumn,
            predicate: r.userPredicate || r.suggestedPredicate
          }))
      };
    } else {
      return {
        entityTypes: analysis.entityTypes
          .filter(e => e.include)
          .map(e => ({
            label: e.userLabel || e.label,
            description: e.description
          })),
        relationships: analysis.relationships
          .filter(r => r.include)
          .map(r => ({
            from: r.from,
            to: r.to,
            predicate: r.userPredicate || r.predicate
          }))
      };
    }
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Sample a document by taking sections from beginning, middle, and end
   * @param {string} text - Full document text
   * @param {number} totalSize - Total chars to sample (split into 3 sections)
   * @returns {string} Sampled text with section markers
   */
  sampleDocument(text, totalSize = 20000) {
    if (text.length <= totalSize) {
      return text;
    }
    
    const sectionSize = Math.floor(totalSize / 3);
    
    // Beginning section
    const beginning = text.substring(0, sectionSize);
    
    // Middle section
    const middleStart = Math.floor(text.length / 2) - Math.floor(sectionSize / 2);
    const middle = text.substring(middleStart, middleStart + sectionSize);
    
    // End section
    const endStart = text.length - sectionSize;
    const end = text.substring(endStart);
    
    return `[BEGINNING OF DOCUMENT - chars 0-${sectionSize}]\n${beginning}\n\n` +
           `[MIDDLE OF DOCUMENT - chars ${middleStart}-${middleStart + sectionSize}]\n${middle}\n\n` +
           `[END OF DOCUMENT - chars ${endStart}-${text.length}]\n${end}`;
  }

  /**
   * Get sample values from throughout the dataset (not just beginning)
   */
  getSampleValues(rows, column, count = 5) {
    if (rows.length === 0) return [];
    
    const values = new Set();
    
    // Sample from beginning, middle, and end of dataset
    const indices = [];
    const step = Math.max(1, Math.floor(rows.length / count));
    for (let i = 0; i < rows.length && indices.length < count * 2; i += step) {
      indices.push(i);
    }
    // Always include last row
    if (rows.length > 1) indices.push(rows.length - 1);
    
    for (const idx of indices) {
      const row = rows[idx];
      if (row && row[column] && row[column].toString().trim()) {
        values.add(row[column].toString().trim());
        if (values.size >= count) break;
      }
    }
    
    return Array.from(values);
  }

  /**
   * Sample rows from throughout the dataset for representative coverage
   */
  sampleRows(rows, count = 10) {
    if (rows.length <= count) return rows;
    
    const sampled = [];
    const step = Math.floor(rows.length / count);
    
    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, rows.length - 1);
      sampled.push(rows[idx]);
    }
    
    return sampled;
  }

  async suggestColumnType(columnName, sampleValues, stats, industry) {
    const systemPrompt = `You are a knowledge graph schema expert. Analyze CSV columns and determine their role in a graph model.

Return ONLY valid JSON with this structure:
{
  "label": "ClassName",
  "type": "node or property",
  "includeAsNode": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}

Guidelines:
- Nodes represent entities that have identity and relationships
- Properties are attributes/values attached to nodes
- Consider the semantic meaning, not just data type`;

    const userPrompt = `Column: "${columnName}"
Sample values: ${JSON.stringify(sampleValues.slice(0, 5))}
Domain: ${industry}

Classify this column.`;

    try {
      const response = await llmService.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.2 });

      return JSON.parse(this.extractJSON(response));
    } catch (error) {
      // Return minimal default - let LLM retry or user decide
      return {
        label: this.toPascalCase(columnName),
        type: 'property',
        includeAsNode: false,
        confidence: 0.5,
        reasoning: 'Classification pending'
      };
    }
  }

  async suggestRelationships(columns, sampleRows, industry) {
    const nodeColumns = columns.filter(c => c.includeAsNode);
    
    if (nodeColumns.length < 2) {
      return [];
    }

    // Build context for LLM
    const columnContext = nodeColumns.map(c => 
      `${c.column} (${c.suggestedLabel}): ${c.sampleValues.join(', ')}`
    ).join('\n');

    const rowContext = sampleRows.slice(0, 3).map((row, i) => 
      `Row ${i + 1}: ${JSON.stringify(row)}`
    ).join('\n');

    const prompt = `Given these CSV columns that will become nodes in a knowledge graph:

${columnContext}

Sample rows:
${rowContext}

Industry: ${industry}

Suggest meaningful relationships between these node types.
Consider: What connects these entities? What relationships exist in each row?

Return JSON:
{
  "relationships": [
    {
      "fromColumn": "Name",
      "toColumn": "Department", 
      "suggestedPredicate": "BELONGS_TO",
      "description": "Person belongs to a department",
      "confidence": 0.9
    }
  ]
}`;

    try {
      const response = await llmService.chat([
        { role: 'system', content: 'You are a knowledge graph schema expert. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ], { temperature: 0.3 });

      const result = JSON.parse(this.extractJSON(response));
      return result.relationships.map(r => ({
        ...r,
        userPredicate: r.suggestedPredicate,
        include: true
      }));
    } catch (error) {
      // Fallback: create generic relationships between adjacent columns
      return this.generateDefaultRelationships(nodeColumns);
    }
  }

  generateDefaultRelationships(nodeColumns) {
    const relationships = [];
    
    for (let i = 0; i < nodeColumns.length - 1; i++) {
      const from = nodeColumns[i];
      const to = nodeColumns[i + 1];
      
      relationships.push({
        fromColumn: from.column,
        toColumn: to.column,
        suggestedPredicate: `HAS_${this.toSnakeCase(to.suggestedLabel).toUpperCase()}`,
        userPredicate: `HAS_${this.toSnakeCase(to.suggestedLabel).toUpperCase()}`,
        description: `${from.suggestedLabel} has associated ${to.suggestedLabel}`,
        confidence: 0.6,
        include: true
      });
    }
    
    return relationships;
  }

  /**
   * Detect document type from content and filename
   */
  detectDocumentType(text, filename) {
    const lowerText = text.toLowerCase();
    const lowerFilename = filename.toLowerCase();
    
    // Resume detection
    if (lowerFilename.includes('resume') || lowerFilename.includes('cv') ||
        lowerText.includes('work experience') || lowerText.includes('education') ||
        lowerText.includes('skills') || lowerText.includes('employment history') ||
        (lowerText.includes('objective') && lowerText.includes('experience'))) {
      return 'resume';
    }
    
    // Research paper
    if (lowerText.includes('abstract') && lowerText.includes('references') &&
        (lowerText.includes('methodology') || lowerText.includes('conclusion'))) {
      return 'research_paper';
    }
    
    // Contract/Legal
    if (lowerText.includes('whereas') || lowerText.includes('hereby') ||
        lowerText.includes('terms and conditions') || lowerText.includes('agreement')) {
      return 'legal_document';
    }
    
    // Technical documentation
    if (lowerText.includes('api') || lowerText.includes('function') ||
        lowerText.includes('parameter') || lowerText.includes('installation')) {
      return 'technical_documentation';
    }
    
    // News/Article
    if (lowerText.includes('reporter') || lowerText.includes('published') ||
        lowerText.includes('according to sources')) {
      return 'news_article';
    }
    
    return 'general_document';
  }

  /**
   * Get smart defaults based on detected document type
   */
  getSmartDefaults(text, filename, detectedType, industry) {
    const lowerText = text.toLowerCase();
    
    // Document-type specific defaults
    const typeDefaults = {
      resume: {
        entityTypes: [
          { label: 'Person', description: 'The job candidate or referenced individuals', examples: [], confidence: 0.95, estimatedCount: 1 },
          { label: 'Organization', description: 'Companies, universities, institutions', examples: [], confidence: 0.9, estimatedCount: 5 },
          { label: 'Role', description: 'Job titles and positions held', examples: [], confidence: 0.9, estimatedCount: 5 },
          { label: 'Skill', description: 'Technical and soft skills', examples: [], confidence: 0.9, estimatedCount: 10 },
          { label: 'Education', description: 'Degrees, certifications, courses', examples: [], confidence: 0.85, estimatedCount: 3 },
          { label: 'Project', description: 'Named projects or initiatives', examples: [], confidence: 0.8, estimatedCount: 5 },
          { label: 'Technology', description: 'Programming languages, tools, frameworks', examples: [], confidence: 0.85, estimatedCount: 10 },
          { label: 'Location', description: 'Cities, countries, work locations', examples: [], confidence: 0.7, estimatedCount: 3 },
          { label: 'TimePeriod', description: 'Employment dates, durations', examples: [], confidence: 0.8, estimatedCount: 5 },
          { label: 'Achievement', description: 'Accomplishments and metrics', examples: [], confidence: 0.75, estimatedCount: 5 }
        ],
        suggestedRelationships: [
          { from: 'Person', to: 'Organization', predicate: 'WORKED_AT', description: 'Employment relationship' },
          { from: 'Person', to: 'Role', predicate: 'HAD_ROLE', description: 'Job position held' },
          { from: 'Person', to: 'Skill', predicate: 'HAS_SKILL', description: 'Skills possessed' },
          { from: 'Person', to: 'Education', predicate: 'HAS_EDUCATION', description: 'Educational background' },
          { from: 'Person', to: 'Project', predicate: 'WORKED_ON', description: 'Project involvement' },
          { from: 'Role', to: 'Organization', predicate: 'AT_ORGANIZATION', description: 'Role at company' },
          { from: 'Project', to: 'Technology', predicate: 'USES', description: 'Technology used in project' },
          { from: 'Education', to: 'Organization', predicate: 'FROM', description: 'Educational institution' }
        ]
      },
      research_paper: {
        entityTypes: [
          { label: 'Author', description: 'Paper authors and researchers', examples: [], confidence: 0.95, estimatedCount: 3 },
          { label: 'Institution', description: 'Universities and research organizations', examples: [], confidence: 0.9, estimatedCount: 3 },
          { label: 'Concept', description: 'Key concepts and theories', examples: [], confidence: 0.85, estimatedCount: 10 },
          { label: 'Method', description: 'Research methodologies', examples: [], confidence: 0.8, estimatedCount: 5 },
          { label: 'Finding', description: 'Research findings and results', examples: [], confidence: 0.8, estimatedCount: 5 },
          { label: 'Citation', description: 'Referenced works', examples: [], confidence: 0.85, estimatedCount: 20 },
          { label: 'Dataset', description: 'Data sources used', examples: [], confidence: 0.7, estimatedCount: 3 }
        ],
        suggestedRelationships: [
          { from: 'Author', to: 'Institution', predicate: 'AFFILIATED_WITH', description: 'Author affiliation' },
          { from: 'Method', to: 'Finding', predicate: 'PRODUCES', description: 'Method leads to finding' },
          { from: 'Finding', to: 'Concept', predicate: 'SUPPORTS', description: 'Finding supports concept' },
          { from: 'Citation', to: 'Concept', predicate: 'DISCUSSES', description: 'Citation covers concept' }
        ]
      },
      legal_document: {
        entityTypes: [
          { label: 'Party', description: 'Contract parties (individuals/organizations)', examples: [], confidence: 0.95, estimatedCount: 2 },
          { label: 'Obligation', description: 'Contractual obligations', examples: [], confidence: 0.9, estimatedCount: 10 },
          { label: 'Term', description: 'Legal terms and definitions', examples: [], confidence: 0.85, estimatedCount: 10 },
          { label: 'Date', description: 'Important dates and deadlines', examples: [], confidence: 0.9, estimatedCount: 5 },
          { label: 'Amount', description: 'Financial amounts and fees', examples: [], confidence: 0.85, estimatedCount: 5 },
          { label: 'Clause', description: 'Contract clauses and sections', examples: [], confidence: 0.8, estimatedCount: 15 }
        ],
        suggestedRelationships: [
          { from: 'Party', to: 'Obligation', predicate: 'HAS_OBLIGATION', description: 'Party must fulfill obligation' },
          { from: 'Clause', to: 'Obligation', predicate: 'DEFINES', description: 'Clause defines obligation' },
          { from: 'Obligation', to: 'Date', predicate: 'DUE_BY', description: 'Obligation deadline' }
        ]
      },
      technical_documentation: {
        entityTypes: [
          { label: 'API', description: 'API endpoints and interfaces', examples: [], confidence: 0.9, estimatedCount: 10 },
          { label: 'Function', description: 'Functions and methods', examples: [], confidence: 0.9, estimatedCount: 20 },
          { label: 'Parameter', description: 'Function parameters', examples: [], confidence: 0.85, estimatedCount: 30 },
          { label: 'DataType', description: 'Data types and structures', examples: [], confidence: 0.85, estimatedCount: 10 },
          { label: 'Module', description: 'Code modules and packages', examples: [], confidence: 0.8, estimatedCount: 5 },
          { label: 'Example', description: 'Code examples', examples: [], confidence: 0.75, estimatedCount: 15 }
        ],
        suggestedRelationships: [
          { from: 'API', to: 'Function', predicate: 'EXPOSES', description: 'API exposes function' },
          { from: 'Function', to: 'Parameter', predicate: 'ACCEPTS', description: 'Function parameter' },
          { from: 'Function', to: 'DataType', predicate: 'RETURNS', description: 'Return type' },
          { from: 'Module', to: 'Function', predicate: 'CONTAINS', description: 'Module contains function' }
        ]
      },
      general_document: {
        entityTypes: [
          { label: 'Person', description: 'People mentioned', examples: [], confidence: 0.7, estimatedCount: 5 },
          { label: 'Organization', description: 'Organizations mentioned', examples: [], confidence: 0.7, estimatedCount: 3 },
          { label: 'Location', description: 'Places mentioned', examples: [], confidence: 0.7, estimatedCount: 3 },
          { label: 'Date', description: 'Dates and time periods', examples: [], confidence: 0.7, estimatedCount: 5 },
          { label: 'Topic', description: 'Main topics discussed', examples: [], confidence: 0.6, estimatedCount: 5 },
          { label: 'Event', description: 'Events mentioned', examples: [], confidence: 0.6, estimatedCount: 3 }
        ],
        suggestedRelationships: [
          { from: 'Person', to: 'Organization', predicate: 'ASSOCIATED_WITH', description: 'Person-organization relationship' },
          { from: 'Event', to: 'Location', predicate: 'OCCURRED_AT', description: 'Event location' },
          { from: 'Event', to: 'Date', predicate: 'ON_DATE', description: 'Event date' },
          { from: 'Person', to: 'Event', predicate: 'PARTICIPATED_IN', description: 'Person involvement in event' }
        ]
      }
    };
    
    return typeDefaults[detectedType] || typeDefaults.general_document;
  }

  getDefaultTextSuggestions(industry) {
    const defaults = {
      general: {
        entityTypes: [
          { label: 'Entity', description: 'Generic entity', examples: [], confidence: 0.5, estimatedCount: 0 },
          { label: 'Concept', description: 'Abstract concept', examples: [], confidence: 0.5, estimatedCount: 0 }
        ],
        suggestedRelationships: [
          { from: 'Entity', to: 'Concept', predicate: 'RELATED_TO', description: 'Generic relationship' }
        ]
      },
      healthcare: {
        entityTypes: [
          { label: 'Drug', description: 'Medications and treatments', examples: [], confidence: 0.7, estimatedCount: 0 },
          { label: 'Disease', description: 'Medical conditions', examples: [], confidence: 0.7, estimatedCount: 0 },
          { label: 'Symptom', description: 'Clinical symptoms', examples: [], confidence: 0.7, estimatedCount: 0 }
        ],
        suggestedRelationships: [
          { from: 'Drug', to: 'Disease', predicate: 'TREATS', description: 'Treatment relationship' },
          { from: 'Disease', to: 'Symptom', predicate: 'CAUSES', description: 'Symptom causation' }
        ]
      },
      technology: {
        entityTypes: [
          { label: 'Technology', description: 'Software/hardware', examples: [], confidence: 0.7, estimatedCount: 0 },
          { label: 'Service', description: 'System components', examples: [], confidence: 0.7, estimatedCount: 0 },
          { label: 'Organization', description: 'Companies/teams', examples: [], confidence: 0.7, estimatedCount: 0 }
        ],
        suggestedRelationships: [
          { from: 'Technology', to: 'Service', predicate: 'POWERS', description: 'Technology enables service' },
          { from: 'Organization', to: 'Technology', predicate: 'USES', description: 'Organization uses technology' }
        ]
      }
    };

    return defaults[industry] || defaults.general;
  }

  /**
   * Deduplicate entity types by label (case-insensitive)
   */
  deduplicateEntityTypes(entityTypes) {
    const seen = new Map();
    return entityTypes.filter(et => {
      const key = et.label.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, true);
      return true;
    });
  }

  /**
   * Deduplicate relationships by from-predicate-to (case-insensitive)
   */
  deduplicateRelationships(relationships) {
    const seen = new Map();
    return relationships.filter(rel => {
      const key = `${rel.from.toLowerCase()}-${rel.predicate.toLowerCase()}-${rel.to.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, true);
      return true;
    });
  }

  extractJSON(text) {
    // Try to find JSON in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    return text;
  }

  toPascalCase(str) {
    return str
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  toSnakeCase(str) {
    return str
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '')
      .replace(/[^a-z0-9_]/g, '_');
  }

  cleanupOldAnalyses() {
    const now = new Date();
    for (const [id, analysis] of this.pendingAnalyses) {
      if (new Date(analysis.expiresAt) < now) {
        this.pendingAnalyses.delete(id);
        console.log(`🧹 Cleaned up expired analysis: ${id}`);
      }
    }
  }
}

module.exports = new SchemaAnalysisService();

