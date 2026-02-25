/**
 * Ontology Generator Service
 * Generates ontologies from text prompts or document content using LLM
 */

const llmService = require('./llmService');
const logger = require('../utils/logger');

class OntologyGeneratorService {
  constructor() {
    logger.info(`🧠 OntologyGeneratorService initialized (using shared llmService)`);
  }

  /**
   * Generate ontology from a text prompt describing the domain/industry
   */
  async generateFromPrompt(prompt, options = {}) {
    const { name, industry } = options;

    const systemPrompt = `You are an ontology designer. Create knowledge graph schemas from domain descriptions.

Output ONLY valid JSON:
{
  "name": "Ontology Name",
  "description": "Brief description",
  "industry": "domain_name",
  "entityTypes": [
    {
      "name": "EntityName",
      "description": "What this entity represents",
      "aliases": [],
      "properties": [
        {"name": "property_name", "data_type": "string|number|date|boolean", "required": boolean, "description": "Purpose"}
      ]
    }
  ],
  "relationships": [
    {
      "name": "RELATIONSHIP_NAME",
      "description": "Semantic meaning",
      "source_types": ["SourceEntity"],
      "target_types": ["TargetEntity"],
      "properties": []
    }
  ]
}

Design principles:
- Entity types represent distinct concepts with identity
- Properties capture attributes of entities
- Relationships express semantic connections between entities
- Use PascalCase for entity names
- Use UPPER_SNAKE_CASE for relationship names
- Create specific, meaningful relationships`;

    const userPrompt = `Design an ontology for:

${prompt}

${name ? `Suggested name: ${name}` : ''}
${industry ? `Industry: ${industry}` : ''}

Generate a comprehensive ontology with entity types, their properties, and relationships between them.`;

    try {
      console.log('\n🧠 Generating ontology from prompt...');
      const startTime = Date.now();

      const content = await llmService.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.3 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Ontology generated in ${duration}s`);

      const cleaned = this.extractJSON(content);
      const ontology = JSON.parse(cleaned);
      return this.normalizeOntology(ontology, options);

    } catch (error) {
      logger.error('Ontology generation failed:', error.message);
      throw error;
    }
  }

  /**
   * Generate ontology from document text
   * Uses multi-section sampling for large documents
   */
  async generateFromDocument(documentText, options = {}) {
    const { name, industry, maxChars = 50000 } = options;

    // For large documents, sample from multiple sections
    const text = this.sampleDocument(documentText, maxChars);

    const systemPrompt = `You are an ontology designer. Extract knowledge graph schemas from documents.

Output ONLY valid JSON:
{
  "name": "Ontology Name",
  "description": "What this document/domain covers",
  "industry": "domain_name",
  "entityTypes": [
    {
      "name": "EntityName",
      "description": "What this entity represents",
      "aliases": [],
      "properties": [{"name": "property_name", "data_type": "string|number|date|boolean", "required": boolean, "description": "Purpose"}]
    }
  ],
  "relationships": [
    {
      "name": "RELATIONSHIP_NAME",
      "description": "Semantic meaning",
      "source_types": ["SourceEntity"],
      "target_types": ["TargetEntity"],
      "properties": []
    }
  ]
}

Extract entities and relationships that are explicitly or implicitly present in the document.
Use PascalCase for entity names, UPPER_SNAKE_CASE for relationships.
Output only JSON.`;

    const userPrompt = `Analyze this document and create an ontology:

${text}
${name ? `\nName: ${name}` : ''}${industry ? `\nDomain: ${industry}` : ''}`;

    try {
      console.log('\n🧠 Generating ontology from document...');
      console.log(`   Document length: ${(text.length / 1000).toFixed(1)}K chars`);
      const startTime = Date.now();

      const content = await llmService.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.3 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Ontology generated in ${duration}s`);

      const cleaned = this.extractJSON(content);
      const ontology = JSON.parse(cleaned);
      return this.normalizeOntology(ontology, options);

    } catch (error) {
      logger.error('Ontology generation from document failed:', error.message);
      throw error;
    }
  }

  /**
   * Extract JSON from LLM response
   */
  extractJSON(content) {
    if (!content) throw new Error('Empty response from LLM');

    let cleaned = content.trim();

    // Extract from markdown code blocks
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    // Find first { 
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      throw new Error('No JSON object found in LLM response. Response started with: ' + content.substring(0, 100));
    }
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
    } else {
      throw new Error('Incomplete JSON in LLM response - no matching closing brace');
    }

    // Fix common JSON issues
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');

    return cleaned;
  }

  /**
   * Sample document for large texts - takes sections from beginning, middle, and end
   * This ensures ontology captures entities from throughout the document
   */
  sampleDocument(text, maxChars) {
    if (text.length <= maxChars) {
      return text;
    }

    // Allocate: 50% beginning, 25% middle, 25% end
    const beginSize = Math.floor(maxChars * 0.5);
    const middleSize = Math.floor(maxChars * 0.25);
    const endSize = Math.floor(maxChars * 0.25);

    const beginning = text.substring(0, beginSize);
    
    const middleStart = Math.floor((text.length - middleSize) / 2);
    const middle = text.substring(middleStart, middleStart + middleSize);
    
    const end = text.substring(text.length - endSize);

    const sampled = `${beginning}\n\n[... middle section ...]\n\n${middle}\n\n[... end section ...]\n\n${end}`;
    
    console.log(`   Sampled ${text.length} chars → ${sampled.length} chars (begin: ${beginSize}, mid: ${middleSize}, end: ${endSize})`);
    
    return sampled;
  }

  /**
   * Normalize ontology to standard format
   */
  normalizeOntology(ontology, options = {}) {
    const entityTypes = (ontology.entityTypes || ontology.entity_types || []).map(et => ({
      label: et.name || et.label,
      userLabel: et.name || et.label,
      name: et.name || et.label,
      description: et.description || '',
      aliases: et.aliases || [],
      include: true,
      properties: (et.properties || []).map(p => ({
        name: typeof p === 'string' ? p : (p.name || p.label),
        data_type: p.data_type || p.dataType || 'string',
        required: p.required || false,
        description: p.description || ''
      }))
    }));

    // Build set of valid entity names for relationship validation
    const validEntityNames = new Set(entityTypes.map(et => et.label));

    const relationships = (ontology.relationships || ontology.relationship_types || []).map(r => {
      const fromRaw = (r.source_types || r.from || [])[0] || '';
      const toRaw = (r.target_types || r.to || [])[0] || '';
      // Only set from/to if they reference a valid entity type
      const from = validEntityNames.has(fromRaw) ? fromRaw : '';
      const to = validEntityNames.has(toRaw) ? toRaw : '';
      
      return {
        type: r.name || r.type || r.predicate,
        predicate: r.name || r.type || r.predicate,
        userPredicate: r.name || r.type || r.predicate,
        from,
        to,
        source_types: from ? [from] : [],
        target_types: to ? [to] : [],
        description: r.description || '',
        include: true,
        properties: (r.properties || []).map(p => ({
          name: typeof p === 'string' ? p : (p.name || p.label),
          data_type: p.data_type || 'string'
        }))
      };
    });

    return {
      name: options.name || ontology.name || 'Generated Ontology',
      description: ontology.description || '',
      industry: options.industry || ontology.industry || 'general',
      isCustom: true,
      isAutoGenerated: true,
      entityTypes,
      relationships,
      nodeTypes: entityTypes.map(et => et.label),
      originalEntityTypes: entityTypes,
      originalRelationships: relationships
    };
  }
}

module.exports = new OntologyGeneratorService();
