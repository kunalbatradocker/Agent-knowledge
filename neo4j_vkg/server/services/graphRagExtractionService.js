/**
 * GraphRAG Extraction Service
 * Expert-level ontology and knowledge graph extraction from unstructured text
 * Supports alignment to existing ontologies and suggests missing terms
 * 
 * EXTRACTION PRINCIPLES:
 * 1. Extract SPECIFIC named entities, not generic concepts
 * 2. Use ontology types when provided - don't invent new types
 * 3. Extract ALL properties defined in ontology for each entity type
 * 4. Ensure relationship source/target labels EXACTLY match entity labels
 * 5. Provide source spans for traceability
 */

const llmService = require('./llmService');
const logger = require('../utils/logger');

class GraphRagExtractionService {
  constructor() {
    logger.info(`🧠 GraphRagExtractionService initialized (using shared llmService)`);
  }

  /**
   * Get timeout from Redis settings or use default
   */
  async getTimeoutMs() {
    try {
      const { client: redisClient } = require('../config/redis');
      const settingsJson = await redisClient.hGet('app:settings', 'llm');
      if (settingsJson) {
        const settings = JSON.parse(settingsJson);
        if (settings.llmTimeout) {
          return settings.llmTimeout * 1000; // Convert seconds to ms
        }
      }
    } catch (error) {
      logger.debug('Could not fetch LLM settings from Redis, using default');
    }
    // Default: 5 minutes for local LLM, 2 minutes for cloud
    return this.useLocalLLM ? 300000 : 120000;
  }

  /**
   * Get the system prompt for entity extraction
   */
  getSystemPrompt() {
    return `You are a knowledge graph extractor. Extract named entities and relationships from text.

Output valid JSON with:
- entities: Array of specific named entities found in text
- relationships: Array of connections between entities

Rules:
- Extract specific instances (names, organizations, places), not generic concepts
- Use provided entity types when available
- Relationships must connect entities that exist in your entities array
- sourceLabel and targetLabel must exactly match entity labels`;
  }

  /**
   * Build the extraction prompt with optional existing ontology alignment
   */
  buildExtractionPrompt(text, options = {}) {
    const { domain, existingOntology } = options;
    
    let prompt = `# EXTRACT ENTITIES AND RELATIONSHIPS

Domain: ${domain || 'General'}

## TEXT:
${text}

`;

    if (existingOntology && (existingOntology.entityTypes?.length > 0 || existingOntology.relationships?.length > 0)) {
      const entityTypesSection = (existingOntology.entityTypes || []).map(et => {
        const label = typeof et === 'string' ? et : (et.userLabel || et.label || et.type || et.name);
        return label;
      }).join(', ');
      
      const relTypesSection = (existingOntology.relationships || []).map(r => {
        const type = typeof r === 'string' ? r : (r.type || r.predicate || r.name || r.label);
        return type;
      }).join(', ');
      
      prompt += `## ENTITY TYPES: ${entityTypesSection || 'Any'}

## RELATIONSHIP TYPES: ${relTypesSection || 'Any'}

`;
    }

    prompt += `## OUTPUT (JSON only):
{
  "entities": [{"id": "e1", "label": "Name", "type": "Type", "confidence": 0.9}],
  "relationships": [{"id": "r1", "sourceLabel": "Source", "targetLabel": "Target", "predicate": "TYPE", "confidence": 0.85}]
}`;

    return prompt;
  }

  /**
   * Extract entities and relationships from text with ontology alignment
   */
  async extractFromText(text, options = {}) {
    const {
      extractionMode = 'auto',
      maxChars = 100000,
      chunkThreshold = 80000,
      chunkSize = 20000
    } = options;

    logger.extraction(`LLM extraction: ${(text.length / 1000).toFixed(1)}K chars, mode: ${extractionMode}`);
    
    // Determine actual extraction approach
    let actualMode;
    
    if (extractionMode === 'chunked') {
      actualMode = 'chunked';
      return this.extractWithChunks(text, chunkSize, options);
    } else if (extractionMode === 'full') {
      actualMode = 'full';
      const truncatedText = text.length > maxChars 
        ? text.substring(0, maxChars) + '\n\n[Text truncated due to length...]'
        : text;
      return this.extractFromTextInternal(truncatedText, options, actualMode);
    } else {
      // Auto mode - choose based on document size
      if (text.length > chunkThreshold) {
        actualMode = 'chunked';
        return this.extractWithChunks(text, chunkSize, options);
      } else {
        actualMode = 'full';
        return this.extractFromTextInternal(text, options, actualMode);
      }
    }
  }

  /**
   * Internal extraction method for single-pass extraction
   */
  async extractFromTextInternal(text, options = {}, mode = 'full') {
    const maxChars = options.maxChars || 100000;
    const truncatedText = text.length > maxChars 
      ? text.substring(0, maxChars) + '\n\n[Text truncated due to length...]'
      : text;

    console.log('\n' + '📝'.repeat(40));
    console.log('📝 STARTING EXTRACTION');
    console.log(`   Mode: ${mode}`);
    console.log(`   Text length: ${(text.length / 1000).toFixed(1)}K chars`);
    console.log(`   Truncated to: ${(truncatedText.length / 1000).toFixed(1)}K chars`);
    console.log(`   Ontology: ${options.existingOntology?.entityTypes?.length || 0} entity types, ${options.existingOntology?.relationships?.length || 0} relationships`);
    console.log(`   Domain: ${options.domain || 'General'}`);
    console.log('📝'.repeat(40) + '\n');

    logger.info(`📝 Starting extraction: ${(truncatedText.length / 1000).toFixed(1)}K chars, mode: ${mode}`);

    const prompt = this.buildExtractionPrompt(truncatedText, options);

    // Log the full prompt being sent to LLM
    console.log('\n' + '='.repeat(80));
    console.log('📤 FULL LLM PROMPT:');
    console.log('='.repeat(80));
    console.log(prompt);
    console.log('='.repeat(80) + '\n');

    try {
      const startTime = Date.now();
      
      console.log('\n' + '🤖'.repeat(40));
      console.log(`⏳ SENDING REQUEST TO LLM`);
      console.log(`   Prompt size: ${(prompt.length / 1000).toFixed(1)}K chars`);
      console.log(`   Time: ${new Date().toISOString()}`);
      console.log('🤖'.repeat(40) + '\n');
      
      const content = await llmService.chat([
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: prompt }
      ], { temperature: 0 });
      
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(1);
      
      console.log('\n' + '✅'.repeat(40));
      console.log(`✅ LLM RESPONSE COMPLETE`);
      console.log(`   Duration: ${duration}s`);
      console.log(`   Response: ${content.length} chars, ~${tokenCount} tokens`);
      console.log(`   Speed: ${(tokenCount / (endTime - startTime) * 1000).toFixed(1)} tokens/sec`);
      console.log('✅'.repeat(40) + '\n');
      
      logger.info(`🤖 LLM response in ${duration}s (${content.length} chars)`);
      
      // Log raw LLM response for debugging
      console.log('\n📥 RAW LLM RESPONSE (first 2000 chars):');
      console.log(content.substring(0, 2000));
      console.log('\n');
      
      content = this.extractJSON(content);
      
      let extraction;
      try {
        extraction = JSON.parse(content);
      } catch (parseError) {
        logger.warn(`JSON parse error: ${parseError.message}`);
        // Try to repair the JSON
        extraction = this.repairJSON(content);
      }
      
      // Log what was extracted before normalization
      console.log(`📊 Before normalization: ${extraction.entities?.length || 0} entities, ${extraction.relationships?.length || 0} relationships`);
      if (extraction.relationships?.length > 0) {
        console.log('First 3 relationships from LLM:');
        extraction.relationships.slice(0, 3).forEach((r, i) => {
          console.log(`  ${i+1}. ${r.sourceLabel || r.source} → ${r.predicate || r.type} → ${r.targetLabel || r.target}`);
        });
      }
      
      let normalized = this.normalizeExtraction(extraction, options);

      // If no relationships extracted and we have entities, try a second pass for relationships
      if (normalized.relationships.length === 0 && normalized.entities.length > 0 && this.useLocalLLM) {
        console.log('\n' + '🔄'.repeat(40));
        console.log('🔄 SECOND PASS - RELATIONSHIP EXTRACTION');
        console.log(`   Entities found: ${normalized.entities.length}`);
        console.log('🔄'.repeat(40) + '\n');
        
        logger.info('🔄 No relationships found, attempting relationship extraction pass...');
        const relExtraction = await this.extractRelationshipsOnly(truncatedText, normalized.entities, options);
        if (relExtraction.relationships.length > 0) {
          normalized.relationships = relExtraction.relationships;
          normalized.stats.relationshipCount = relExtraction.relationships.length;
          logger.info(`📊 Second pass found ${relExtraction.relationships.length} relationships`);
        }
      }

      console.log('\n' + '🎉'.repeat(40));
      console.log('🎉 EXTRACTION COMPLETE');
      console.log(`   Entities: ${normalized.stats.entityCount}`);
      console.log(`   Relationships: ${normalized.stats.relationshipCount}`);
      console.log(`   Skipped relationships: ${normalized.stats.skippedRelationships || 0}`);
      console.log('🎉'.repeat(40) + '\n');

      logger.info(`📊 Extracted: ${normalized.stats.entityCount} entities, ${normalized.stats.relationshipCount} relationships`);

      // Add extraction mode info
      normalized.extractionMode = mode;
      normalized.analyzedChars = truncatedText.length;
      normalized.totalChars = text.length;

      return normalized;
    } catch (error) {
      logger.error('GraphRAG extraction error:', error.message);
      throw error;
    }
  }

  /**
   * Second-pass extraction specifically for relationships
   * Used when first pass extracts entities but no relationships
   */
  async extractRelationshipsOnly(text, entities, options = {}) {
    const { existingOntology } = options;
    
    // Build a focused prompt for relationship extraction
    const entityList = entities.slice(0, 30).map(e => `- ${e.label} (${e.type})`).join('\n');
    
    let relTypes = 'RELATED_TO, WORKS_AT, HAS_SKILL, KNOWS';
    if (existingOntology?.relationships?.length > 0) {
      relTypes = existingOntology.relationships.map(r => {
        const type = typeof r === 'string' ? r : (r.type || r.predicate || r.name || r.label);
        return type;
      }).join(', ');
    }
    
    const prompt = `# EXTRACT RELATIONSHIPS BETWEEN ENTITIES

## ENTITIES FOUND IN TEXT:
${entityList}

## ALLOWED RELATIONSHIP TYPES:
${relTypes}

## TEXT:
"""
${text.substring(0, 8000)}
"""

## TASK:
Find relationships between the entities listed above. Look for:
- Employment (who works where)
- Skills (who has what skills)
- Education (who studied where)
- Any other connections

## OUTPUT (JSON array only):
[
  {"sourceLabel": "Entity Name 1", "targetLabel": "Entity Name 2", "predicate": "RELATIONSHIP_TYPE", "confidence": 0.8}
]

Return ONLY the JSON array. sourceLabel and targetLabel must EXACTLY match entity names from the list above.`;

    console.log('\n' + '='.repeat(60));
    console.log('🔄 SECOND PASS - RELATIONSHIP EXTRACTION PROMPT:');
    console.log('='.repeat(60));
    console.log(prompt.substring(0, 2000) + '...');
    console.log('='.repeat(60) + '\n');

    try {
      let content = await llmService.chat([
        { role: 'system', content: 'You extract relationships between entities. Return only valid JSON array.' },
        { role: 'user', content: prompt }
      ], { temperature: 0 });
      
      console.log('\n📥 SECOND PASS RAW RESPONSE:');
      console.log(content.substring(0, 1000));
      console.log('\n');
      
      // Try to extract JSON array
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        content = arrayMatch[0];
      }
      
      let relationships;
      try {
        relationships = JSON.parse(content);
      } catch (parseErr) {
        console.log('❌ Failed to parse JSON:', parseErr.message);
        return { relationships: [] };
      }
      
      console.log(`📊 Parsed ${Array.isArray(relationships) ? relationships.length : 0} relationships from second pass`);
      
      // Build entity label lookup (case-insensitive)
      const entityLabels = new Set(entities.map(e => e.label.toLowerCase()));
      const entityLabelMap = new Map(entities.map(e => [e.label.toLowerCase(), e.label]));
      
      console.log(`📋 Entity labels for matching: ${Array.from(entityLabels).slice(0, 10).join(', ')}...`);
      
      const validRels = (Array.isArray(relationships) ? relationships : [])
        .map((r, i) => {
          const srcLower = (r.sourceLabel || '').toLowerCase();
          const tgtLower = (r.targetLabel || '').toLowerCase();
          const srcMatch = entityLabels.has(srcLower);
          const tgtMatch = entityLabels.has(tgtLower);
          
          if (!srcMatch || !tgtMatch) {
            console.log(`  ⚠️ Skipping rel ${i}: "${r.sourceLabel}" (${srcMatch ? '✓' : '✗'}) → "${r.targetLabel}" (${tgtMatch ? '✓' : '✗'})`);
          }
          
          return {
            ...r,
            srcMatch,
            tgtMatch,
            // Use the original case from entities
            sourceLabel: entityLabelMap.get(srcLower) || r.sourceLabel,
            targetLabel: entityLabelMap.get(tgtLower) || r.targetLabel
          };
        })
        .filter(r => r.srcMatch && r.tgtMatch && r.predicate)
        .map((r, i) => ({
          id: `rel_2nd_${i + 1}`,
          sourceLabel: r.sourceLabel,
          targetLabel: r.targetLabel,
          predicate: (r.predicate || 'RELATED_TO').toUpperCase().replace(/\s+/g, '_'),
          confidence: r.confidence || 0.7,
          sourceSpan: r.sourceSpan || ''
        }));
      
      console.log(`✅ Valid relationships after filtering: ${validRels.length}`);
      
      return { relationships: validRels };
    } catch (error) {
      console.log('❌ Relationship extraction pass failed:', error.message);
      logger.warn('Relationship extraction pass failed:', error.message);
      return { relationships: [] };
    }
  }

  /**
   * Extract from text using chunked approach
   * Splits document into chunks, extracts from each, then merges results
   */
  async extractWithChunks(text, chunkSize = 20000, options = {}) {
    // Create simple chunks
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push({
        text: text.substring(i, Math.min(i + chunkSize, text.length)),
        index: chunks.length,
        startChar: i,
        endChar: Math.min(i + chunkSize, text.length)
      });
    }
    
    logger.debug(`Split into ${chunks.length} chunks`);
    
    const result = await this.extractFromChunks(chunks, options);
    
    // Add extraction mode info
    result.extractionMode = 'chunked';
    result.chunksProcessed = chunks.length;
    result.chunkSize = chunkSize;
    result.analyzedChars = text.length;
    result.totalChars = text.length;
    
    return result;
  }


  /**
   * Extract and clean JSON from LLM response
   */
  extractJSON(content) {
    if (!content) throw new Error('Empty response from LLM');

    let cleaned = content.trim();

    // Extract from markdown code blocks
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    // Find first { and matching }
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) {
      cleaned = cleaned.substring(firstBrace);
    }

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

    // Fix common JSON issues from LLMs
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1'); // trailing commas
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' '); // control chars
    cleaned = cleaned.replace(/\n\s*\n/g, '\n'); // multiple newlines
    cleaned = cleaned.replace(/"\s*\n\s*"/g, '", "'); // broken string arrays
    cleaned = cleaned.replace(/(\w)"(\w)/g, '$1\\"$2'); // unescaped quotes in strings
    
    // Fix missing colons after property names (common LLM error)
    // Pattern: "propertyName" followed by value without colon
    cleaned = cleaned.replace(/"([^"]+)"\s+(?=")/g, '"$1": ');
    cleaned = cleaned.replace(/"([^"]+)"\s+(?=\[)/g, '"$1": ');
    cleaned = cleaned.replace(/"([^"]+)"\s+(?=\{)/g, '"$1": ');
    cleaned = cleaned.replace(/"([^"]+)"\s+(?=\d)/g, '"$1": ');
    cleaned = cleaned.replace(/"([^"]+)"\s+(?=true|false|null)/gi, '"$1": ');

    return cleaned;
  }
  
  /**
   * Attempt to repair malformed JSON from LLM
   */
  repairJSON(content) {
    try {
      // First try direct parse
      return JSON.parse(content);
    } catch (e) {
      logger.debug(`JSON parse failed, attempting repair: ${e.message}`);
      
      let repaired = content;
      
      // Try to fix the specific position mentioned in error
      const posMatch = e.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1]);
        const before = repaired.substring(Math.max(0, pos - 50), pos);
        const after = repaired.substring(pos, Math.min(repaired.length, pos + 50));
        logger.debug(`Error context: ...${before}[HERE]${after}...`);
        
        // Check if missing colon
        if (e.message.includes("Expected ':'")) {
          // Find the property name before this position
          const beforePos = repaired.substring(0, pos);
          const lastQuote = beforePos.lastIndexOf('"');
          if (lastQuote > 0) {
            // Insert colon after the closing quote of property name
            repaired = repaired.substring(0, lastQuote + 1) + ': ' + repaired.substring(lastQuote + 1);
          }
        }
      }
      
      // Try parsing again
      try {
        return JSON.parse(repaired);
      } catch (e2) {
        // Last resort: try to extract just entities and relationships arrays
        logger.warn('JSON repair failed, attempting partial extraction');
        return this.extractPartialJSON(content);
      }
    }
  }
  
  /**
   * Extract partial data from malformed JSON
   */
  extractPartialJSON(content) {
    const result = {
      entities: [],
      relationships: [],
      extractionSummary: {},
      ontologySuggestions: { newEntityTypes: [], newRelationshipTypes: [], newDatatypeProperties: [] },
      assumptions: []
    };
    
    try {
      // Try to extract entities array
      const entitiesMatch = content.match(/"entities"\s*:\s*\[([\s\S]*?)\](?=\s*,?\s*")/);
      if (entitiesMatch) {
        try {
          const entitiesStr = '[' + entitiesMatch[1] + ']';
          // Clean up the array string
          const cleanedEntities = entitiesStr
            .replace(/,\s*]/g, ']')
            .replace(/,\s*,/g, ',');
          result.entities = JSON.parse(cleanedEntities);
          logger.info(`Partial extraction recovered ${result.entities.length} entities`);
        } catch (ee) {
          logger.debug('Could not parse entities array');
        }
      }
      
      // Try to extract relationships array
      const relsMatch = content.match(/"relationships"\s*:\s*\[([\s\S]*?)\](?=\s*,?\s*"|\s*})/);
      if (relsMatch) {
        try {
          const relsStr = '[' + relsMatch[1] + ']';
          const cleanedRels = relsStr
            .replace(/,\s*]/g, ']')
            .replace(/,\s*,/g, ',');
          result.relationships = JSON.parse(cleanedRels);
          logger.info(`Partial extraction recovered ${result.relationships.length} relationships`);
        } catch (re) {
          logger.debug('Could not parse relationships array');
        }
      }
    } catch (error) {
      logger.warn('Partial JSON extraction failed:', error.message);
    }
    
    return result;
  }

  /**
   * Normalize extraction results
   */
  normalizeExtraction(extraction, options = {}) {
    const existingOntology = options.existingOntology || {};
    
    // Debug: Log what ontology was received
    logger.debug(`normalizeExtraction received ontology with ${existingOntology.entityTypes?.length || 0} entity types, ${existingOntology.relationships?.length || 0} relationships`);
    
    const existingTypes = new Set(
      (existingOntology.entityTypes || []).map(et => 
        (typeof et === 'string' ? et : (et.userLabel || et.label || et.type))?.toLowerCase()
      ).filter(Boolean)
    );
    const existingPredicates = new Set(
      (existingOntology.relationships || []).map(r =>
        (typeof r === 'string' ? r : (r.type || r.predicate || r.label))?.toUpperCase().replace(/\s+/g, '_')
      ).filter(Boolean)
    );
    
    // Build relationship constraints map: predicate -> { sourceTypes: Set, targetTypes: Set }
    const relationshipConstraints = new Map();
    (existingOntology.relationships || []).forEach(r => {
      const predicate = (typeof r === 'string' ? r : (r.type || r.predicate || r.name || r.label))?.toUpperCase().replace(/\s+/g, '_');
      if (!predicate) return;
      
      const sourceTypes = r.source_types || r.domain || r.from;
      const targetTypes = r.target_types || r.range || r.to;
      
      const sourceSet = new Set();
      const targetSet = new Set();
      
      if (sourceTypes) {
        (Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes]).forEach(t => sourceSet.add(t.toLowerCase()));
      }
      if (targetTypes) {
        (Array.isArray(targetTypes) ? targetTypes : [targetTypes]).forEach(t => targetSet.add(t.toLowerCase()));
      }
      
      relationshipConstraints.set(predicate, { sourceTypes: sourceSet, targetTypes: targetSet });
    });
    
    logger.debug(`Built relationship constraints for ${relationshipConstraints.size} predicates`);
    
    logger.debug(`Existing predicates for matching: ${Array.from(existingPredicates).join(', ') || 'NONE'}`);
    logger.debug(`LLM returned ${extraction.relationships?.length || 0} relationships`);

    // Normalize entities
    const entities = (extraction.entities || []).map((e, idx) => {
      const type = e.type || 'Entity';
      const typeNormalized = type.toLowerCase();
      
      return {
        id: e.id || `entity_${idx + 1}`,
        label: e.label || e.name || 'Unknown',
        type: type,
        typeSource: existingTypes.has(typeNormalized) ? 'existing' : 'suggested',
        properties: e.properties || {},
        sourceSpan: e.sourceSpan || '',
        confidence: Math.min(Math.max(e.confidence || 0.7, 0.5), 1.0)
      };
    });

    // Build label to ID map for relationship resolution
    const labelToId = new Map();
    const labelToEntity = new Map();
    entities.forEach(e => {
      const lowerLabel = e.label.toLowerCase();
      labelToId.set(lowerLabel, e.id);
      labelToId.set(e.label, e.id);
      labelToEntity.set(lowerLabel, e);
      labelToEntity.set(e.label, e);
    });

    // Normalize relationships with better source/target resolution
    const relationships = (extraction.relationships || []).map((r, idx) => {
      // Try multiple ways to resolve source entity
      const sourceLabel = r.sourceLabel || r.source || r.from || '';
      const targetLabel = r.targetLabel || r.target || r.to || '';
      
      const sourceId = r.sourceId || labelToId.get(sourceLabel) || labelToId.get(sourceLabel.toLowerCase());
      const targetId = r.targetId || labelToId.get(targetLabel) || labelToId.get(targetLabel.toLowerCase());
      
      // Get entity types for validation
      const sourceEntity = labelToEntity.get(sourceLabel.toLowerCase());
      const targetEntity = labelToEntity.get(targetLabel.toLowerCase());
      
      // Normalize predicate
      let predicate = (r.predicate || r.type || r.relationship || 'RELATED_TO')
        .toUpperCase()
        .replace(/\s+/g, '_')
        .replace(/[^A-Z0-9_]/g, '');
      
      return {
        id: r.id || `rel_${idx + 1}`,
        sourceId: sourceId || `unknown_${idx}_source`,
        sourceLabel: sourceLabel || 'Unknown',
        sourceType: sourceEntity?.type?.toLowerCase() || null,
        targetId: targetId || `unknown_${idx}_target`,
        targetLabel: targetLabel || 'Unknown',
        targetType: targetEntity?.type?.toLowerCase() || null,
        predicate: predicate,
        predicateSource: existingPredicates.has(predicate) ? 'existing' : 'suggested',
        properties: r.properties || {},
        sourceSpan: r.sourceSpan || '',
        confidence: Math.min(Math.max(r.confidence || 0.7, 0.5), 1.0)
      };
    });

    // Filter out relationships with unresolved entities
    let validRelationships = relationships.filter(r => {
      const hasValidSource = !r.sourceId.startsWith('unknown_');
      const hasValidTarget = !r.targetId.startsWith('unknown_');
      if (!hasValidSource || !hasValidTarget) {
        console.log(`   ⚠️ Unresolved entity: ${r.sourceLabel} (${hasValidSource ? '✓' : '✗'}) → ${r.predicate} → ${r.targetLabel} (${hasValidTarget ? '✓' : '✗'})`);
      }
      return hasValidSource && hasValidTarget;
    });
    
    console.log(`\n📊 RELATIONSHIP VALIDATION:`);
    console.log(`   Total from LLM: ${relationships.length}`);
    console.log(`   After entity resolution: ${validRelationships.length}`);
    
    // Validate relationships against ontology constraints
    const constraintValidatedRels = [];
    const invalidRels = [];
    
    // Debug: Log ontology structure
    console.log(`\n📋 ONTOLOGY DEBUG:`);
    console.log(`   existingOntology keys: ${Object.keys(existingOntology).join(', ')}`);
    console.log(`   entityTypes count: ${existingOntology.entityTypes?.length || 0}`);
    if (existingOntology.entityTypes?.length > 0) {
      const firstType = existingOntology.entityTypes[0];
      console.log(`   First entityType: ${JSON.stringify(firstType).substring(0, 200)}`);
      console.log(`   First entityType aliases: ${JSON.stringify(firstType.aliases || 'none')}`);
    }
    
    // Build type aliases from ontology definitions
    const typeAliases = new Map();
    (existingOntology.entityTypes || []).forEach(et => {
      const mainType = (typeof et === 'string' ? et : (et.name || et.label || et.type))?.toLowerCase();
      if (!mainType) return;
      
      const aliases = et.aliases || [];
      const allNames = [mainType, ...aliases.map(a => a.toLowerCase())];
      
      // Each name maps to all other names in the group
      allNames.forEach(name => {
        typeAliases.set(name, allNames);
      });
    });
    
    console.log(`   Type aliases loaded: ${typeAliases.size} entries`);
    if (typeAliases.size > 0) {
      console.log(`   Alias examples: ${Array.from(typeAliases.entries()).slice(0, 3).map(([k, v]) => `${k} → [${v.join(', ')}]`).join('; ')}`);
    }
    
    const typesMatch = (actualType, allowedTypes) => {
      if (!actualType || allowedTypes.size === 0) return true;
      const actual = actualType.toLowerCase();
      if (allowedTypes.has(actual)) return true;
      
      // Check aliases from ontology
      const aliases = typeAliases.get(actual) || [];
      for (const alias of aliases) {
        if (allowedTypes.has(alias)) return true;
      }
      return false;
    };
    
    for (const rel of validRelationships) {
      const constraints = relationshipConstraints.get(rel.predicate);
      
      // If no constraints defined for this predicate, allow it
      if (!constraints || (constraints.sourceTypes.size === 0 && constraints.targetTypes.size === 0)) {
        constraintValidatedRels.push(rel);
        continue;
      }
      
      // Check source type constraint with alias matching
      const sourceTypeValid = typesMatch(rel.sourceType, constraints.sourceTypes);
      
      // Check target type constraint with alias matching
      const targetTypeValid = typesMatch(rel.targetType, constraints.targetTypes);
      if (sourceTypeValid && targetTypeValid) {
        constraintValidatedRels.push(rel);
      } else {
        invalidRels.push({
          rel,
          reason: !sourceTypeValid 
            ? `Source type "${rel.sourceType}" not in allowed types [${Array.from(constraints.sourceTypes).join(', ')}]`
            : `Target type "${rel.targetType}" not in allowed types [${Array.from(constraints.targetTypes).join(', ')}]`
        });
      }
    }
    
    console.log(`   After constraint validation: ${constraintValidatedRels.length}`);
    
    if (invalidRels.length > 0) {
      console.log(`\n   ❌ FILTERED RELATIONSHIPS (${invalidRels.length}):`);
      invalidRels.forEach(({ rel, reason }) => {
        console.log(`      ${rel.sourceLabel} (${rel.sourceType}) → ${rel.predicate} → ${rel.targetLabel} (${rel.targetType})`);
        console.log(`         Reason: ${reason}`);
      });
    }
    
    if (constraintValidatedRels.length > 0) {
      console.log(`\n   ✅ VALID RELATIONSHIPS (${constraintValidatedRels.length}):`);
      constraintValidatedRels.slice(0, 5).forEach(rel => {
        console.log(`      ${rel.sourceLabel} (${rel.sourceType}) → ${rel.predicate} → ${rel.targetLabel} (${rel.targetType})`);
      });
    }
    
    validRelationships = constraintValidatedRels;

    // Normalize ontology suggestions
    const ontologySuggestions = {
      newEntityTypes: (extraction.ontologySuggestions?.newEntityTypes || []).filter(t => 
        !existingTypes.has(t.type?.toLowerCase())
      ),
      newRelationshipTypes: (extraction.ontologySuggestions?.newRelationshipTypes || []).filter(r =>
        !existingPredicates.has(r.predicate?.toUpperCase().replace(/\s+/g, '_'))
      ),
      newDatatypeProperties: extraction.ontologySuggestions?.newDatatypeProperties || []
    };

    return {
      extractionSummary: extraction.extractionSummary || {},
      entities,
      relationships: validRelationships,
      ontologySuggestions,
      assumptions: extraction.assumptions || [],
      unmatchedConcepts: extraction.unmatchedConcepts || [],
      stats: {
        entityCount: entities.length,
        relationshipCount: validRelationships.length,
        skippedRelationships: relationships.length - validRelationships.length,
        invalidTypeRelationships: invalidRels.length,
        existingTypeMatches: entities.filter(e => e.typeSource === 'existing').length,
        suggestedTypes: entities.filter(e => e.typeSource === 'suggested').length,
        existingPredicateMatches: validRelationships.filter(r => r.predicateSource === 'existing').length,
        suggestedPredicates: validRelationships.filter(r => r.predicateSource === 'suggested').length,
        newTypeSuggestions: ontologySuggestions.newEntityTypes.length,
        newPredicateSuggestions: ontologySuggestions.newRelationshipTypes.length
      }
    };
  }

  /**
   * Log extraction summary - only in debug mode
   */
  logExtractionSummary(result) {
    logger.debug(`Entities: ${result.stats.entityCount}, Relationships: ${result.stats.relationshipCount}`);
  }

  /**
   * Extract from multiple text chunks and merge results
   */
  async extractFromChunks(chunks, options = {}) {
    const allEntities = new Map();
    const allRelationships = [];
    const allSuggestions = {
      newEntityTypes: new Map(),
      newRelationshipTypes: new Map(),
      newDatatypeProperties: new Map()
    };
    const allAssumptions = new Set();
    const allUnmatched = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.debug(`Processing chunk ${i + 1}/${chunks.length}`);

      try {
        const result = await this.extractFromText(chunk.text || chunk, options);

        // Merge entities (dedupe by label)
        for (const entity of result.entities) {
          const key = entity.label.toLowerCase();
          if (!allEntities.has(key)) {
            allEntities.set(key, entity);
          } else {
            // Merge - keep higher confidence
            const existing = allEntities.get(key);
            if (entity.confidence > existing.confidence) {
              allEntities.set(key, { ...existing, ...entity });
            }
          }
        }

        // Add relationships
        allRelationships.push(...result.relationships);

        // Merge suggestions
        for (const type of result.ontologySuggestions.newEntityTypes) {
          if (!allSuggestions.newEntityTypes.has(type.type)) {
            allSuggestions.newEntityTypes.set(type.type, type);
          }
        }
        for (const rel of result.ontologySuggestions.newRelationshipTypes) {
          if (!allSuggestions.newRelationshipTypes.has(rel.predicate)) {
            allSuggestions.newRelationshipTypes.set(rel.predicate, rel);
          }
        }
        for (const prop of result.ontologySuggestions.newDatatypeProperties) {
          if (!allSuggestions.newDatatypeProperties.has(prop.property)) {
            allSuggestions.newDatatypeProperties.set(prop.property, prop);
          }
        }

        // Merge assumptions and unmatched
        result.assumptions.forEach(a => allAssumptions.add(a));
        allUnmatched.push(...result.unmatchedConcepts);

      } catch (error) {
        logger.warn(`Error processing chunk ${i + 1}: ${error.message}`);
      }
    }

    // Deduplicate relationships
    const uniqueRelationships = this.deduplicateRelationships(allRelationships);

    const entities = Array.from(allEntities.values());
    
    return {
      extractionSummary: {
        chunksProcessed: chunks.length,
        documentType: 'multi-chunk'
      },
      entities,
      relationships: uniqueRelationships,
      ontologySuggestions: {
        newEntityTypes: Array.from(allSuggestions.newEntityTypes.values()),
        newRelationshipTypes: Array.from(allSuggestions.newRelationshipTypes.values()),
        newDatatypeProperties: Array.from(allSuggestions.newDatatypeProperties.values())
      },
      assumptions: Array.from(allAssumptions),
      unmatchedConcepts: allUnmatched,
      stats: {
        entityCount: entities.length,
        relationshipCount: uniqueRelationships.length,
        existingTypeMatches: entities.filter(e => e.typeSource === 'existing').length,
        suggestedTypes: entities.filter(e => e.typeSource === 'suggested').length,
        existingPredicateMatches: uniqueRelationships.filter(r => r.predicateSource === 'existing').length,
        suggestedPredicates: uniqueRelationships.filter(r => r.predicateSource === 'suggested').length,
        newTypeSuggestions: allSuggestions.newEntityTypes.size,
        newPredicateSuggestions: allSuggestions.newRelationshipTypes.size
      }
    };
  }

  /**
   * Deduplicate relationships
   */
  deduplicateRelationships(relationships) {
    const seen = new Set();
    return relationships.filter(r => {
      const key = `${r.sourceLabel}|${r.predicate}|${r.targetLabel}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = new GraphRagExtractionService();
