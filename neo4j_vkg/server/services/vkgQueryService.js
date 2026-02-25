/**
 * VKG Query Service
 * Core query engine for the Virtual Knowledge Graph path.
 * Natural language → LLM plan → LLM SQL → Validate → Trino execute →
 * Context graph + Reasoning trace → LLM answer → Unified response.
 */

const fs = require('fs');
const path = require('path');
const trinoClient = require('../config/trino');
const graphDBStore = require('./graphDBStore');
const vkgOntologyService = require('./vkgOntologyService');
const trinoCatalogService = require('./trinoCatalogService');
const sqlValidatorService = require('./sqlValidatorService');
const contextGraphBuilder = require('./contextGraphBuilder');
const llmService = require('./llmService');
const redisService = require('./redisService');
const logger = require('../utils/logger');

const PROMPTS_DIR = path.join(__dirname, 'prompts', 'vkg');

class VKGQueryService {
  constructor() {
    this._prompts = {};
    logger.info('🔗 VKGQueryService initialized');
  }

  /**
   * Execute a full VKG query pipeline.
   * Optimized: steps 1-3 run in parallel, plan+SQL merged into single LLM call.
   */
  async query(question, tenantId, workspaceId, options = {}) {
      const pipeline = { steps: [], totalStartTime: Date.now() };
      const tag = `[VKG:${tenantId}]`;
      const workspaceName = options.workspaceName || workspaceId;

      console.log(`\n${'═'.repeat(70)}`);
      console.log(`${tag} 🌐 FEDERATED QUERY PIPELINE START`);
      console.log(`${tag} ❓ Question: "${question}"`);
      console.log(`${tag} 📁 Workspace: ${workspaceName} (id: ${workspaceId})`);
      console.log(`${'─'.repeat(70)}`);

      try {
        // Step 1: Load ontology + mappings from GraphDB (NO Trino introspection needed)
        console.log(`${tag} ⏳ Step 1: Loading ontology schema + mappings from GraphDB...`);
        const [ontologySchema, mappings] = await this._timedStep(
          pipeline, 'Load Ontology + Mappings', async () => {
            return Promise.all([
              this._getOntologySchema(tenantId, workspaceId, workspaceName),
              vkgOntologyService.getMappingAnnotations(tenantId, workspaceId, workspaceName)
            ]);
          }
        );
        const classCount = ontologySchema.classes?.length || 0;
        const propCount = (ontologySchema.dataProperties?.length || 0) + (ontologySchema.objectProperties?.length || 0);
        const mappingClassCount = Object.keys(mappings.classes || {}).length;
        const mappingPropCount = Object.keys(mappings.properties || {}).length;
        console.log(`${tag} ✅ Context loaded: ${classCount} classes, ${propCount} properties, ${mappingClassCount} mapped tables, ${mappingPropCount} mapped columns`);

        // Resolve 2-part table names (database.table) to 3-part Trino names (catalog.schema.table)
        const resolvedMappings = await this._resolveTrinoTableNames(tenantId, mappings);

        // Filter schema to only VKG-mapped classes/properties (avoids flooding LLM with unrelated ontology)
        const filteredSchema = this._filterSchemaByMappings(ontologySchema, resolvedMappings);
        const filteredClassCount = filteredSchema.classes?.length || 0;
        const filteredPropCount = (filteredSchema.dataProperties?.length || 0) + (filteredSchema.objectProperties?.length || 0);
        console.log(`${tag} 🔍 Filtered schema: ${filteredClassCount}/${classCount} classes, ${filteredPropCount}/${propCount} properties (VKG-mapped only)`);

        // Steps 2-4: Generate SQL → Validate → Execute (with up to 3 retries on failure)
        const MAX_ATTEMPTS = 3;
        let sql = '';
        let plan = {};
        let trinoResult = null;
        let validation = null;
        let lastError = null;
        let conversationHistory = []; // accumulate messages for error-feedback retries

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const attemptTag = MAX_ATTEMPTS > 1 && attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : '';

          // Step 2: LLM generates plan + SQL
          console.log(`${tag} ⏳ Step 2: LLM generating execution plan + SQL...${attemptTag}`);
          try {
            const genResult = await this._timedStep(pipeline, `LLM Plan+SQL Generation${attemptTag}`, async () => {
              return this._generatePlanAndSQL(question, filteredSchema, resolvedMappings, conversationHistory);
            });
            plan = genResult.plan;
            sql = genResult.sql;
          } catch (genErr) {
            console.log(`${tag} ❌ SQL generation failed: ${genErr.message}`);
            lastError = genErr.message;
            continue;
          }
          console.log(`${tag} ✅ Plan: entities=[${(plan.entities || []).join(', ')}], singleHop=${plan.singleHop}, aggregation=${plan.aggregation || 'none'}`);
          console.log(`${tag} ✅ SQL generated (${sql.length} chars):`);
          console.log(`${tag}    ${sql.split('\n').join(`\n${tag}    `)}`);

          // Step 3: Validate SQL offline
          console.log(`${tag} ⏳ Step 3: Validating SQL...`);
          validation = await this._timedStep(pipeline, `SQL Validation${attemptTag}`, async () => {
            return sqlValidatorService.validate(sql, null, resolvedMappings);
          });

          if (!validation.valid) {
            const errMsg = validation.errors.join('; ');
            console.log(`${tag} ❌ SQL validation FAILED: ${errMsg}`);
            lastError = `SQL validation failed: ${errMsg}`;
            conversationHistory.push(
              { role: 'assistant', content: JSON.stringify({ plan, sql }) },
              { role: 'user', content: `The SQL you generated failed validation: ${errMsg}\n\nPlease fix the SQL and return the corrected JSON. Remember: all table references must use 3-part names (catalog.schema.table) from the TABLE MAPPINGS.` }
            );
            if (attempt < MAX_ATTEMPTS) continue;
            return this._errorResponse(question, lastError, pipeline);
          }
          console.log(`${tag} ✅ SQL valid${validation.warnings?.length ? ` (${validation.warnings.length} warnings)` : ''}`);

          // Step 4: Execute SQL on Trino
          console.log(`${tag} ⏳ Step 4: Executing on Trino...`);
          try {
            trinoResult = await this._timedStep(pipeline, `Trino Execution${attemptTag}`, async () => {
              return trinoClient.executeSQL(sql);
            });
            console.log(`${tag} ✅ Trino returned ${trinoResult.rowCount} rows, ${trinoResult.columns?.length || 0} columns in ${trinoResult.durationMs}ms`);
            if (trinoResult.columns?.length) {
              console.log(`${tag}    Columns: ${trinoResult.columns.map(c => c.name).join(', ')}`);
            }
            lastError = null;
            break; // success — exit retry loop
          } catch (trinoErr) {
            console.log(`${tag} ❌ Trino execution FAILED: ${trinoErr.message}`);
            lastError = trinoErr.message;
            conversationHistory.push(
              { role: 'assistant', content: JSON.stringify({ plan, sql }) },
              { role: 'user', content: `The SQL you generated failed on Trino with error: ${trinoErr.message}\n\nPlease fix the SQL and return the corrected JSON. Remember: all table references must use fully-qualified 3-part names (catalog.schema.table) exactly as shown in the TABLE MAPPINGS.` }
            );
            if (attempt < MAX_ATTEMPTS) {
              console.log(`${tag} 🔄 Retrying with error feedback...`);
              continue;
            }
          }
        }

        if (lastError) {
          return this._errorResponse(question, `Failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`, pipeline);
        }

        // Step 5: Build context graph + reasoning trace (non-fatal — answer still generated if this fails)
        const databases = this._extractDatabases(sql);
        console.log(`${tag} ⏳ Step 5: Building context graph + reasoning trace (databases: ${databases.join(', ')})...`);
        let graph = { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0 } };
        let reasoningTrace = [];
        try {
          const start5 = Date.now();
          const g = await contextGraphBuilder.buildGraph(
            trinoResult.rows, trinoResult.columns, filteredSchema, resolvedMappings,
            { sql, databases }
          );
          const r = await contextGraphBuilder.buildReasoningTrace(g, question, { databases });
          graph = g;
          reasoningTrace = r;
          pipeline.steps.push({ name: 'Context Graph + Trace', duration_ms: Date.now() - start5, status: 'success' });
          console.log(`${tag} ✅ Graph: ${graph.statistics?.nodeCount || 0} nodes, ${graph.statistics?.edgeCount || 0} edges`);
        } catch (graphErr) {
          pipeline.steps.push({ name: 'Context Graph + Trace', duration_ms: 0, status: 'skipped', error: graphErr.message });
          console.log(`${tag} ⚠️ Context graph failed (non-fatal): ${graphErr.message}`);
        }

        // Step 6: LLM generates answer
        console.log(`${tag} ⏳ Step 6: LLM generating natural language answer...`);
        const answer = await this._timedStep(pipeline, 'LLM Answer Generation', async () => {
          return this._generateAnswer(question, trinoResult, graph);
        });
        console.log(`${tag} ✅ Answer generated (${answer.length} chars)`);

        const totalMs = Date.now() - pipeline.totalStartTime;

        console.log(`${'─'.repeat(70)}`);
        console.log(`${tag} 🏁 PIPELINE COMPLETE in ${totalMs}ms`);
        pipeline.steps.forEach(s => {
          const icon = s.status === 'success' ? '✅' : '❌';
          console.log(`${tag}    ${icon} ${s.name}: ${s.duration_ms}ms`);
        });
        console.log(`${'═'.repeat(70)}\n`);

        // Record VKG metrics
        try {
          const metricsService = require('./metricsService');
          await metricsService.incrementCounter('vkg_queries', workspaceId);
          await metricsService.setGauge('vkg_avg_latency_ms', workspaceId, totalMs);
        } catch { /* metrics are non-critical */ }

        return {
          answer,
          question,
          context_graph: graph,
          reasoning_trace: reasoningTrace,
          citations: { sql, databases },
          execution_stats: {
            total_ms: totalMs,
            rows_returned: trinoResult.rowCount,
            databases_queried: databases.length,
            trino_execution_ms: trinoResult.durationMs
          },
          execution_pipeline: {
            total_time_ms: totalMs,
            steps: pipeline.steps
          },
          query_mode: 'vkg_federated',
          plan,
          warnings: validation.warnings
        };

      } catch (err) {
        const totalMs = Date.now() - pipeline.totalStartTime;
        console.log(`${tag} ❌ PIPELINE FAILED after ${totalMs}ms: ${err.message}`);
        pipeline.steps.forEach(s => {
          const icon = s.status === 'success' ? '✅' : '❌';
          console.log(`${tag}    ${icon} ${s.name}: ${s.duration_ms}ms`);
        });
        console.log(`${'═'.repeat(70)}\n`);

        try {
          const metricsService = require('./metricsService');
          await metricsService.incrementCounter('vkg_query_failures', workspaceId);
        } catch { /* metrics are non-critical */ }
        return this._errorResponse(question, err.message, pipeline);
      }
    }




  /**
   * Get ontology schema from GraphDB (classes, object properties, data properties)
   */
  async _getOntologySchema(tenantId, workspaceId, workspaceName = null) {
        const cacheKey = `vkg:ontology-schema:v2:${tenantId}:${workspaceId}`;
        const cached = await redisService.get(cacheKey);
        if (cached) {
          try {
            console.log(`  📚 Ontology schema: cache HIT`);
            return JSON.parse(cached);
          } catch { /* fall through */ }
        }

        console.log(`  📚 Ontology schema: cache MISS — querying GraphDB (workspace-only)...`);
        const start = Date.now();
        // VKG queries only need the workspace ontology (which has vkgmap: annotations).
        // Exclude global and tenant ontologies to avoid flooding the LLM with unrelated classes.
        const wsSlug = workspaceName || workspaceId;
        const vkgGraphPattern = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${wsSlug}/ontology/`;
        const sparqlOptions = {
          includeGlobalOntologies: false,
          includeTenantOntologies: false,
          includeWorkspaceOntologies: true,
          vkgGraphPattern
        };
        const [classes, objectProperties, dataProperties] = await Promise.all([
          graphDBStore.getClasses(tenantId, workspaceId, sparqlOptions).catch(() => []),
          graphDBStore.getObjectProperties(tenantId, workspaceId, sparqlOptions).catch(() => []),
          graphDBStore.getDataProperties(tenantId, workspaceId, sparqlOptions).catch(() => [])
        ]);
        const schema = { classes, objectProperties, dataProperties };
        console.log(`  📚 Ontology schema: loaded in ${Date.now() - start}ms (${classes.length} classes, ${objectProperties.length} objProps, ${dataProperties.length} dataProps)`);

        // Cache for 10 minutes
        await redisService.setEx(cacheKey, 600, JSON.stringify(schema));
        return schema;
      }

    /**
     * Filter ontology schema to only include classes/properties that have VKG mappings.
     * This avoids sending 100+ unrelated classes (from other ontologies) to the LLM.
     */
    _filterSchemaByMappings(schema, mappings) {
          const mappedClassNames = new Set(Object.keys(mappings.classes || {}));
          const mappedPropNames = new Set(Object.keys(mappings.properties || {}));
          const mappedRelNames = new Set(Object.keys(mappings.relationships || {}));

          // If no mappings, return full schema (user hasn't generated VKG ontology yet)
          if (mappedClassNames.size === 0) return schema;

          const extractLocal = (val) => {
            if (!val) return null;
            const s = String(val);
            if (s.includes('/') || s.includes('#')) return s.split(/[#\/]/).pop();
            return s;
          };

          const matchesClass = (item) => {
            const label = item.label || item.name || '';
            const localName = item.iri ? item.iri.split(/[#/]/).pop() : '';
            return mappedClassNames.has(label) || mappedClassNames.has(localName);
          };

          const matchesPropOrDomain = (item, nameSet) => {
            const label = item.label || item.name || '';
            const localName = item.iri ? item.iri.split(/[#/]/).pop() : '';
            // Match by property name in mapping set
            if (nameSet.has(label) || nameSet.has(localName)) return true;
            // Also include if any of the property's domains is a mapped class
            const domains = Array.isArray(item.domain) ? item.domain : (item.domain ? [item.domain] : []);
            for (const d of domains) {
              const domainLocal = extractLocal(d);
              if (domainLocal && mappedClassNames.has(domainLocal)) return true;
            }
            return false;
          };

          return {
            classes: schema.classes.filter(matchesClass),
            objectProperties: schema.objectProperties.filter(p => matchesPropOrDomain(p, mappedRelNames)),
            dataProperties: schema.dataProperties.filter(p => matchesPropOrDomain(p, mappedPropNames))
          };
        }
    /**
     * Resolve mapping sourceTable values to fully-qualified Trino 3-part names.
     * Ontology stores "database.table" but Trino needs "catalog.schema.table".
     * Builds lookup from registered catalogs: database → catalogName.schemaName
     */
    async _resolveTrinoTableNames(tenantId, mappings) {
        const catalogs = await trinoCatalogService.listCatalogs(tenantId);
        if (!catalogs.length) return mappings;

        // Build lookup: database/schema name → catalogName
        // Catalog metadata stores the DB name in either "database" or "schema" field
        const dbToCatalog = {};
        for (const cat of catalogs) {
          if (cat.catalogName) {
            // Try database field first, then schema field
            const dbName = cat.database || cat.schema || '';
            if (dbName) {
              dbToCatalog[dbName.toLowerCase()] = cat.catalogName;
            }
          }
        }

        console.log(`  🔗 Catalog lookup: ${JSON.stringify(dbToCatalog)}`);

        if (Object.keys(dbToCatalog).length === 0) return mappings;

        const resolve = (sourceTable) => {
          if (!sourceTable) return sourceTable;
          const parts = sourceTable.split('.');
          // Already 3-part? (catalog.schema.table)
          if (parts.length >= 3) return sourceTable;
          // 2-part: "database.table" → "catalog.database.table"
          if (parts.length === 2) {
            const [db, table] = parts;
            const catalogName = dbToCatalog[db.toLowerCase()];
            if (catalogName) return `${catalogName}.${db}.${table}`;
          }
          return sourceTable;
        };

        // Deep-clone and rewrite
        const resolved = JSON.parse(JSON.stringify(mappings));
        for (const meta of Object.values(resolved.classes || {})) {
          if (meta.sourceTable) meta.sourceTable = resolve(meta.sourceTable);
        }
        for (const meta of Object.values(resolved.properties || {})) {
          if (meta.sourceTable) meta.sourceTable = resolve(meta.sourceTable);
        }

        const resolvedCount = Object.values(resolved.classes || {}).filter(m => m.sourceTable?.split('.').length >= 3).length;
        console.log(`  🔗 Table name resolution: ${resolvedCount}/${Object.keys(resolved.classes || {}).length} tables resolved to 3-part Trino names`);

        return resolved;
      }





  /**
   * LLM: Combined plan + SQL generation in a single call.
   * Eliminates one full LLM round-trip (~2-10s savings).
   */
  async _generatePlanAndSQL(question, ontologySchema, mappings, priorMessages = []) {
        const systemPrompt = this._loadPrompt('plan-and-sql-generator.md');
        const ontologyDesc = this._describeOntology(ontologySchema);
        const mappingDesc = this._describeFullMappings(ontologySchema, mappings);

        const context = [
          '=== ONTOLOGY (classes, properties, relationships) ===',
          ontologyDesc,
          '',
          '=== TABLE MAPPINGS (ontology → Trino tables/columns) ===',
          mappingDesc
        ].join('\n');

        // Debug: log what context the LLM sees
        console.log(`  🧠 LLM context (${context.length} chars):`);
        console.log(`     Ontology: ${ontologyDesc.substring(0, 200)}${ontologyDesc.length > 200 ? '...' : ''}`);
        console.log(`     Mappings: ${mappingDesc.substring(0, 200)}${mappingDesc.length > 200 ? '...' : ''}`);

        if (context.includes('No ontology schema available') && context.includes('No mappings available')) {
          console.log(`  ⚠️ WARNING: Both ontology and mappings are empty — LLM has no schema context`);
          console.log(`  ⚠️ Make sure you have generated and saved a VKG ontology first (Data Sources → Generate Ontology → Save)`);
        }

        // Build message list: initial question + any prior error-feedback messages
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${context}\n\nQuestion: ${question}` },
          ...priorMessages
        ];

        if (priorMessages.length > 0) {
          console.log(`  🔄 Retry with ${priorMessages.length / 2} prior error(s) in conversation`);
        }

        const content = await this._llmChat(messages, { temperature: 0.1 });

        // Debug: log raw LLM response
        console.log(`  🧠 LLM raw response (${content.length} chars): ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}`);

        try {
          const cleaned = this._extractJSON(content);
          const parsed = JSON.parse(cleaned);

          let sql = (parsed.sql || '').trim();
          const codeMatch = sql.match(/```(?:sql)?\s*([\s\S]*?)\s*```/);
          if (codeMatch) sql = codeMatch[1].trim();
          if (sql && !/\bLIMIT\b/i.test(sql)) {
            sql = sql.replace(/;?\s*$/, '') + '\nLIMIT 1000';
          }

          if (!sql) {
            console.log(`  ⚠️ LLM returned valid JSON but sql field is empty. Parsed keys: ${Object.keys(parsed).join(', ')}`);
          }

          return {
            plan: parsed.plan || { entities: [], relationships: [], singleHop: true, reasoning: 'Parsed from combined response' },
            sql
          };
        } catch (parseErr) {
          console.log(`  ⚠️ JSON parse failed: ${parseErr.message} — attempting SQL extraction from raw text`);
          let sql = content.trim();
          const codeMatch = sql.match(/```(?:sql)?\s*([\s\S]*?)\s*```/);
          if (codeMatch) sql = codeMatch[1].trim();
          if (sql && !/\bLIMIT\b/i.test(sql)) {
            sql = sql.replace(/;?\s*$/, '') + '\nLIMIT 1000';
          }
          return {
            plan: { entities: [], relationships: [], singleHop: true, reasoning: 'Fallback — could not parse combined JSON' },
            sql
          };
        }
      }





  /**
   * LLM: Generate natural language answer from results
   */
  async _generateAnswer(question, trinoResult, graph) {
    if (trinoResult.rowCount === 0) {
      return 'No results found for this query.';
    }

    const systemPrompt = this._loadPrompt('answer-generator.md');

    // Build a readable summary of results
    const colNames = trinoResult.columns.map(c => c.name);
    const sampleRows = trinoResult.rows.slice(0, 20);
    const resultSummary = [
      `Columns: ${colNames.join(', ')}`,
      `Total rows: ${trinoResult.rowCount}`,
      '',
      'Sample data:',
      ...sampleRows.map(row => colNames.map((col, i) => `${col}=${row[i]}`).join(', '))
    ].join('\n');

    const content = await this._llmChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Question: ${question}\n\nQuery Results:\n${resultSummary}\n\nGraph: ${graph.statistics.nodeCount} entities, ${graph.statistics.edgeCount} relationships\n\nGenerate a conversational answer:` }
    ], { temperature: 0.3 });

    return content.trim();
  }

  // --- Helper methods ---

  /**
   * Wrapper for llmService.chat — token is injected by middleware via AsyncLocalStorage
   */
  _llmChat(messages, options = {}) {
    return llmService.chat(messages, options);
  }

  _describeOntology(schema) {
    const lines = [];
    if (schema.classes?.length) {
      lines.push('Classes:');
      for (const c of schema.classes) lines.push(`  - ${c.label || c.name || c}`);
    }
    if (schema.objectProperties?.length) {
      lines.push('Relationships:');
      for (const p of schema.objectProperties) {
        lines.push(`  - ${p.label || p.name}: ${p.domain || '?'} → ${p.range || '?'}`);
      }
    }
    if (schema.dataProperties?.length) {
      lines.push('Properties:');
      for (const p of schema.dataProperties) {
        lines.push(`  - ${p.label || p.name} (${p.domain || '?'}): ${p.range || 'string'}`);
      }
    }
    return lines.join('\n') || 'No ontology schema available';
  }

  /**
   * Build a rich mapping description for the LLM that combines ontology + vkgmap annotations.
   * This replaces the need for Trino catalog introspection — the ontology already knows
   * which catalog.schema.table each class maps to and which column each property maps to.
   */
  _describeFullMappings(ontologySchema, mappings) {
        const lines = [];

        // Build a lookup: property name → ontology metadata (domain, range, etc.)
        const ontoPropLookup = {};
        for (const dp of (ontologySchema.dataProperties || [])) {
          const name = dp.label || dp.name || (dp.iri ? dp.iri.split(/[#\/]/).pop() : '');
          if (name) ontoPropLookup[name] = dp;
        }
        const ontoRelLookup = {};
        for (const op of (ontologySchema.objectProperties || [])) {
          const name = op.label || op.name || (op.iri ? op.iri.split(/[#\/]/).pop() : '');
          if (name) ontoRelLookup[name] = op;
        }

        // Helper: extract local name from IRI or string, handling arrays
        const extractLocal = (val) => {
          if (!val) return null;
          if (Array.isArray(val)) val = val[0]; // take first domain/range
          if (!val) return null;
          const s = String(val);
          if (s.includes('/') || s.includes('#')) return s.split(/[#\/]/).pop();
          return s;
        };

        // Group properties by their domain class (from ontology schema, not mappings)
        const propsByClass = {};
        for (const [propName, meta] of Object.entries(mappings.properties || {})) {
          const ontoProp = ontoPropLookup[propName];
          const domain = extractLocal(ontoProp?.domain) || 'Unknown';
          if (!propsByClass[domain]) propsByClass[domain] = [];
          propsByClass[domain].push({ propName, ...meta });
        }

        // For each mapped class, show table + all its columns
        for (const [className, meta] of Object.entries(mappings.classes || {})) {
          const table = meta.sourceTable || 'unknown';
          const idCol = meta.sourceIdColumn || '?';
          lines.push(`TABLE: ${table}`);
          lines.push(`  Entity: ${className} (primary key: ${idCol})`);

          // List all properties (columns) for this class
          const props = propsByClass[className] || [];
          if (props.length > 0) {
            lines.push(`  Columns:`);
            for (const p of props) {
              const ontoProp = ontoPropLookup[p.propName];
              const xsdType = extractLocal(ontoProp?.range) || p.range || '';
              const sqlType = this._xsdToSqlHint(xsdType);
              lines.push(`    ${p.sourceColumn || p.propName}${sqlType ? ' (' + sqlType + ')' : ''} → :${p.propName}`);
            }
          }
          lines.push('');
        }

        // Show relationship join conditions (domain/range from ontology schema)
        const rels = mappings.relationships || {};
        if (Object.keys(rels).length > 0) {
          lines.push('JOINS (relationship → SQL condition):');
          for (const [relName, meta] of Object.entries(rels)) {
            const ontoRel = ontoRelLookup[relName];
            const domain = extractLocal(ontoRel?.domain) || '?';
            const range = extractLocal(ontoRel?.range) || '?';
            lines.push(`  ${relName}: ${domain} → ${range} ON ${meta.joinSQL || '?'}`);
          }
        }

        return lines.join('\n') || 'No mappings available';
      }

  /**
   * Convert XSD type hint to a SQL-friendly type hint for the LLM
   */
  _xsdToSqlHint(xsdType) {
    if (!xsdType) return '';
    const t = xsdType.replace(/.*[#/]/, '').toLowerCase();
    const map = {
      'string': 'varchar', 'integer': 'integer', 'int': 'integer',
      'long': 'bigint', 'bigint': 'bigint', 'decimal': 'decimal',
      'float': 'real', 'double': 'double', 'boolean': 'boolean',
      'date': 'date', 'datetime': 'timestamp', 'datetype': 'timestamp',
      'time': 'time'
    };
    return map[t] || '';
  }



  _extractDatabases(sql) {
    const dbs = new Set();
    const pattern = /(\w+)\.\w+\.\w+/g;
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      dbs.add(match[1]);
    }
    return Array.from(dbs);
  }

  _loadPrompt(filename) {
    if (this._prompts[filename]) return this._prompts[filename];
    try {
      const content = fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
      this._prompts[filename] = content;
      return content;
    } catch {
      return '';
    }
  }

  _extractJSON(content) {
    let cleaned = content.trim();
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) cleaned = match[1].trim();
    const first = cleaned.indexOf('{');
    if (first > 0) cleaned = cleaned.substring(first);
    return cleaned;
  }

  async _timedStep(pipeline, name, fn) {
    const start = Date.now();
    try {
      const result = await fn();
      pipeline.steps.push({ name, duration_ms: Date.now() - start, status: 'success' });
      return result;
    } catch (err) {
      pipeline.steps.push({ name, duration_ms: Date.now() - start, status: 'failed', error: err.message });
      throw err;
    }
  }

  _errorResponse(question, error, pipeline) {
    return {
      answer: `Query failed: ${error}`,
      question,
      context_graph: { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0 } },
      reasoning_trace: [{ step: `Error: ${error}`, evidence: [], sources: [] }],
      citations: {},
      execution_stats: { total_ms: Date.now() - pipeline.totalStartTime, error },
      execution_pipeline: { total_time_ms: Date.now() - pipeline.totalStartTime, steps: pipeline.steps },
      query_mode: 'vkg_federated',
      error
    };
  }
}

module.exports = new VKGQueryService();
