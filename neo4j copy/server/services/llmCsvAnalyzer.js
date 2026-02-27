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
    const { sheets, dataProfile } = options;
    
    // Multi-sheet: single holistic LLM call with cross-sheet context for relationship detection
    if (sheets && sheets.length > 1) {
      console.log(`🔗 Holistic multi-sheet mapping analysis: ${sheets.length} sheets`);
      return this._analyzeMultiSheetMapping(headers, sampleRows, ontology, sheets, dataProfile);
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
    return this._analyzeForMappingSingle(headers, sampleRows, ontology, null, dataProfile);
  }

  /**
   * Multi-sheet holistic mapping: sends ALL sheets + cross-sheet FK data in one LLM call
   * so the LLM can reason about inter-sheet relationships.
   */
  async _analyzeMultiSheetMapping(headers, sampleRows, ontology, sheets, dataProfile) {
    // For very large workbooks (>8 sheets or >50 total columns), go per-sheet
    const totalColumns = sheets.reduce((sum, s) => sum + (s.headers?.length || 0), 0);
    if (sheets.length > 8 || totalColumns > 50) {
      console.log(`🔗 Very large workbook (${sheets.length} sheets, ${totalColumns} cols) — using per-sheet analysis`);
      return this._fallbackPerSheetMapping(headers, sampleRows, ontology, sheets, dataProfile);
    }

    const safeOntology = sanitizeOntologyContext(ontology);
    const allProps = ontology?.properties || [];
    const dataProperties = safeOntology.dataProperties.length > 0 ? safeOntology.dataProperties : allProps.filter(p => p.type === 'datatypeProperty');
    const objectProperties = safeOntology.objectProperties.length > 0 ? safeOntology.objectProperties : allProps.filter(p => p.type === 'objectProperty');
    const classes = safeOntology.classes;

    const normName = (n) => (n || '').toLowerCase().replace(/[\s_-]/g, '');
    const domainMatchesClass = (prop, cls) => {
      const cLabel = normName(cls.label);
      const cLocal = normName(cls.localName);
      const pDomain = normName(prop.domain);
      const pDomainLabel = normName(prop.domainLabel);
      return (pDomain && (pDomain === cLabel || pDomain === cLocal))
        || (pDomainLabel && (pDomainLabel === cLabel || pDomainLabel === cLocal));
    };

    // Build ontology summary
    const classDetails = classes.map(c => {
      const classDataProps = dataProperties
        .filter(p => domainMatchesClass(p, c))
        .map(p => `${p.label || p.localName} (${p.range || 'string'})`);
      const classObjProps = objectProperties
        .filter(p => domainMatchesClass(p, c))
        .map(p => `${p.label || p.localName} → ${p.rangeLabel || p.range || 'Entity'}`);
      return `  ${c.label || c.localName}: ${c.comment || ''}
    Data properties: ${classDataProps.join(', ') || 'none'}
    Object properties: ${classObjProps.join(', ') || 'none'}`;
    }).join('\n');

    const objPropsStr = objectProperties.map(p =>
      `${p.label || p.localName}: ${p.domainLabel || p.domain || 'any'} → ${p.rangeLabel || p.range || 'Entity'}`
    ).join('\n  - ') || 'None';

    // Build per-sheet summaries with sample data
    const sheetSummaries = sheets.map(sheet => {
      const sheetRows = sampleRows.filter(r => r.__sheet === sheet.name);
      const sheetHeaders = sheet.headers || [];
      const sampleData = this.buildSampleData(sanitizeHeaders(sheetHeaders), sanitizeSampleRows(sheetRows.slice(0, 2)));
      
      // Per-column profiling hints (compact)
      let profileHints = '';
      if (dataProfile?.columns) {
        profileHints = sheetHeaders.map(h => {
          const p = dataProfile.columns[h];
          if (!p) return null;
          const tags = [];
          if (p.isId) tags.push('PK');
          if (p.isFkCandidate) tags.push('FK');
          if (p.isCategory) tags.push('CAT');
          return `    "${h}": ${p.type}${tags.length ? ' [' + tags.join(',') + ']' : ''}`;
        }).filter(Boolean).join('\n');
      }
      
      return `SHEET: "${sheet.name}" (${sheet.rowCount || sheetRows.length} rows)
  Columns: ${sheetHeaders.join(', ')}
  Sample:
${sampleData}
${profileHints ? `  Profile:\n${profileHints}` : ''}`;
    }).join('\n\n');

    // Cross-sheet FK candidates from data profiling
    let fkSection = '';
    if (dataProfile?.fkCandidates?.length > 0) {
      fkSection = `\nDETECTED CROSS-SHEET RELATIONSHIPS:
${dataProfile.fkCandidates.map(fk =>
  `  ${fk.fromSheet}.${fk.fromColumn} → ${fk.toSheet}.${fk.toColumn} (${(fk.matchRate * 100).toFixed(0)}% overlap)`
).join('\n')}`;
    }

    const systemPrompt = `You are mapping a multi-sheet Excel workbook to an EXISTING ontology for knowledge graph construction.

ONTOLOGY CLASSES:
${classDetails || '  No classes defined'}

OBJECT PROPERTIES:
  - ${objPropsStr}
${fkSection}

RULES:
- FK (isLiteral=false): column ends in ID matching a class, or references another entity
- LITERAL (isLiteral=true): dates, numbers, text, hashes, booleans, PKs in own sheet
- PK in own sheet = ALWAYS literal. Same column in other sheets = FK.
- Use EXACT ontology property labels. Set propertyIsNew=true only if no match exists.
- Keep reasoning VERY brief (max 5 words).

Output ONLY valid JSON:
{
  "sheetMappings": {
    "SheetName": {
      "sheetClass": "class label",
      "columns": [
        {"column":"col","isLiteral":true,"property":"propLabel","propertyIsNew":false,"linkedClass":"","reasoning":"brief"}
      ]
    }
  }
}`;

    const userPrompt = `Map this workbook:\n\n${sheetSummaries}\n\nOutput only JSON.`;

    try {
      console.log(`\n🔗 LLM multi-sheet mapping: ${sheets.length} sheets, ${totalColumns} total columns`);
      const startTime = Date.now();

      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 30000 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Multi-sheet mapping complete in ${duration}s`);

      let result;
      try {
        result = JSON.parse(this.extractJSON(content));
      } catch (e) {
        console.warn(`⚠️ Multi-sheet mapping JSON parse failed, falling back to per-sheet`);
        console.warn(`⚠️ Raw response length: ${content?.length || 0} chars`);
        return this._fallbackPerSheetMapping(headers, sampleRows, ontology, sheets, dataProfile);
      }

      if (!result.sheetMappings || Object.keys(result.sheetMappings).length === 0) {
        console.warn(`⚠️ No sheetMappings in response, falling back to per-sheet`);
        return this._fallbackPerSheetMapping(headers, sampleRows, ontology, sheets, dataProfile);
      }

      return this._normalizeMultiSheetMapping(result, ontology, sheets, headers);
    } catch (error) {
      logger.error('Multi-sheet LLM mapping failed:', error.message);
      return this._fallbackPerSheetMapping(headers, sampleRows, ontology, sheets, dataProfile);
    }
  }

  /**
   * Fallback: per-sheet individual LLM calls (used when holistic call fails)
   */
  async _fallbackPerSheetMapping(headers, sampleRows, ontology, sheets, dataProfile) {
    console.log(`🔗 Fallback: per-sheet mapping analysis`);
    const allMappings = [];
    const sheetPrimaryClasses = {};

    for (const sheet of sheets) {
      const sheetRows = sampleRows.filter(r => r.__sheet === sheet.name);
      const sheetHeaders = sheet.headers || headers.filter(h => sheetRows.some(r => r[h] != null && r[h] !== ''));
      if (sheetHeaders.length === 0) continue;

      try {
        const result = await this._analyzeForMappingSingle(sheetHeaders, sheetRows, ontology, sheet.name, dataProfile);
        if (result.primaryClass) sheetPrimaryClasses[sheet.name] = result.primaryClass;
        // Tag mappings with sheet name
        for (const m of (result.mappings || [])) {
          m._sheet = sheet.name;
        }
        allMappings.push(...(result.mappings || []));
      } catch (e) {
        logger.warn(`Sheet "${sheet.name}" mapping failed: ${e.message}`);
      }
    }

    const primaryClass = Object.values(sheetPrimaryClasses)[0] || null;
    const primaryClassObj = primaryClass ? (ontology?.classes || []).find(c => c.iri === primaryClass) : null;
    return {
      primaryClass,
      primaryClassLabel: primaryClassObj?.label || primaryClassObj?.localName || '',
      primaryClassExplanation: 'Per-sheet fallback analysis',
      mappings: allMappings,
      sheetPrimaryClasses
    };
  }

  /**
   * Normalize multi-sheet LLM output into the standard mapping format
   */
  _normalizeMultiSheetMapping(result, ontology, sheets, headers) {
    const classes = ontology?.classes || [];
    const allProps = ontology?.properties || [];
    const allObjProps = ontology?.objectProperties || allProps.filter(p => p.type === 'objectProperty');
    const allDataProps = ontology?.dataProperties || allProps.filter(p => p.type === 'datatypeProperty');
    const sheetMappings = result.sheetMappings || {};

    const sheetPrimaryClasses = {};
    const allMappings = [];

    for (const sheet of sheets) {
      const sheetData = sheetMappings[sheet.name];
      if (!sheetData) continue;

      // Resolve sheet class
      const sheetClassLabel = sheetData.sheetClass || '';
      const sheetClass = classes.find(c =>
        (c.label || c.localName || '').toLowerCase() === sheetClassLabel.toLowerCase() ||
        (c.localName || '').toLowerCase() === sheetClassLabel.toLowerCase()
      );
      if (sheetClass) {
        sheetPrimaryClasses[sheet.name] = sheetClass.iri;
      }

      for (const col of (sheetData.columns || [])) {
        const colName = col.column;
        const isLiteral = col.isLiteral !== false;
        const propLabel = col.property || '';
        const linkedClassLabel = col.linkedClass || '';

        // Resolve property
        let property = null;
        if (propLabel) {
          const propLower = propLabel.toLowerCase();
          property = allProps.find(p => (p.label || p.localName || '').toLowerCase() === propLower)
            || allObjProps.find(p => (p.label || p.localName || '').toLowerCase() === propLower)
            || allDataProps.find(p => (p.label || p.localName || '').toLowerCase() === propLower);
        }

        // Resolve linked class
        let linkedClass = null;
        if (!isLiteral && linkedClassLabel) {
          const classLower = linkedClassLabel.toLowerCase();
          linkedClass = classes.find(c =>
            (c.label || c.localName || '').toLowerCase() === classLower
          );
        }

        // If FK detected a class but no property matched, find the object property linking to it
        if (!isLiteral && linkedClass && !property) {
          const linkedLabel = (linkedClass.label || linkedClass.localName || '').toLowerCase();
          property = allObjProps.find(p => {
            const range = (p.range || p.rangeLabel || '').toLowerCase();
            const rangeLocal = p.range?.includes('://') ? p.range.split(/[#/]/).pop().toLowerCase() : range;
            return range === linkedLabel || rangeLocal === linkedLabel;
          });
          if (!property) {
            const hasName = `has${linkedLabel}`;
            property = allObjProps.find(p => (p.label || p.localName || '').toLowerCase() === hasName);
          }
        }

        // Resolve domain for literal properties
        let domain = '';
        let domainLabel = '';
        if (isLiteral && property && property.domain) {
          const domainLocal = property.domain.includes('://') ? property.domain.split(/[#/]/).pop() : property.domain;
          const normDomain = domainLocal.toLowerCase().replace(/[\s_-]/g, '');
          const domainClass = classes.find(c => {
            const cLabel = (c.label || c.localName || '').toLowerCase().replace(/[\s_-]/g, '');
            const cLocal = (c.localName || '').toLowerCase().replace(/[\s_-]/g, '');
            return cLabel === normDomain || cLocal === normDomain;
          }) || (property.domainLabel ? classes.find(c =>
            (c.label || '').toLowerCase().replace(/[\s_-]/g, '') === property.domainLabel.toLowerCase().replace(/[\s_-]/g, '')
          ) : null);
          if (domainClass) {
            domain = domainClass.iri;
            domainLabel = domainClass.label || domainClass.localName || '';
          }
        }

        allMappings.push({
          column: colName,
          _sheet: sheet.name,
          isLiteral,
          property: property?.iri || '',
          propertyLabel: property?.label || property?.localName || propLabel || colName,
          propertyIsNew: !property && !!propLabel && (col.propertyIsNew !== false),
          linkedClass: isLiteral ? '' : (linkedClass?.iri || ''),
          linkedClassLabel: isLiteral ? '' : (linkedClass?.label || linkedClassLabel),
          linkedClassIsNew: !isLiteral && !linkedClass && !!linkedClassLabel && (col.linkedClassIsNew !== false),
          domain,
          domainLabel,
          reasoning: col.reasoning || ''
        });
      }
    }

    const primaryClass = Object.values(sheetPrimaryClasses)[0] || null;
    const primaryClassObj = primaryClass ? classes.find(c => c.iri === primaryClass) : null;

    return {
      primaryClass,
      primaryClassLabel: primaryClassObj?.label || primaryClassObj?.localName || '',
      primaryClassExplanation: 'Multi-sheet holistic analysis',
      mappings: allMappings,
      sheetPrimaryClasses,
      crossSheetRelationships: result.crossSheetRelationships || []
    };
  }

  async _analyzeForMappingSingle(headers, sampleRows, ontology, sheetName = null, dataProfile = null) {
    const sampleData = this.buildSampleData(sanitizeHeaders(headers), sanitizeSampleRows(sampleRows));
    
    // Sanitize ontology context and limit size for large ontologies
    const safeOntology = sanitizeOntologyContext(ontology);
    
    // Normalize ontology - split properties if needed
    const allProps = ontology?.properties || [];
    const dataProperties = safeOntology.dataProperties.length > 0 ? safeOntology.dataProperties : allProps.filter(p => p.type === 'datatypeProperty');
    const objectProperties = safeOntology.objectProperties.length > 0 ? safeOntology.objectProperties : allProps.filter(p => p.type === 'objectProperty');
    const classes = safeOntology.classes;
    
    // Run data profiling for smarter context
    const profile = dataProfile || dataProfileService.profileColumns(headers, sampleRows);
    const profileHints = Object.values(profile.columns).map(p => {
      const tags = [];
      if (p.isId) tags.push('PK');
      if (p.isFkCandidate) tags.push('FK');
      if (p.isCategory) tags.push('CATEGORY');
      return `  - "${p.header}": ${p.type}${tags.length ? ' [' + tags.join(',') + ']' : ''} (${p.cardinality} unique${p.sampleValues?.length ? ', samples: ' + p.sampleValues.slice(0, 3).join(', ') : ''})`;
    }).join('\n');
    
    // Normalize a name for domain matching
    const normName = (n) => (n || '').toLowerCase().replace(/[\s_-]/g, '');

    const domainMatchesClass = (prop, cls) => {
      const cLabel = normName(cls.label);
      const cLocal = normName(cls.localName);
      const pDomain = normName(prop.domain);
      const pDomainLabel = normName(prop.domainLabel);
      return (pDomain && (pDomain === cLabel || pDomain === cLocal))
        || (pDomainLabel && (pDomainLabel === cLabel || pDomainLabel === cLocal));
    };

    // Build class details with properties
    const MAX_CLASSES_IN_PROMPT = 30;
    let relevantClasses = classes;
    if (classes.length > MAX_CLASSES_IN_PROMPT) {
      const headerWords = new Set(headers.flatMap(h => h.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/)));
      const scoredClasses = classes.map(c => {
        const label = (c.label || c.localName || '').toLowerCase();
        const words = label.replace(/([A-Z])/g, ' $1').toLowerCase().split(/\s+/);
        const score = words.filter(w => headerWords.has(w)).length;
        return { ...c, _relevanceScore: score };
      }).sort((a, b) => b._relevanceScore - a._relevanceScore);
      relevantClasses = scoredClasses.slice(0, MAX_CLASSES_IN_PROMPT);
      logger.info(`🔗 Large ontology (${classes.length} classes), using top ${MAX_CLASSES_IN_PROMPT} relevant classes`);
    }

    const classDetails = relevantClasses.map(c => {
      const classDataProps = dataProperties
        .filter(p => domainMatchesClass(p, c))
        .map(p => `${p.label || p.localName} (${p.range || 'string'})`);
      const classObjProps = objectProperties
        .filter(p => domainMatchesClass(p, c))
        .map(p => `${p.label || p.localName} → ${p.rangeLabel || p.range || 'Entity'}`);
      return `${c.label || c.localName}: ${c.comment || c.description || 'no description'}
      Data properties: ${classDataProps.join(', ') || 'none defined'}
      Object properties: ${classObjProps.join(', ') || 'none defined'}`;
    }).join('\n  ');

    const objPropsStr = objectProperties.map(p => `${p.label || p.localName}: ${p.domainLabel || p.domain || 'any'} → ${p.rangeLabel || p.range || 'Entity'}`).join('\n  - ') || 'None';
    const dataPropsStr = dataProperties.map(p => `${p.label || p.localName} (domain: ${p.domainLabel || p.domain || 'any'}, range: ${p.range === 'Literal' ? 'string' : (p.range || 'xsd:string')})`).join('\n  - ') || 'None';

    const systemPrompt = `You are mapping CSV columns to an EXISTING ontology for knowledge graph construction. You must use the provided classes and properties.

AVAILABLE ONTOLOGY:

CLASSES (with their properties):
  ${classDetails || 'No classes defined'}

ALL OBJECT PROPERTIES (create relationships between entities):
  - ${objPropsStr}

ALL DATA PROPERTIES (literal values on entities):
  - ${dataPropsStr}

DATA PROFILING (pre-computed column analysis):
${profileHints}

TASK:
1. Identify which ontology class best represents EACH ROW of this CSV (primaryClass)
2. For each column, determine: literal data property OR foreign key to another entity?
3. Map each column to the correct ontology property

RELATIONSHIP DETECTION RULES:
- A column is a FOREIGN KEY (isLiteral=false) when:
  • Column name ends in "ID"/"Id"/"_id" and matches a class name (e.g., "CustomerID" → Customer class)
  • Column contains references to entities of another class (e.g., "approved_by" with person names → Employee class)
  • Column has low cardinality categorical values that should be separate nodes (e.g., "Segment" with "Retail","Corporate" → if Segment class exists)
  • Data profiling marks it as [FK] or [CATEGORY] with a matching class
- A column is a LITERAL (isLiteral=true) when:
  • Dates, timestamps, datetime values → ALWAYS literal
  • Numeric values: amounts, scores, counts, percentages, ages → ALWAYS literal
  • Free-text: names, descriptions, addresses, emails, phones, URLs → ALWAYS literal
  • Hashes, fingerprints, boolean flags → ALWAYS literal
  • The column is the PRIMARY KEY of this sheet → ALWAYS literal in this sheet
- SELF-REFERENTIAL: A column like "ManagerID" on an "Employees" sheet references the same class → still a foreign key (Employee → Employee)

PROPERTY SELECTION RULES:
- For foreign keys: use the OBJECT PROPERTY whose domain=primaryClass and range=targetClass
- If multiple object properties link to the same target, pick the one whose name best matches the column semantics
- For literals: use the DATA PROPERTY whose domain=primaryClass and name matches the column
- Use EXACT property labels from the ontology — do NOT rename them
- Only set propertyIsNew=true if absolutely NO existing property matches

Output ONLY valid JSON:
{
  "primaryClass": "The ontology class label that each CSV row represents",
  "primaryClassExplanation": "Why this class was chosen",
  "mappings": [
    {
      "column": "column_name",
      "isLiteral": true/false,
      "property": "exact ontology property label (MUST exist or be marked new)",
      "propertyIsNew": true/false,
      "linkedClass": "target class label if foreign key (empty string if literal)",
      "linkedClassIsNew": true/false,
      "reasoning": "brief explanation of why this mapping"
    }
  ]
}

CRITICAL:
- Every column MUST appear in mappings
- primaryClass MUST be an existing ontology class label
- Property labels must EXACTLY match ontology labels (case-sensitive)
- Do NOT map date/numeric columns as foreign keys`;

    const sheetContext = sheetName ? `\nSHEET NAME: "${sanitizeValue(sheetName, 100)}" — each row represents one entity of this type.\n` : '';
    const userPrompt = `Map these CSV columns to the ontology:
${sheetContext}
COLUMNS: ${sanitizeHeaders(headers).join(', ')}

SAMPLE DATA:
${sampleData}

Remember: primaryClass must be one of the available ontology classes.${sheetName ? ` This is the "${sanitizeValue(sheetName, 100)}" sheet — pick the class that matches this sheet name.` : ''}
Output only JSON.`;

    try {
      console.log(`\n🔗 LLM analyzing CSV for mapping: ${headers.length} columns${sheetName ? ` (sheet: ${sheetName})` : ''}`);
      const startTime = Date.now();

      const content = await this._chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 8000 });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Mapping analysis complete in ${duration}s`);

      let result;
      try {
        result = JSON.parse(this.extractJSON(content));
      } catch (e) {
        console.warn(`⚠️ Mapping JSON incomplete, attempting partial recovery`);
        const partial = content.replace(/```json?\n?/g, '').replace(/```/g, '');
        const lastBracket = partial.lastIndexOf('}');
        if (lastBracket > 0) {
          let fixed = partial.substring(0, lastBracket + 1);
          if (!fixed.includes(']}')) fixed += ']}';
          try { result = JSON.parse(fixed); } catch (_) {}
        }
        if (!result) {
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
        const propDomainLabel = property.domainLabel;
        const domainIri = propDomain.includes('://') ? propDomain : null;
        const domainLocal = propDomain.includes('://') ? propDomain.split(/[#/]/).pop() : propDomain;
        // Normalize for matching: strip spaces/underscores, lowercase
        const normDomain = domainLocal.toLowerCase().replace(/[\s_-]/g, '');
        const domainClass = domainIri
          ? classes.find(c => c.iri === domainIri)
          : classes.find(c => {
              const cLabel = (c.label || c.localName || '').toLowerCase().replace(/[\s_-]/g, '');
              const cLocal = (c.localName || '').toLowerCase().replace(/[\s_-]/g, '');
              return cLabel === normDomain || cLocal === normDomain;
            });
        // Also try matching via domainLabel from getOntologyStructure
        const resolvedClass = domainClass || (propDomainLabel ? classes.find(c => {
          const cLabel = (c.label || c.localName || '').toLowerCase().replace(/[\s_-]/g, '');
          return cLabel === propDomainLabel.toLowerCase().replace(/[\s_-]/g, '');
        }) : null);
        if (resolvedClass) {
          domain = resolvedClass.iri;
          domainLabel = resolvedClass.label || resolvedClass.localName || '';
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
