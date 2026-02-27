/**
 * VKG Query Service
 * Core query engine for the Virtual Knowledge Graph path.
 * Natural language → LLM plan → LLM SQL → Validate → Trino execute →
 * Context graph + Reasoning trace → LLM answer → Unified response.
 */

const fs = require('fs');
const path = require('path');
const trinoManager = require('../config/trino');
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
        // Also run a lightweight drift check in parallel (non-blocking)
        console.log(`${tag} ⏳ Step 1: Loading ontology schema + mappings from GraphDB...`);
        let driftWarnings = [];
        const [ontologySchema, mappings] = await this._timedStep(
          pipeline, 'Load Ontology + Mappings', async () => {
            return Promise.all([
              this._getOntologySchema(tenantId, workspaceId, workspaceName),
              vkgOntologyService.getMappingAnnotations(tenantId, workspaceId, workspaceName)
            ]);
          }
        );

        // Non-blocking drift check — runs in background, result appended to response
        const driftPromise = vkgOntologyService.detectSchemaDrift(tenantId, workspaceId, workspaceName)
          .then(drift => {
            if (drift.hasDrift) {
              if (drift.removedTables.length > 0) driftWarnings.push(`⚠️ Schema drift: ${drift.removedTables.length} mapped table(s) no longer exist in database: ${drift.removedTables.join(', ')}`);
              if (drift.removedColumns.length > 0) driftWarnings.push(`⚠️ Schema drift: ${drift.removedColumns.length} mapped column(s) no longer exist: ${drift.removedColumns.slice(0, 5).join(', ')}${drift.removedColumns.length > 5 ? '...' : ''}`);
              if (drift.newTables.length > 0) driftWarnings.push(`ℹ️ ${drift.newTables.length} new table(s) found but not in ontology. Consider regenerating.`);
              console.log(`${tag} ⚠️ Schema drift detected: ${JSON.stringify({ newTables: drift.newTables.length, removedTables: drift.removedTables.length, newColumns: drift.newColumns.length, removedColumns: drift.removedColumns.length })}`);
            }
          })
          .catch(err => {
            console.log(`${tag} ⚠️ Drift check failed (non-fatal): ${err.message}`);
          });
        const classCount = ontologySchema.classes?.length || 0;
        const propCount = (ontologySchema.dataProperties?.length || 0) + (ontologySchema.objectProperties?.length || 0);
        const mappingClassCount = Object.keys(mappings.classes || {}).length;
        const mappingPropCount = Object.keys(mappings.properties || {}).length;
        console.log(`${tag} ✅ Context loaded: ${classCount} classes, ${propCount} properties, ${mappingClassCount} mapped tables, ${mappingPropCount} mapped columns`);

        // Resolve 2-part table names (database.table) to 3-part Trino names (catalog.schema.table)
        const resolvedMappings = await this._resolveTrinoTableNames(tenantId, mappings);

        // Augment relationship JOIN conditions with FK data from Trino introspection.
        // The LLM-generated joinSQL in the ontology may be wrong or missing — Trino
        // introspection provides accurate FK relationships detected from column naming.
        await this._augmentJoinsFromTrino(tenantId, resolvedMappings, workspaceId);

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

          // Treat column-mismatch warnings as errors (they will cause Trino failures)
          const columnWarnings = (validation.warnings || []).filter(w => w.includes('not found in mapped columns') || w.includes('not found in any mapped table'));
          const allErrors = [...validation.errors, ...columnWarnings];

          if (!validation.valid || columnWarnings.length > 0) {
            const errMsg = allErrors.join('; ');
            console.log(`${tag} ❌ SQL validation FAILED: ${errMsg}`);
            lastError = `SQL validation failed: ${errMsg}`;
            conversationHistory.push(
              { role: 'assistant', content: JSON.stringify({ plan, sql }) },
              { role: 'user', content: `The SQL you generated has WRONG COLUMN NAMES: ${errMsg}\n\nYou MUST use ONLY the exact column names from the SQL COLUMNS section and COLUMN DICTIONARY. Do NOT invent column names from ontology property names. Fix the SQL and return corrected JSON.` }
            );
            if (attempt < MAX_ATTEMPTS) continue;
            return this._errorResponse(question, lastError, pipeline);
          }
          const nonColumnWarnings = (validation.warnings || []).filter(w => !columnWarnings.includes(w));
          console.log(`${tag} ✅ SQL valid${nonColumnWarnings.length ? ` (${nonColumnWarnings.length} warnings)` : ''}`);

          // Step 4: Execute SQL on Trino
          console.log(`${tag} ⏳ Step 4: Executing on Trino...`);
          try {
            trinoResult = await this._timedStep(pipeline, `Trino Execution${attemptTag}`, async () => {
              const trinoClient = await trinoManager.getClient(workspaceId);
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
          return this._generateAnswer(question, trinoResult, graph, {
            sql, plan, mappings: resolvedMappings, workspaceId
          });
        });
        console.log(`${tag} ✅ Answer generated (${answer.length} chars)`);

        // Wait for drift check to complete before building response
        await driftPromise;

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
          warnings: [...(validation.warnings || []), ...driftWarnings]
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
     * Augment relationship JOIN conditions with FK data from Trino introspection.
     * The LLM-generated joinSQL in the ontology may be incorrect or missing.
     * Trino introspection detects FK relationships from column naming conventions
     * (e.g., customer_id in transactions → customers.customer_id).
     *
     * This method:
     * 1. Introspects all catalogs referenced in the mappings
     * 2. Builds a table→FK lookup from Trino's detected relationships
     * 3. For each ontology relationship, either validates/replaces the joinSQL
     *    or generates one from Trino FK data if missing
     * 4. Adds any Trino-detected FKs that have no corresponding ontology relationship
     */
    async _augmentJoinsFromTrino(tenantId, mappings, workspaceId = null) {
      try {
        // Collect unique catalogs from mapped tables
        const catalogSet = new Set();
        for (const meta of Object.values(mappings.classes || {})) {
          if (meta.sourceTable) {
            const parts = meta.sourceTable.split('.');
            if (parts.length >= 2) catalogSet.add(parts[0]);
          }
        }
        if (catalogSet.size === 0) return;

        // Introspect each catalog to get FK relationships
        const allFKs = []; // { fromTable, fromColumn, toTable, toColumn }
        const introspections = await Promise.all(
          Array.from(catalogSet).map(async (catalogName) => {
            try {
              return await trinoCatalogService.introspectCatalog(tenantId, catalogName, null, workspaceId);
            } catch { return null; }
          })
        );

        for (const intro of introspections) {
          if (intro?.relationships) {
            allFKs.push(...intro.relationships);
          }
        }

        if (allFKs.length === 0) {
          console.log(`  🔗 No FK relationships detected from Trino introspection`);
          return;
        }

        console.log(`  🔗 Trino FK introspection: ${allFKs.length} foreign key relationships detected`);

        // Build class name → sourceTable lookup
        const classToTable = {};
        const tableToClass = {};
        for (const [className, meta] of Object.entries(mappings.classes || {})) {
          if (meta.sourceTable) {
            classToTable[className] = meta.sourceTable;
            tableToClass[meta.sourceTable.toLowerCase()] = className;
          }
        }

        // Build FK lookup: fromTable → [{ fromColumn, toTable, toColumn }]
        const fkByTable = {};
        for (const fk of allFKs) {
          const key = fk.fromTable.toLowerCase();
          if (!fkByTable[key]) fkByTable[key] = [];
          fkByTable[key].push(fk);
        }

        // For each existing ontology relationship, validate/replace joinSQL
        let augmented = 0;
        for (const [relName, meta] of Object.entries(mappings.relationships || {})) {
          // Find domain and range classes from ontology
          const domain = meta.domain;
          const range = meta.range;
          if (!domain || !range) continue;

          const domainTable = classToTable[domain];
          const rangeTable = classToTable[range];
          if (!domainTable || !rangeTable) continue;

          // Look for a Trino FK that connects these two tables
          const domainFKs = fkByTable[domainTable.toLowerCase()] || [];
          const matchingFK = domainFKs.find(fk => fk.toTable.toLowerCase() === rangeTable.toLowerCase());

          // Also check reverse direction (range → domain)
          const rangeFKs = fkByTable[rangeTable.toLowerCase()] || [];
          const reverseFK = rangeFKs.find(fk => fk.toTable.toLowerCase() === domainTable.toLowerCase());

          const fk = matchingFK || reverseFK;
          if (fk) {
            const newJoinSQL = `${fk.fromTable}.${fk.fromColumn} = ${fk.toTable}.${fk.toColumn}`;
            if (meta.joinSQL !== newJoinSQL) {
              console.log(`  🔗 Augmented JOIN for ${relName}: ${meta.joinSQL || '(missing)'} → ${newJoinSQL}`);
              meta.joinSQL = newJoinSQL;
              augmented++;
            }
          }
        }

        // Also add any Trino FKs that don't have a corresponding ontology relationship
        let added = 0;
        for (const fk of allFKs) {
          const fromClass = tableToClass[fk.fromTable.toLowerCase()];
          const toClass = tableToClass[fk.toTable.toLowerCase()];
          if (!fromClass || !toClass) continue;

          // Check if any existing relationship already covers this FK
          const alreadyCovered = Object.values(mappings.relationships || {}).some(rel => {
            if (!rel.joinSQL) return false;
            return rel.joinSQL.includes(fk.fromColumn) && rel.joinSQL.includes(fk.toColumn);
          });

          if (!alreadyCovered) {
            // Generate a relationship name from the FK column
            const relName = `${fromClass}_${fk.fromColumn.replace(/_id$/, '')}`;
            mappings.relationships[relName] = {
              domain: fromClass,
              range: toClass,
              joinSQL: `${fk.fromTable}.${fk.fromColumn} = ${fk.toTable}.${fk.toColumn}`
            };
            added++;
          }
        }

        if (augmented > 0 || added > 0) {
          console.log(`  🔗 JOIN augmentation: ${augmented} corrected, ${added} new from Trino FK detection`);
        }
      } catch (err) {
        console.warn(`  ⚠️ FK augmentation failed (non-blocking): ${err.message}`);
      }
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
        // Also resolve table references inside joinSQL conditions
        for (const meta of Object.values(resolved.relationships || {})) {
          if (meta.joinSQL) {
            // Replace 2-part table.column references with 3-part catalog.schema.table.column
            meta.joinSQL = meta.joinSQL.replace(/(\b\w+)\.(\w+)\.(\w+)\b/g, (match, p1, p2, p3) => {
              // Already 3-part? Check if p1 is a known catalog — if so, leave it
              const allCatalogNames = catalogs.map(c => c.catalogName);
              if (allCatalogNames.includes(p1)) return match;
              // Otherwise treat as database.table.column → resolve database.table then append .column
              const resolved3 = resolve(`${p1}.${p2}`);
              return resolved3 !== `${p1}.${p2}` ? `${resolved3}.${p3}` : match;
            });
          }
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
  async _generateAnswer(question, trinoResult, graph, options = {}) {
      const { sql = '', plan = {}, mappings = null, workspaceId = null } = options;

      if (trinoResult.rowCount === 0) {
        // Instead of just "no results", try to show what data actually exists
        const exploration = await this._exploreAvailableData(sql, plan, mappings, workspaceId);
        if (exploration) {
          const content = await this._llmChat([
            { role: 'system', content: `You are a helpful data analyst. The user's query returned 0 results. You have exploration data showing what values actually exist in the database. Explain clearly: (1) the query found no matching data, (2) show what values DO exist so the user can refine their question. Be concise and helpful.` },
            { role: 'user', content: `Question: ${question}\n\nOriginal SQL: ${sql}\n\nThe query returned 0 rows.\n\nExploration of available data:\n${exploration}\n\nExplain what happened and show the user what data is available:` }
          ], { temperature: 0.3 });
          return content.trim();
        }
        return 'No results found for this query. The filter criteria may not match any records in the database.';
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
  /**
     * When a query returns 0 rows, explore the database to show what data actually exists.
     * Extracts WHERE clause filter columns from the SQL and runs SELECT DISTINCT on them.
     */
    async _exploreAvailableData(sql, plan, mappings, workspaceId) {
      if (!sql || !workspaceId) return null;

      try {
        // Extract table references and their aliases from the SQL
        const aliasMap = {};
        const tablePattern = /(?:FROM|JOIN)\s+(\w+\.\w+\.\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
        let m;
        while ((m = tablePattern.exec(sql)) !== null) {
          const table = m[1];
          const alias = m[2];
          if (alias && !['ON', 'WHERE', 'LEFT', 'RIGHT', 'INNER', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'LIMIT'].includes(alias.toUpperCase())) {
            aliasMap[alias] = table;
          }
        }

        // Extract filter columns from WHERE clause (columns used in comparisons)
        const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP\s+BY|ORDER\s+BY|LIMIT|$)/i);
        if (!whereMatch) return null;

        const whereClause = whereMatch[1];
        // Find alias.column or LOWER(alias.column) patterns in WHERE
        const filterCols = new Map();
        const colPattern = /(?:LOWER\s*\(\s*)?(\w+)\.(\w+)\s*\)?\s*(?:=|LIKE|IN|!=|<>)/gi;
        while ((m = colPattern.exec(whereClause)) !== null) {
          const alias = m[1];
          const col = m[2];
          const table = aliasMap[alias];
          if (table) {
            const key = `${table}.${col}`;
            if (!filterCols.has(key)) filterCols.set(key, { table, alias, column: col });
          }
        }

        if (filterCols.size === 0) return null;

        // Run SELECT DISTINCT on each filter column (limit to 25 values)
        const trinoClient = await trinoManager.getClient(workspaceId);
        const explorations = [];

        for (const { table, column } of filterCols.values()) {
          try {
            const exploreSql = `SELECT DISTINCT ${column}, COUNT(*) as cnt FROM ${table} GROUP BY ${column} ORDER BY cnt DESC LIMIT 25`;
            const result = await trinoClient.executeSQL(exploreSql);
            if (result.rowCount > 0) {
              const values = result.rows.map(r => `${r[0]} (${r[1]} rows)`);
              explorations.push(`Column "${column}" in ${table} has ${result.rowCount} distinct values:\n  ${values.join(', ')}`);
            }
          } catch (e) {
            // Non-fatal — skip this column
            console.log(`  ⚠️ Exploration query failed for ${table}.${column}: ${e.message}`);
          }
        }

        // Also show total row count for the main table
        const mainTableMatch = sql.match(/FROM\s+(\w+\.\w+\.\w+)/i);
        if (mainTableMatch) {
          try {
            const countResult = await trinoClient.executeSQL(`SELECT COUNT(*) FROM ${mainTableMatch[1]}`);
            if (countResult.rows?.[0]) {
              explorations.unshift(`Total rows in ${mainTableMatch[1]}: ${countResult.rows[0][0]}`);
            }
          } catch { /* non-fatal */ }
        }

        return explorations.length > 0 ? explorations.join('\n\n') : null;
      } catch (err) {
        console.log(`  ⚠️ Data exploration failed: ${err.message}`);
        return null;
      }
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
            if (Array.isArray(val)) val = val[0];
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

          // For each mapped class, show table + all its columns in SQL-friendly format
          for (const [className, meta] of Object.entries(mappings.classes || {})) {
            const table = meta.sourceTable || 'unknown';
            const idCol = meta.sourceIdColumn || '?';
            lines.push(`TABLE: ${table}  (entity: ${className})`);
            lines.push(`  PRIMARY KEY: ${idCol}`);

            // List all columns — column name first, prominently
            const props = propsByClass[className] || [];
            if (props.length > 0) {
              lines.push(`  SQL COLUMNS (use ONLY these exact column names in queries):`);
              for (const p of props) {
                const colName = p.sourceColumn || p.propName;
                const ontoProp = ontoPropLookup[p.propName];
                const xsdType = extractLocal(ontoProp?.range) || p.range || '';
                const sqlType = this._xsdToSqlHint(xsdType);
                lines.push(`    - ${colName}${sqlType ? ' (' + sqlType + ')' : ''}    [ontology: ${p.propName}]`);
              }
            }
            lines.push('');
          }

          // Show relationship join conditions
          const rels = mappings.relationships || {};
          if (Object.keys(rels).length > 0) {
            lines.push('JOINS (use these exact JOIN conditions):');
            for (const [relName, meta] of Object.entries(rels)) {
              const ontoRel = ontoRelLookup[relName];
              // Use domain/range from ontology lookup, or from augmented meta (Trino FK)
              const domain = extractLocal(ontoRel?.domain) || meta.domain || '?';
              const range = extractLocal(ontoRel?.range) || meta.range || '?';
              lines.push(`  ${relName}: ${domain} → ${range} ON ${meta.joinSQL || '?'}`);
            }
          }

          // Build a quick-reference column dictionary for the LLM
          lines.push('');
          lines.push('COLUMN DICTIONARY (ontology property → actual SQL column):');
          for (const [propName, meta] of Object.entries(mappings.properties || {})) {
            const colName = meta.sourceColumn || propName;
            if (colName !== propName) {
              lines.push(`  ${propName} → USE "${colName}" (NOT "${propName}")`);
            } else {
              lines.push(`  ${propName} → "${colName}"`);
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
