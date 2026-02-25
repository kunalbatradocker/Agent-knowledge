/**
 * Enhanced Extraction Service - Tier 1-3 Implementation
 * Combines NER + LLM + Rules for highest quality extraction
 */

const owlOntologyService = require('./owlOntologyService');
const llmService = require('./llmService');
const nerService = require('./nerService');
const logger = require('../utils/logger');

class EnhancedExtractionService {
  constructor() {
    this.nerModels = new Map();
    this.domainPatterns = new Map();
    this.feedbackStore = new Map();
  }

  /**
   * Main extraction method - uses all tiers
   */
  async extract(text, ontologyId, options = {}) {
    const { 
      approaches = ['ner', 'llm', 'patterns'],
      tenantId = 'default',
      workspaceId = 'default',
      userFeedback = null
    } = options;

    try {
      logger.info(`🧠 Enhanced extraction: ${approaches.join('+')} approaches`);

      // Validate inputs
      if (!text || typeof text !== 'string') {
        throw new Error('Text is required for extraction');
      }

      // Get rich ontology context (handles undefined ontologyId gracefully)
      const ontologyContext = await this.getRichOntologyContext(ontologyId, tenantId, workspaceId);

      // Run multiple extraction approaches
      const extractions = await this.runMultipleApproaches(text, ontologyContext, approaches);

      // Build consensus
      const consensus = this.buildConsensus(extractions, ontologyContext);

      // Apply user feedback if available
      const refined = userFeedback ? this.applyUserFeedback(consensus, userFeedback) : consensus;

      // Final validation
      const validated = await this.validateAndEnrich(refined, ontologyContext);

      return {
        ...validated,
        metadata: {
          approaches: approaches,
          ontologyId: ontologyId || null,
          qualityScore: this.calculateQualityScore(validated, ontologyContext),
          extractionTime: Date.now()
        }
      };

    } catch (error) {
      logger.error('Enhanced extraction failed:', error);
      throw error;
    }
  }

  /**
   * Get rich ontology context from GraphDB
   */
  async getRichOntologyContext(ontologyId, tenantId, workspaceId) {
    // Validate ontologyId
    if (!ontologyId || ontologyId === 'undefined') {
      logger.warn('Invalid ontologyId provided, using fallback context');
      return {
        classes: [],
        properties: [],
        domainRules: {},
        ontologyId: null
      };
    }

    try {
      const structure = await owlOntologyService.getOntologyStructure(tenantId, workspaceId, ontologyId);
      
      return {
        classes: structure.classes?.map(cls => ({
          ...cls,
          localName: this.extractLocalName(cls.uri),
          synonyms: this.extractSynonyms(cls.comment),
          patterns: this.getEntityPatterns(cls.label, ontologyId)
        })) || [],
        properties: structure.properties?.map(prop => ({
          ...prop,
          localName: this.extractLocalName(prop.uri),
          patterns: this.getRelationshipPatterns(prop.label, ontologyId),
          domainClass: this.extractLocalName(prop.domain),
          rangeClass: this.extractLocalName(prop.range)
        })) || [],
        domainRules: this.getDomainRules(ontologyId),
        ontologyId: ontologyId
      };
    } catch (error) {
      logger.warn(`Failed to load ontology context for ${ontologyId}:`, error.message);
      return {
        classes: [],
        properties: [],
        domainRules: {},
        ontologyId: ontologyId
      };
    }
  }

  /**
   * Run multiple extraction approaches in parallel
   */
  async runMultipleApproaches(text, ontologyContext, approaches) {
    const results = await Promise.allSettled(
      approaches.map(async (approach) => {
        try {
          const result = await this.runSingleApproach(approach, text, ontologyContext);
          return { approach, result, success: true };
        } catch (error) {
          logger.warn(`${approach} extraction failed:`, error.message);
          return { approach, error: error.message, success: false };
        }
      })
    );

    return results
      .filter(r => r.status === 'fulfilled' && r.value.success)
      .map(r => r.value);
  }

  /**
   * Run single extraction approach
   */
  async runSingleApproach(approach, text, ontologyContext) {
    switch (approach) {
      case 'ner':
        return await this.runNERExtraction(text, ontologyContext);
      case 'llm':
        return await this.runLLMExtraction(text, ontologyContext);
      case 'patterns':
        return await this.runPatternExtraction(text, ontologyContext);
      case 'hybrid':
        return await this.runHybridExtraction(text, ontologyContext);
      default:
        throw new Error(`Unknown extraction approach: ${approach}`);
    }
  }

  /**
   * NER-based extraction (Tier 1) - Using real NLP models
   */
  async runNERExtraction(text, ontologyContext) {
    try {
      // Determine domain from ontology context
      const domain = this.detectDomain(ontologyContext);
      
      // Extract entities using NER service
      const nerResult = await nerService.extractEntities(text, { 
        domain: domain,
        confidence: 0.6 
      });

      // Map NER entities to ontology classes
      const mappedEntities = nerResult.entities.map(entity => {
        const ontologyClass = this.findBestOntologyMatch(entity.text, entity.type, ontologyContext.classes);
        return {
          ...entity,
          ontologyClass: ontologyClass?.uri,
          ontologyLabel: ontologyClass?.label,
          source: 'ner'
        };
      });

      // Extract relationships (basic co-occurrence)
      const relationships = this.extractBasicRelationships(mappedEntities, text);

      return { 
        entities: mappedEntities, 
        relationships,
        metadata: nerResult.metadata
      };
    } catch (error) {
      logger.warn('NER extraction failed, falling back to patterns:', error.message);
      return await this.runFallbackNER(text, ontologyContext);
    }
  }

  /**
   * Fallback NER using simple patterns
   */
  async runFallbackNER(text, ontologyContext) {
    const entities = [];
    const relationships = [];

    // Simple patterns as fallback
    const patterns = {
      PERSON: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g,
      EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      PHONE: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
      DATE: /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g,
      MONEY: /\$[\d,]+\.?\d*/g,
      ORGANIZATION: /\b[A-Z][a-z]+ (?:Inc|Corp|LLC|Ltd|Company|Corporation)\b/g
    };

    for (const [type, pattern] of Object.entries(patterns)) {
      const matches = [...text.matchAll(pattern)];
      matches.forEach(match => {
        entities.push({
          text: match[0],
          type: type,
          start: match.index,
          end: match.index + match[0].length,
          confidence: 0.7,
          source: 'ner-fallback'
        });
      });
    }

    // Map to ontology classes
    const mappedEntities = entities.map(entity => {
      const ontologyClass = this.findBestOntologyMatch(entity.text, entity.type, ontologyContext.classes);
      return {
        ...entity,
        ontologyClass: ontologyClass?.uri,
        ontologyLabel: ontologyClass?.label
      };
    });

    return { entities: mappedEntities, relationships };
  }

  /**
   * Detect domain from ontology context
   */
  detectDomain(ontologyContext) {
    const ontologyId = ontologyContext.ontologyId?.toLowerCase() || '';
    
    if (!ontologyId) {
      return 'general';
    }
    
    if (ontologyId.includes('resume') || ontologyId.includes('cv')) return 'resume';
    if (ontologyId.includes('legal') || ontologyId.includes('contract')) return 'legal';
    if (ontologyId.includes('financial') || ontologyId.includes('banking')) return 'financial';
    
    // Check class names for domain hints
    const classNames = ontologyContext.classes?.map(c => c.label?.toLowerCase()).join(' ') || '';
    if (classNames.includes('skill') || classNames.includes('education')) return 'resume';
    if (classNames.includes('contract') || classNames.includes('legal')) return 'legal';
    if (classNames.includes('account') || classNames.includes('transaction')) return 'financial';
    
    return 'general';
  }

  /**
   * Extract basic relationships from co-occurring entities
   */
  extractBasicRelationships(entities, text) {
    const relationships = [];
    
    // Find entities that appear close to each other (within 50 characters)
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entity1 = entities[i];
        const entity2 = entities[j];
        
        const distance = Math.abs(entity1.start - entity2.start);
        if (distance < 50) {
          relationships.push({
            subject: entity1.text,
            subjectType: entity1.type,
            predicate: 'relatedTo',
            object: entity2.text,
            objectType: entity2.type,
            confidence: 0.6,
            source: 'ner-cooccurrence'
          });
        }
      }
    }
    
    return relationships;
  }

  /**
   * LLM-based extraction (Tier 2)
   */
  async runLLMExtraction(text, ontologyContext) {
    const prompt = this.buildExtractionPrompt(text, ontologyContext);
    
    try {
      const response = await llmService.chat([
        {
          role: 'system',
          content: 'You are an expert entity extraction system. Extract entities and relationships from text and return valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ], { temperature: 0 });

      // Parse the LLM response
      const result = JSON.parse(response);
      
      return {
        entities: result.entities?.map(e => ({ ...e, source: 'llm' })) || [],
        relationships: result.relationships?.map(r => ({ ...r, source: 'llm' })) || []
      };
    } catch (error) {
      logger.warn('LLM extraction failed:', error.message);
      return { entities: [], relationships: [] };
    }
  }

  /**
   * Pattern-based extraction (Tier 3)
   */
  async runPatternExtraction(text, ontologyContext) {
    const entities = [];
    const relationships = [];

    // Domain-specific patterns
    for (const cls of ontologyContext.classes) {
      if (cls.patterns) {
        for (const pattern of cls.patterns) {
          const regex = new RegExp(pattern, 'gi');
          const matches = [...text.matchAll(regex)];
          matches.forEach(match => {
            entities.push({
              text: match[0],
              type: cls.localName,
              ontologyClass: cls.uri,
              ontologyLabel: cls.label,
              start: match.index,
              end: match.index + match[0].length,
              confidence: 0.9,
              source: 'patterns'
            });
          });
        }
      }
    }

    return { entities, relationships };
  }

  /**
   * Hybrid extraction combining all approaches
   */
  async runHybridExtraction(text, ontologyContext) {
    const [ner, llm, patterns] = await Promise.all([
      this.runNERExtraction(text, ontologyContext),
      this.runLLMExtraction(text, ontologyContext),
      this.runPatternExtraction(text, ontologyContext)
    ]);

    return {
      entities: [...ner.entities, ...llm.entities, ...patterns.entities],
      relationships: [...ner.relationships, ...llm.relationships, ...patterns.relationships]
    };
  }

  /**
   * Build consensus from multiple extractions
   */
  buildConsensus(extractions, ontologyContext) {
    const allEntities = extractions.flatMap(e => e.result.entities);
    const allRelationships = extractions.flatMap(e => e.result.relationships);

    // Group overlapping entities
    const entityGroups = this.groupOverlappingEntities(allEntities);
    
    // Select best entity from each group
    const consensusEntities = entityGroups.map(group => this.selectBestEntity(group));

    // Merge relationships
    const consensusRelationships = this.mergeRelationships(allRelationships);

    return {
      entities: consensusEntities,
      relationships: consensusRelationships
    };
  }

  /**
   * Group overlapping entities by text position
   */
  groupOverlappingEntities(entities) {
    const groups = [];
    const processed = new Set();

    entities.forEach((entity, i) => {
      if (processed.has(i)) return;

      const group = [entity];
      processed.add(i);

      entities.forEach((other, j) => {
        if (i !== j && !processed.has(j) && this.entitiesOverlap(entity, other)) {
          group.push(other);
          processed.add(j);
        }
      });

      groups.push(group);
    });

    return groups;
  }

  /**
   * Check if two entities overlap
   */
  entitiesOverlap(e1, e2) {
    if (!e1.start || !e1.end || !e2.start || !e2.end) return false;
    return !(e1.end <= e2.start || e2.end <= e1.start);
  }

  /**
   * Select best entity from group based on confidence and source
   */
  selectBestEntity(group) {
    const sourceWeights = { patterns: 3, llm: 2, ner: 1 };
    
    return group.reduce((best, current) => {
      const bestScore = (best.confidence || 0.5) * (sourceWeights[best.source] || 1);
      const currentScore = (current.confidence || 0.5) * (sourceWeights[current.source] || 1);
      return currentScore > bestScore ? current : best;
    });
  }

  /**
   * Find best ontology class match
   */
  findBestOntologyMatch(text, entityType, classes) {
    // Exact label match
    let match = classes.find(cls => 
      cls.label?.toLowerCase() === text.toLowerCase() ||
      cls.localName?.toLowerCase() === text.toLowerCase()
    );
    if (match) return match;

    // Synonym match
    match = classes.find(cls => 
      cls.synonyms?.some(syn => syn.toLowerCase() === text.toLowerCase())
    );
    if (match) return match;

    // Type-based mapping
    const typeMapping = {
      PERSON: ['Person', 'Individual', 'Employee', 'Contact'],
      ORGANIZATION: ['Organization', 'Company', 'Institution'],
      EMAIL: ['Email', 'EmailAddress', 'Contact'],
      PHONE: ['Phone', 'PhoneNumber', 'Contact'],
      DATE: ['Date', 'DateTime', 'Timestamp'],
      MONEY: ['Amount', 'Currency', 'Price', 'Cost']
    };

    const possibleTypes = typeMapping[entityType] || [];
    return classes.find(cls => 
      possibleTypes.some(type => 
        cls.localName?.toLowerCase().includes(type.toLowerCase()) ||
        cls.label?.toLowerCase().includes(type.toLowerCase())
      )
    );
  }

  /**
   * Get entity patterns for a class
   */
  getEntityPatterns(label, ontologyId) {
    const patterns = this.domainPatterns.get(ontologyId) || {};
    return patterns[label] || [];
  }

  /**
   * Get relationship patterns
   */
  getRelationshipPatterns(label, ontologyId) {
    const patterns = this.domainPatterns.get(ontologyId) || {};
    return patterns[`rel_${label}`] || [];
  }

  /**
   * Get domain-specific rules
   */
  getDomainRules(ontologyId) {
    const rules = {
      'resume': {
        entityValidation: {
          'Person': (text) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(text),
          'Email': (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
        }
      },
      'legal-contract': {
        entityValidation: {
          'Party': (text) => text.length > 2,
          'Date': (text) => /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/.test(text)
        }
      }
    };
    return rules[ontologyId] || {};
  }

  /**
   * Build extraction prompt for LLM
   */
  buildExtractionPrompt(text, ontologyContext) {
    const classNames = ontologyContext.classes.map(c => c.localName).join(', ');
    const propertyNames = ontologyContext.properties.map(p => p.localName).join(', ');

    return `Extract entities and relationships from this text using the ontology:

Classes: ${classNames}
Properties: ${propertyNames}

Text: "${text}"

Return JSON with entities and relationships arrays.`;
  }

  /**
   * Merge relationships removing duplicates
   */
  mergeRelationships(relationships) {
    const unique = new Map();
    
    relationships.forEach(rel => {
      const key = `${rel.subject}-${rel.predicate}-${rel.object}`;
      if (!unique.has(key) || (unique.get(key).confidence || 0) < (rel.confidence || 0)) {
        unique.set(key, rel);
      }
    });

    return Array.from(unique.values());
  }

  /**
   * Apply user feedback to improve results
   */
  applyUserFeedback(extraction, feedback) {
    // Store feedback for future improvements
    feedback.corrections?.forEach(correction => {
      const key = `${correction.text}-${correction.type}`;
      this.feedbackStore.set(key, correction);
    });

    // Apply corrections to current extraction
    const correctedEntities = extraction.entities.map(entity => {
      const key = `${entity.text}-${entity.type}`;
      const correction = this.feedbackStore.get(key);
      return correction ? { ...entity, ...correction } : entity;
    });

    return { ...extraction, entities: correctedEntities };
  }

  /**
   * Validate and enrich final results
   */
  async validateAndEnrich(extraction, ontologyContext) {
    const validatedEntities = extraction.entities.filter(entity => {
      const rules = ontologyContext.domainRules.entityValidation || {};
      const validator = rules[entity.type];
      return !validator || validator(entity.text);
    });

    return {
      entities: validatedEntities,
      relationships: extraction.relationships
    };
  }

  /**
   * Calculate quality score
   */
  calculateQualityScore(extraction, ontologyContext) {
    const entityScore = extraction.entities.reduce((sum, e) => sum + (e.confidence || 0.5), 0) / Math.max(extraction.entities.length, 1);
    const relationshipScore = extraction.relationships.reduce((sum, r) => sum + (r.confidence || 0.5), 0) / Math.max(extraction.relationships.length, 1);
    
    return (entityScore + relationshipScore) / 2;
  }

  /**
   * Extract local name from URI
   */
  extractLocalName(uri) {
    if (!uri) return '';
    return uri.split('#').pop() || uri.split('/').pop() || uri;
  }

  /**
   * Extract synonyms from comment
   */
  extractSynonyms(comment) {
    if (!comment) return [];
    const synonymMatch = comment.match(/(?:also known as|synonyms?:?|aka)\s*([^.]+)/i);
    return synonymMatch ? synonymMatch[1].split(/[,;]/).map(s => s.trim()) : [];
  }
}

module.exports = new EnhancedExtractionService();
