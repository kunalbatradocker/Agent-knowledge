/**
 * VKG Ontology Service
 * Generates OWL ontologies from Trino catalog schemas using LLM,
 * stores them in GraphDB with mapping annotations (vkgmap: predicates).
 *
 * Approach: LLM outputs structured JSON (like schemaAnalysisService),
 * then we generate valid Turtle programmatically. This avoids malformed
 * RDF from LLM and provides a mapping table for the review UI.
 */

const trinoCatalogService = require('./trinoCatalogService');
const graphDBStore = require('./graphDBStore');
const llmService = require('./llmService');
const redisService = require('./redisService');
const logger = require('../utils/logger');

const VKG_MAP_PREFIX = 'http://purplefabric.ai/vkg/mapping/';
const VKG_BASE_URI = 'http://purplefabric.ai/vkg/';
const CACHE_TTL = 300; // 5 minutes

// SQL type → XSD type mapping
const SQL_TO_XSD = {
  varchar: 'xsd:string', char: 'xsd:string', text: 'xsd:string', clob: 'xsd:string',
  integer: 'xsd:integer', int: 'xsd:integer', smallint: 'xsd:integer', bigint: 'xsd:long',
  tinyint: 'xsd:integer', serial: 'xsd:integer',
  decimal: 'xsd:decimal', numeric: 'xsd:decimal', real: 'xsd:float',
  float: 'xsd:float', double: 'xsd:double',
  boolean: 'xsd:boolean', bool: 'xsd:boolean',
  date: 'xsd:date', time: 'xsd:time',
  timestamp: 'xsd:dateTime', 'timestamp with time zone': 'xsd:dateTime',
  json: 'xsd:string', jsonb: 'xsd:string', uuid: 'xsd:string',
  bytea: 'xsd:hexBinary', blob: 'xsd:hexBinary',
};

function sqlTypeToXsd(sqlType) {
  const normalized = (sqlType || 'varchar').toLowerCase().replace(/\(.*\)/, '').trim();
  return SQL_TO_XSD[normalized] || 'xsd:string';
}

class VKGOntologyService {
  constructor() {
    logger.info('🧠 VKGOntologyService initialized');
  }

  /**
   * Generate an ontology from all active Trino catalogs for a workspace.
   * Steps:
   *   1. Introspect all catalogs via Trino
   *   2. Build schema description
   *   3. LLM generates structured JSON (classes, properties, relationships)
   *   4. Convert JSON → Turtle programmatically
   *   5. Return for review (with mapping table)
   */
  async generateFromCatalogs(tenantId, workspaceId, options = {}) {
    const startTime = Date.now();

    // Step 1: Introspect
    logger.info(`[VKG] Introspecting catalogs for tenant ${tenantId}...`);
    const catalogSchemas = await trinoCatalogService.introspectAllCatalogs(tenantId);
    const validSchemas = catalogSchemas.filter(s => !s.error && s.tables?.length > 0);

    if (validSchemas.length === 0) {
      throw new Error('No catalogs with tables found. Register and connect databases first.');
    }

    // Step 2: Build schema description for LLM
    const schemaDescription = this._buildSchemaDescription(validSchemas);

    // Step 3: LLM generates structured JSON
    logger.info(`[VKG] Generating ontology from ${validSchemas.length} catalog(s)...`);
    const analysis = await this._analyzeSchemaWithLLM(schemaDescription, options);

    // Step 4: Convert to Turtle
    const baseUri = options.baseUri || VKG_BASE_URI;
    const turtle = this._generateTurtle(analysis, baseUri);

    // Build mapping table for review UI
    const mappingTable = this._buildMappingTable(analysis);

    const durationMs = Date.now() - startTime;

    if (!options.autoSave) {
      logger.info(`[VKG] Ontology generated in ${durationMs}ms — returning for review`);
      return {
        success: true,
        status: 'preview',
        catalogsUsed: validSchemas.map(s => s.catalog),
        tablesFound: validSchemas.reduce((sum, s) => sum + s.tables.length, 0),
        durationMs,
        turtle,
        mappingTable,
        analysis,
        schemaDescription
      };
    }

    return this._saveOntology(tenantId, workspaceId, turtle, validSchemas, durationMs, options);
  }

  /**
   * Save a reviewed/edited ontology to GraphDB
   */
  async saveOntology(tenantId, workspaceId, turtle, options = {}) {
    if (!turtle || turtle.trim().length < 50) {
      throw new Error('Ontology content is too short or empty');
    }

    // Clean: strip markdown code blocks, validate RDF lines
    turtle = this._cleanTurtle(turtle);

    // If baseUri provided, replace the default prefix
    if (options.baseUri && options.baseUri !== VKG_BASE_URI) {
      turtle = turtle.replace(
        new RegExp(`@prefix\\s+:\\s+<${VKG_BASE_URI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\s*\\.`),
        `@prefix : <${options.baseUri}> .`
      );
    }

    return this._saveOntology(tenantId, workspaceId, turtle, [], 0, options);
  }

  async _saveOntology(tenantId, workspaceId, turtle, validSchemas, durationMs, options = {}) {
    const name = options.name || 'vkg-ontology';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Use workspace name (human-readable) in graph IRI instead of UUID
    const wsSlug = options.workspaceName || workspaceId;
    const graphIRI = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${wsSlug}/ontology/${slug}`;
    logger.info(`[VKG] Storing ontology "${name}" in GraphDB: ${graphIRI}`);

    // Import directly to the named graph (bypasses graphDBStore.importTurtle's IRI builder)
    await graphDBStore.importTurtleToGraph(tenantId, turtle, graphIRI);

    // Cache the mapping annotations (keyed by workspace ID for stable lookups)
    await this._cacheMappings(tenantId, workspaceId, turtle);

    logger.info(`[VKG] Ontology "${name}" saved to GraphDB (workspace: ${wsSlug})`);

    return {
      success: true,
      status: 'saved',
      name,
      graphIRI,
      workspaceName: wsSlug,
      catalogsUsed: validSchemas.map(s => s.catalog),
      tablesFound: validSchemas.reduce((sum, s) => sum + s.tables.length, 0),
      durationMs
    };
  }

  /**
   * Build a human-readable schema description for the LLM prompt
   */
  _buildSchemaDescription(catalogSchemas) {
    const lines = [];
    for (const schema of catalogSchemas) {
      lines.push(`\n=== Catalog: ${schema.catalog} (Schema: ${schema.schema}) ===`);
      for (const table of schema.tables) {
        const cols = table.columns.map(c => {
          let desc = `  - ${c.name} (${c.type})`;
          if (c.isPrimaryKey) desc += ' [PK]';
          if (c.isForeignKey) desc += ' [FK]';
          return desc;
        }).join('\n');
        lines.push(`\nTable: ${table.fullName}\n${cols}`);
      }
      if (schema.relationships?.length > 0) {
        lines.push('\nDetected Relationships:');
        for (const rel of schema.relationships) {
          lines.push(`  ${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Use LLM to analyze database schemas and output structured JSON.
   * Same pattern as schemaAnalysisService.analyzeText — no bedrockToken
   * passed; relies on injectUserLLMToken middleware via AsyncLocalStorage.
   */
  async _analyzeSchemaWithLLM(schemaDescription, options = {}) {
      const systemPrompt = `You are an expert ontology engineer. Analyze database schemas and produce a structured ontology mapping.

  Key principles:
  - Each significant table becomes an OWL class
  - Foreign key relationships become object properties
  - Table columns become datatype properties
  - Use PascalCase for class names, camelCase for property names
  - Infer semantic names from column names (e.g., first_name → firstName)
  - Skip internal/system columns unless they carry business meaning
  - Be concise: skip columns that are obvious (created_at, updated_at) unless they carry business meaning
  - Return ONLY valid JSON, no explanations or markdown`;

      const userPrompt = `Analyze these database schemas and produce an ontology mapping:

  ${schemaDescription}

  Return ONLY valid JSON in this exact format:
  {
    "classes": [
      {
        "name": "Customer",
        "label": "Customer",
        "comment": "Represents a customer entity",
        "sourceTable": "catalog.schema.table_name",
        "sourceIdColumn": "id_column_name"
      }
    ],
    "dataProperties": [
      {
        "name": "firstName",
        "label": "First Name",
        "domain": "Customer",
        "xsdType": "string",
        "sourceColumn": "first_name",
        "sourceTable": "catalog.schema.table_name"
      }
    ],
    "objectProperties": [
      {
        "name": "hasTransaction",
        "label": "Has Transaction",
        "domain": "Customer",
        "range": "Transaction",
        "joinSQL": "catalog.schema.customer.id = catalog.schema.transaction.customer_id"
      }
    ]
  }

  CRITICAL: Return ONLY valid JSON. No explanations, no markdown code blocks.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      // Try with increasing token limits (response may be large for many tables)
      const tokenLimits = [16384, 32768];
      let lastError = null;

      for (const maxTokens of tokenLimits) {
        const response = await llmService.chat(messages, { temperature: 0.2, maxTokens });

        let jsonText = this._extractJSON(response);

        // Attempt to repair truncated JSON (common: missing closing brackets)
        jsonText = this._repairTruncatedJSON(jsonText);

        try {
          const analysis = JSON.parse(jsonText);

          // Validate structure
          if (!analysis.classes || !Array.isArray(analysis.classes) || analysis.classes.length === 0) {
            throw new Error('LLM analysis returned no classes.');
          }
          analysis.dataProperties = analysis.dataProperties || [];
          analysis.objectProperties = analysis.objectProperties || [];

          logger.info(`[VKG] LLM analysis: ${analysis.classes.length} classes, ${analysis.dataProperties.length} data props, ${analysis.objectProperties.length} object props (maxTokens=${maxTokens})`);
          return analysis;
        } catch (err) {
          lastError = err;
          logger.warn(`[VKG] JSON parse failed with maxTokens=${maxTokens}: ${err.message} — ${maxTokens < tokenLimits[tokenLimits.length - 1] ? 'retrying with higher limit' : 'giving up'}`);
          logger.warn(`[VKG] Raw response (first 500 chars): ${response.substring(0, 500)}`);
        }
      }

      logger.error(`[VKG] Failed to parse LLM JSON after all attempts: ${lastError?.message}`);
      throw new Error('LLM returned invalid JSON. Please try again.');
    }

  /**
   * Extract JSON from LLM response (may be wrapped in code blocks or have leading text)
   */
  _extractJSON(text) {
    // Try to find JSON in code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();

    // Try to find raw JSON object
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      return text.substring(jsonStart, jsonEnd + 1);
    }

    return text.trim();
  }
  /**
   * Attempt to repair truncated JSON from LLM output.
   * Common issue: response hits token limit and JSON is cut off mid-object.
   */
  _repairTruncatedJSON(json) {
    if (!json) return json;
    let text = json.trim();

    // Remove any trailing incomplete object/array element
    // e.g., '{ "name": "foo",' or '{ "name":' at the very end
    text = text.replace(/,\s*\{[^}]*$/, ''); // remove trailing incomplete object in array
    text = text.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, ''); // remove trailing incomplete key-value
    text = text.replace(/,\s*$/, ''); // remove trailing comma

    // Count open/close brackets and add missing closers
    let openBraces = 0, openBrackets = 0;
    let inString = false, escape = false;
    for (const ch of text) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }

    // Close any unclosed brackets/braces
    while (openBrackets > 0) { text += ']'; openBrackets--; }
    while (openBraces > 0) { text += '}'; openBraces--; }

    return text;
  }

  /**
   * Generate valid Turtle from structured analysis JSON.
   * This is deterministic — no LLM involved, no malformed RDF possible.
   */
  _generateTurtle(analysis, baseUri = VKG_BASE_URI) {
    const lines = [];

    // Prefixes
    lines.push(`@prefix : <${baseUri}> .`);
    lines.push('@prefix owl: <http://www.w3.org/2002/07/owl#> .');
    lines.push('@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .');
    lines.push('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');
    lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
    lines.push(`@prefix vkgmap: <${VKG_MAP_PREFIX}> .`);
    lines.push('');

    // Ontology declaration
    lines.push('<> a owl:Ontology ;');
    lines.push('  rdfs:label "VKG Federated Ontology" ;');
    lines.push('  rdfs:comment "Auto-generated ontology from federated database schemas" .');
    lines.push('');

    // Classes
    for (const cls of analysis.classes) {
      const name = this._sanitizeName(cls.name);
      lines.push(`:${name} a owl:Class ;`);
      lines.push(`  rdfs:label "${this._escapeLiteral(cls.label || cls.name)}" ;`);
      if (cls.comment) lines.push(`  rdfs:comment "${this._escapeLiteral(cls.comment)}" ;`);
      if (cls.sourceTable) lines.push(`  vkgmap:sourceTable "${this._escapeLiteral(cls.sourceTable)}" ;`);
      if (cls.sourceIdColumn) lines.push(`  vkgmap:sourceIdColumn "${this._escapeLiteral(cls.sourceIdColumn)}" ;`);
      // Replace last ; with .
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
      lines.push('');
    }

    // Datatype properties
    for (const prop of analysis.dataProperties) {
      const name = this._sanitizeName(prop.name);
      const xsd = this._normalizeXsdType(prop.xsdType);
      lines.push(`:${name} a owl:DatatypeProperty ;`);
      lines.push(`  rdfs:label "${this._escapeLiteral(prop.label || prop.name)}" ;`);
      if (prop.domain) lines.push(`  rdfs:domain :${this._sanitizeName(prop.domain)} ;`);
      lines.push(`  rdfs:range ${xsd} ;`);
      if (prop.sourceColumn) lines.push(`  vkgmap:sourceColumn "${this._escapeLiteral(prop.sourceColumn)}" ;`);
      if (prop.sourceTable) lines.push(`  vkgmap:sourceTable "${this._escapeLiteral(prop.sourceTable)}" ;`);
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
      lines.push('');
    }

    // Object properties
    for (const rel of analysis.objectProperties) {
      const name = this._sanitizeName(rel.name);
      lines.push(`:${name} a owl:ObjectProperty ;`);
      lines.push(`  rdfs:label "${this._escapeLiteral(rel.label || rel.name)}" ;`);
      if (rel.domain) lines.push(`  rdfs:domain :${this._sanitizeName(rel.domain)} ;`);
      if (rel.range) lines.push(`  rdfs:range :${this._sanitizeName(rel.range)} ;`);
      if (rel.joinSQL) lines.push(`  vkgmap:joinSQL "${this._escapeLiteral(rel.joinSQL)}" ;`);
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Sanitize a name for use as a Turtle local name */
  _sanitizeName(name) {
    return (name || 'Unknown').replace(/[^a-zA-Z0-9_]/g, '');
  }

  /** Escape a string for use as a Turtle literal */
  _escapeLiteral(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  /** Normalize an XSD type from LLM output to a valid XSD type */
  _normalizeXsdType(raw) {
    if (!raw) return 'xsd:string';
    const cleaned = raw.replace(/^xsd:/, '').toLowerCase().trim();
    // Map common LLM outputs to valid XSD types
    const XSD_MAP = {
      string: 'xsd:string', text: 'xsd:string', varchar: 'xsd:string', char: 'xsd:string',
      integer: 'xsd:integer', int: 'xsd:integer', smallint: 'xsd:integer', tinyint: 'xsd:integer',
      bigint: 'xsd:long', long: 'xsd:long', serial: 'xsd:integer',
      decimal: 'xsd:decimal', numeric: 'xsd:decimal',
      float: 'xsd:float', real: 'xsd:float',
      double: 'xsd:double',
      boolean: 'xsd:boolean', bool: 'xsd:boolean',
      date: 'xsd:date',
      time: 'xsd:time',
      datetime: 'xsd:dateTime', timestamp: 'xsd:dateTime', datetimestamp: 'xsd:dateTime',
      hexbinary: 'xsd:hexBinary', base64binary: 'xsd:base64Binary',
      anyuri: 'xsd:anyURI', uri: 'xsd:anyURI',
    };
    return XSD_MAP[cleaned] || 'xsd:string';
  }

  /**
   * Build a mapping table from the analysis for the review UI.
   * Each row: ontology concept → source table/column → type
   */
  _buildMappingTable(analysis) {
    const rows = [];

    for (const cls of analysis.classes) {
      rows.push({
        ontologyElement: cls.name,
        type: 'Class',
        sourceTable: cls.sourceTable || '',
        sourceColumn: cls.sourceIdColumn || '',
        xsdType: '',
        label: cls.label || cls.name,
        comment: cls.comment || ''
      });
    }

    for (const prop of analysis.dataProperties) {
      rows.push({
        ontologyElement: prop.name,
        type: 'DataProperty',
        sourceTable: prop.sourceTable || '',
        sourceColumn: prop.sourceColumn || '',
        xsdType: this._normalizeXsdType(prop.xsdType).replace('xsd:', ''),
        domain: prop.domain || '',
        label: prop.label || prop.name
      });
    }

    for (const rel of analysis.objectProperties) {
      rows.push({
        ontologyElement: rel.name,
        type: 'ObjectProperty',
        sourceTable: '',
        sourceColumn: '',
        xsdType: '',
        domain: rel.domain || '',
        range: rel.range || '',
        joinSQL: rel.joinSQL || '',
        label: rel.label || rel.name
      });
    }

    return rows;
  }

  /**
   * Extract and cache mapping annotations from the ontology turtle
   */
  async _cacheMappings(tenantId, workspaceId, turtle) {
    const mappings = this._parseMappingAnnotations(turtle);
    const cacheKey = `vkg:mappings:v2:${tenantId}:${workspaceId}`;
    await redisService.set(cacheKey, JSON.stringify(mappings), CACHE_TTL);
    return mappings;
  }

  /**
   * Get mapping annotations for a workspace (from cache or GraphDB)
   */
  async getMappingAnnotations(tenantId, workspaceId, workspaceName = null) {
      const cacheKey = `vkg:mappings:v2:${tenantId}:${workspaceId}`;
      const cached = await redisService.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          console.log(`  🗺️ Mappings: cache HIT (${Object.keys(parsed.classes || {}).length} classes)`);
          return parsed;
        } catch { /* fall through */ }
      }

      console.log(`  🗺️ Mappings: cache MISS — querying GraphDB SPARQL...`);
      const start = Date.now();
      const sparql = `
        PREFIX vkgmap: <${VKG_MAP_PREFIX}>
        SELECT ?subject ?predicate ?object WHERE {
          ?subject ?predicate ?object .
          FILTER(STRSTARTS(STR(?predicate), "${VKG_MAP_PREFIX}"))
        }
      `;

      try {
        // VKG ontologies use workspace name in graph IRI, not UUID.
        // Query specifically the VKG graphs using workspace name slug.
        const wsSlug = workspaceName || workspaceId;
        const vkgGraphPattern = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${wsSlug}/ontology/`;
        
        const result = await graphDBStore.executeSPARQL(tenantId, workspaceId, sparql, 'schema', {
          includeGlobalOntologies: false,
          includeTenantOntologies: false,
          includeWorkspaceOntologies: true,
          // Also search VKG-specific graphs (workspace name based)
          vkgGraphPattern
        });
        const mappings = this._buildMappingsFromSPARQL(result);
        console.log(`  🗺️ Mappings: loaded in ${Date.now() - start}ms (${Object.keys(mappings.classes || {}).length} classes, ${Object.keys(mappings.properties || {}).length} props, ${Object.keys(mappings.relationships || {}).length} rels)`);
        await redisService.set(cacheKey, JSON.stringify(mappings), CACHE_TTL);
        return mappings;
      } catch (err) {
        console.log(`  🗺️ Mappings: FAILED in ${Date.now() - start}ms — ${err.message}`);
        logger.warn(`Failed to load VKG mappings from GraphDB: ${err.message}`);
        return { classes: {}, properties: {}, relationships: {} };
      }
    }


  /**
   * Clean turtle content: strip markdown code blocks, leading/trailing noise,
   * and validate/remove malformed RDF lines.
   */
  _cleanTurtle(turtle) {
    let cleaned = turtle.trim();

    const codeBlockMatch = cleaned.match(/```(?:turtle|ttl|rdf|sparql|n3)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

    cleaned = cleaned.replace(/^`+/, '').replace(/`+$/, '').trim();

    const prefixStart = cleaned.search(/@(prefix|base)\s/i);
    if (prefixStart > 0) cleaned = cleaned.substring(prefixStart);

    // Remove inline backticks
    cleaned = cleaned.replace(/`/g, '');

    // Validate line-by-line: remove lines with illegal RDF subjects
    const lines = cleaned.split('\n');
    const validLines = [];
    let inMultiLine = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('@') ||
          inMultiLine || trimmed.startsWith(';') || trimmed.startsWith(',') ||
          trimmed === '.' || trimmed === '];' || trimmed === '] .') {
        validLines.push(line);
        if (trimmed.endsWith(';') || trimmed.endsWith(',') || trimmed.endsWith('[')) inMultiLine = true;
        else if (trimmed.endsWith('.') || trimmed === '') inMultiLine = false;
        continue;
      }

      const startsWithValidSubject = /^(<[^>]*>|[a-zA-Z_][\w-]*:[a-zA-Z_][\w-]*|:[a-zA-Z_][\w-]*|_:[a-zA-Z_][\w-]*)/.test(trimmed);
      if (startsWithValidSubject) {
        validLines.push(line);
        if (trimmed.endsWith(';') || trimmed.endsWith(',') || trimmed.endsWith('[')) inMultiLine = true;
        else if (trimmed.endsWith('.')) inMultiLine = false;
      } else {
        logger.warn(`[VKG] Stripped malformed turtle line: ${trimmed.substring(0, 100)}`);
        inMultiLine = false;
      }
    }

    return validLines.join('\n').trim();
  }

  /**
   * Parse mapping annotations from turtle text (lightweight regex-based)
   */
  _parseMappingAnnotations(turtle) {
    const mappings = { classes: {}, properties: {}, relationships: {} };
    const lines = turtle.split('\n');
    let currentSubject = null;
    let currentType = null;

    for (const line of lines) {
      const trimmed = line.trim();

      const subjectMatch = trimmed.match(/^:(\w+)\s+a\s+owl:(Class|DatatypeProperty|ObjectProperty)/);
      if (subjectMatch) {
        currentSubject = subjectMatch[1];
        currentType = subjectMatch[2];
        if (currentType === 'Class') mappings.classes[currentSubject] = {};
        else if (currentType === 'DatatypeProperty') mappings.properties[currentSubject] = {};
        else if (currentType === 'ObjectProperty') mappings.relationships[currentSubject] = {};
      }

      if (currentSubject) {
        const mapMatch = trimmed.match(/vkgmap:(\w+)\s+"([^"]+)"/);
        if (mapMatch) {
          const [, predicate, value] = mapMatch;
          const target = currentType === 'Class' ? mappings.classes[currentSubject]
            : currentType === 'DatatypeProperty' ? mappings.properties[currentSubject]
            : mappings.relationships[currentSubject];
          if (target) target[predicate] = value;
        }

        const domainMatch = trimmed.match(/rdfs:domain\s+:(\w+)/);
        if (domainMatch) {
          const target = mappings.properties[currentSubject] || mappings.relationships[currentSubject];
          if (target) target.domain = domainMatch[1];
        }
        const rangeMatch = trimmed.match(/rdfs:range\s+(?::(\w+)|xsd:(\w+))/);
        if (rangeMatch) {
          const target = mappings.properties[currentSubject] || mappings.relationships[currentSubject];
          if (target) target.range = rangeMatch[1] || rangeMatch[2];
        }
      }

      if (trimmed === '' || trimmed === '.') {
        currentSubject = null;
        currentType = null;
      }
    }

    return mappings;
  }

  _buildMappingsFromSPARQL(result) {
      const mappings = { classes: {}, properties: {}, relationships: {} };
      if (!result?.results?.bindings) return mappings;

      for (const binding of result.results.bindings) {
        const subject = binding.subject?.value?.split('/').pop() || '';
        const predicate = binding.predicate?.value?.replace(VKG_MAP_PREFIX, '') || '';
        const object = binding.object?.value || '';

        // Categorize by predicate type:
        // - sourceTable + sourceIdColumn on a class → classes
        // - sourceColumn (+ optional sourceTable on a property) → properties
        // - joinSQL → relationships
        if (predicate === 'joinSQL') {
          if (!mappings.relationships[subject]) mappings.relationships[subject] = {};
          mappings.relationships[subject][predicate] = object;
        } else if (predicate === 'sourceColumn') {
          if (!mappings.properties[subject]) mappings.properties[subject] = {};
          mappings.properties[subject][predicate] = object;
        } else if (predicate === 'sourceTable' || predicate === 'sourceIdColumn') {
          // Could be on a class OR a datatype property (properties also have sourceTable)
          // We'll put it in classes first; second pass resolves properties that also have sourceTable
          if (!mappings.classes[subject]) mappings.classes[subject] = {};
          mappings.classes[subject][predicate] = object;
        } else {
          // Unknown vkgmap predicate — store in classes as fallback
          if (!mappings.classes[subject]) mappings.classes[subject] = {};
          mappings.classes[subject][predicate] = object;
        }
      }

      // Second pass: subjects that have sourceColumn are properties, not classes.
      // If they also had sourceTable, move that to the property entry.
      for (const propName of Object.keys(mappings.properties)) {
        if (mappings.classes[propName]) {
          // Merge sourceTable from classes into the property entry
          Object.assign(mappings.properties[propName], mappings.classes[propName]);
          delete mappings.classes[propName];
        }
      }

      return mappings;
    }

  async detectSchemaDrift(tenantId, workspaceId, workspaceName = null) {
    const [currentSchemas, storedMappings] = await Promise.all([
      trinoCatalogService.introspectAllCatalogs(tenantId),
      this.getMappingAnnotations(tenantId, workspaceId, workspaceName)
    ]);

    const drift = { newTables: [], removedTables: [], newColumns: [], removedColumns: [] };

    const currentTables = new Set();
    for (const schema of currentSchemas) {
      for (const table of (schema.tables || [])) {
        currentTables.add(table.fullName);
      }
    }

    const mappedTables = new Set();
    for (const [, meta] of Object.entries(storedMappings.classes)) {
      if (meta.sourceTable) mappedTables.add(meta.sourceTable);
    }

    for (const table of currentTables) {
      if (!mappedTables.has(table)) drift.newTables.push(table);
    }
    for (const table of mappedTables) {
      if (!currentTables.has(table)) drift.removedTables.push(table);
    }

    drift.hasDrift = drift.newTables.length > 0 || drift.removedTables.length > 0;
    return drift;
  }

  async invalidateCache(tenantId, workspaceId) {
    await redisService.del(`vkg:mappings:v2:${tenantId}:${workspaceId}`);
  }
}

module.exports = new VKGOntologyService();
