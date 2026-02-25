const OpenAI = require('openai');
require('dotenv').config();
const { AsyncLocalStorage } = require('async_hooks');

// Request-scoped storage for per-user Bedrock token
const llmRequestContext = new AsyncLocalStorage();

class LLMService {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'ollama'; // 'bedrock', 'openai', or 'ollama'
    this.openaiClient = null;
    this.model = null;
    this.bedrockApiKey = null;
    this.bedrockRegion = process.env.AWS_REGION || 'us-east-1';

    // Concurrency control for Bedrock — prevents "too many connections"
    this._queue = [];
    this._activeRequests = 0;
    this._maxConcurrent = parseInt(process.env.BEDROCK_MAX_CONCURRENT) || 5;
    this._requestLog = []; // track active/recent requests for monitoring

    if (this.provider === 'bedrock') {
      this.model = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
      this.bedrockApiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
      if (!this.bedrockApiKey) {
        console.error('❌ AWS_BEARER_TOKEN_BEDROCK is not set. Bedrock calls will fail.');
      }
      console.log(`Using AWS Bedrock (bearer token) with model: ${this.model}`);
    } else if (this.provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.warn('Warning: OPENAI_API_KEY not set.');
      } else {
        this.openaiClient = new OpenAI({ apiKey });
      }
      this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      console.log(`Using OpenAI with model: ${this.model}`);
    } else {
      // Default: Ollama
      const baseURL = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1';
      this.openaiClient = new OpenAI({ baseURL, apiKey: 'ollama' });
      this.model = process.env.LOCAL_LLM_MODEL || 'llama3.2';
      console.log(`Using local LLM (Ollama) at: ${baseURL}`);
    }
  }

  /**
   * Acquire a slot from the concurrency limiter. Resolves when a slot is available.
   */
  _acquireSlot() {
    if (this._activeRequests < this._maxConcurrent) {
      this._activeRequests++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  _releaseSlot() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._activeRequests--;
    }
  }

  /** Get status of all active/queued LLM requests */
  getStatus() {
    return {
      provider: this.provider,
      model: this.model,
      activeRequests: this._activeRequests,
      queuedRequests: this._queue.length,
      maxConcurrent: this._maxConcurrent,
      recentRequests: this._requestLog.slice(-20).map(r => ({
        id: r.id,
        started: r.started,
        elapsed: r.finished ? r.finished - r.started : Date.now() - r.started,
        status: r.status,
        preview: r.preview
      }))
    };
  }

  /** Cancel all queued requests (active ones will finish) */
  cancelQueued() {
    const cancelled = this._queue.length;
    this._queue.forEach(resolve => resolve('__CANCELLED__'));
    this._queue = [];
    console.log(`🛑 Cancelled ${cancelled} queued LLM requests`);
    return cancelled;
  }

  async _callBedrock(messages, options = {}) {
    const MAX_RETRIES = 3;
    const CALL_TIMEOUT = (parseInt(process.env.LLM_TIMEOUT) || 300) * 1000; // default 5 min

    // Support per-user token: options.bedrockToken > request-scoped token > server default
    const requestCtx = llmRequestContext.getStore();
    const token = options.bedrockToken || requestCtx?.bedrockToken || this.bedrockApiKey;
    if (!token) {
      throw new Error('No Bedrock bearer token available. Click the 🔑 LLM Token button in the sidebar to add your own token.');
    }

    // Ensure the token has the required "bedrock-api-key-" prefix
    const bearerToken = token.startsWith('bedrock-api-key-') ? token : `bedrock-api-key-${token}`;

    // Extract the signing region from the token — the API call MUST use the same region
    const tokenRegion = LLMService.parseTokenRegion(token);
    const effectiveRegion = tokenRegion || this.bedrockRegion;

    const src = options.bedrockToken ? 'options' : requestCtx?.bedrockToken ? 'ALS' : 'server';
    const expiry = LLMService.parseTokenExpiry(token);
    console.log(`🔑 [LLM] Using ${src} token (len=${bearerToken.length}) | region=${effectiveRegion} | expired=${expiry.expired}, remaining=${expiry.remainingSeconds}s`);

    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: [{ text: m.content }]
    }));

    // Wait for a concurrency slot
    const slotResult = await this._acquireSlot();
    if (slotResult === '__CANCELLED__') throw new Error('LLM request cancelled (queue cleared)');

    const reqEntry = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      started: Date.now(),
      status: 'active',
      preview: (messages[messages.length - 1]?.content || '').substring(0, 80)
    };
    this._requestLog.push(reqEntry);
    if (this._requestLog.length > 50) this._requestLog.shift();

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const url = `https://bedrock-runtime.${effectiveRegion}.amazonaws.com/model/${encodeURIComponent(this.model)}/converse`;
          const body = {
            messages: userMessages,
            ...(systemPrompt && { system: [{ text: systemPrompt }] }),
            inferenceConfig: { maxTokens: options.maxTokens || 4096, temperature: options.temperature ?? 0.7 }
          };

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT);

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}` },
            body: JSON.stringify(body),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const status = response.status;
            const respBody = await response.text();

            // Token expired — give a clear message
            if (status === 403) {
              throw new Error('Bedrock auth failed (403). Your bearer token has likely expired. Click the 🔑 LLM Token button in the sidebar to update your token.');
            }

            if ((status === 429 || status === 503) && attempt < MAX_RETRIES) {
              const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
              console.warn(`⏳ Bedrock ${status} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            throw new Error(`Bedrock API error ${status}: ${respBody}`);
          }
          const result = await response.json();
          reqEntry.status = 'done';
          reqEntry.finished = Date.now();
          return result.output.message.content[0].text;
        } catch (error) {
          // Don't retry auth failures
          if (error.message.includes('403')) throw error;
          // Don't retry timeouts
          if (error.name === 'AbortError') throw new Error(`Bedrock request timed out after ${CALL_TIMEOUT / 1000}s. Increase LLM_TIMEOUT env var or simplify the query.`);

          const retryable = /429|503|Too many connections|throttl/i.test(error.message);
          if (retryable && attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            console.warn(`⏳ Bedrock throttled — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            reqEntry.status = `retry_${attempt + 1}`;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw error;
        }
      }
      // All retries exhausted without success or throw (e.g., last attempt got 429/503)
      throw new Error(`Bedrock API failed after ${MAX_RETRIES} retries`);
    } finally {
      if (!reqEntry.finished) { reqEntry.status = 'failed'; reqEntry.finished = Date.now(); }
      this._releaseSlot();
    }
  }

  async _callWithFallback(messages, options = {}) {
    // Try primary provider first
    try {
      if (this.provider === 'bedrock') {
        return await this._callBedrock(messages, options);
      } else if (this.openaiClient) {
        const controller = new AbortController();
        const timeoutMs = (parseInt(process.env.LLM_TIMEOUT) || 300) * 1000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await this.openaiClient.chat.completions.create({
            model: this.model,
            messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens || 2000
          }, { signal: controller.signal });
          return response.choices[0].message.content;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (error) {
      console.error(`Primary LLM (${this.provider}) failed:`, error.message);
      
      // Fallback to Ollama if enabled
      if (process.env.LLM_FALLBACK_ENABLED === 'true') {
        console.log('Falling back to Ollama...');
        try {
          const fallbackClient = new OpenAI({
            baseURL: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
            apiKey: 'ollama'
          });
          const response = await fallbackClient.chat.completions.create({
            model: process.env.LOCAL_LLM_MODEL || 'llama3.2',
            messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens || 2000
          });
          return response.choices[0].message.content;
        } catch (fallbackError) {
          console.error('Fallback to Ollama also failed:', fallbackError.message);
          throw fallbackError;
        }
      }
      throw error;
    }
    throw new Error('No LLM provider configured');
  }

  /**
   * Update the server-default Bedrock bearer token at runtime.
   */
  setBedrockToken(token) {
    this.bedrockApiKey = token;
    console.log('🔑 Bedrock bearer token updated at runtime');
  }

  /**
   * Parse expiry from a Bedrock presigned bearer token.
   * The token is base64-encoded and contains X-Amz-Date and X-Amz-Expires query params.
   * Returns { expiresAt: Date|null, remainingSeconds: number|null, expired: boolean }
   */
  static parseTokenExpiry(token) {
    if (!token) return { expiresAt: null, remainingSeconds: null, expired: true };
    try {
      // Token format: bedrock-api-key-<base64payload>
      const b64 = token.replace(/^bedrock-api-key-/, '');
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const dateMatch = decoded.match(/X-Amz-Date=(\d{8}T\d{6}Z)/);
      const expiresMatch = decoded.match(/X-Amz-Expires=(\d+)/);
      if (!dateMatch || !expiresMatch) return { expiresAt: null, remainingSeconds: null, expired: false };
      const issuedAt = new Date(
        dateMatch[1].replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')
      );
      const expiresInSec = parseInt(expiresMatch[1]);
      const expiresAt = new Date(issuedAt.getTime() + expiresInSec * 1000);
      const remainingSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      return { expiresAt, remainingSeconds, expired: remainingSeconds <= 0 };
    } catch (e) {
      return { expiresAt: null, remainingSeconds: null, expired: false };
    }
  }

  /**
   * Extract the AWS region from a Bedrock presigned bearer token.
   * The token must be used against the same region it was signed for.
   */
  static parseTokenRegion(token) {
    if (!token) return null;
    try {
      const b64 = token.replace(/^bedrock-api-key-/, '');
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const regionMatch = decoded.match(/X-Amz-Credential=[^%]+%2F\d+%2F([^%]+)%2F/);
      return regionMatch ? regionMatch[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Generic chat method for flexible LLM interactions
   * @param {Array} messages - Array of {role, content} objects
   * @param {Object} options - Optional settings like temperature
   * @returns {string} - The LLM response content
   */
  async chat(messages, options = {}) {
    return this._callWithFallback(messages, options);
  }

  async generateOntologyFromText(text, options = {}) {
    console.log('\n' + '='.repeat(80));
    console.log('🧠 ONTOLOGY EXTRACTION STARTED');
    console.log('='.repeat(80));
    console.log(`📄 Document length: ${text.length} characters`);
    console.log(`🤖 Using provider: ${this.provider}, model: ${this.model}`);

    // Truncate text if too long (to avoid token limits)
    const maxChars = options.maxChars || 100000;
    const truncatedText = text.length > maxChars 
      ? text.substring(0, maxChars) + '\n\n[Text truncated due to length...]'
      : text;

    if (text.length > maxChars) {
      console.log(`⚠️  Text truncated from ${text.length} to ${maxChars} characters`);
    }

    // Log a preview of the document
    console.log('\n📋 Document Preview (first 500 chars):');
    console.log('-'.repeat(50));
    console.log(truncatedText.substring(0, 500) + (truncatedText.length > 500 ? '...' : ''));
    console.log('-'.repeat(50));

    let prompt = this.buildOntologyPrompt(truncatedText, options);

    // For local LLMs, add JSON instruction to the prompt
    const isLocalLLM = this.provider === 'ollama';
    if (isLocalLLM) {
      prompt = prompt + '\n\nCRITICAL: You must respond with ONLY valid JSON. Do not include any text, explanations, or markdown formatting before or after the JSON object. Start your response with { and end with }.';
    }

    try {
      console.log('\n⏳ Calling LLM API...');
      const startTime = Date.now();

      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: prompt }
      ];

      let content = await this._callWithFallback(messages, { temperature: 0.2 });

      const endTime = Date.now();
      console.log(`✅ LLM response received in ${((endTime - startTime) / 1000).toFixed(2)}s`);

      // Extract and clean JSON from response
      content = this.extractJSON(content, isLocalLLM);

      const ontology = JSON.parse(content);
      
      // Validate and normalize the ontology structure
      const normalizedOntology = this.normalizeOntology(ontology);

      // Log the extracted ontology in detail
      this.logExtractedOntology(normalizedOntology);

      return normalizedOntology;
    } catch (error) {
      console.error('\n❌ ERROR calling LLM API:', error.message);
      if (error.message.includes('JSON')) {
        throw new Error(`Failed to parse LLM response as JSON. The model may not have returned valid JSON. Error: ${error.message}`);
      }
      throw new Error(`Failed to generate ontology: ${error.message}`);
    }
  }

  getSystemPrompt() {
    return `You are an expert ontology engineer and knowledge architect with deep expertise in:
- Semantic Web technologies (OWL, RDF, RDFS)
- Knowledge representation and reasoning
- Domain modeling and entity-relationship design
- Taxonomy construction and classification systems
- Named Entity Recognition and Information Extraction

Your task is to analyze documents and extract well-structured, semantically meaningful ontologies that accurately represent the knowledge contained in the text. 

Key principles you follow:
1. ACCURACY: Only extract entities and relationships explicitly mentioned or strongly implied in the text
2. HIERARCHY: Build proper taxonomies with meaningful class hierarchies
3. PRECISION: Use specific, descriptive names rather than generic terms
4. COMPLETENESS: Capture all important concepts, properties, and relationships
5. CONSISTENCY: Maintain consistent naming conventions and modeling patterns

You always return valid JSON that strictly follows the requested schema.`;
  }

  buildOntologyPrompt(text, options) {
    const domain = options.domain || 'general';
    
    return `# ONTOLOGY EXTRACTION TASK

Analyze the following document and extract a comprehensive, well-structured ontology.

## DOCUMENT TEXT:
---
${text}
---

## EXTRACTION GUIDELINES:

### Step 1: Identify the Domain
First, determine the primary domain(s) of this document (e.g., healthcare, finance, technology, legal, scientific research, etc.). This will guide your entity and relationship extraction.

### Step 2: Extract Classes (Concepts/Types)
Identify all significant concepts, categories, or types of entities mentioned. For each class:
- **URI**: Use format \`http://ontology.purplefabric.ai/[domain]#[ClassName]\` with PascalCase naming
- **Label**: Human-readable name
- **Comment**: Clear definition of what this class represents
- **subClassOf**: Parent class URIs if there's a hierarchical relationship

Consider these types of classes:
- Core domain concepts (e.g., Person, Organization, Document, Product)
- Abstract concepts (e.g., Process, Event, State, Attribute)
- Domain-specific entities (e.g., in healthcare: Disease, Treatment, Symptom)
- Role classes (e.g., Author, Customer, Manager)

### Step 3: Extract Properties (Relationships & Attributes)
Identify relationships between entities and attributes. For each property:
- **URI**: Use format \`http://ontology.purplefabric.ai/[domain]#[propertyName]\` with camelCase naming
- **Label**: Human-readable name
- **Comment**: Clear description of what this property represents
- **Domain**: Which class(es) this property applies to
- **Range**: What values this property can have (other classes for relationships, or datatypes like "string", "integer", "date", "boolean" for attributes)
- **propertyType**: Either "ObjectProperty" (links to another entity) or "DatatypeProperty" (has a literal value)

Common relationship patterns to look for:
- Hierarchical: partOf, containedIn, subTypeOf, memberOf
- Associative: relatedTo, associatedWith, linkedTo
- Causal: causedBy, resultsIn, leadsTo, enables
- Temporal: precedes, follows, occursDuring, startedBy
- Spatial: locatedIn, nearTo, adjacentTo
- Functional: performs, produces, consumes, provides

### Step 4: Extract Individuals (Instances)
Identify specific named entities, examples, or instances mentioned. For each individual:
- **URI**: Use format \`http://ontology.purplefabric.ai/[domain]#[individualName]\`
- **Label**: The actual name/identifier
- **Type**: Which class(es) this individual belongs to
- **Properties**: Any specific attribute values mentioned

Look for:
- Named people, organizations, locations
- Specific products, documents, events
- Dates, quantities, identifiers
- Examples or case studies mentioned

### Step 5: Validate Relationships
Ensure all extracted relationships make logical sense:
- Domain and range classes exist in your classes list
- Individual types reference existing classes
- Property domains and ranges are semantically appropriate

## OUTPUT FORMAT:

Return a JSON object with this exact structure:

{
  "uri": "http://ontology.purplefabric.ai/[domain]",
  "name": "[Descriptive Ontology Name based on document content]",
  "description": "[2-3 sentence summary of what this ontology represents]",
  "domain": "[primary domain: e.g., healthcare, finance, technology]",
  "extractionSummary": {
    "mainTopics": ["topic1", "topic2"],
    "keyEntities": ["entity1", "entity2"],
    "documentType": "[article, report, manual, research paper, etc.]"
  },
  "classes": [
    {
      "uri": "http://ontology.purplefabric.ai/domain#ClassName",
      "label": "Class Label",
      "comment": "Clear definition of what instances of this class represent",
      "subClassOf": []
    }
  ],
  "properties": [
    {
      "uri": "http://ontology.purplefabric.ai/domain#propertyName",
      "label": "Property Label", 
      "comment": "Description of this property",
      "propertyType": "ObjectProperty or DatatypeProperty",
      "domain": ["http://ontology.purplefabric.ai/domain#DomainClass"],
      "range": ["http://ontology.purplefabric.ai/domain#RangeClass or datatype"]
    }
  ],
  "individuals": [
    {
      "uri": "http://ontology.purplefabric.ai/domain#individualName",
      "label": "Individual Name",
      "type": ["http://ontology.purplefabric.ai/domain#ClassName"],
      "properties": {
        "propertyUri": "value"
      }
    }
  ]
}

## QUALITY REQUIREMENTS:

1. Extract AT LEAST 5-10 classes if the document has sufficient content
2. Extract AT LEAST 5-15 properties capturing key relationships
3. Extract any specific named individuals mentioned
4. Build meaningful class hierarchies where applicable
5. Use domain-specific terminology from the document
6. Avoid generic placeholder names - use actual concepts from the text
7. Ensure every property has valid domain and range values
8. Add descriptive comments that would help someone understand the ontology

Now analyze the document and extract the ontology:`;
  }

  normalizeOntology(ontology) {
    // Ensure required fields exist
    const normalized = {
      uri: ontology.uri || 'http://ontology.purplefabric.ai/extracted',
      name: ontology.name || 'Extracted Ontology',
      description: ontology.description || '',
      domain: ontology.domain || 'general',
      extractionSummary: ontology.extractionSummary || null,
      classes: Array.isArray(ontology.classes) ? ontology.classes : [],
      properties: Array.isArray(ontology.properties) ? ontology.properties : [],
      individuals: Array.isArray(ontology.individuals) ? ontology.individuals : []
    };

    // Normalize classes
    normalized.classes = normalized.classes.map(cls => ({
      uri: cls.uri || `http://ontology.purplefabric.ai/extracted#${this.sanitizeName(cls.label || 'Class')}`,
      label: cls.label || this.extractNameFromURI(cls.uri),
      comment: cls.comment || null,
      subClassOf: Array.isArray(cls.subClassOf) ? cls.subClassOf : (cls.subClassOf ? [cls.subClassOf] : [])
    }));

    // Normalize properties
    normalized.properties = normalized.properties.map(prop => ({
      uri: prop.uri || `http://ontology.purplefabric.ai/extracted#${this.sanitizeName(prop.label || 'Property')}`,
      label: prop.label || this.extractNameFromURI(prop.uri),
      comment: prop.comment || null,
      propertyType: prop.propertyType || 'ObjectProperty',
      domain: Array.isArray(prop.domain) ? prop.domain : (prop.domain ? [prop.domain] : []),
      range: Array.isArray(prop.range) ? prop.range : (prop.range ? [prop.range] : [])
    }));

    // Normalize individuals
    normalized.individuals = normalized.individuals.map(ind => ({
      uri: ind.uri || `http://ontology.purplefabric.ai/extracted#${this.sanitizeName(ind.label || 'Individual')}`,
      label: ind.label || this.extractNameFromURI(ind.uri),
      type: Array.isArray(ind.type) ? ind.type : (ind.type ? [ind.type] : []),
      properties: ind.properties || {}
    }));

    return normalized;
  }

  logExtractedOntology(ontology) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 EXTRACTED ONTOLOGY SUMMARY');
    console.log('='.repeat(80));
    
    console.log(`\n🏷️  Name: ${ontology.name}`);
    console.log(`🔗 URI: ${ontology.uri}`);
    console.log(`📝 Description: ${ontology.description || 'N/A'}`);
    console.log(`🎯 Domain: ${ontology.domain || 'general'}`);

    if (ontology.extractionSummary) {
      console.log('\n📋 Extraction Summary:');
      console.log(`   Document Type: ${ontology.extractionSummary.documentType || 'N/A'}`);
      console.log(`   Main Topics: ${(ontology.extractionSummary.mainTopics || []).join(', ') || 'N/A'}`);
      console.log(`   Key Entities: ${(ontology.extractionSummary.keyEntities || []).join(', ') || 'N/A'}`);
    }

    // Log Classes
    console.log(`\n📦 CLASSES (${ontology.classes.length}):`);
    console.log('-'.repeat(60));
    ontology.classes.forEach((cls, index) => {
      console.log(`\n  [${index + 1}] ${cls.label}`);
      console.log(`      URI: ${cls.uri}`);
      if (cls.comment) {
        console.log(`      Description: ${cls.comment.substring(0, 100)}${cls.comment.length > 100 ? '...' : ''}`);
      }
      if (cls.subClassOf && cls.subClassOf.length > 0) {
        console.log(`      Parent Classes: ${cls.subClassOf.map(uri => this.extractNameFromURI(uri)).join(', ')}`);
      }
    });

    // Log Properties
    console.log(`\n🔗 PROPERTIES (${ontology.properties.length}):`);
    console.log('-'.repeat(60));
    ontology.properties.forEach((prop, index) => {
      console.log(`\n  [${index + 1}] ${prop.label} (${prop.propertyType || 'ObjectProperty'})`);
      console.log(`      URI: ${prop.uri}`);
      if (prop.comment) {
        console.log(`      Description: ${prop.comment.substring(0, 80)}${prop.comment.length > 80 ? '...' : ''}`);
      }
      if (prop.domain && prop.domain.length > 0) {
        console.log(`      Domain: ${prop.domain.map(uri => this.extractNameFromURI(uri)).join(', ')}`);
      }
      if (prop.range && prop.range.length > 0) {
        console.log(`      Range: ${prop.range.map(uri => typeof uri === 'string' ? this.extractNameFromURI(uri) : uri).join(', ')}`);
      }
    });

    // Log Individuals
    console.log(`\n👤 INDIVIDUALS (${ontology.individuals.length}):`);
    console.log('-'.repeat(60));
    ontology.individuals.forEach((ind, index) => {
      console.log(`\n  [${index + 1}] ${ind.label}`);
      console.log(`      URI: ${ind.uri}`);
      if (ind.type && ind.type.length > 0) {
        console.log(`      Type: ${ind.type.map(uri => this.extractNameFromURI(uri)).join(', ')}`);
      }
      if (ind.properties && Object.keys(ind.properties).length > 0) {
        console.log(`      Properties: ${JSON.stringify(ind.properties)}`);
      }
    });

    // Summary statistics
    console.log('\n' + '='.repeat(80));
    console.log('📈 STATISTICS:');
    console.log(`   Total Classes: ${ontology.classes.length}`);
    console.log(`   Total Properties: ${ontology.properties.length}`);
    console.log(`   Total Individuals: ${ontology.individuals.length}`);
    
    const hierarchicalClasses = ontology.classes.filter(c => c.subClassOf && c.subClassOf.length > 0).length;
    console.log(`   Classes with Parent: ${hierarchicalClasses}`);
    
    const objectProps = ontology.properties.filter(p => p.propertyType === 'ObjectProperty').length;
    const datatypeProps = ontology.properties.filter(p => p.propertyType === 'DatatypeProperty').length;
    console.log(`   Object Properties: ${objectProps}`);
    console.log(`   Datatype Properties: ${datatypeProps}`);
    
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Extract and clean JSON from LLM response
   * Handles various edge cases from local LLMs
   */
  extractJSON(content, isLocalLLM = false) {
    if (!content) {
      throw new Error('Empty response from LLM');
    }

    let cleaned = content.trim();

    // Try to extract JSON from markdown code blocks first
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    // Remove any leading text before the first {
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) {
      cleaned = cleaned.substring(firstBrace);
    }

    // Find matching closing brace (handle nested objects)
    let braceCount = 0;
    let lastValidIndex = -1;
    
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') {
        braceCount++;
      } else if (cleaned[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastValidIndex = i;
          break; // Found the matching closing brace
        }
      }
    }

    if (lastValidIndex > 0) {
      cleaned = cleaned.substring(0, lastValidIndex + 1);
    }

    // Try to parse as-is first
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      // Continue with more aggressive cleaning
    }

    // Fix common JSON issues from local LLMs
    // Remove trailing commas before ] or }
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    
    // Fix unquoted keys (simple cases)
    cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    
    // Remove control characters
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');
    
    // Try parsing again
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      // Log for debugging
      console.error('JSON extraction failed. First 500 chars:', cleaned.substring(0, 500));
      console.error('Last 200 chars:', cleaned.substring(cleaned.length - 200));
      throw new Error(`Failed to extract valid JSON: ${e.message}`);
    }
  }

  sanitizeName(name) {
    return name
      .replace(/[^a-zA-Z0-9]/g, '')
      .replace(/^[0-9]/, 'N$&')
      .replace(/^([a-z])/, (match) => match.toUpperCase());
  }

  extractNameFromURI(uri) {
    if (!uri) return 'Unknown';
    if (typeof uri !== 'string') return String(uri);
    const parts = uri.split('#');
    if (parts.length > 1) return parts[parts.length - 1];
    const pathParts = uri.split('/');
    return pathParts[pathParts.length - 1] || 'Unknown';
  }
}

module.exports = new LLMService();
module.exports.llmRequestContext = llmRequestContext;
