/**
 * LLM-based CSV Schema Analyzer
 * Uses LLM to analyze CSV structure and suggest ontology schema
 * 
 * Now integrates:
 * - promptSanitizer for input sanitization (prompt injection prevention)
 * - dataProfileService for deterministic column profiling (reduces LLM dependency)
 * - llmOutputValidator for output validation
 */

const llmService = require('./llmService');
const logger = require('../utils/logger');
const { sanitizeHeaders, sanitizeSampleRows, sanitizeValue, sanitizeOntologyContext, sanitizeDocumentText } = require('../utils/promptSanitizer');
const dataProfileService = require('./dataProfileService');
const llmOutputValidator = require('./llmOutputValidator');

class LLMCSVAnalyzer {
  constructor() {
    logger.info(`📊 LLMCSVAnalyzer initialized (using shared llmService)`);
  }

  async _chat(messages, options = {}) {
    return llmService.chat(messages, { temperature: options.temperature || 0.2, ...options });
  }

  async analyze(headers, sampleRows = [], options = {}) {
    // Sanitize inputs before LLM prompt interpolation
    const safeHeaders = sanitizeHeaders(headers);
    const safeSampleRows = sanitizeSampleRows(sampleRows);
    const sampleData = this.buildSampleData(safeHeaders, safeSampleRows);
    const { sheets } = options;

    // Run deterministic data profiling first (no LLM needed)
    const dataProfile = dataProfileService.profileColumns(headers, sampleRows, { sheets });
    
    // Build profiling context for the LLM — this gives it pre-computed type info
    // so it focuses on semantic naming and relationships, not type detection
    const profileContext = Object.values(dataProfile.columns).map(p => 
      `  - "${p.header}": detected=${p.type}, xsd=${p.xsdType}, nullRate=${p.nullRate}, cardinality=${p.cardinality}${p.isId ? ' [PRIMARY KEY]' : ''}${p.isFkCandidate ? ' [FK CANDIDATE]' : ''}${p.isCategory ? ' [CATEGORY]' : ''}`
    ).join('\n');
    
    const fkContext = dataProfile.fkCandidates.length > 0
      ? `\nDETECTED FK RELATIONSHIPS:\n${dataProfile.fkCandidates.map(fk => 
          `  - "${fk.fromColumn}" (${fk.fromSheet}) → "${fk.toColumn}" (${fk.toSheet}) [match rate: ${(fk.matchRate * 100).toFixed(0)}%]`
        ).join('\n')}`
      : '';

    // Build per-sheet context if multi-sheet Excel
    let sheetContext = '';
    if (sheets && sheets.length > 1) {
      sheetContext = `

MULTI-SHEET WORKBOOK (${sheets.length} sheets):
${sheets.map(s => `  - "${sanitizeValue(s.name, 100)}": ${s.rowCount} rows, columns: ${sanitizeHeaders(s.headers).join(', ')}`).join('\n')}

CROSS-SHEET RELATIONSHIP DETECTION:
- Look for columns that appear as IDs in one sheet and foreign keys in another
- Each sheet likely represents a different entity type — use sheet names as hints for class names
- Columns shared across sheets with matching values indicate relationships
- Include cross-sheet relationships in the "relationships" array with clear from/to class names`;
    }

    const systemPrompt = `You are a knowledge graph and ontology expert. Analyze CSV structure and design an OWL-compatible schema with proper data properties and object properties.${sheetContext}

DATA PROFILING RESULTS (pre-computed, use these for type decisions):
${profileContext}
${fkContext}

Output ONLY valid JSON:
{
  "primaryClass": "MainEntityName",
  "primaryClassExplanation": "Why this class represents each row",
  "description": "What this dataset represents",
  "columns": [
    {
      "column": "column_name",
      "type": "id|date|numeric|boolean|text|category|entity",
      "includeAsNode": boolean,
      "linkedClass": "ClassName ONLY if type is entity/category, otherwise empty string",
      "objectProperty": "hasCustomer (ONLY for entity columns)",
      "dataProperty": "propertyName (for literal values: id, date, numeric, boolean, text)",
      "reasoning": "Classification rationale",
      "suggestion": "Plain English explanation of recommended mapping",
      "queryExample": "Example SPARQL query using this field"
    }
  ],
  "entityTypes": [
    {"name": "ClassName", "description": "What it represents"}
  ],
  "dataProperties": [
    {"name": "propertyName", "domain": "ClassName", "range": "xsd:string|xsd:integer|xsd:date|xsd:decimal|xsd:boolean", "description": "What this property stores"}
  ],
  "objectProperties": [
    {"name": "hasCustomer", "domain": "SourceClass", "range": "TargetClass", "description": "Semantic meaning of relationship"}
  ],
  "relationships": [
    {"from": "SourceClass", "to": "TargetClass", "predicate": "hasCustomer", "description": "Semantic meaning"}
  ]
}

CRITICAL RULES:
1. DATA PROPERTIES (includeAsNode=false, linkedClass=""):
   - MUST use for: id, date, numeric, boolean, text columns
   - These are NEVER nodes, they are literal values stored on the entity
   - Date columns like "date_received", "created_at", "order_date" → includeAsNode=FALSE, linkedClass=""
   - Numeric columns like "amount", "quantity", "price" → includeAsNode=FALSE
   - Name semantically: "dateReceived" not "date", "totalAmount" not "amount"
   - Specify correct XSD range: xsd:string, xsd:integer, xsd:decimal, xsd:date, xsd:boolean

2. OBJECT PROPERTIES (includeAsNode=true, linkedClass="TargetClass"):
   - ONLY use for: entity/category columns that reference OTHER THINGS (foreign keys)
   - Examples: customer_id, product_id, category, status (if referencing lookup table)
   - Name semantically using "has", "belongs", "contains" patterns
   - linkedClass should be the TARGET entity type, NOT the primary class

3. For each entity column, MUST provide both:
   - linkedClass: The target class name (e.g., "Customer")
   - objectProperty: The semantic relationship name (e.g., "hasCustomer")

4. Query examples should use SPARQL syntax (not SQL).`;

    const userPrompt = `Analyze this ${sheets && sheets.length > 1 ? 'multi-sheet Excel workbook' : 'CSV'} and suggest a knowledge graph schema:

COLUMNS: ${safeHeaders.join(', ')}

SAMPLE DATA:
${sampleData}

Use the DATA PROFILING RESULTS above to inform your type decisions. Focus on semantic naming and relationships.
Output only JSON.`;

    try {
      console.log(`\n📊 LLM analyzing CSV: ${headers.length} columns, ${sampleRows.length} sample rows`);
      const startTime = Date.now();

      // For multi-sheet workbooks, always analyze per-sheet for reliable class assignment
      if (sheets && sheets.length > 1) {
        console.log(`📊 Multi-sheet workbook (${sheets.length} sheets, ${headers.length} cols) — analyzing per-sheet`);
        return await this._analyzePerSheet(headers, sampleRows, sheets);
      }

      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 4000 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ CSV analysis complete in ${duration}s`);

      let analysis;
      try {
        analysis = JSON.parse(this.extractJSON(content));
      } catch (e) {
        // Fallback: generate minimal analysis from headers
        console.warn(`⚠️ JSON parse failed, generating fallback analysis`);
        analysis = { primaryClass: 'Record', columns: [], entityTypes: [], dataProperties: [], objectProperties: [], relationships: [] };
      }
      
      console.log(`📊 LLM returned: ${analysis.columns?.length || 0} columns, ${analysis.dataProperties?.length || 0} dataProps, ${analysis.objectProperties?.length || 0} objProps, primaryClass: ${analysis.primaryClass}`);

      // Validate LLM output against headers
      const validation = llmOutputValidator.validateSchemaAnalysis(analysis, headers);
      if (validation.warnings.length > 0) {
        logger.warn(`⚠️ Schema analysis validation warnings: ${validation.warnings.join('; ')}`);
      }

      // Attach data profile to result for downstream use
      const normalized = this.normalizeAnalysis(validation.cleaned, headers);
      normalized._dataProfile = dataProfile;
      return normalized;
    } catch (error) {
      logger.error('LLM CSV analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Analyze large multi-sheet workbooks by processing each sheet separately then merging
   */
  async _analyzePerSheet(allHeaders, allRows, sheets) {
    const allColumns = [];
    const allEntityTypes = [];
    const allDataProps = [];
    const allObjProps = [];
    const allRelationships = [];
    const classNames = [];

    // Run data profiling for cross-sheet FK detection
    const dataProfile = dataProfileService.profileColumns(allHeaders, allRows, { sheets });

    for (const sheet of sheets) {
      const sheetRows = allRows.filter(r => r.__sheet === sheet.name);
      const safeSampleData = this.buildSampleData(sanitizeHeaders(sheet.headers), sanitizeSampleRows(sheetRows));
      const className = this.toClassName(sheet.name);
      classNames.push(className);

      // Include profiling context for this sheet's columns
      const sheetProfiles = Object.values(dataProfile.columns)
        .filter(p => sheet.headers.includes(p.header))
        .map(p => `  - "${p.header}": ${p.type}, ${p.xsdType}${p.isId ? ' [PK]' : ''}${p.isFkCandidate ? ' [FK]' : ''}`)
        .join('\n');
      
      const sheetFKs = dataProfile.fkCandidates
        .filter(fk => fk.fromSheet === sheet.name || fk.toSheet === sheet.name)
        .map(fk => `  - "${fk.fromColumn}" (${fk.fromSheet}) → "${fk.toColumn}" (${fk.toSheet})`)
        .join('\n');

      const prompt = `Analyze this sheet "${sanitizeValue(sheet.name, 100)}" (${sheet.rowCount} rows) from a multi-sheet Excel workbook.
Other sheets in workbook: ${sheets.filter(s => s.name !== sheet.name).map(s => `"${sanitizeValue(s.name, 100)}" (${sanitizeHeaders(s.headers).join(', ')})`).join('; ')}

DATA PROFILING (pre-computed):
${sheetProfiles}
${sheetFKs ? `\nFK CANDIDATES:\n${sheetFKs}` : ''}

COLUMNS: ${sanitizeHeaders(sheet.headers).join(', ')}

SAMPLE DATA:
${safeSampleData}

Output ONLY valid JSON:
{
  "primaryClass": "ClassName for each row in this sheet",
  "columns": [{"column": "name", "type": "id|date|numeric|boolean|text|category|entity", "includeAsNode": false, "linkedClass": "", "dataProperty": "propName", "objectProperty": ""}],
  "crossSheetRelationships": [{"from": "ThisClass", "to": "OtherSheetClass", "predicate": "hasX", "viaColumn": "column_name", "description": "why"}]
}
Rules:
- date/numeric/text/boolean columns → includeAsNode=false, set dataProperty
- Foreign key columns (e.g. CustomerID, BranchID, AccountID) that reference another sheet → includeAsNode=true, linkedClass=target sheet class, objectProperty=relationship name (e.g. "hasBranch")
- Category columns with few distinct values (e.g. Status, Type, Segment) → includeAsNode=true, linkedClass=category class name
- The primary key column of THIS sheet (e.g. the ID column) → includeAsNode=false, type="id"`;

      try {
        console.log(`📊 Analyzing sheet "${sheet.name}": ${sheet.headers.length} cols`);
        const content = await this._chat([{ role: 'user', content: prompt }], { maxTokens: 2000 });
        const result = JSON.parse(this.extractJSON(content));

        const pc = result.primaryClass || className;
        allEntityTypes.push({ name: pc, description: `Represents rows in sheet "${sheet.name}"` });

        for (const col of (result.columns || [])) {
          col._sheetClass = pc;
          allColumns.push(col);
          if (!col.includeAsNode && col.column) {
            allDataProps.push({ name: col.dataProperty || this.toCamelCase(col.column), domain: pc, range: this.inferXsdType(col.type), description: `${col.column} value` });
          } else if (col.includeAsNode && col.linkedClass) {
            allObjProps.push({ name: col.objectProperty || `has${col.linkedClass}`, domain: pc, range: col.linkedClass, description: `Links to ${col.linkedClass}` });
          }
        }

        for (const rel of (result.crossSheetRelationships || [])) {
          allRelationships.push({ from: rel.from || pc, to: rel.to, predicate: rel.predicate, description: rel.description });
          if (rel.to && !allObjProps.find(p => p.name === rel.predicate)) {
            allObjProps.push({ name: rel.predicate, domain: rel.from || pc, range: rel.to, description: rel.description });
          }
        }
      } catch (e) {
        console.warn(`⚠️ Sheet "${sheet.name}" analysis failed: ${e.message}, using defaults`);
        for (const h of sheet.headers) {
          allDataProps.push({ name: this.toCamelCase(h), domain: className, range: 'xsd:string', description: `${h} value` });
        }
        allEntityTypes.push({ name: className, description: `Rows from sheet "${sheet.name}"` });
      }
    }

    console.log(`📊 Per-sheet analysis complete: ${allEntityTypes.length} classes, ${allDataProps.length} dataProps, ${allObjProps.length} objProps, ${allRelationships.length} relationships`);

    return {
      primaryClass: allEntityTypes[0]?.name || 'Record',
      primaryClassExplanation: `Multi-sheet workbook with ${sheets.length} entity types`,
      description: `Workbook with sheets: ${sheets.map(s => s.name).join(', ')}`,
      columns: allColumns,
      entityTypes: allEntityTypes,
      dataProperties: allDataProps,
      objectProperties: allObjProps,
      relationships: allRelationships
    };
  }

  /**
   * Analyze CSV for column-to-ontology MAPPING (uses existing ontology)
   * Different from schema analysis - this maps to EXISTING classes/properties
   */
  async analyzeForMapping(headers, sampleRows, ontology, options = {}) {
    const { sheets } = options;
    
    // Multi-sheet: analyze per-sheet with sheet context
    if (sheets && sheets.length > 1) {
      console.log(`🔗 Per-sheet mapping analysis: ${sheets.length} sheets`);
      const allMappings = [];
      const sheetPrimaryClasses = {};
      
      for (const sheet of sheets) {
        const sheetRows = sampleRows.filter(r => r.__sheet === sheet.name);
        const sheetHeaders = sheet.headers || headers.filter(h => {
          return sheetRows.some(r => r[h] != null && r[h] !== '');
        });
        if (sheetHeaders.length === 0) continue;
        
        console.log(`🔗 Sheet "${sheet.name}": ${sheetHeaders.length} columns`);
        const result = await this._analyzeForMappingSingle(sheetHeaders, sheetRows, ontology, sheet.name);
        if (result.primaryClass) sheetPrimaryClasses[sheet.name] = result.primaryClass;
        allMappings.push(...(result.mappings || []));
      }
      
      // Deduplicate mappings (same column from multiple sheets — keep first)
      const seen = new Set();
      const dedupedMappings = allMappings.filter(m => {
        if (seen.has(m.column)) return false;
        seen.add(m.column);
        return true;
      });
      
      const primaryClass = Object.values(sheetPrimaryClasses)[0] || null;
      // Resolve primaryClassLabel from the IRI
      const primaryClassObj = primaryClass ? (ontology?.classes || []).find(c => c.iri === primaryClass) : null;
      const primaryClassLabel = primaryClassObj?.label || primaryClassObj?.localName || '';
      return { primaryClass, primaryClassLabel, primaryClassExplanation: `Per-sheet analysis`, mappings: dedupedMappings, sheetPrimaryClasses };
    }
    
    // Single sheet or small column set
    if (headers.length > 25) {
      console.log(`🔗 Large column set (${headers.length}), batching mapping analysis`);
      const BATCH = 20;
      const allMappings = [];
      let primaryClass = null;
      let primaryClassExplanation = '';
      for (let i = 0; i < headers.length; i += BATCH) {
        const batchHeaders = headers.slice(i, i + BATCH);
        const batchSample = sampleRows.map(r => {
          const row = {};
          batchHeaders.forEach(h => { row[h] = r[h]; });
          return row;
        });
        console.log(`🔗 Batch ${Math.floor(i / BATCH) + 1}: columns ${i + 1}-${Math.min(i + BATCH, headers.length)}`);
        const batchResult = await this._analyzeForMappingSingle(batchHeaders, batchSample, ontology);
        if (!primaryClass && batchResult.primaryClass) {
          primaryClass = batchResult.primaryClass;
          primaryClassExplanation = batchResult.primaryClassExplanation || '';
        }
        allMappings.push(...(batchResult.mappings || []));
      }
      return { primaryClass, primaryClassExplanation, mappings: allMappings };
    }
    return this._analyzeForMappingSingle(headers, sampleRows, ontology);
  }

  async _analyzeForMappingSingle(headers, sampleRows, ontology, sheetName = null) {
    const sampleData = this.buildSampleData(sanitizeHeaders(headers), sanitizeSampleRows(sampleRows));
    
    // Sanitize ontology context and limit size for large ontologies
    const safeOntology = sanitizeOntologyContext(ontology);
    
    // Normalize ontology - split properties if needed
    const allProps = ontology?.properties || [];
    const dataProperties = safeOntology.dataProperties.length > 0 ? safeOntology.dataProperties : allProps.filter(p => p.type === 'datatypeProperty');
    const objectProperties = safeOntology.objectProperties.length > 0 ? safeOntology.objectProperties : allProps.filter(p => p.type === 'objectProperty');
    const classes = safeOntology.classes;
    
    // Run data profiling for smarter context (only include relevant ontology classes)
    const dataProfile = dataProfileService.profileColumns(headers, sampleRows);
    const profileHints = Object.values(dataProfile.columns).map(p =>
      `  - "${p.header}": ${p.type}${p.isId ? ' [PK]' : ''}${p.isFkCandidate ? ' [FK]' : ''}${p.isCategory ? ' [CATEGORY]' : ''}`
    ).join('\n');
    
    // For large ontologies, only include classes relevant to the data
    // This prevents token overflow
    const MAX_CLASSES_IN_PROMPT = 30;
    let classDetails;
    if (classes.length > MAX_CLASSES_IN_PROMPT) {
      // Score classes by relevance to column names
      const headerWords = new Set(headers.flatMap(h => h.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/)));
      const scoredClasses = classes.map(c => {
        const label = (c.label || c.localName || '').toLowerCase();
        const words = label.replace(/([A-Z])/g, ' $1').toLowerCase().split(/\s+/);
        const score = words.filter(w => headerWords.has(w)).length;
        return { ...c, _relevanceScore: score };
      }).sort((a, b) => b._relevanceScore - a._relevanceScore);
      
      const relevantClasses = scoredClasses.slice(0, MAX_CLASSES_IN_PROMPT);
      logger.info(`🔗 Large ontology (${classes.length} classes), using top ${MAX_CLASSES_IN_PROMPT} relevant classes`);
      
      classDetails = relevantClasses.map(c => {
        const cLabel = c.label || c.localName;
        const classDataProps = dataProperties
          .filter(p => (p.domain || p.domainLabel) === cLabel || p.domain === c.localName)
          .map(p => p.label || p.localName);
        const classObjProps = objectProperties
          .filter(p => (p.domain || p.domainLabel) === cLabel || p.domain === c.localName)
          .map(p => `${p.label || p.localName} → ${p.range || p.rangeLabel || 'Entity'}`);
        return `${cLabel}: ${c.comment || c.description || 'no description'}
      Data properties: ${classDataProps.join(', ') || 'none defined'}
      Object properties: ${classObjProps.join(', ') || 'none defined'}`;
      }).join('\n  ');
    } else {
      classDetails = classes.map(c => {
        const cLabel = c.label || c.localName;
        const classDataProps = dataProperties
          .filter(p => (p.domain || p.domainLabel) === cLabel || p.domain === c.localName)
          .map(p => p.label || p.localName);
        const classObjProps = objectProperties
          .filter(p => (p.domain || p.domainLabel) === cLabel || p.domain === c.localName)
          .map(p => `${p.label || p.localName} → ${p.range || p.rangeLabel || 'Entity'}`);
        return `${cLabel}: ${c.comment || c.description || 'no description'}
      Data properties: ${classDataProps.join(', ') || 'none defined'}
      Object properties: ${classObjProps.join(', ') || 'none defined'}`;
      }).join('\n  ');
    }

    const objPropsStr = objectProperties.map(p => `${p.label || p.localName}: ${p.domain || 'any'} → ${p.range || 'Entity'}`).join('\n  - ') || 'None';
    const dataPropsStr = dataProperties.map(p => `${p.label || p.localName} (domain: ${p.domain || 'any'}, range: ${p.range || 'xsd:string'})`).join('\n  - ') || 'None';

    const systemPrompt = `You are mapping CSV columns to an EXISTING ontology. You must use the provided classes and properties.

AVAILABLE ONTOLOGY:

CLASSES (with their properties):
  ${classDetails || 'No classes defined'}

ALL OBJECT PROPERTIES (create linked nodes):
  - ${objPropsStr}

ALL DATA PROPERTIES (literal values):
  - ${dataPropsStr}

DATA PROFILING (pre-computed column analysis):
${profileHints}

TASK:
1. FIRST: Identify which class best represents EACH ROW of this CSV (primaryClass)
2. THEN: For each column, map to properties that have the primaryClass as their DOMAIN
3. For columns like "Company", "Product" that reference OTHER entities → use OBJECT PROPERTY with linkedClass

Output ONLY valid JSON:
{
  "primaryClass": "The class name that each CSV row represents",
  "primaryClassExplanation": "Why this class was chosen based on the data",
  "mappings": [
    {
      "column": "column_name",
      "isLiteral": true/false,
      "property": "property name (MUST have primaryClass as domain, or be new)",
      "propertyIsNew": true/false,
      "linkedClass": "target class name if object property (or empty string)",
      "linkedClassIsNew": true/false,
      "reasoning": "Why this mapping - mention domain compatibility"
    }
  ]
}

CRITICAL RULES:
- primaryClass MUST be chosen FIRST based on what each row represents
- For columns ending in "_id" or "Id" that match an ontology class name (e.g., "device_id" → Device, "card_id" → Card): set isLiteral=false and linkedClass to that class. Use the EXISTING object property that links primaryClass to that class (e.g., "hasDevice", "hasCard").
- For literal data columns (names, dates, amounts, scores, hashes, booleans): set isLiteral=true and map to the EXISTING data property with matching name
- Date/time columns → ALWAYS isLiteral=true
- Numeric columns (amounts, scores, counts, ages) → ALWAYS isLiteral=true
- Hash/fingerprint columns → ALWAYS isLiteral=true
- Prefer EXISTING properties/classes over creating new ones — only set propertyIsNew=true if NO existing property matches
- When mapping to an existing property, use its EXACT label (e.g., "emailHash" not "email_hash", "signupDate" not "signup_date")
- The "property" field must be the ontology property label, not the CSV column name`;

    const sheetContext = sheetName ? `\nSHEET NAME: "${sanitizeValue(sheetName, 100)}" — each row in this sheet represents one entity of this type.\n` : '';
    const userPrompt = `Map these CSV columns to the ontology:
${sheetContext}
COLUMNS: ${sanitizeHeaders(headers).join(', ')}

SAMPLE DATA:
${sampleData}

Remember: primaryClass must be one of the available ontology classes.${sheetName ? ` This is the "${sanitizeValue(sheetName, 100)}" sheet — pick the class that matches this sheet name.` : ''}
Output only JSON.`;

    try {
      console.log(`\n🔗 LLM analyzing CSV for mapping: ${headers.length} columns`);
      const startTime = Date.now();

      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 4000 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Mapping analysis complete in ${duration}s`);

      let result;
      try {
        result = JSON.parse(this.extractJSON(content));
      } catch (e) {
        // Try to salvage partial JSON — find last complete mapping entry
        console.warn(`⚠️ Mapping JSON incomplete, attempting partial recovery`);
        const partial = content.replace(/```json?\n?/g, '').replace(/```/g, '');
        const lastBracket = partial.lastIndexOf('}');
        if (lastBracket > 0) {
          // Close the mappings array and outer object
          let fixed = partial.substring(0, lastBracket + 1);
          if (!fixed.includes(']}')) fixed += ']}';
          try { result = JSON.parse(fixed); } catch (_) {}
        }
        if (!result) {
          // Fallback: return identity mappings
          result = { primaryClass: classes[0]?.label || 'Record', mappings: headers.map(h => ({ column: h, isLiteral: true, property: h, propertyIsNew: true, linkedClass: '', linkedClassIsNew: false })) };
        }
      }

      return this.normalizeMappingAnalysis(result, headers, ontology);
    } catch (error) {
      logger.error('LLM mapping analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Validate mapping result against ontology before returning.
   */
  _validateAndReturnMapping(result, headers, ontology) {
    const validation = llmOutputValidator.validateColumnMapping(result, ontology, headers);
    if (validation.warnings.length > 0) {
      logger.warn(`⚠️ Mapping validation: ${validation.warnings.length} warnings`);
      for (const w of validation.warnings.slice(0, 5)) {
        logger.warn(`  - ${w}`);
      }
    }
    return this.normalizeMappingAnalysis(validation.cleaned, headers, ontology);
  }

  /**
   * Normalize mapping analysis and match to actual ontology IRIs
   */
  normalizeMappingAnalysis(result, headers, ontology) {
    const mappingMap = new Map((result.mappings || []).map(m => [m.column, m]));
    
    // Find primary class in ontology
    let primaryClass = null;
    let primaryClassLabel = result.primaryClass || '';
    if (primaryClassLabel && ontology?.classes) {
      primaryClass = ontology.classes.find(c => 
        c.label?.toLowerCase() === primaryClassLabel?.toLowerCase() ||
        c.localName?.toLowerCase() === primaryClassLabel?.toLowerCase()
      );
    }

    // Normalize properties
    const allProps = ontology?.properties || [];
    const allObjProps = ontology?.objectProperties || allProps.filter(p => p.type === 'objectProperty');
    const allDataProps = ontology?.dataProperties || allProps.filter(p => p.type === 'datatypeProperty');
    const classes = ontology?.classes || [];

    const mappings = headers.map(h => {
      const m = mappingMap.get(h) || {};
      const looksLikeDate = /date|time|created|updated|received|sent|_at$/i.test(h);
      // Only force literal for dates/numbers. If LLM says isLiteral=false, respect it.
      // If LLM didn't return a mapping for this column, check if it looks like a foreign key.
      const looksLikeFK = /id$/i.test(h) && !/^id$/i.test(h);
      const isLiteral = looksLikeDate ? true : (m.isLiteral === true || (m.isLiteral === undefined && !looksLikeFK && !m.linkedClass));

      // Find matching property in ontology
      let property = null;
      let propertyLabel = m.property || this.toCamelCase(h);
      const propLower = propertyLabel?.toLowerCase();
      
      // Search all properties
      property = allProps.find(p => 
        (p.label || p.localName)?.toLowerCase() === propLower
      );
      if (!property) {
        property = allObjProps.find(p => 
          (p.label || p.localName)?.toLowerCase() === propLower
        );
      }
      if (!property) {
        property = allDataProps.find(p => 
          (p.label || p.localName)?.toLowerCase() === propLower
        );
      }

      // Find matching class in ontology
      let linkedClass = null;
      let linkedClassLabel = m.linkedClass || '';
      if (!isLiteral && linkedClassLabel) {
        const classLower = linkedClassLabel.toLowerCase();
        linkedClass = classes.find(c => 
          (c.label || c.localName)?.toLowerCase() === classLower
        );
      }

      // If FK detected a class but no property matched, find the object property linking to it
      if (!isLiteral && linkedClass && !property) {
        const linkedLabel = (linkedClass.label || linkedClass.localName || '').toLowerCase();
        // Find object property whose range matches the linked class
        property = allObjProps.find(p => {
          const range = (p.range || p.rangeLabel || '').toLowerCase();
          const rangeLocal = p.range?.includes('://') ? p.range.split(/[#/]/).pop().toLowerCase() : range;
          return range === linkedLabel || rangeLocal === linkedLabel;
        });
        // Fallback: look for "has{ClassName}" pattern
        if (!property) {
          const hasName = `has${linkedLabel}`;
          property = allObjProps.find(p =>
            (p.label || p.localName || '').toLowerCase() === hasName
          );
        }
        if (property) {
          propertyLabel = property.label || property.localName || propertyLabel;
        }
      }

      // Resolve domain for literal properties from ontology rdfs:domain
      let domain = '';
      let domainLabel = '';
      if (isLiteral && property && property.domain) {
        const propDomain = property.domain;
        const domainIri = propDomain.includes('://') ? propDomain : null;
        const domainLocal = propDomain.includes('://') ? propDomain.split(/[#/]/).pop() : propDomain;
        const domainClass = domainIri
          ? classes.find(c => c.iri === domainIri)
          : classes.find(c => (c.label || c.localName || '').toLowerCase() === domainLocal.toLowerCase());
        if (domainClass) {
          domain = domainClass.iri;
          domainLabel = domainClass.label || domainClass.localName || '';
        }
      }

      return {
        column: h,
        isLiteral,
        property: property?.iri || '',
        propertyLabel: property?.label || propertyLabel,
        propertyIsNew: !property && !!propertyLabel,
        linkedClass: isLiteral ? '' : (linkedClass?.iri || ''),
        linkedClassLabel: isLiteral ? '' : (linkedClass?.label || linkedClassLabel),
        linkedClassIsNew: !isLiteral && !linkedClass && !!linkedClassLabel,
        domain,
        domainLabel,
        reasoning: m.reasoning || (looksLikeDate ? 'Date column - stored as literal' : '')
      };
    });

    return { 
      mappings,
      primaryClass: primaryClass?.iri || '',
      primaryClassLabel: primaryClass?.label || primaryClassLabel,
      primaryClassExplanation: result.primaryClassExplanation || ''
    };
  }

  async suggestMapping(column, sampleValues, ontologyClasses = [], ontologyProperties = []) {
    const prompt = `Given a CSV column "${column}" with sample values: ${sampleValues.slice(0, 5).join(', ')}

Available ontology classes: ${ontologyClasses.map(c => c.label).join(', ') || 'None'}
Available properties: ${ontologyProperties.map(p => p.label).join(', ') || 'None'}

Respond with JSON only:
{
  "recommendation": "literal" or "linked",
  "suggestedProperty": "property name or null",
  "suggestedClass": "class name if linked, or null",
  "explanation": "Plain English explanation for non-technical users",
  "storagePreview": "How this will be stored as a triple",
  "queryExample": "Simple SPARQL query example"
}`;

    try {
      const content = await this._chat([{ role: 'user', content: prompt }], { temperature: 0.1 });
      return JSON.parse(this.extractJSON(content));
    } catch (e) {
      logger.error('Mapping suggestion failed:', e.message);
      return null;
    }
  }

  /**
   * Calculate confidence score based on various factors
   */
  calculateConfidence(item, context = {}) {
    let score = 0.5; // Base score
    
    // Boost for exact name matches
    if (context.existingNames?.includes(item.name?.toLowerCase())) {
      score += 0.3;
    }
    
    // Boost for common patterns
    const commonPatterns = ['id', 'name', 'date', 'time', 'amount', 'count', 'type', 'status'];
    if (commonPatterns.some(p => item.name?.toLowerCase().includes(p))) {
      score += 0.1;
    }
    
    // Boost if has description/reasoning
    if (item.description || item.reasoning) {
      score += 0.1;
    }
    
    // Penalize very generic names
    const genericNames = ['entity', 'item', 'thing', 'data', 'value'];
    if (genericNames.includes(item.name?.toLowerCase())) {
      score -= 0.2;
    }
    
    // Clamp to valid range
    score = Math.max(0.1, Math.min(1.0, score));
    
    // Convert to confidence level
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  /**
   * Analyze text document for SCHEMA CREATION (no existing ontology)
   */
  async analyzeTextForSchema(text, options = {}) {
    const { maxChars = 30000 } = options;
    const textSample = sanitizeDocumentText(text, maxChars);

    const systemPrompt = `You are an ontology expert analyzing a document to design a knowledge graph schema.

Output ONLY valid JSON:
{
  "documentType": "What kind of document this is",
  "primaryClass": "Main entity type",
  "primaryClassExplanation": "Why this is the primary class",
  "description": "What this document represents",
  "entityTypes": [
    {"name": "ClassName", "description": "What it represents"}
  ],
  "dataProperties": [
    {"name": "propertyName", "domain": "ClassName", "range": "xsd:string|xsd:date|xsd:decimal", "description": "What this stores"}
  ],
  "objectProperties": [
    {"name": "hasRelationship", "domain": "SourceClass", "range": "TargetClass", "description": "Semantic meaning"}
  ]
}

RULES:
- Entity types = NOUNS (Person, Document, Organization)
- Data properties = literal values (dates, numbers, text)
- Object properties = relationships between entities
- Use semantic names: "hasAuthor" not "author_id"`;

    try {
      console.log(`\n📊 LLM analyzing text for schema: ${textSample.length} chars`);
      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this document:\n\n${textSample}\n\nOutput only JSON.` }
      ]);
      return JSON.parse(this.extractJSON(content));
    } catch (error) {
      logger.error('Text schema analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Analyze text document for MAPPING to existing ontology
   */
  async analyzeTextForMapping(text, ontology, options = {}) {
    const { maxChars = 30000 } = options;
    const textSample = sanitizeDocumentText(text, maxChars);

    const safeOntology = sanitizeOntologyContext(ontology);
    const classes = safeOntology.classes.map(c => c.label).join(', ') || 'None';
    const objProps = safeOntology.objectProperties.map(p => p.label).join(', ') || 'None';
    const dataProps = safeOntology.dataProperties.map(p => p.label).join(', ') || 'None';

    const systemPrompt = `Map concepts from a document to an EXISTING ontology.

AVAILABLE ONTOLOGY:
- Classes: ${classes}
- Object Properties: ${objProps}
- Data Properties: ${dataProps}

Output ONLY valid JSON:
{
  "primaryClass": "Best matching class from ontology",
  "mappings": [
    {
      "concept": "concept from document",
      "mappedClass": "existing class or null",
      "mappedClassIsNew": false,
      "attributes": [
        {"name": "attribute", "mappedProperty": "existing data property or null", "isNew": false}
      ],
      "relationships": [
        {"predicate": "relationship", "target": "target concept", "mappedProperty": "existing object property or null", "isNew": false}
      ]
    }
  ],
  "unmappedConcepts": ["concepts needing new classes"]
}

RULES:
- Prefer EXISTING classes/properties
- Set isNew=true only if no match exists`;

    try {
      console.log(`\n🔗 LLM analyzing text for mapping: ${textSample.length} chars`);
      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Map this document:\n\n${textSample}\n\nOutput only JSON.` }
      ]);
      return JSON.parse(this.extractJSON(content));
    } catch (error) {
      logger.error('Text mapping analysis failed:', error.message);
      throw error;
    }
  }

  buildSampleData(headers, rows) {
    if (!rows || rows.length === 0) return 'No sample data available';

    const lines = [];
    const sampleCount = Math.min(10, rows.length);

    for (let i = 0; i < sampleCount; i++) {
      const row = rows[i];
      const values = headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return 'NULL';
        const str = String(val);
        return str.length > 50 ? str.substring(0, 50) + '...' : str;
      });
      lines.push(`Row ${i + 1}: ${values.join(' | ')}`);
    }

    return lines.join('\n');
  }

  extractJSON(content) {
    if (!content) throw new Error('Empty LLM response');

    let cleaned = content.trim();

    // Extract from code blocks
    const codeMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeMatch) cleaned = codeMatch[1].trim();

    // Find JSON object
    const start = cleaned.indexOf('{');
    if (start === -1) throw new Error('No JSON found in response');

    let braceCount = 0;
    let bracketCount = 0;
    let end = -1;
    let inString = false;
    let escape = false;

    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') braceCount++;
      else if (c === '}') { braceCount--; if (braceCount === 0) { end = i; break; } }
      else if (c === '[') bracketCount++;
      else if (c === ']') bracketCount--;
    }

    if (end === -1) {
      // Attempt repair: close open braces/brackets
      let repaired = cleaned.substring(start);
      while (bracketCount > 0) { repaired += ']'; bracketCount--; }
      while (braceCount > 0) { repaired += '}'; braceCount--; }
      try {
        JSON.parse(repaired);
        return repaired;
      } catch {
        throw new Error('Incomplete JSON');
      }
    }

    return cleaned.substring(start, end + 1);
  }

  normalizeAnalysis(analysis, headers) {
    const columnMap = new Map((analysis.columns || []).map(c => [c.column, c]));
    const existingNames = headers.map(h => h.toLowerCase());

    const columns = headers.map(h => {
      const col = columnMap.get(h) || {};
      
      // Force date/numeric/boolean types to be literals, not nodes
      // BUT: id columns that the LLM marked as includeAsNode with linkedClass are foreign keys — keep as entities
      const isFK = col.includeAsNode && col.linkedClass;
      const isLiteralType = ['date', 'numeric', 'boolean', 'text'].includes(col.type) || (col.type === 'id' && !isFK);
      const looksLikeDate = /date|time|created|updated|received|sent|_at$/i.test(h);
      const forceLiteral = (isLiteralType || looksLikeDate) && !isFK;
      
      const isEntity = !forceLiteral && (col.includeAsNode || col.type === 'entity' || col.type === 'category');
      
      // Calculate confidence for this column mapping
      const confidence = this.calculateConfidence({ 
        name: h, 
        reasoning: col.reasoning,
        description: col.suggestion 
      }, { existingNames });
      
      return {
        column: h,
        suggestedType: col.type || 'property',
        suggestedLabel: col.linkedClass || this.toClassName(h),
        includeAsNode: isEntity,
        includeAsProperty: !isEntity,
        linkedClass: isEntity ? (col.linkedClass || '') : '',
        // Use objectProperty for entities, dataProperty for literals
        objectProperty: isEntity ? (col.objectProperty || col.relationship || this.generateObjectPropertyName(h, col.linkedClass)) : '',
        dataProperty: !isEntity ? (col.dataProperty || col.property || this.toCamelCase(h)) : '',
        confidence,
        confidenceScore: confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.7 : 0.4,
        reasoning: col.reasoning || (forceLiteral && col.includeAsNode ? 'Corrected: dates/numbers are literals, not nodes' : 'LLM analysis'),
        suggestion: col.suggestion || this.generateDefaultSuggestion(h, { ...col, includeAsNode: isEntity }),
        queryExample: col.queryExample || ''
      };
    });

    // Build data properties list from literal columns
    const dataProperties = columns
      .filter(c => !c.includeAsNode && c.dataProperty)
      .map(c => ({
        name: c.dataProperty,
        domain: analysis.primaryClass || 'Record',
        range: this.inferXsdType(c.suggestedType),
        description: `Stores ${c.column} value`,
        confidence: c.confidence
      }));

    // Build object properties list from entity columns
    const objectProperties = columns
      .filter(c => c.includeAsNode && c.linkedClass)
      .map(c => ({
        name: c.objectProperty,
        domain: analysis.primaryClass || 'Record',
        range: c.linkedClass,
        description: `Links to ${c.linkedClass}`
      }));

    return {
      primaryClass: analysis.primaryClass || 'Record',
      primaryClassExplanation: analysis.primaryClassExplanation || `Each row in your data becomes a "${analysis.primaryClass || 'Record'}" entity in the knowledge graph.`,
      description: analysis.description || '',
      columns,
      entityTypes: analysis.entityTypes || [],
      dataProperties: [...(analysis.dataProperties || []), ...dataProperties],
      objectProperties: [...(analysis.objectProperties || []), ...objectProperties],
      relationships: analysis.relationships || []
    };
  }

  generateObjectPropertyName(column, linkedClass) {
    // Generate semantic object property name from column
    const clean = column.replace(/[_\s-]?(id|ID|Id)$/i, '').trim();
    const className = linkedClass || this.toClassName(clean);
    return `has${className}`;
  }

  toCamelCase(str) {
    return str
      .replace(/[_-]/g, ' ')
      .replace(/\s+(.)/g, (_, c) => c.toUpperCase())
      .replace(/\s/g, '')
      .replace(/^(.)/, c => c.toLowerCase());
  }

  inferXsdType(type) {
    const typeMap = {
      'numeric': 'xsd:decimal',
      'integer': 'xsd:integer',
      'date': 'xsd:date',
      'boolean': 'xsd:boolean',
      'id': 'xsd:string',
      'text': 'xsd:string'
    };
    return typeMap[type] || 'xsd:string';
  }

  generateDefaultSuggestion(column, col) {
    if (col.includeAsNode && col.linkedClass) {
      const objProp = col.objectProperty || this.generateObjectPropertyName(column, col.linkedClass);
      return `Creates ${col.linkedClass} node linked via "${objProp}" - enables graph traversal queries`;
    }
    if (col.type === 'id') {
      return `Unique identifier - stored as data property for filtering`;
    }
    if (col.type === 'date') {
      return `Date field - stored as xsd:date for temporal queries`;
    }
    if (col.type === 'numeric') {
      return `Numeric value - stored as xsd:decimal for calculations`;
    }
    return `Stored as data property "${col.dataProperty || this.toCamelCase(column)}" for direct querying`;
  }

  toClassName(header) {
    return header
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\s+/g, '')
      .replace(/Id$/, '');
  }
}

module.exports = new LLMCSVAnalyzer();
