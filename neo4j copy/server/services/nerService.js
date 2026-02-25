/**
 * NER Service - Real Named Entity Recognition using multiple NLP libraries
 */

const natural = require('natural');
const compromise = require('compromise');
const logger = require('../utils/logger');

class NERService {
  constructor() {
    this.models = new Map();
    this.tokenizer = new natural.WordTokenizer();
    this.stemmer = natural.PorterStemmer;
    this.initializeModels();
  }

  /**
   * Initialize NER models
   */
  initializeModels() {
    // Load compromise NLP for entity recognition
    this.models.set('compromise', compromise);
    
    // Initialize pattern-based models for different domains
    this.models.set('patterns', this.getPatternModels());
    
    logger.info('🧠 NER Service initialized with compromise and pattern models');
  }

  /**
   * Extract entities using multiple NER approaches
   */
  async extractEntities(text, options = {}) {
    const { domain = 'general', confidence = 0.7 } = options;
    
    try {
      // Run multiple NER approaches
      const [compromiseEntities, patternEntities] = await Promise.all([
        this.extractWithCompromise(text),
        this.extractWithPatterns(text, domain)
      ]);

      // Merge and deduplicate entities
      const allEntities = [...compromiseEntities, ...patternEntities];
      const mergedEntities = this.mergeEntities(allEntities);
      
      // Filter by confidence threshold
      const filteredEntities = mergedEntities.filter(e => e.confidence >= confidence);

      return {
        entities: filteredEntities,
        metadata: {
          totalFound: allEntities.length,
          afterMerging: mergedEntities.length,
          afterFiltering: filteredEntities.length,
          approaches: ['compromise', 'patterns']
        }
      };
    } catch (error) {
      logger.error('NER extraction failed:', error);
      throw error;
    }
  }

  /**
   * Extract entities using Compromise NLP
   */
  async extractWithCompromise(text) {
    const doc = compromise(text);
    const entities = [];

    // Extract people
    const people = doc.people().out('array');
    people.forEach(person => {
      entities.push({
        text: person,
        type: 'PERSON',
        start: text.indexOf(person),
        end: text.indexOf(person) + person.length,
        confidence: 0.85,
        source: 'compromise'
      });
    });

    // Extract places
    const places = doc.places().out('array');
    places.forEach(place => {
      entities.push({
        text: place,
        type: 'LOCATION',
        start: text.indexOf(place),
        end: text.indexOf(place) + place.length,
        confidence: 0.8,
        source: 'compromise'
      });
    });

    // Extract organizations
    const orgs = doc.organizations().out('array');
    orgs.forEach(org => {
      entities.push({
        text: org,
        type: 'ORGANIZATION',
        start: text.indexOf(org),
        end: text.indexOf(org) + org.length,
        confidence: 0.8,
        source: 'compromise'
      });
    });

    // Extract dates using match instead of dates()
    const dateMatches = doc.match('#Date').out('array');
    dateMatches.forEach(date => {
      entities.push({
        text: date,
        type: 'DATE',
        start: text.indexOf(date),
        end: text.indexOf(date) + date.length,
        confidence: 0.9,
        source: 'compromise'
      });
    });

    // Extract money using match
    const moneyMatches = doc.match('#Money').out('array');
    moneyMatches.forEach(amount => {
      entities.push({
        text: amount,
        type: 'MONEY',
        start: text.indexOf(amount),
        end: text.indexOf(amount) + amount.length,
        confidence: 0.9,
        source: 'compromise'
      });
    });

    // Extract nouns that might be entities
    const nouns = doc.nouns().out('array');
    nouns.forEach(noun => {
      // Only include capitalized nouns that might be proper nouns
      if (noun.length > 2 && /^[A-Z]/.test(noun)) {
        entities.push({
          text: noun,
          type: 'ENTITY',
          start: text.indexOf(noun),
          end: text.indexOf(noun) + noun.length,
          confidence: 0.6,
          source: 'compromise'
        });
      }
    });

    return entities;
  }

  /**
   * Extract entities using enhanced pattern matching
   */
  async extractWithPatterns(text, domain = 'general') {
    const patterns = this.getPatternModels()[domain] || this.getPatternModels().general;
    const entities = [];

    for (const [type, patternList] of Object.entries(patterns)) {
      for (const pattern of patternList) {
        const matches = [...text.matchAll(pattern.regex)];
        matches.forEach(match => {
          entities.push({
            text: match[0],
            type: type,
            start: match.index,
            end: match.index + match[0].length,
            confidence: pattern.confidence,
            source: 'patterns',
            domain: domain
          });
        });
      }
    }

    return entities;
  }

  /**
   * Get pattern models for different domains
   */
  getPatternModels() {
    return {
      general: {
        PERSON: [
          { regex: /\b[A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/g, confidence: 0.7 },
          { regex: /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)+/g, confidence: 0.9 }
        ],
        EMAIL: [
          { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, confidence: 0.95 }
        ],
        PHONE: [
          { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, confidence: 0.9 },
          { regex: /\b\(\d{3}\)\s?\d{3}[-.]?\d{4}\b/g, confidence: 0.9 }
        ],
        DATE: [
          { regex: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, confidence: 0.9 },
          { regex: /\b\d{4}-\d{2}-\d{2}\b/g, confidence: 0.9 },
          { regex: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g, confidence: 0.85 }
        ],
        MONEY: [
          { regex: /\$[\d,]+\.?\d*/g, confidence: 0.9 },
          { regex: /\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:dollars?|USD|cents?)\b/gi, confidence: 0.85 }
        ],
        ORGANIZATION: [
          { regex: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|Corp|LLC|Ltd|Company|Corporation|Co)\b/g, confidence: 0.8 },
          { regex: /\b[A-Z][A-Z]+(?:\s+[A-Z]+)*\b/g, confidence: 0.6 }
        ],
        URL: [
          { regex: /https?:\/\/[^\s]+/g, confidence: 0.95 }
        ],
        ADDRESS: [
          { regex: /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b/g, confidence: 0.8 }
        ]
      },
      
      resume: {
        SKILL: [
          { regex: /\b(?:JavaScript|Python|Java|C\+\+|React|Node\.js|SQL|HTML|CSS|Git|Docker|AWS|Azure|GCP)\b/g, confidence: 0.9 },
          { regex: /\b(?:machine learning|data science|artificial intelligence|deep learning|neural networks)\b/gi, confidence: 0.85 }
        ],
        EDUCATION: [
          { regex: /\b(?:Bachelor|Master|PhD|B\.S\.|M\.S\.|M\.A\.|B\.A\.)\s+(?:of|in)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, confidence: 0.9 },
          { regex: /\b(?:University|College|Institute)\s+of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, confidence: 0.8 }
        ],
        JOB_TITLE: [
          { regex: /\b(?:Software Engineer|Data Scientist|Product Manager|Senior Developer|Lead Engineer|CTO|CEO|VP)\b/g, confidence: 0.85 }
        ]
      },

      legal: {
        LEGAL_ENTITY: [
          { regex: /\b(?:Plaintiff|Defendant|Petitioner|Respondent|Appellant|Appellee)\b/g, confidence: 0.9 }
        ],
        CASE_NUMBER: [
          { regex: /\b(?:Case|Docket)\s+No\.?\s*[\w-]+/g, confidence: 0.9 }
        ],
        STATUTE: [
          { regex: /\b\d+\s+U\.S\.C\.?\s+§?\s*\d+/g, confidence: 0.85 }
        ]
      },

      financial: {
        ACCOUNT_NUMBER: [
          { regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, confidence: 0.8 }
        ],
        CURRENCY: [
          { regex: /\b(?:USD|EUR|GBP|JPY|CAD|AUD)\s*[\d,]+\.?\d*/g, confidence: 0.9 }
        ],
        FINANCIAL_INSTRUMENT: [
          { regex: /\b(?:stock|bond|option|future|derivative|security)\b/gi, confidence: 0.7 }
        ]
      }
    };
  }

  /**
   * Merge overlapping entities and resolve conflicts
   */
  mergeEntities(entities) {
    // Sort by start position
    entities.sort((a, b) => a.start - b.start);
    
    const merged = [];
    let current = null;

    for (const entity of entities) {
      if (!current) {
        current = entity;
        continue;
      }

      // Check for overlap
      if (entity.start < current.end) {
        // Overlapping entities - keep the one with higher confidence
        if (entity.confidence > current.confidence) {
          current = entity;
        }
        // If same confidence, prefer longer entity
        else if (entity.confidence === current.confidence && 
                 (entity.end - entity.start) > (current.end - current.start)) {
          current = entity;
        }
      } else {
        // No overlap - add current and move to next
        merged.push(current);
        current = entity;
      }
    }

    if (current) {
      merged.push(current);
    }

    return merged;
  }

  /**
   * Get available entity types for a domain
   */
  getEntityTypes(domain = 'general') {
    const patterns = this.getPatternModels()[domain] || this.getPatternModels().general;
    return Object.keys(patterns);
  }

  /**
   * Validate entity extraction results
   */
  validateEntities(entities, text) {
    return entities.filter(entity => {
      // Check if entity text actually exists at the specified position
      const actualText = text.substring(entity.start, entity.end);
      return actualText === entity.text;
    });
  }

  /**
   * Get extraction statistics
   */
  getStats() {
    return {
      modelsLoaded: this.models.size,
      availableDomains: Object.keys(this.getPatternModels()),
      supportedEntityTypes: {
        general: this.getEntityTypes('general'),
        resume: this.getEntityTypes('resume'),
        legal: this.getEntityTypes('legal'),
        financial: this.getEntityTypes('financial')
      }
    };
  }
}

module.exports = new NERService();
