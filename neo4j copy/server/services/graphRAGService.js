/**
 * Graph RAG Service - IMPROVED VERSION
 * Combines vector search with knowledge graph traversal for enhanced retrieval
 * Better query understanding and context building for grounded responses
 */

const vectorStoreService = require('./vectorStoreService');
const neo4jService = require('./neo4jService');
const driver = require('../config/neo4j');
const llmService = require('./llmService');

class GraphRAGService {
  constructor() {
    this.maxGraphDepth = 2;
    this.maxContextChunks = 50;
    this.maxGraphNodes = 20;
    this.maxConceptsPerQuery = 10;
    // Cache for compact schema summaries (5 min TTL)
    this._compactSchemaCache = null;
    this._compactSchemaCacheTime = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UNIFIED AGENT QUERY PIPELINE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Unified query pipeline for agents. Replaces the single-mode routing with
   * a planner that decides which sources to consult, runs them in parallel,
   * fuses the results, and generates a single grounded response.
   */
  async unifiedAgentQuery(question, options = {}) {
    const {
      agent = {},
      memoryContext = null,
      scopedDocumentIds = null,
      tenant_id = 'default',
      workspace_id = 'default',
      history = [],
      bedrockToken = null
    } = options;

    if (bedrockToken) this._activeBedrockToken = bedrockToken;

    const agentFolders = agent.folders || [];
    const agentOntologies = agent.ontologies || [];
    let agentVkgDbs = agent.vkg_databases || [];
    const topK = agent.settings?.topK || 8;
    const graphDepth = agent.settings?.graphDepth || 2;

    // ── VKG databases: explicit selection only ──
    // VKG is only triggered when the agent explicitly has vkg_databases configured.
    // Previously we auto-derived VKG databases from ontology mapping annotations,
    // but this caused false positives (e.g., an ontology with VKG mappings would
    // trigger VKG queries even when the user only wanted graph/RAG queries).
    if (agentVkgDbs.length === 0) {
      console.log(`   ℹ️ No VKG databases configured — VKG source will not be used`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log(`🧠 UNIFIED AGENT PIPELINE: "${question}"`);
    console.log(`   Agent: ${agent.name || 'unknown'} | Sources: folders=${agentFolders.length}, ontologies=${agentOntologies.length}, vkg=${agentVkgDbs.length}`);
    if (agentOntologies.length > 0) console.log(`   📚 Ontologies: ${agentOntologies.map(o => o.name || o.id).join(', ')}`);
    if (agentVkgDbs.length > 0) console.log(`   🗄️ VKG databases: ${agentVkgDbs.join(', ')}`);
    console.log('═'.repeat(70));

    try {
      // ── Phase 1: Query Planning ──
      const plan = await this._planQuery(question, {
        memoryContext,
        hasFolders: agentFolders.length > 0,
        hasOntologies: agentOntologies.length > 0,
        hasVkgDbs: agentVkgDbs.length > 0,
        ontologyNames: agentOntologies.map(o => o.name || o.id),
        vkgDatabaseNames: agentVkgDbs,
        agentOntologies,
        tenant_id,
        workspace_id,
        history
      });

      console.log(`   📋 Plan: sources=${plan.sources.join(',')} | rewrite="${plan.rewrittenQuery}"`);
      console.log(`   📋 Entity hints: [${plan.entityHints.join(', ')}]`);

      const effectiveQuery = plan.rewrittenQuery || question;

      // ── Phase 2: Parallel Retrieval ──
      const retrievalResults = await this._parallelRetrieve(effectiveQuery, plan, {
        topK, graphDepth, tenant_id, workspace_id,
        scopedDocumentIds, agentVkgDbs, history,
        entityHints: plan.entityHints,
        memoryContext,
        agentId: agent.agent_id,
        userId: options.userId || 'default',
        agentOntologies
      });

      // ── Phase 3: Context Fusion ──
      const fused = this._fuseContext(retrievalResults, plan, {
        memoryContext,
        maxTokenBudget: 6000
      });

      console.log(`   🔗 Fused: ${fused.chunks.length} chunks, ${fused.entities.length} entities, ${fused.relations.length} relations`);
      console.log(`   🔗 Sources used: ${fused.sourcesUsed.join(', ')}`);

      // ── Phase 4: Response Generation ──
      const contextString = this._buildUnifiedContextString(fused, plan);

      // Build system prompt with agent perspective + core memory
      const systemParts = [];
      if (agent.perspective) systemParts.push(agent.perspective);

      // Add core memory as persistent context
      if (memoryContext) {
        const coreSection = memoryContext.split('\n\n').find(s => s.includes('[Core Memory'));
        if (coreSection) systemParts.push(coreSection);
        const recalledSection = memoryContext.split('\n\n').find(s => s.includes('[Recalled Memories'));
        if (recalledSection) systemParts.push(recalledSection);
      }

      // If VKG returned data, include it as structured context
      let vkgContext = '';
      if (retrievalResults.vkg?.answer && retrievalResults.vkg.rowCount > 0) {
        vkgContext = `\n\n=== FEDERATED DATABASE RESULTS ===\n${retrievalResults.vkg.answer}\n(Source: SQL query across ${retrievalResults.vkg.databases?.join(', ') || 'databases'})`;
      }

      const systemPrompt = `You are a precise assistant that answers questions based on the provided context.
${systemParts.length > 0 ? '\n' + systemParts.join('\n\n') + '\n' : ''}
RULES:
1. Use information from the provided context to answer
2. When citing information, mention the source (document name, graph entity, memory, or database)
3. If partial information exists, share what you found and note what's missing
4. Be direct and concise
5. If the context contains recalled memories, use them to inform your answer but prioritize factual data from documents and graphs`;

      const fullContext = contextString + vkgContext;

      const userPrompt = `CONTEXT:\n${fullContext}\n\n---\nQUESTION: ${question}\n---\nAnswer using the context above. Cite sources when possible.`;

      // Build messages with conversation history for continuity
      const messages = [{ role: 'system', content: systemPrompt }];
      // Include recent history so the LLM can reference prior answers
      if (history.length > 0) {
        for (const msg of history.slice(-4)) {
          messages.push({ role: msg.role, content: (msg.content || '').substring(0, 500) });
        }
      }
      messages.push({ role: 'user', content: userPrompt });

      const answer = await this._llmChat(messages, { temperature: 0.3, maxTokens: 1500 });

      console.log('   ✅ Unified pipeline complete');
      console.log('═'.repeat(70) + '\n');

      // Build response
      const metadata = {
        searchMode: 'unified',
        planSources: plan.sources,
        sourcesUsed: fused.sourcesUsed,
        rewrittenQuery: plan.rewrittenQuery !== question ? plan.rewrittenQuery : undefined,
        entityHints: plan.entityHints,
        vectorChunksUsed: retrievalResults.vector?.chunks?.length || 0,
        graphConceptsUsed: retrievalResults.graph?.concepts?.length || 0,
        vkgRowCount: retrievalResults.vkg?.rowCount || 0,
        memoriesRecalled: retrievalResults.memory?.memories?.length || 0,
        totalContextLength: fullContext.length
      };

      const sources = {
        chunks: (fused.chunks || []).map(c => ({
          text: c.text ? (c.text.substring(0, 300) + (c.text.length > 300 ? '...' : '')) : '',
          documentName: c.documentName || 'Unknown Document',
          similarity: c.similarity?.toFixed?.(3) || '0.000',
          chunkIndex: c.chunkIndex,
          source: c.source
        })),
        graphEntities: (fused.entities || []).map(e => ({
          label: e.label,
          type: e.type || 'Concept',
          description: e.description || '',
          source: e.source,
          boosted: e.boosted || false
        })),
        relations: (fused.relations || []).slice(0, 15).map(r => ({
          source: r.source,
          predicate: r.predicate || r.type,
          target: r.target
        }))
      };

      if (retrievalResults.vkg?.sql) {
        sources.vkg = {
          sql: retrievalResults.vkg.sql,
          databases: retrievalResults.vkg.databases || [],
          rowCount: retrievalResults.vkg.rowCount || 0
        };
      }

      return {
        answer,
        sources,
        metadata,
        context_graph: retrievalResults.vkg?.contextGraph || null,
        reasoning_trace: retrievalResults.vkg?.reasoningTrace || null
      };
    } catch (error) {
      console.error('Unified pipeline error:', error);
      console.log('   ⚠️ Falling back to single-mode query...');
      return this._fallbackSingleMode(question, options);
    } finally {
      this._activeBedrockToken = null;
    }
  }

  /**
   * Query planner: decides which sources to consult based on the query,
   * memory context, and available data sources.
   */
  async _planQuery(question, context = {}) {
        const {
          memoryContext = null,
          hasFolders = false,
          hasOntologies = false,
          hasVkgDbs = false,
          ontologyNames = [],
          vkgDatabaseNames = [],
          agentOntologies = [],
          tenant_id = 'default',
          workspace_id = 'default',
          history = []
        } = context;

        // Build a compact schema summary for the planner — scoped to agent's ontologies
        let schemaSummary = '';
        try {
          schemaSummary = await this._getCompactSchemaSummary(tenant_id, workspace_id, agentOntologies);
        } catch { /* schema unavailable */ }

        // Extract memory-derived hints
        let memoryHints = '';
        if (memoryContext) {
          memoryHints = memoryContext.substring(0, 800);
        }

        // Build available sources list based on agent's data source manifest
        // GraphDB is NOT a query source — it provides ontology schema to guide Neo4j and VKG queries.
        const availableSources = [];
        if (hasFolders) {
          availableSources.push('- "vector": Semantic search over document chunks (best for: finding specific passages, factual lookups in documents)');
        }
        if (hasFolders || hasOntologies) {
          const ontologyNote = hasOntologies
            ? ` Ontology-guided using: ${ontologyNames.join(', ')}.`
            : '';
          availableSources.push(`- "graph": Neo4j knowledge graph traversal (best for: entity relationships, "how are X and Y connected", multi-hop reasoning, listing entities by type).${ontologyNote}`);
        }
        if (hasVkgDbs) {
          const dbList = vkgDatabaseNames.join(', ');
          availableSources.push(`- "vkg": Federated SQL databases via Trino (databases: ${dbList}). Best for: structured data queries, aggregations, counts, rankings, numbers, listing records, "top N", "how many", filtering. ALWAYS use VKG when the question asks for data that lives in databases.`);
        }
        availableSources.push('- "memory": Agent long-term memory from past conversations (best for: user preferences, past decisions, prior context)');

        // Build example that matches the agent's actual sources
        const exampleSources = [];
        if (hasFolders) exampleSources.push('vector');
        if (hasVkgDbs) exampleSources.push('vkg');
        else if (hasFolders || hasOntologies) exampleSources.push('graph');
        if (exampleSources.length === 0) exampleSources.push('memory');
        const exampleSourcesStr = JSON.stringify(exampleSources);

        // Build conversation history context for the planner
        let historyContext = '';
        if (history.length > 0) {
          const recentHistory = history.slice(-4).map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`).join('\n');
          historyContext = `RECENT CONVERSATION:\n${recentHistory}\n`;
        }

        const plannerPrompt = `You are a query routing planner for a knowledge system. Based on the user's question and available data sources, decide which sources to query.

    AVAILABLE SOURCES:
    ${availableSources.join('\n')}

    ${schemaSummary ? `SCHEMA SUMMARY:\n${schemaSummary}\n` : ''}
    ${memoryHints ? `AGENT MEMORY:\n${memoryHints}\n` : ''}
    ${historyContext}
    IMPORTANT ROUTING RULES:
    - If the agent has VKG databases and the question asks for data listings, rankings, counts, aggregations, or structured records, ALWAYS include "vkg" in sources.
    - "graph" is for entity relationships already extracted into Neo4j. "vkg" is for querying live database tables.
    - When in doubt between "graph" and "vkg", prefer "vkg" if databases are configured.
    - If the question is a follow-up (references "this", "that", "their", etc.), use the RECENT CONVERSATION to resolve what the user is referring to. Include the resolved entity names in the rewritten query.

    Given the user's question, decide:
    1. Which sources to query (1-3, always include "memory" if memory context exists)
    2. A rewritten query incorporating conversation context and memory (CRITICAL: resolve pronouns and references from the conversation history into specific entity names/IDs)
    3. Key entity names/terms to search for

    Return JSON only:
    {
      "sources": ${exampleSourcesStr},
      "rewrittenQuery": "the query, possibly enriched with memory context",
      "entityHints": ["Entity1", "Term2"],
      "reasoning": "brief explanation"
    }

    USER QUESTION: ${question}`;

        try {
          const result = await this._llmChat([
            { role: 'user', content: plannerPrompt }
          ], { temperature: 0.1, maxTokens: 300 });

          const jsonMatch = result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            let sources = Array.isArray(parsed.sources) ? parsed.sources : ['vector', 'graph'];
            if (memoryContext && !sources.includes('memory')) sources.push('memory');
            // Filter out sources the agent doesn't have access to
            if (!hasVkgDbs) sources = sources.filter(s => s !== 'vkg');
            if (!hasFolders) sources = sources.filter(s => s !== 'vector');
            if (!hasFolders && !hasOntologies) sources = sources.filter(s => s !== 'graph');
            // Remove legacy "graphdb" source — GraphDB is schema-only, not a query target
            sources = sources.filter(s => s !== 'graphdb');
            // If no real sources left, ensure at least memory
            if (sources.filter(s => s !== 'memory').length === 0) {
              if (hasFolders) sources.unshift('vector');
              else sources.unshift('memory');
            }

            return {
              sources,
              rewrittenQuery: parsed.rewrittenQuery || question,
              entityHints: parsed.entityHints || this.extractKeyTermsFallback(question),
              reasoning: parsed.reasoning || ''
            };
          }
        } catch (e) {
          console.warn('   ⚠️ Planner LLM failed, using defaults:', e.message);
        }

        // Fallback: use all available non-memory sources
        const fallbackSources = [];
        if (hasFolders) fallbackSources.push('vector');
        if (hasFolders || hasOntologies) fallbackSources.push('graph');
        if (hasVkgDbs) fallbackSources.push('vkg');
        if (memoryContext) fallbackSources.push('memory');
        if (fallbackSources.length === 0) fallbackSources.push('memory');

        return {
          sources: fallbackSources,
          rewrittenQuery: question,
          entityHints: this.extractKeyTermsFallback(question),
          reasoning: 'Fallback: planner unavailable, using all available sources'
        };
      }

  /**
   * Build a compact schema summary for the planner (cached 5 min).
   */
  async _getCompactSchemaSummary(tenantId, workspaceId, agentOntologies = []) {
      // Cache key includes ontology IDs so different agents get different summaries
      const ontIds = agentOntologies.map(o => o.id || o.name || '').sort().join(',');
      const cacheKey = `${tenantId}:${workspaceId}:${ontIds}`;
      if (this._compactSchemaCache && this._compactSchemaCacheKey === cacheKey && Date.now() - this._compactSchemaCacheTime < 300000) {
        return this._compactSchemaCache;
      }

      const parts = [];

      try {
        await driver.verifyConnectivity();
        const schema = await neo4jService.getSchema();
        if (schema.nodeLabels.length > 0) {
          const labels = schema.nodeLabels.slice(0, 15).map(n => `${n.label}(${n.count})`).join(', ');
          parts.push(`Neo4j entities: ${labels}`);
          const patterns = schema.patterns.slice(0, 10).map(p => `(${p.from})-[:${p.relationship}]->(${p.to})`).join(', ');
          if (patterns) parts.push(`Patterns: ${patterns}`);
        }
      } catch { /* Neo4j unavailable */ }

      try {
        const graphDBStore = require('./graphDBStore');

        // If agent has specific ontologies, scope the SPARQL to those ontology graphs only
        if (agentOntologies.length > 0) {
          const specificGraphs = [];
          for (const ont of agentOntologies) {
            // Try to resolve the ontology's graph IRI
            const ontId = ont.id || ont.name;
            if (ont.graphIRI) {
              specificGraphs.push(ont.graphIRI);
            } else {
              // Build possible graph IRIs for this ontology
              specificGraphs.push(`http://example.org/graphs/global/ontology/${ontId}`);
              specificGraphs.push(`http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontId}`);
            }
          }

          // Use FROM clauses to scope to agent's ontologies only
          const fromClauses = specificGraphs.map(g => `FROM <${g}>`).join('\n');
          const classesQuery = `
            PREFIX owl: <http://www.w3.org/2002/07/owl#>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            SELECT DISTINCT ?label
            ${fromClauses}
            WHERE { ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label } }
            LIMIT 20`;
          const res = await graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'schema');
          const classLabels = (res?.results?.bindings || [])
            .map(b => b.label?.value)
            .filter(Boolean)
            .slice(0, 15);
          if (classLabels.length > 0) {
            parts.push(`Ontology classes (agent-scoped): ${classLabels.join(', ')}`);
          }
        } else {
          // No specific ontologies — fetch workspace-level schema
          const classesQuery = `
            PREFIX owl: <http://www.w3.org/2002/07/owl#>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            SELECT DISTINCT ?label WHERE {
              ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label }
            } LIMIT 20`;
          const res = await graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'schema');
          const classLabels = (res?.results?.bindings || [])
            .map(b => b.label?.value)
            .filter(Boolean)
            .slice(0, 15);
          if (classLabels.length > 0) {
            parts.push(`Ontology classes: ${classLabels.join(', ')}`);
          }
        }
      } catch { /* GraphDB unavailable */ }

      const summary = parts.join('\n');
      this._compactSchemaCache = summary;
      this._compactSchemaCacheKey = cacheKey;
      this._compactSchemaCacheTime = Date.now();
      return summary;
    }

  /**
   * Run retrieval from multiple sources in parallel based on the plan.
   */
  async _parallelRetrieve(query, plan, options = {}) {
      const {
        topK = 8, graphDepth = 2, tenant_id, workspace_id,
        scopedDocumentIds, agentVkgDbs = [], history = [],
        entityHints = [], memoryContext = null, agentId = null,
        userId = 'default', agentOntologies = []
      } = options;

      const results = {};
      const promises = [];

      if (plan.sources.includes('vector')) {
        promises.push(
          (async () => {
            try {
              console.log('   📊 Retrieving: vector search...');
              const searchFilters = { tenant_id, workspace_id };
              if (scopedDocumentIds) searchFilters.documentIds = scopedDocumentIds;
              let chunks = await vectorStoreService.semanticSearch(query, topK, searchFilters);
              chunks = await this.enrichChunksWithDocNames(chunks);
              results.vector = { chunks };
              console.log(`   📊 Vector: ${chunks.length} chunks`);
            } catch (e) {
              console.warn('   ⚠️ Vector retrieval failed:', e.message);
              results.vector = { chunks: [] };
            }
          })()
        );
      }

      if (plan.sources.includes('graph')) {
        promises.push(
          (async () => {
            try {
              console.log('   🔗 Retrieving: ontology-guided Neo4j graph query...');
              // Step 1: Fetch ontology schema from GraphDB (if available) to guide the query
              let ontologySchema = null;
              try {
                ontologySchema = await this.getGraphDBSchema(tenant_id, workspace_id, agentOntologies);
                if (ontologySchema.classes.length > 0) {
                  console.log(`   🔗 Ontology loaded: ${ontologySchema.classes.length} classes, ${ontologySchema.properties.length} properties`);
                }
              } catch (e) {
                console.log('   🔗 No ontology available, using keyword-based graph search');
              }

              // Step 2: If ontology is available, generate a Cypher query guided by the schema
              if (ontologySchema && ontologySchema.classes.length > 0) {
                const ontologyResult = await this._ontologyGuidedGraphQuery(query, ontologySchema, entityHints, {
                  workspace_id, graphDepth, history
                });
                results.graph = ontologyResult;
                console.log(`   🔗 Graph (ontology-guided): ${ontologyResult.concepts.length} concepts, ${ontologyResult.relations.length} relations`);
              } else {
                // Fallback: keyword-based graph traversal (no ontology)
                const searchTerms = entityHints.length > 0 ? entityHints : this.extractKeyTermsFallback(query);
                const graphContext = await this.getGraphContext(searchTerms, graphDepth, { workspace_id });
                results.graph = graphContext;
                console.log(`   🔗 Graph (keyword): ${graphContext.concepts.length} concepts, ${graphContext.relations.length} relations`);
              }
            } catch (e) {
              console.warn('   ⚠️ Graph retrieval failed:', e.message);
              results.graph = { concepts: [], relatedChunks: [], relations: [] };
            }
          })()
        );
      }

      if (plan.sources.includes('vkg') && agentVkgDbs.length > 0) {
        promises.push(
          (async () => {
            try {
              console.log('   🌐 Retrieving: VKG ontology-guided federated query...');
              const vkgQueryService = require('./vkgQueryService');
              const vkgResult = await vkgQueryService.query(query, tenant_id, workspace_id, {
                databases: agentVkgDbs
              });
              results.vkg = {
                answer: vkgResult.answer,
                sql: vkgResult.citations?.sql,
                databases: vkgResult.citations?.databases || [],
                rowCount: vkgResult.execution_stats?.rows_returned || 0,
                contextGraph: vkgResult.context_graph,
                reasoningTrace: vkgResult.reasoning_trace
              };
              console.log(`   🌐 VKG: ${results.vkg.rowCount} rows`);
            } catch (e) {
              console.warn('   ⚠️ VKG retrieval failed:', e.message);
              results.vkg = { answer: '', sql: null, databases: [], rowCount: 0 };
            }
          })()
        );
      }

      if (plan.sources.includes('memory') && agentId) {
        promises.push(
          (async () => {
            try {
              console.log('   🧠 Retrieving: memory recall...');
              const memoryService = require('./memoryService');
              const memories = await memoryService.searchMemories(agentId, userId, query, 5);
              results.memory = { memories };
              console.log(`   🧠 Memory: ${memories.length} recalled`);
            } catch (e) {
              console.warn('   ⚠️ Memory retrieval failed:', e.message);
              results.memory = { memories: [] };
            }
          })()
        );
      }

      await Promise.all(promises);
      return results;
    }

  /**
   * Fuse results from multiple retrieval sources into a single ranked context.
   * Handles deduplication, cross-source entity boosting, and token budget allocation.
   */
  _fuseContext(retrievalResults, plan, options = {}) {
      const { memoryContext = null, maxTokenBudget = 6000 } = options;
      const sourcesUsed = [];

      // ── Collect all chunks ──
      const chunkMap = new Map();

      if (retrievalResults.vector?.chunks?.length > 0) {
        sourcesUsed.push('vector');
        for (const chunk of retrievalResults.vector.chunks) {
          const key = chunk.chunkId || `${chunk.documentId}_${chunk.chunkIndex}`;
          chunkMap.set(key, {
            ...chunk,
            source: 'vector',
            relevanceScore: chunk.similarity || 0.5
          });
        }
      }

      if (retrievalResults.graph?.relatedChunks?.length > 0) {
        for (const item of retrievalResults.graph.relatedChunks) {
          const chunk = item.chunk;
          const key = chunk.chunk_id || chunk.uri;
          if (chunkMap.has(key)) {
            const existing = chunkMap.get(key);
            existing.relevanceScore = Math.min(existing.relevanceScore + 0.15, 1.0);
            existing.source = 'both';
          } else {
            chunkMap.set(key, {
              chunkId: chunk.chunk_id,
              text: chunk.text,
              documentName: item.docTitle,
              source: 'graph',
              relevanceScore: 0.6
            });
          }
        }
      }

      // ── Collect all entities (from Neo4j graph, ontology-guided) ──
      const entityMap = new Map();

      if (retrievalResults.graph?.concepts?.length > 0) {
        sourcesUsed.push('graph');
        for (const item of retrievalResults.graph.concepts) {
          const c = item.concept;
          if (!c?.label) continue;
          const key = c.label.toLowerCase();
          entityMap.set(key, {
            label: c.label,
            type: c.type || 'Concept',
            description: c.description || '',
            source: 'graph',
            relations: item.relations || [],
            score: item.score || 0.5,
            boosted: false
          });
        }
      }

      // Memory entity cross-linking
      if (retrievalResults.memory?.memories?.length > 0) {
        sourcesUsed.push('memory');
        for (const mem of retrievalResults.memory.memories) {
          const memContent = (mem.content || '').toLowerCase();
          for (const [key, entity] of entityMap) {
            if (memContent.includes(key) || memContent.includes(entity.label?.toLowerCase())) {
              entity.score = Math.min((entity.score || 0.5) + 0.15, 1.0);
              entity.boosted = true;
            }
          }
        }
      }

      if (retrievalResults.vkg?.rowCount > 0) {
        sourcesUsed.push('vkg');
      }

      // ── Collect all relations (from Neo4j graph) ──
      const relationMap = new Map();
      for (const rel of (retrievalResults.graph?.relations || [])) {
        const key = `${rel.source}|${rel.predicate || rel.type}|${rel.target}`;
        if (!relationMap.has(key)) relationMap.set(key, rel);
      }

      // ── Rank and budget ──
      const chunks = Array.from(chunkMap.values())
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, this.maxContextChunks);

      const entities = Array.from(entityMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxGraphNodes);

      const relations = Array.from(relationMap.values()).slice(0, 20);

      return {
        chunks, entities, relations, sourcesUsed,
        // Pass through raw graph results for the answer LLM (full node properties)
        graphRawResults: retrievalResults.graph?.rawResults || [],
        graphCypher: retrievalResults.graph?.cypher || ''
      };
    }

  /**
   * Build a unified context string from fused results for the final LLM call.
   */
  _buildUnifiedContextString(fused, plan) {
    let context = '';

    if (fused.chunks.length > 0) {
      context += '=== DOCUMENT EXCERPTS ===\n\n';
      for (const chunk of fused.chunks) {
        const sourceTag = chunk.source === 'both' ? '📊+🔗' : (chunk.source === 'vector' ? '📊' : '🔗');
        const header = `--- ${chunk.documentName || 'Document'} ${sourceTag} ---\n`;
        const text = (chunk.text || '').substring(0, 500);
        context += header + text + '\n\n';
      }
    }

    // If we have raw graph query results (full node properties), use those
    // instead of the lossy entity summaries — this gives the answer LLM
    // the complete data just like the main chat's graph-only mode.
    if (fused.graphRawResults?.length > 0) {
      context += '\n=== NEO4J QUERY RESULTS ===\n\n';
      if (fused.graphCypher) context += `Cypher: ${fused.graphCypher}\n\n`;
      const resultsJson = JSON.stringify(fused.graphRawResults.slice(0, 30), null, 2);
      // Budget: cap at ~3000 chars to leave room for other context
      context += resultsJson.substring(0, 3000);
      if (resultsJson.length > 3000) context += '\n... (truncated)';
      context += '\n\n';
    } else if (fused.entities.length > 0) {
      context += '\n=== KNOWLEDGE GRAPH ===\n\n';
      const byType = {};
      for (const e of fused.entities) {
        const type = e.type || 'Concept';
        if (!byType[type]) byType[type] = [];
        byType[type].push(e);
      }
      for (const [type, entities] of Object.entries(byType)) {
        context += `[${type}s]\n`;
        for (const e of entities) {
          const boost = e.boosted ? ' ⭐' : '';
          context += `• ${e.label}${boost}`;
          if (e.description) context += `: ${e.description}`;
          context += ` (from: ${e.source})\n`;
          if (e.relations) {
            for (const rel of e.relations.slice(0, 3)) {
              if (rel.concept) {
                context += `  → ${rel.predicate || rel.type || 'relates to'}: ${rel.concept}\n`;
              }
            }
          }
        }
        context += '\n';
      }
    }

    if (fused.relations.length > 0) {
      context += '\n=== KEY RELATIONSHIPS ===\n';
      const seen = new Set();
      for (const rel of fused.relations.slice(0, 12)) {
        if (rel.source && rel.target) {
          const str = `${rel.source} --[${rel.predicate || rel.type}]--> ${rel.target}`;
          if (!seen.has(str)) {
            seen.add(str);
            context += `• ${str}\n`;
          }
        }
      }
    }

    return context;
  }

  /**
   * Fallback to the original single-mode query path if the unified pipeline fails.
   */
  async _fallbackSingleMode(question, options = {}) {
    const agent = options.agent || {};
    const searchMode = agent.search_mode || 'hybrid';
    const queryOptions = {
      searchMode,
      topK: agent.settings?.topK || 8,
      graphDepth: agent.settings?.graphDepth || 2,
      tenant_id: options.tenant_id || 'default',
      workspace_id: options.workspace_id || 'default',
      history: options.history || [],
      documentIds: options.scopedDocumentIds
    };

    let prefix = '';
    if (agent.perspective) prefix += `[Agent Perspective: ${agent.perspective}]\n\n`;
    if (options.memoryContext) prefix += options.memoryContext + '\n\n';

    return this.query(prefix + question, queryOptions);
  }

  /**
   * Extract structured sources from graph query results (SPARQL or Cypher).
   * Parses result rows into graphEntities, relations, and source documents.
   * @param {Array} results - Raw result bindings/rows
   * @param {Object} opts - { mode: 'sparql'|'cypher', query: string }
   * @returns {{ graphEntities: Array, relations: Array, documents: Array }}
   */
  async extractGraphSources(results, opts = {}) {
    const { mode = 'sparql' } = opts;
    const entities = [];
    const relations = [];
    const docUriSet = new Set();
    const seenEntities = new Set();

    const localName = (iri) => {
      if (!iri || typeof iri !== 'string') return iri;
      const parts = iri.split(/[#/]/);
      return parts[parts.length - 1] || iri;
    };

    if (mode === 'sparql') {
      // SPARQL bindings: each binding is { varName: { value, type } }
      for (const binding of (results || [])) {
        const keys = Object.keys(binding);
        const row = {};
        for (const k of keys) row[k] = binding[k]?.value;

        // Collect entity-like rows (has a type or label column)
        const label = row.label || row.name || row.entityLabel || row.entity || null;
        const type = row.type || row.class || row.entityType || null;
        if (label && !seenEntities.has(label)) {
          seenEntities.add(label);
          // Build description from remaining columns
          const descParts = [];
          for (const [k, v] of Object.entries(row)) {
            if (['label','name','entityLabel','entity','type','class','entityType'].includes(k)) continue;
            if (v && !v.startsWith('http://') && !v.startsWith('urn:')) descParts.push(`${k}: ${v}`);
          }
          entities.push({
            label: localName(label),
            type: type ? localName(type) : 'Entity',
            description: descParts.join(', ').substring(0, 300),
            relationships: 0
          });
        }

        // Collect relation-like rows (has source/predicate/target or from/rel/to)
        const relSrc = row.source || row.from || row.subject || row.s;
        const relPred = row.predicate || row.rel || row.relationship || row.p;
        const relTgt = row.target || row.to || row.object || row.o;
        if (relSrc && relPred && relTgt) {
          relations.push({
            source: localName(relSrc),
            predicate: localName(relPred),
            target: localName(relTgt)
          });
        }

        // Collect source document URIs from any value that looks like a doc URI
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && v.startsWith('doc://')) {
            docUriSet.add(v.split('/entity/')[0].split('#')[0]);
          }
        }
      }

      // If no entities extracted from column names, treat each result row as an entity
      if (entities.length === 0 && results?.length > 0) {
        for (const binding of results.slice(0, 20)) {
          const keys = Object.keys(binding);
          const row = {};
          for (const k of keys) row[k] = binding[k]?.value;
          const firstVal = row[keys[0]];
          if (!firstVal) continue;
          const lbl = localName(firstVal);
          if (seenEntities.has(lbl)) continue;
          seenEntities.add(lbl);
          const descParts = [];
          for (const [k, v] of Object.entries(row)) {
            if (k === keys[0]) continue;
            if (v && !v.startsWith('http://') && !v.startsWith('urn:')) descParts.push(`${k}: ${v}`);
          }
          entities.push({
            label: lbl,
            type: 'Result',
            description: descParts.join(', ').substring(0, 300),
            relationships: 0
          });
        }
      }
    } else {
      // Cypher results: each row is a plain object
      for (const row of (results || [])) {
        const keys = Object.keys(row);
        const label = row.name || row.label || row.title || (keys.length > 0 ? row[keys[0]] : null);
        if (label && typeof label === 'string' && !seenEntities.has(label)) {
          seenEntities.add(label);
          const descParts = [];
          for (const [k, v] of Object.entries(row)) {
            if (['name','label','title'].includes(k)) continue;
            if (v != null && typeof v !== 'object') descParts.push(`${k}: ${v}`);
          }
          entities.push({
            label: String(label),
            type: row.type || row.labels?.[0] || 'Entity',
            description: descParts.join(', ').substring(0, 300),
            relationships: 0
          });
        }

        // Collect doc URIs from Cypher results
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && (v.startsWith('doc://') || v.startsWith('file://'))) {
            docUriSet.add(v.split('/entity/')[0].split('#')[0]);
          }
        }
      }
    }

    // If no doc URIs found in results, try a provenance lookup for SPARQL
    if (docUriSet.size === 0 && mode === 'sparql' && results?.length > 0) {
      try {
        const graphDBStore = require('./graphDBStore');
        const subjects = [];
        for (const binding of results.slice(0, 15)) {
          const firstKey = Object.keys(binding)[0];
          const val = binding[firstKey]?.value;
          if (val && val.startsWith('http')) subjects.push(val);
        }
        if (subjects.length > 0) {
          const valuesClause = subjects.map(s => `<${s}>`).join(' ');
          const provQuery = `SELECT DISTINCT ?doc WHERE { VALUES ?s { ${valuesClause} } ?s <http://purplefabric.ai/ontology#sourceDocument> ?doc . }`;
          const tenantId = opts.tenantId || 'default';
          const workspaceId = opts.workspaceId || 'default';
          const provRes = await graphDBStore.executeSPARQL(tenantId, workspaceId, provQuery, 'data');
          for (const b of (provRes?.results?.bindings || [])) {
            if (b.doc?.value) docUriSet.add(b.doc.value);
          }
        }
      } catch (e) {
        console.warn('Provenance lookup failed:', e.message);
      }
    }

    // Resolve doc URIs to metadata from Redis
    const documents = [];
    if (docUriSet.size > 0) {
      const redisService = require('./redisService');
      for (const uri of docUriSet) {
        try {
          // Extract docId from URI: doc://abc123 → abc123
          const docId = uri.replace(/^doc:\/\//, '').replace(/^file:\/\//, '');
          const docJson = await redisService.get(`doc:${docId}`);
          if (docJson) {
            const meta = JSON.parse(docJson);
            documents.push({
              title: meta.title || docId,
              docId: meta.doc_id || docId,
              docType: meta.doc_type || 'unknown',
              entityCount: meta.entity_count || 0,
              uri
            });
          }
        } catch (e) { /* skip */ }
      }
    }

    return {
      graphEntities: entities.slice(0, 20),
      relations: relations.slice(0, 15),
      documents: documents
    };
  }

  /**
   * Main query function - routes to appropriate search mode
   * @param {string} question - User's question
   * @param {object} options - Query options including searchMode
   */
  async query(question, options = {}) {
    const searchMode = options.searchMode || 'hybrid';
    
    // Store per-user bedrockToken so all LLM calls in this query can use it
    if (options.bedrockToken) {
      this._activeBedrockToken = options.bedrockToken;
    } else {
      this._activeBedrockToken = null;
    }

    try {
      let result;
      switch (searchMode) {
        case 'rag':
          result = await this.queryRAGOnly(question, options);
          break;
        case 'graph':
          result = await this.queryGraphOnly(question, options);
          break;
        case 'neo4j':
          result = await this.queryNeo4jDirect(question, options);
          break;
        case 'graphdb':
          result = await this.queryGraphDBDirect(question, options);
          break;
        case 'compare':
          result = await this.queryCompare(question, options);
          break;
        case 'hybrid':
        default:
          result = await this.queryHybrid(question, options);
          break;
      }

      // Phase 7: Enrich materialized path responses with context graph
      if (result && searchMode !== 'compare') {
        try {
          const contextGraphBuilder = require('./contextGraphBuilder');
          if (result.metadata?.sparql && result.sources?.graphEntities) {
            // GraphDB/SPARQL results — build context graph from bindings
            const bindings = result.metadata.results || [];
            const variables = bindings.length > 0 ? Object.keys(bindings[0]) : [];
            result.context_graph = contextGraphBuilder.buildFromSPARQLBindings(bindings, variables);
            result.reasoning_trace = contextGraphBuilder.buildReasoningTrace(result.context_graph, question, {
              databases: ['graphdb']
            });
          } else if (result.sources?.graphEntities?.length > 0) {
            // Neo4j/Cypher or hybrid results — build from extracted entities
            const nodes = result.sources.graphEntities.map((e, i) => ({
              id: `mat_${i}_${e.label}`,
              type: e.type || 'Entity',
              label: e.label,
              value: e.label,
              source: 'materialized',
              properties: { description: e.description }
            }));
            const edges = result.sources.relations?.map(r => ({
              source: nodes.find(n => n.label === r.source)?.id,
              target: nodes.find(n => n.label === r.target)?.id,
              relation: r.predicate
            })).filter(e => e.source && e.target) || [];
            const cardinality = {};
            nodes.forEach(n => { cardinality[n.type] = (cardinality[n.type] || 0) + 1; });
            result.context_graph = {
              nodes, edges,
              statistics: { nodeCount: nodes.length, edgeCount: edges.length, cardinality },
              provenance: { queryMode: 'materialized' }
            };
            result.reasoning_trace = contextGraphBuilder.buildReasoningTrace(result.context_graph, question, {
              databases: [searchMode === 'graphdb' ? 'graphdb' : 'neo4j']
            });
          }
        } catch (e) {
          console.warn('Context graph enrichment failed (non-fatal):', e.message);
        }
      }

      return result;
    } finally {
      this._activeBedrockToken = null;
    }
  }

  /**
   * Wrapper for llmService.chat that injects per-user bedrockToken
   */
  _llmChat(messages, options = {}) {
    if (this._activeBedrockToken) {
      options.bedrockToken = this._activeBedrockToken;
    }
    return llmService.chat(messages, options);
  }

  /**
   * Compare Mode - Run RAG and GraphDB queries in parallel, return both results
   */
  async queryCompare(question, options = {}) {
    console.log('\n' + '='.repeat(60));
    console.log(`⚖️ COMPARE MODE: "${question}"`);
    console.log('='.repeat(60));

    // Run sequentially to avoid LLM contention (local LLMs can't handle parallel requests well)
    let rag, graph;
    try {
      rag = await this.queryRAGOnly(question, { ...options, pureRAG: true });
    } catch (e) {
      rag = { answer: `RAG error: ${e.message}`, sources: {}, metadata: {} };
    }
    try {
      graph = await this.queryGraphOnly(question, options);
    } catch (e) {
      graph = { answer: `Graph error: ${e.message}`, sources: {}, metadata: {} };
    }

    return {
      answer: '__COMPARE__',
      compare: {
        rag: { answer: rag.answer, sources: rag.sources, metadata: rag.metadata },
        graphdb: { answer: graph.answer, sources: graph.sources, metadata: graph.metadata }
      },
      sources: {},
      metadata: { searchMode: 'compare' }
    };
  }

  /**
   * GraphDB Direct - Generate SPARQL and query GraphDB directly (for RDF/ontology data)
   */
  async queryGraphDBDirect(question, options = {}) {
    console.log('\n' + '='.repeat(60));
    console.log(`🔷 GRAPHDB DIRECT QUERY: "${question}"`);
    console.log('='.repeat(60));

    const graphDBStore = require('./graphDBStore');
    const tenantId = options.tenant_id || 'default';
    const workspaceId = options.workspace_id || 'default';

    try {
      // Use schema from options if provided (from UI selection), otherwise fetch from GraphDB
      let ontologyInfo;
      if (options.schema?.classes?.length > 0) {
        console.log(`📊 Using UI-provided schema: ${options.schema.classes.length} classes`);
        ontologyInfo = {
          classes: options.schema.classes,
          properties: options.schema.properties || []
        };
      } else {
        console.log('📊 No UI schema provided, fetching from GraphDB. options.schema:', JSON.stringify(options.schema));
        ontologyInfo = await this.getGraphDBSchema(tenantId, workspaceId);
      }
      
      // Also discover entity types from data graph (text document entities)
      if (ontologyInfo.classes.length === 0 || !options.schema) {
        try {
          const dataEntities = await this.discoverDataGraphEntities(tenantId, workspaceId);
          if (dataEntities.classes.length > 0) {
            console.log(`📊 Discovered ${dataEntities.classes.length} entity types from data graph`);
            // Merge, avoiding duplicates
            const existingIris = new Set(ontologyInfo.classes.map(c => c.iri));
            for (const cls of dataEntities.classes) {
              if (!existingIris.has(cls.iri)) ontologyInfo.classes.push(cls);
            }
            const existingPropIris = new Set(ontologyInfo.properties.map(p => p.iri));
            for (const prop of dataEntities.properties) {
              if (!existingPropIris.has(prop.iri)) ontologyInfo.properties.push(prop);
            }
          }
        } catch (e) {
          console.warn('Could not discover data graph entities:', e.message);
        }
      }
      
      // Generate SPARQL from natural language
      ontologyInfo._tenantId = tenantId;
      ontologyInfo._workspaceId = workspaceId;
      const sparql = await this.generateSPARQL(question, ontologyInfo);
      console.log(`Generated SPARQL:\n${sparql}`);

      if (!sparql) {
        return {
          answer: "I couldn't generate a SPARQL query for that question. Try rephrasing it.",
          sources: [],
          metadata: { searchMode: 'graphdb', error: 'sparql_generation_failed' }
        };
      }

      // Execute the query
      let results;
      try {
        const graphIRI = options.graphIRI;
        let execOptions = {};
        if (graphIRI) {
          // User selected a specific ontology in UI — only query data graph + that ontology graph
          execOptions.includeGlobalOntologies = false;
          execOptions.includeTenantOntologies = false;
          execOptions.specificGraphs = [graphIRI];
          console.log(`🎯 Scoped query: data graph + specific ontology: ${graphIRI}`);
        } else {
          console.log(`🌐 Unscoped query: data graph + all ontology graphs`);
        }
        // Always query against the data graph — that's where committed instances live
        const response = await graphDBStore.executeSPARQL(tenantId, workspaceId, sparql, 'all', execOptions);
        results = response?.results?.bindings || [];
        console.log(`Query returned ${results.length} results`);
      } catch (execError) {
        console.error('SPARQL execution error:', execError.message);
        return {
          answer: `Query failed: ${execError.message}. The generated query was:\n\`\`\`sparql\n${sparql}\n\`\`\``,
          sources: [],
          metadata: { searchMode: 'graphdb', sparql, error: execError.message }
        };
      }

      // Format results for display
      const formattedResults = results.slice(0, 50).map(binding => {
        const row = {};
        for (const [key, val] of Object.entries(binding)) {
          row[key] = val.value;
        }
        return row;
      });

      const resultsContext = results.length > 0
        ? `Query Results (${results.length} rows):\n${JSON.stringify(formattedResults, null, 2)}`
        : 'No results found.';

      // Generate natural language response
      const answer = await this._llmChat([{
        role: 'user',
        content: `Based on this SPARQL query result from a knowledge graph, answer the user's question naturally.

Question: ${question}
SPARQL Query: ${sparql}
${resultsContext}

Provide a clear, concise answer. Format lists and data nicely.`
      }], { temperature: 0.3, maxTokens: 1000 });

      // Extract structured sources from results
      const extractedSources = await this.extractGraphSources(results, {
        mode: 'sparql',
        tenantId,
        workspaceId
      });

      return {
        answer,
        sources: {
          chunks: [],
          graphEntities: extractedSources.graphEntities,
          graphChunks: [],
          relations: extractedSources.relations,
          documents: extractedSources.documents
        },
        metadata: {
          searchMode: 'graphdb',
          sparql,
          resultCount: results.length,
          results: formattedResults.slice(0, 10)
        }
      };
    } catch (error) {
      console.error('GraphDB direct query error:', error);
      return {
        answer: `Error querying GraphDB: ${error.message}`,
        sources: [],
        metadata: { searchMode: 'graphdb', error: error.message }
      };
    }
  }

  /**
   * Get GraphDB schema info for SPARQL generation
   */
  async getGraphDBSchema(tenantId, workspaceId, agentOntologies = []) {
      const graphDBStore = require('./graphDBStore');
      console.log('GraphDB store baseUrl:', graphDBStore.baseUrl, 'repo:', graphDBStore.repository);
      try {
        // Build FROM clauses scoped to agent's ontologies (if specified)
        let fromClause = '';
        if (agentOntologies.length > 0) {
          const fromParts = [];
          for (const ont of agentOntologies) {
            const ontId = ont.id || ont.name;
            if (ont.graphIRI) {
              fromParts.push(`FROM <${ont.graphIRI}>`);
            } else {
              // Try both global and workspace-scoped graph IRIs
              fromParts.push(`FROM <http://example.org/graphs/global/ontology/${ontId}>`);
              fromParts.push(`FROM <http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontId}>`);
            }
          }
          // Also include the workspace schema graph (for workspace-level ontology definitions)
          fromParts.push(`FROM <http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/schema>`);
          fromClause = fromParts.join('\n');
          console.log(`📊 Schema query scoped to ${agentOntologies.length} agent ontologies`);
        }

        // Query classes — scoped to agent ontologies if available
        const classesQuery = agentOntologies.length > 0
          ? `PREFIX owl: <http://www.w3.org/2002/07/owl#>
             PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
             SELECT DISTINCT ?class ?label
             ${fromClause}
             WHERE {
               ?class a owl:Class .
               OPTIONAL { ?class rdfs:label ?label }
             } LIMIT 50`
          : `PREFIX owl: <http://www.w3.org/2002/07/owl#>
             PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
             SELECT DISTINCT ?class ?label WHERE {
               ?class a owl:Class .
               OPTIONAL { ?class rdfs:label ?label }
             } LIMIT 50`;

        // Query properties — scoped to agent ontologies if available
        const propsQuery = agentOntologies.length > 0
          ? `PREFIX owl: <http://www.w3.org/2002/07/owl#>
             PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
             SELECT DISTINCT ?prop ?label ?type ?domain ?range
             ${fromClause}
             WHERE {
               { ?prop a owl:ObjectProperty BIND("objectProperty" as ?type) }
               UNION
               { ?prop a owl:DatatypeProperty BIND("datatypeProperty" as ?type) }
               OPTIONAL { ?prop rdfs:label ?label }
               OPTIONAL { ?prop rdfs:domain ?domain }
               OPTIONAL { ?prop rdfs:range ?range }
             } LIMIT 100`
          : `PREFIX owl: <http://www.w3.org/2002/07/owl#>
             PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
             SELECT DISTINCT ?prop ?label ?type ?domain ?range WHERE {
               { ?prop a owl:ObjectProperty BIND("objectProperty" as ?type) }
               UNION
               { ?prop a owl:DatatypeProperty BIND("datatypeProperty" as ?type) }
               OPTIONAL { ?prop rdfs:label ?label }
               OPTIONAL { ?prop rdfs:domain ?domain }
               OPTIONAL { ?prop rdfs:range ?range }
             } LIMIT 100`;

        const [classesRes, propsRes] = await Promise.all([
          graphDBStore.executeSPARQL(tenantId, workspaceId, classesQuery, 'schema'),
          graphDBStore.executeSPARQL(tenantId, workspaceId, propsQuery, 'schema')
        ]);

        console.log('Schema query raw results:', JSON.stringify(classesRes?.results?.bindings?.slice(0, 3)));

        const classes = (classesRes?.results?.bindings || []).map(b => ({
          iri: b.class?.value,
          label: b.label?.value || b.class?.value?.split('#').pop() || b.class?.value?.split('/').pop()
        }));

        const properties = (propsRes?.results?.bindings || []).map(b => ({
          iri: b.prop?.value,
          name: b.label?.value || b.prop?.value?.split('#').pop() || b.prop?.value?.split('/').pop(),
          type: b.type?.value || 'datatypeProperty',
          domain: b.domain?.value?.split('#').pop() || b.domain?.value?.split('/').pop() || 'Unknown',
          range: b.range?.value?.split('#').pop() || b.range?.value?.split('/').pop() || null
        }));

        console.log(`📊 Schema loaded: ${classes.length} classes, ${properties.length} properties`);
        if (classes.length === 0) {
          console.warn('⚠️ No classes found in schema - LLM will generate generic queries');
        }

        return { classes, properties };
      } catch (e) {
        console.error('Could not fetch GraphDB schema:', e.message, e.stack);
        return { classes: [], properties: [] };
      }
    }

  /**
   * Discover entity types and predicates from the workspace data graph
   * This finds text document entities (Person, Organization, etc.) that aren't in ontology graphs
   */
  async discoverDataGraphEntities(tenantId, workspaceId) {
    const graphDBStore = require('./graphDBStore');
    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      SELECT DISTINCT ?class ?label ?pred ?predLabel ?predType WHERE {
        {
          GRAPH <${dataGraphIRI}> {
            ?s rdf:type ?class .
            FILTER(?class != owl:Class && ?class != owl:ObjectProperty && ?class != owl:DatatypeProperty && ?class != rdf:Statement)
            OPTIONAL { ?class rdfs:label ?label }
          }
        } UNION {
          GRAPH <${dataGraphIRI}> {
            ?s ?pred ?o .
            FILTER(?pred != rdf:type && ?pred != rdfs:label && ?pred != rdfs:comment && !STRSTARTS(STR(?pred), "http://purplefabric.ai/ontology#sourceDocument") && !STRSTARTS(STR(?pred), "http://purplefabric.ai/ontology#rowIndex") && !STRSTARTS(STR(?pred), "http://purplefabric.ai/ontology#confidence"))
            OPTIONAL { ?pred rdfs:label ?predLabel }
            BIND(IF(isIRI(?o), "objectProperty", "datatypeProperty") AS ?predType)
          }
        }
      } LIMIT 200
    `;

    try {
      const res = await graphDBStore.executeSPARQL(tenantId, workspaceId, query, 'data');
      const bindings = res?.results?.bindings || [];
      
      const classMap = new Map();
      const propMap = new Map();
      
      for (const b of bindings) {
        if (b.class?.value) {
          const iri = b.class.value;
          if (!classMap.has(iri)) {
            classMap.set(iri, {
              iri,
              label: b.label?.value || iri.split(/[#/]/).pop()
            });
          }
        }
        if (b.pred?.value) {
          const iri = b.pred.value;
          if (!propMap.has(iri)) {
            propMap.set(iri, {
              iri,
              name: b.predLabel?.value || iri.split(/[#/]/).pop(),
              type: b.predType?.value || 'datatypeProperty',
              domain: 'Unknown'
            });
          }
        }
      }
      
      return {
        classes: Array.from(classMap.values()),
        properties: Array.from(propMap.values())
      };
    } catch (e) {
      console.warn('Data graph discovery failed:', e.message);
      return { classes: [], properties: [] };
    }
  }

  /**
   * Generate SPARQL query from natural language
   */
  async generateSPARQL(question, schemaInfo = {}) {
    // Build class info with IRIs if available
    const classes = schemaInfo.classes?.slice(0, 30) || [];
    const classInfo = classes.map(c => {
      if (typeof c === 'string') return c;
      return c.iri ? `${c.label || c.iri.split(/[#/]/).pop()} (<${c.iri}>)` : c.label || c.name;
    }).join(', ') || 'Unknown';
    
    // Separate data properties (literals) from object properties (links to entities)
    const allProps = schemaInfo.properties || [];
    const objProps = allProps.filter(p => p.type === 'objectProperty');
    const dataProps = allProps.filter(p => p.type !== 'objectProperty');
    
    const buildGroupedProps = (props) => {
      const grouped = {};
      for (const p of props.slice(0, 80)) {
        const name = typeof p === 'string' ? p : (p.name || p.label);
        const iri = typeof p === 'string' ? '' : p.iri;
        const domain = typeof p === 'string' ? 'Unknown' : (p.domain || 'Unknown');
        if (!grouped[domain]) grouped[domain] = [];
        grouped[domain].push(iri ? `${name} (<${iri}>)` : name);
      }
      return Object.entries(grouped).map(([d, ps]) => `  ${d}: ${ps.join(', ')}`).join('\n');
    };
    
    const dataPropStr = dataProps.length > 0 ? '\n' + buildGroupedProps(dataProps) : 'None';
    const objPropStr = objProps.length > 0 ? '\n' + buildGroupedProps(objProps) : 'None';

    // Fetch sample data values to help LLM write accurate filters
    let sampleDataStr = '';
    try {
      const graphDBStore = require('./graphDBStore');
      const sampleQuery = `
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?type ?label ?prop ?val WHERE {
          ?s rdf:type ?type . ?s rdfs:label ?label .
          OPTIONAL { ?s ?prop ?val . FILTER(?prop != rdf:type && ?prop != rdfs:label) }
        } LIMIT 30`;
      const sampleRes = await graphDBStore.executeSPARQL(
        schemaInfo._tenantId || 'default',
        schemaInfo._workspaceId || 'default',
        sampleQuery, 'all'
      );
      const bindings = sampleRes?.results?.bindings || [];
      if (bindings.length > 0) {
        const samples = {};
        for (const b of bindings) {
          const type = b.type?.value?.split(/[#/]/).pop();
          if (!samples[type]) samples[type] = { label: b.label?.value, props: {} };
          if (b.prop?.value && b.val?.value) {
            const pName = b.prop.value.split(/[#/]/).pop();
            samples[type].props[pName] = b.val.value;
          }
        }
        sampleDataStr = '\n\nSample data (showing actual values in the graph):\n' +
          Object.entries(samples).slice(0, 5).map(([type, s]) =>
            `  ${type}: "${s.label}" — ${Object.entries(s.props).slice(0, 5).map(([k,v]) => `${k}="${v}"`).join(', ')}`
          ).join('\n');
      }
    } catch (e) {
      // Sample fetch is best-effort
    }
    
    const systemPrompt = `You are a SPARQL expert. Generate precise SPARQL queries for a knowledge graph.

Available classes: ${classInfo}

Data properties (literals, grouped by domain class):${dataPropStr}

Object properties (links between entities, grouped by domain class):${objPropStr}${sampleDataStr}

RULES:
1. Use full URIs in angle brackets: <http://example.org#prop>
2. Use OPTIONAL for properties that may not exist on every entity
3. Object properties link to separate entities — follow the link and get rdfs:label:
   ?entity <objProp> ?linked . ?linked rdfs:label ?linkedName
4. Only use properties that belong to the queried class (check domain grouping above)
5. For text matching use REGEX with "i" flag: FILTER(REGEX(?val, "keyword", "i"))
6. For numeric comparisons: FILTER(?val > 100)
7. Return ONLY the SPARQL query, no explanation

PATTERNS FOR COMPLEX QUESTIONS:

Counting/Aggregation:
  SELECT ?type (COUNT(?entity) AS ?count) WHERE { ... } GROUP BY ?type ORDER BY DESC(?count)

Top-N / Ranking:
  SELECT ?name ?score WHERE { ... } ORDER BY DESC(?score) LIMIT 10

Multi-hop traversal (e.g., "people at companies in sector X"):
  ?person <worksAt> ?company . ?company <hasSector> ?sector . ?sector rdfs:label "X"

Existence check:
  FILTER EXISTS { ?entity <hasProp> ?val }
  FILTER NOT EXISTS { ?entity <hasProp> ?val }

Multiple conditions:
  Use UNION for OR logic, nested patterns for AND logic

SIMPLE EXAMPLE:
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?entity ?name ?score WHERE {
  ?entity rdf:type <http://example.org#Customer> .
  OPTIONAL { ?entity rdfs:label ?name }
  OPTIONAL { ?entity <http://example.org#riskScore> ?score }
} LIMIT 100

AGGREGATION EXAMPLE:
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?type (COUNT(?entity) AS ?count) WHERE {
  ?entity rdf:type ?type .
} GROUP BY ?type ORDER BY DESC(?count) LIMIT 100`;

    console.log('📝 LLM Prompt:\n', systemPrompt);
    console.log('📝 User question:', question);
    
    let sparql = await this._llmChat([{
      role: 'system',
      content: systemPrompt
    }, {
      role: 'user',
      content: `Generate a SPARQL query for: ${question}`
    }], { temperature: 0.1, maxTokens: 1200 });

    sparql = sparql.trim();
    
    // Clean up the response
    if (sparql.includes('```')) {
      sparql = sparql.replace(/```sparql?\n?/g, '').replace(/```/g, '').trim();
    }
    
    // Strip any preamble text before the actual SPARQL
    const prefixMatch = sparql.match(/(PREFIX\s|SELECT\s|ASK\s|CONSTRUCT\s|DESCRIBE\s)/i);
    if (prefixMatch && prefixMatch.index > 0) {
      sparql = sparql.substring(prefixMatch.index).trim();
    }
    
    // Remove invalid SERVICE blocks
    sparql = sparql.replace(/SERVICE\s*\{[^}]*\}/gi, '');
    
    // Fix malformed triple patterns (missing predicate - e.g., "?s ?o" instead of "?s <pred> ?o")
    sparql = sparql.replace(/\{\s*(\?\w+)\s+(\?\w+)\s*\}/g, (match, subj, obj) => {
      console.log(`⚠️ Removing malformed triple pattern: ${match}`);
      return '{ }';
    });
    // Remove empty OPTIONAL blocks
    sparql = sparql.replace(/OPTIONAL\s*\{\s*\}\s*\.?/gi, '');
    
    return sparql;
  }

  /**
   * Neo4j Direct - Generate Cypher and query Neo4j directly (for structured data like CSV)
   */
  async queryNeo4jDirect(question, options = {}) {
    console.log('\n' + '='.repeat(60));
    console.log(`🔷 NEO4J DIRECT QUERY: "${question}"`);
    console.log('='.repeat(60));

    try {
      const cypher = await this.generateCypher(question, options.workspace_id, options.documentIds);
      console.log(`Generated Cypher: ${cypher}`);

      if (!cypher) {
        return {
          answer: "I couldn't generate a query for that question. Try rephrasing it.",
          sources: [],
          metadata: { searchMode: 'neo4j', error: 'cypher_generation_failed' }
        };
      }

      let results;
      let executedCypher = cypher;
      try {
        results = await this.executeCypherQuery(cypher);
        console.log(`Query returned ${results.length} results`);
      } catch (execError) {
        console.warn(`First query failed: ${execError.message}, retrying...`);
        try {
          const schema = await neo4jService.getSchema();
          const schemaText = neo4jService.formatSchemaForLLM(schema);
          const fixedCypher = await this._llmChat([{ role: 'user', content: `This Cypher query failed with error: ${execError.message}\n\nQuery: ${cypher}\n\nSchema:\n${schemaText}\n\nFix the query. Return ONLY the corrected Cypher, no explanation.` }], { temperature: 0.1, maxTokens: 800 });
          executedCypher = fixedCypher.trim().replace(/```cypher\n?/gi, '').replace(/```\n?/g, '').trim();
          results = await this.executeCypherQuery(executedCypher);
        } catch (retryError) {
          return {
            answer: `Query failed: ${execError.message}.\n\n**Generated Cypher:**\n\`\`\`cypher\n${cypher}\n\`\`\`\n\nTry rephrasing your question.`,
            sources: [],
            metadata: { searchMode: 'neo4j', cypher, error: execError.message }
          };
        }
      }

      if (!results || results.length === 0) {
        return {
          answer: `No results found.\n\n**Cypher used:**\n\`\`\`cypher\n${executedCypher}\n\`\`\`\n\nTry different keywords or a broader question.`,
          sources: [],
          metadata: { searchMode: 'neo4j', cypher: executedCypher, resultCount: 0 }
        };
      }

      const resultsContext = `Query Results (${results.length} rows):\n${JSON.stringify(results.slice(0, 50), null, 2)}`;

      const answer = await this._llmChat([{
        role: 'user',
        content: `Based on this Neo4j query result, answer the user's question naturally.

Question: ${question}
Cypher Query: ${executedCypher}
${resultsContext}

Provide a clear, concise answer. If there are numbers, summarize them. If it's a list, format it nicely.`
      }], { temperature: 0.3, maxTokens: 1000 });

      // Extract structured sources from Cypher results
      const extractedSources = await this.extractGraphSources(results, { mode: 'cypher' });

      return {
        answer,
        sources: {
          chunks: [],
          graphEntities: extractedSources.graphEntities,
          graphChunks: [],
          relations: extractedSources.relations,
          documents: extractedSources.documents
        },
        metadata: {
          searchMode: 'neo4j',
          cypher: executedCypher,
          resultCount: results.length,
          results: results.slice(0, 10)
        }
      };
    } catch (error) {
      console.error('Neo4j direct query error:', error);
      return {
        answer: `Error querying the graph: ${error.message}`,
        sources: [],
        metadata: { searchMode: 'neo4j', error: error.message }
      };
    }
  }

  /**
   * RAG Only - Search chunks from vector DB only
   */
  async queryRAGOnly(question, options = {}) {
    const topK = options.topK || this.maxContextChunks;

    try {
      console.log('\n' + '='.repeat(60));
      console.log(`📊 RAG ONLY QUERY: "${question}"`);
      console.log('='.repeat(60));

      // Step 1: Semantic search for relevant chunks from vector store
      console.log('\n📊 Step 1: Vector Search');
      console.log('-'.repeat(40));
      // Extract filters from options
      const searchFilters = {
        tenant_id: options.tenant_id,
        workspace_id: options.workspace_id,
        doc_type: options.doc_type,
        context_type: options.context_type,
        dateRange: options.dateRange,
        documentIds: options.documentIds
      };
      // Remove undefined filters
      Object.keys(searchFilters).forEach(key => 
        searchFilters[key] === undefined && delete searchFilters[key]
      );
      const vectorChunks = await vectorStoreService.semanticSearch(question, topK, searchFilters);
      console.log(`   Found ${vectorChunks.length} relevant chunks from vector store`);

      // Fallback: if vector search returns few/no results, try GraphDB entity lookup
      // Skip this fallback in pureRAG mode (e.g., compare mode) to keep RAG results clean
      let graphContext = '';
      if (vectorChunks.length < 2 && !options.pureRAG) {
        try {
          console.log('   ⚡ Few vector results — trying GraphDB entity fallback');
          const graphDBStore = require('./graphDBStore');
          const tenantId = options.tenant_id || 'default';
          const workspaceId = options.workspace_id || 'default';
          
          // Search for entities matching keywords in the question
          const sparql = `
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            SELECT ?entity ?label ?type ?pred ?val WHERE {
              ?entity rdfs:label ?label .
              ?entity rdf:type ?type .
              FILTER(REGEX(STR(?label), "${question.replace(/[^a-zA-Z0-9@ ]/g, '').split(/\s+/).slice(0, 5).join('|')}", "i"))
              OPTIONAL { ?entity ?pred ?val . FILTER(?pred != rdf:type && ?pred != rdfs:label) }
            } LIMIT 10`;
          
          const res = await graphDBStore.executeSPARQL(tenantId, workspaceId, sparql, 'all');
          const bindings = res?.results?.bindings || [];
          if (bindings.length > 0) {
            const entities = {};
            for (const b of bindings) {
              const uri = b.entity?.value;
              if (!entities[uri]) entities[uri] = { label: b.label?.value, type: b.type?.value?.split(/[#/]/).pop(), props: {} };
              if (b.pred?.value && b.val?.value) {
                entities[uri].props[b.pred.value.split(/[#/]/).pop()] = b.val.value;
              }
            }
            graphContext = '\n\nKnowledge Graph entities found:\n' + Object.values(entities).map(e => 
              `${e.type}: ${e.label} — ${Object.entries(e.props).slice(0, 8).map(([k,v]) => `${k}: ${v}`).join(', ')}`
            ).join('\n');
            console.log(`   📊 GraphDB fallback found ${Object.keys(entities).length} entities`);
          }
        } catch (e) {
          console.warn('   GraphDB fallback failed:', e.message);
        }
      }

      // Step 2: Build context string from vector chunks only
      console.log('\n📝 Step 2: Building Context');
      console.log('-'.repeat(40));
      
      // Enrich chunks with document names from Neo4j if missing
      const enrichedChunks = await this.enrichChunksWithDocNames(vectorChunks);
      
      const contextString = this.buildVectorOnlyContext(enrichedChunks) + graphContext;
      console.log(`   Context length: ${contextString.length} characters`);

      // Step 3: Generate response using LLM
      console.log('\n🤖 Step 3: Generating Response');
      console.log('-'.repeat(40));
      const response = await this.generateResponse(question, contextString, { chunks: enrichedChunks, concepts: [], relations: [] });

      console.log('\n✅ RAG Query complete');
      console.log('='.repeat(60) + '\n');

      return {
        answer: response,
        searchMode: 'rag',
        sources: {
          chunks: enrichedChunks.map(c => ({
            text: c.text ? (c.text.substring(0, 300) + (c.text.length > 300 ? '...' : '')) : '',
            documentName: c.documentName || 'Unknown Document',
            similarity: c.similarity?.toFixed(3) || '0.000',
            chunkIndex: c.chunkIndex,
            startPage: c.startPage || c.metadata?.startPage || null,
            endPage: c.endPage || c.metadata?.endPage || null
          })),
          graphEntities: [],
          graphChunks: [],
          relations: []
        },
        metadata: {
          searchMode: 'rag',
          vectorChunksUsed: enrichedChunks.length,
          graphConceptsUsed: 0,
          graphChunksUsed: 0,
          relationsFound: 0,
          totalContextLength: contextString.length
        }
      };
    } catch (error) {
      console.error('RAG query failed:', error);
      throw new Error(`RAG query failed: ${error.message}`);
    }
  }

  /**
   * Graph Only - Search knowledge graph only (no vector search)
   */
  async queryGraphOnly(question, options = {}) {
    const graphDepth = options.graphDepth || this.maxGraphDepth;
    console.log('\n' + '='.repeat(60));
    console.log(`🔗 GRAPH ONLY (Neo4j Cypher): "${question}" [depth: ${graphDepth}]`);
    console.log('='.repeat(60));

    try {
      // Step 1: Read Neo4j schema
      console.log('\n📊 Step 1: Reading Neo4j Schema');
      console.log('-'.repeat(40));
      const schema = await neo4jService.getSchema();
      const schemaText = neo4jService.formatSchemaForLLM(schema);
      console.log(`   Schema: ${schema.nodeLabels.length} labels, ${schema.relationshipTypes.length} rel types, ${schema.patterns.length} patterns`);

      // Step 2: Generate Cypher with multi-hop support
      console.log('\n🧠 Step 2: Generating Cypher');
      console.log('-'.repeat(40));
      const cypher = await this.generateGraphOnlyCypher(question, schemaText, graphDepth, options.workspace_id, options.documentIds);
      console.log(`   Generated Cypher: ${cypher}`);

      if (!cypher) {
        return {
          answer: "I couldn't generate a Cypher query for that question. Try rephrasing it.",
          sources: [],
          metadata: { searchMode: 'graph', error: 'cypher_generation_failed' }
        };
      }

      // Step 3: Execute query with retry on failure
      console.log('\n⚡ Step 3: Executing Query');
      console.log('-'.repeat(40));
      let results;
      let executedCypher = cypher;
      try {
        results = await this.executeCypherQuery(cypher);
        console.log(`   Query returned ${results.length} results`);
      } catch (execError) {
        console.warn(`   First query failed: ${execError.message}, retrying with simplified query...`);
        // Retry: ask LLM to fix the query
        try {
          const fixedCypher = await this._llmChat([{ role: 'user', content: `This Cypher query failed with error: ${execError.message}\n\nQuery: ${cypher}\n\nSchema:\n${schemaText}\n\nFix the query. Return ONLY the corrected Cypher, no explanation.` }], { temperature: 0.1, maxTokens: 800 });
          executedCypher = fixedCypher.trim().replace(/```cypher\n?/gi, '').replace(/```\n?/g, '').trim();
          results = await this.executeCypherQuery(executedCypher);
          console.log(`   Retry succeeded: ${results.length} results`);
        } catch (retryError) {
          return {
            answer: `The query couldn't be executed.\n\n**Error:** ${execError.message}\n\n**Generated Cypher:**\n\`\`\`cypher\n${cypher}\n\`\`\`\n\nTry rephrasing your question or simplifying it.`,
            sources: [],
            metadata: { searchMode: 'graph', cypher, error: execError.message }
          };
        }
      }

      // Step 4: Handle empty results
      if (!results || results.length === 0) {
        return {
          answer: `No results found in the knowledge graph for your question.\n\n**Cypher used:**\n\`\`\`cypher\n${executedCypher}\n\`\`\`\n\nThis could mean:\n- The data doesn't contain matching entities\n- Try different keywords or a broader question\n- Check if the data has been synced to Neo4j`,
          sources: [],
          metadata: { searchMode: 'graph', cypher: executedCypher, resultCount: 0 }
        };
      }

      // Step 5: Generate natural language response
      console.log('\n🤖 Step 5: Generating Response');
      console.log('-'.repeat(40));
      const formattedResults = results.slice(0, 50);
      const resultsContext = `Query Results (${results.length} rows):\n${JSON.stringify(formattedResults, null, 2)}`;

      const answer = await this._llmChat([{
        role: 'user',
        content: `Based on this Neo4j Cypher query result from a knowledge graph, answer the user's question naturally.

Question: ${question}
Cypher Query: ${executedCypher}
${resultsContext}

Provide a clear, concise answer. Format tables and lists nicely using markdown.`
      }], { temperature: 0.3, maxTokens: 1500 });

      console.log('\n✅ Graph Query complete');
      console.log('='.repeat(60) + '\n');

      // Extract structured sources from Cypher results
      const extractedSources = await this.extractGraphSources(formattedResults, { mode: 'cypher' });

      return {
        answer,
        searchMode: 'graph',
        sources: {
          chunks: [],
          graphEntities: extractedSources.graphEntities,
          graphChunks: [],
          relations: extractedSources.relations,
          documents: extractedSources.documents
        },
        metadata: {
          searchMode: 'graph',
          cypher: executedCypher,
          resultCount: results.length,
          results: formattedResults.slice(0, 10)
        }
      };
    } catch (error) {
      console.error('Graph query failed:', error);
      return {
        answer: `Error querying Neo4j: ${error.message}`,
        sources: [],
        metadata: { searchMode: 'graph', error: error.message }
      };
    }
  }

  /**
   * Generate Cypher for graph-only mode with multi-hop (up to 3 levels) support
   */
  async generateGraphOnlyCypher(question, schemaText, maxHops = 2, workspaceId = null, documentIds = null) {
    const wsFilter = workspaceId
      ? `\nWORKSPACE ISOLATION (MANDATORY):\n- EVERY query MUST include: WHERE n.workspace_id = '${workspaceId}' (on ALL matched nodes)\n- This ensures data isolation between workspaces. NEVER omit this filter.\n`
      : '';

    const docFilter = documentIds && documentIds.length > 0
      ? `\nDOCUMENT SCOPE (MANDATORY):\n- EVERY query MUST filter nodes to only those from specific source documents.\n- Add this filter on ALL matched nodes: WHERE n.source_document IN [${documentIds.slice(0, 50).map(id => `'${id}'`).join(', ')}]\n- This ensures the agent only sees data from its attached folders. NEVER omit this filter.\n`
      : '';

    const prompt = `You are a Neo4j Cypher expert. Generate a Cypher query for the user's question.

${schemaText}
${wsFilter}${docFilter}
CRITICAL RULES:
1. ONLY use relationships from the "Connection Patterns" section above — those are the ONLY relationships that exist
2. MATCH the EXACT direction shown in patterns: (A)-[:REL]->(B) means A points to B, never reverse it
3. Use EXACT property names (case-sensitive) and EXACT sample values shown
4. Property names like "customerId", "accountId" are DATA PROPERTIES on nodes, NOT relationship types
5. If schema shows numeric-looking strings like "0", "1", use string comparison: WHERE n.prop = "1"
6. If no sample values match the user's intent, use CONTAINS or toLower() for flexible text matching
7. Return ONLY the Cypher query, no explanation
8. Add LIMIT 50 unless counting/aggregating

MULTI-HOP TRAVERSAL (max ${maxHops} hops — chain patterns from the Connection Patterns section):
- 1-hop: MATCH (a:Label)-[:REL]->(b:Label) RETURN a, b
${maxHops >= 2 ? '- 2-hop: MATCH (a:Label)-[:REL1]->(b:Label)-[:REL2]->(c:Label) RETURN a, b, c' : ''}
${maxHops >= 3 ? '- 3-hop: MATCH (a)-[:REL1]->(b)-[:REL2]->(c)-[:REL3]->(d) RETURN a, b, c, d' : ''}
- Variable length: MATCH path = (a)-[*1..${maxHops}]->(b) RETURN path
- For "how are X and Y connected": MATCH path = shortestPath((a)-[*..${maxHops}]-(b)) RETURN path

USER QUESTION: ${question}`;

    try {
      let cypher = await this._llmChat([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 800 });
      cypher = cypher.trim().replace(/```cypher\n?/gi, '').replace(/```\n?/g, '').trim();
      return cypher;
    } catch (error) {
      console.error('Error generating Cypher:', error);
      return null;
    }
  }

  /**
   * Hybrid - Combines vector search with knowledge graph traversal (original behavior)
   */
  async queryHybrid(question, options = {}) {
    const topK = options.topK || this.maxContextChunks;
    const graphDepth = options.graphDepth || this.maxGraphDepth;

    try {
      console.log('\n' + '='.repeat(60));
      console.log(`🔍 HYBRID QUERY: "${question}"`);
      console.log('='.repeat(60));

      // Step 1: Extract key concepts from the query using LLM
      console.log('\n🧠 Step 1: Query Analysis');
      console.log('-'.repeat(40));
      const queryAnalysis = await this.analyzeQuery(question);
      console.log(`   Key concepts: ${queryAnalysis.concepts.join(', ')}`);
      console.log(`   Query intent: ${queryAnalysis.intent}`);

      // Step 2: Semantic search for relevant chunks from vector store
      console.log('\n📊 Step 2: Vector Search');
      console.log('-'.repeat(40));
      // Extract filters from options (tenant_id, workspace_id, doc_type, context_type, dateRange)
      const searchFilters = {
        tenant_id: options.tenant_id,
        workspace_id: options.workspace_id,
        doc_type: options.doc_type,
        context_type: options.context_type,
        dateRange: options.dateRange,
        documentIds: options.documentIds
      };
      // Remove undefined filters
      Object.keys(searchFilters).forEach(key => 
        searchFilters[key] === undefined && delete searchFilters[key]
      );
      let vectorChunks = await vectorStoreService.semanticSearch(question, topK, searchFilters);
      console.log(`   Found ${vectorChunks.length} relevant chunks from vector store`);
      
      // Enrich chunks with document names from Neo4j if missing
      vectorChunks = await this.enrichChunksWithDocNames(vectorChunks);

      // Step 3: Find related concepts from the knowledge graph
      console.log('\n🔗 Step 3: Knowledge Graph Search');
      console.log('-'.repeat(40));
      const graphContext = await this.getGraphContext(queryAnalysis.concepts, graphDepth, {
        workspace_id: options.workspace_id
      });
      console.log(`   Found ${graphContext.concepts.length} concepts`);
      console.log(`   Found ${graphContext.relatedChunks.length} related chunks from graph`);
      console.log(`   Found ${graphContext.relations.length} concept relationships`);

      // Step 4: Merge and deduplicate chunks with relevance scoring
      console.log('\n📝 Step 4: Building Context');
      console.log('-'.repeat(40));
      const mergedContext = this.mergeContext(vectorChunks, graphContext, queryAnalysis);
      console.log(`   Total unique chunks in context: ${mergedContext.chunks.length}`);
      console.log(`   Total concepts in context: ${mergedContext.concepts.length}`);

      // Step 5: Build the context string
      const contextString = this.buildContextString(mergedContext, queryAnalysis);
      console.log(`   Context length: ${contextString.length} characters`);

      // Step 6: Generate response using LLM
      console.log('\n🤖 Step 5: Generating Response');
      console.log('-'.repeat(40));
      const response = await this.generateResponse(question, contextString, mergedContext);

      console.log('\n✅ Hybrid Query complete');
      console.log('='.repeat(60) + '\n');

      return {
        answer: response,
        searchMode: 'hybrid',
        sources: {
          chunks: vectorChunks.map(c => ({
            text: c.text ? (c.text.substring(0, 300) + (c.text.length > 300 ? '...' : '')) : '',
            documentName: c.documentName || 'Unknown Document',
            similarity: c.similarity?.toFixed(3) || '0.000',
            chunkIndex: c.chunkIndex,
            startPage: c.startPage || c.metadata?.startPage || null,
            endPage: c.endPage || c.metadata?.endPage || null
          })),
          graphEntities: graphContext.concepts.map(c => ({
            label: c.concept?.label || 'Unknown',
            type: c.concept?.type || 'Concept',
            description: c.concept?.description || '',
            relationships: c.relations?.length || 0
          })),
          graphChunks: graphContext.relatedChunks.map(c => ({
            docTitle: c.docTitle || 'Unknown',
            text: c.chunk?.text ? (c.chunk.text.substring(0, 200) + '...') : '',
            concepts: c.concepts?.map(con => con.concept).filter(Boolean).join(', ') || '',
            startPage: c.chunk?.start_page || null,
            endPage: c.chunk?.end_page || null
          })),
          relations: graphContext.relations.slice(0, 10).map(r => ({
            source: r.source,
            predicate: r.predicate || r.type,
            target: r.target
          }))
        },
        metadata: {
          searchMode: 'hybrid',
          queryAnalysis: queryAnalysis,
          vectorChunksUsed: vectorChunks.length,
          graphConceptsUsed: graphContext.concepts.length,
          graphChunksUsed: graphContext.relatedChunks.length,
          relationsFound: graphContext.relations.length,
          graphDepth: graphDepth,
          totalContextLength: contextString.length
        }
      };
    } catch (error) {
      console.error('Hybrid query failed:', error);
      throw new Error(`Hybrid query failed: ${error.message}`);
    }
  }

  /**
   * Build context string from vector chunks only (RAG mode)
   */
  buildVectorOnlyContext(vectorChunks) {
    let context = '=== RELEVANT DOCUMENT EXCERPTS ===\n\n';
    
    vectorChunks.forEach((chunk, i) => {
      const sourceInfo = chunk.documentName || 'Unknown Document';
      const score = chunk.similarity ? ` [Relevance: ${(chunk.similarity * 100).toFixed(0)}%]` : '';
      context += `--- Source: ${sourceInfo}${score} ---\n`;
      context += chunk.text + '\n\n';
    });

    return context;
  }

  /**
   * Build context string from graph only (Graph mode)
   */
  buildGraphOnlyContext(graphContext, queryAnalysis) {
    let context = '';

    // Add graph-related chunks
    if (graphContext.relatedChunks.length > 0) {
      context += '=== DOCUMENT EXCERPTS FROM KNOWLEDGE GRAPH ===\n\n';
      graphContext.relatedChunks.forEach((item, i) => {
        const chunk = item.chunk;
        if (chunk?.text) {
          context += `--- Source: ${item.docTitle || 'Unknown'} ---\n`;
          context += chunk.text + '\n\n';
        }
      });
    }

    // Add knowledge graph context (concepts and their relationships)
    if (graphContext.concepts.length > 0) {
      context += '\n=== KNOWLEDGE GRAPH ENTITIES ===\n\n';
      
      // Group concepts by type
      const conceptsByType = {};
      for (const item of graphContext.concepts) {
        const c = item.concept;
        if (c) {
          const type = c.type || 'Concept';
          if (!conceptsByType[type]) conceptsByType[type] = [];
          conceptsByType[type].push({ ...c, relations: item.relations });
        }
      }

      for (const [type, concepts] of Object.entries(conceptsByType)) {
        context += `[${type}s]\n`;
        for (const c of concepts) {
          context += `• ${c.label}`;
          if (c.description) {
            context += `: ${c.description}`;
          }
          context += '\n';
          
          // Add entity properties (important for answering questions about specific attributes)
          const skipProps = ['label', 'type', 'description', 'uri', 'concept_id', 'canonical_id', 
                           'created_at', 'updated_at', 'extracted_at', 'source', 'confidence',
                           'tenant_id', 'workspace_id', 'source_document', 'normalized_label', 'industry'];
          const props = Object.entries(c)
            .filter(([key, val]) => !skipProps.includes(key) && val !== null && val !== undefined && val !== '')
            .slice(0, 10);
          
          if (props.length > 0) {
            context += '  Properties:\n';
            for (const [key, val] of props) {
              context += `    - ${key}: ${val}\n`;
            }
          }
          
          // Add relationships
          if (c.relations && c.relations.length > 0) {
            context += '  Relationships:\n';
            for (const rel of c.relations.slice(0, 3)) {
              if (rel.concept) {
                const predicate = rel.predicate || rel.type || 'relates to';
                context += `    → ${predicate}: ${rel.concept}\n`;
              }
            }
          }
        }
        context += '\n';
      }
    }

    // Add explicit relationships summary
    if (graphContext.relations.length > 0) {
      context += '\n=== KEY RELATIONSHIPS ===\n\n';
      const uniqueRelations = new Set();
      for (const rel of graphContext.relations.slice(0, 15)) {
        if (rel.source && rel.target) {
          const relStr = `${rel.source} --[${rel.predicate || rel.type}]--> ${rel.target}`;
          if (!uniqueRelations.has(relStr)) {
            uniqueRelations.add(relStr);
            context += `• ${relStr}\n`;
          }
        }
      }
    }

    return context;
  }

  /**
   * Analyze query to extract key concepts using LLM
   * Also includes raw terms from the query as fallback
   */
  async analyzeQuery(query) {
    // Always extract raw terms from the query first
    const rawTerms = this.extractKeyTermsFallback(query);
    
    try {
      const content = await this._llmChat([
        {
          role: 'system',
          content: `Extract key search concepts from user queries for a knowledge graph search.
Return JSON: { "concepts": ["Concept1", "Concept2"], "intent": "brief description of what user wants to know" }

CRITICAL RULES:
1. ONLY extract terms that are EXPLICITLY mentioned in the query - DO NOT infer or expand names
2. If user says "kunal", extract "kunal" - NOT "Kunal Shah" or "Kunal Patel"
3. Extract COMPOUND CONCEPTS as single items (e.g., "Control Plane" not "Control" and "Plane")
4. Include proper nouns, technical terms, product names AS WRITTEN
5. Remove generic words like "tell", "about", "what", "is"
6. Max 5 concepts, ordered by importance
7. DO NOT hallucinate or guess full names - use exactly what's in the query`
        },
        {
          role: 'user',
          content: query
        }
      ], { temperature: 0.1 });
      
      // Extract JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        let llmConcepts = parsed.concepts || [];
        
        // Merge LLM concepts with raw terms, prioritizing raw terms
        const allConcepts = [...new Set([...rawTerms, ...llmConcepts])];
        
        return {
          concepts: allConcepts.slice(0, 7),
          intent: parsed.intent || 'information retrieval'
        };
      }
    } catch (error) {
      console.log('   Query analysis fallback (LLM unavailable)');
    }

    // Fallback to simple extraction
    return {
      concepts: this.extractKeyTermsFallback(query),
      intent: 'information retrieval'
    };
  }

  /**
   * Fallback key term extraction (improved)
   */
  extractKeyTermsFallback(query) {
    const stopWords = new Set([
      'what', 'where', 'when', 'how', 'why', 'who', 'which',
      'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did',
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'into', 'about', 'can', 'could',
      'will', 'would', 'should', 'may', 'might', 'must',
      'this', 'that', 'these', 'those', 'it', 'its',
      'my', 'your', 'his', 'her', 'our', 'their',
      'me', 'you', 'him', 'us', 'them', 'i', 'we',
      'tell', 'explain', 'describe', 'show', 'find', 'get', 'give'
    ]);

    // Try to extract compound terms (capitalized sequences)
    const compoundTerms = [];
    const capitalizedPattern = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g;
    let match;
    while ((match = capitalizedPattern.exec(query)) !== null) {
      compoundTerms.push(match[0]);
    }

    // Extract remaining terms
    const cleanedQuery = query.replace(capitalizedPattern, ' ');
    const singleTerms = cleanedQuery
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2 && !stopWords.has(term));

    // Combine, dedupe, limit
    const allTerms = [...compoundTerms, ...singleTerms];
    return [...new Set(allTerms)].slice(0, 5);
  }

  /**
   * Get context from the knowledge graph using extracted concepts
   * Supports workspace scoping for multi-tenant isolation
   */
  async getGraphContext(concepts, depth = 2, options = {}) {
    try {
      await driver.verifyConnectivity();
    } catch (error) {
      console.log('   Neo4j not available, skipping graph context');
      return { concepts: [], relatedChunks: [], relations: [] };
    }

    try {
      const allConcepts = [];
      const workspaceId = options.workspace_id;
      
      // Search for each concept with specified depth
      // Always use workspace-scoped search to prevent cross-workspace data leaks
      for (const term of concepts.slice(0, 5)) {
        let found;
        const effectiveWorkspaceId = workspaceId || 'default';
        found = await neo4jService.findRelatedConceptsInWorkspace(term, effectiveWorkspaceId, this.maxConceptsPerQuery, depth);
        allConcepts.push(...found);
      }

      // Deduplicate concepts
      const uniqueConcepts = this.deduplicateConcepts(allConcepts);
      console.log(`   Matched ${uniqueConcepts.length} concepts in graph${workspaceId ? ` (workspace: ${workspaceId})` : ''}`);

      // Extract concept URIs for chunk lookup
      const conceptUris = uniqueConcepts.map(c => c.concept?.uri).filter(Boolean);

      // Get chunks that mention these concepts
      let relatedChunks = [];
      if (conceptUris.length > 0) {
        relatedChunks = await neo4jService.getChunksForConceptsInWorkspace(conceptUris, workspaceId || 'default', 10);
      }

      // Collect all relations with deduplication
      const relationMap = new Map();
      for (const c of uniqueConcepts) {
        if (c.relations) {
          for (const rel of c.relations) {
            const key = `${c.concept?.label}|${rel.predicate || rel.type}|${rel.concept}`;
            if (!relationMap.has(key)) {
              relationMap.set(key, {
                source: c.concept?.label,
                type: rel.type,
                predicate: rel.predicate,
                target: rel.concept
              });
            }
          }
        }
      }

      return {
        concepts: uniqueConcepts.slice(0, this.maxGraphNodes),
        relatedChunks: relatedChunks,
        relations: Array.from(relationMap.values())
      };
    } catch (error) {
      console.error('Error getting graph context:', error.message);
      return { concepts: [], relatedChunks: [], relations: [] };
    }
  }

    /**
     * Ontology-guided Neo4j graph query.
     * Uses ontology schema from GraphDB to understand the data model,
     * then generates a targeted Cypher query against Neo4j.
     *
     * GraphDB = schema store (classes, properties, relationships)
     * Neo4j = data store (entity instances, relationship instances)
     */
    async _ontologyGuidedGraphQuery(question, ontologySchema, entityHints = [], options = {}) {
      const { workspace_id = 'default', graphDepth = 2, history = [] } = options;

      // Build a concise ontology description — only entity types and relationships.
      // Data properties are omitted because the Neo4j schema (below) has the REAL
      // property names with sample values, which is what the LLM needs for Cypher.
      const classDescriptions = (ontologySchema.classes || []).slice(0, 20).map(c => {
        return c.label || c.iri?.split(/[#/]/).pop() || 'Unknown';
      });

      // Only object properties (relationships) — these tell the LLM how entities connect
      const relDescriptions = (ontologySchema.properties || [])
        .filter(p => p.type === 'objectProperty')
        .slice(0, 30)
        .map(p => {
          const name = p.name || p.label || p.iri?.split(/[#/]/).pop() || 'Unknown';
          const domain = p.domain || 'Any';
          const range = p.range || 'Entity';
          return `${domain} —[${name}]→ ${range}`;
        });

      // Get the FULL Neo4j schema with sample values — this is the primary source
      // for Cypher generation (exact property names, exact values, exact relationships)
      let neo4jSchemaText = '';
      try {
        const schema = await neo4jService.getSchema();
        neo4jSchemaText = neo4jService.formatSchemaForLLM(schema);
      } catch { /* Neo4j schema unavailable */ }

      const wsFilter = workspace_id
        ? `\nWORKSPACE ISOLATION (MANDATORY):\n- EVERY query MUST include: WHERE n.workspace_id = '${workspace_id}' (on ALL matched nodes)\n- This ensures data isolation between workspaces. NEVER omit this filter.\n`
        : '';

      // Build conversation history for context resolution
      let historyContext = '';
      if (history.length > 0) {
        const recentHistory = history.slice(-4).map(m => `${m.role}: ${(m.content || '').substring(0, 300)}`).join('\n');
        historyContext = `\n  RECENT CONVERSATION (use to resolve references like "this customer", "their", "Joy Harris", etc.):\n  ${recentHistory}\n`;
      }

      const cypherPrompt = `You are a Neo4j Cypher expert. Generate a Cypher query to answer the user's question.

  ONTOLOGY (semantic model — how entity types relate to each other):
  Entity types: ${classDescriptions.join(', ') || 'Unknown'}
  ${relDescriptions.length > 0 ? `Semantic relationships:\n  ${relDescriptions.join('\n  ')}` : ''}

  ${neo4jSchemaText ? `${neo4jSchemaText}\n` : ''}
  ${wsFilter}
  ENTITY HINTS from the question: ${entityHints.join(', ') || 'none'}
  ${historyContext}

  CRITICAL RULES:
  1. ONLY use relationships from the "Connection Patterns" section — those are the ONLY relationships that exist in Neo4j
  2. MATCH the EXACT direction shown in patterns: (A)-[:REL]->(B) means A points to B, never reverse it
  3. Use EXACT property names (case-sensitive) and EXACT sample values shown in the Neo4j schema
  4. Property names like "customerId", "accountId" are DATA PROPERTIES on nodes, NOT relationship types
  5. If schema shows numeric-looking strings like "0", "1", use string comparison: WHERE n.prop = "1"
  6. If no sample values match the user's intent, use CONTAINS or toLower() for flexible text matching
  7. When the user mentions an entity by name/ID, check the EXACT VALUES in the schema to find the correct format
  8. Always filter by workspace: WHERE n.workspace_id = '${workspace_id}' on ALL matched nodes
  9. LIMIT results to 25 max
  10. Return entity labels, types, and relationship info
  11. For entity lookups, try multiple matching strategies: exact ID, concept_id, and case-insensitive label match
  12. The "Ontology" section shows the semantic model. The "Neo4j Graph Schema" section shows the ACTUAL data. When they conflict, trust the Neo4j schema.
  13. If the question is a follow-up, use the RECENT CONVERSATION to resolve references. For example, if the user previously asked about "CUST000022" and now asks "what about their loans", query Loan entities connected to CUST000022.

  Return ONLY the Cypher query, no explanation.

  QUESTION: ${question}`;

      let concepts = [];
      let relations = [];
      let relatedChunks = [];
      let rawResults = [];
      let cleanCypher = '';

      try {
        // Generate Cypher from ontology + question
        const cypher = await this._llmChat([
          { role: 'user', content: cypherPrompt }
        ], { temperature: 0.1, maxTokens: 800 });

        cleanCypher = cypher.trim();
        if (cleanCypher.includes('```')) {
          cleanCypher = cleanCypher.replace(/```cypher?\n?/g, '').replace(/```/g, '').trim();
        }
        // Strip preamble text before MATCH/CALL/WITH
        const cypherStart = cleanCypher.match(/(MATCH|CALL|WITH|OPTIONAL|UNWIND)\s/i);
        if (cypherStart && cypherStart.index > 0) {
          cleanCypher = cleanCypher.substring(cypherStart.index).trim();
        }

        console.log(`   🔗 Generated Cypher:\n      ${cleanCypher.split('\n').join('\n      ')}`);

        // Execute against Neo4j
        const session = neo4jService.getSession();
        try {
          const result = await session.run(cleanCypher);
          const records = result.records || [];
          console.log(`   🔗 Cypher returned ${records.length} records`);

          // Serialize raw results for the answer LLM (preserves all node properties)
          rawResults = [];

          // Helper: convert Neo4j Integer objects to plain numbers
          const toPlain = (val) => {
            if (val === null || val === undefined) return val;
            if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
            if (typeof val?.toNumber === 'function') return val.toNumber();
            if (typeof val?.low !== 'undefined' && typeof val?.high !== 'undefined') return val.low;
            return val;
          };
          const nodeToObj = (v) => {
            if (!v || typeof v !== 'object') return toPlain(v);
            if (v.labels) {
              const props = {};
              for (const [k, pv] of Object.entries(v.properties || {})) props[k] = toPlain(pv);
              return { _labels: v.labels, ...props };
            }
            if (v.type && v.startNodeElementId) {
              const props = {};
              for (const [k, pv] of Object.entries(v.properties || {})) props[k] = toPlain(pv);
              return { _type: v.type, ...props };
            }
            if (v.properties) {
              const props = {};
              for (const [k, pv] of Object.entries(v.properties)) props[k] = toPlain(pv);
              return props;
            }
            return v;
          };

          for (const record of records) {
            const row = {};
            for (const key of record.keys) {
              const val = record.get(key);
              if (val && typeof val === 'object' && val.labels) {
                row[key] = nodeToObj(val);
              } else if (val && typeof val === 'object' && val.type && val.startNodeElementId) {
                row[key] = nodeToObj(val);
              } else if (Array.isArray(val)) {
                row[key] = val.map(v => nodeToObj(v));
              } else if (val && typeof val === 'object' && val.segments) {
                row[key] = val.segments.map(seg => ({
                  start: nodeToObj(seg.start),
                  rel: seg.relationship?.type,
                  end: nodeToObj(seg.end)
                }));
              } else {
                row[key] = toPlain(val);
              }
            }
            rawResults.push(row);
          }

          // Parse results into concepts and relations (for entity display in UI)
          const conceptMap = new Map();
          for (const record of records) {
            const keys = record.keys;
            for (const key of keys) {
              const val = record.get(key);
              if (val && typeof val === 'object' && val.labels) {
                // It's a node
                const label = val.properties?.rdfs__label || val.properties?.name || val.properties?.label || 'Unknown';
                const type = val.labels?.[0] || 'Entity';
                const uri = val.properties?.uri || val.elementId;
                if (!conceptMap.has(label)) {
                  conceptMap.set(label, {
                    concept: { label, type, uri, description: '' },
                    relations: [],
                    score: 0.7
                  });
                }
              } else if (val && typeof val === 'object' && val.type) {
                // It's a relationship
                relations.push({
                  source: val.startNodeElementId,
                  predicate: val.type,
                  target: val.endNodeElementId
                });
              } else if (val && typeof val === 'string') {
                // It's a scalar value — might be a label
                // Skip, handled by node properties
              }
            }

            // Also try to extract relationship patterns from path-like results
            for (const key of keys) {
              const val = record.get(key);
              if (val && val.segments) {
                // It's a path
                for (const seg of val.segments) {
                  const startLabel = seg.start?.properties?.rdfs__label || seg.start?.properties?.name || 'Unknown';
                  const endLabel = seg.end?.properties?.rdfs__label || seg.end?.properties?.name || 'Unknown';
                  relations.push({
                    source: startLabel,
                    predicate: seg.relationship?.type || 'RELATED_TO',
                    target: endLabel
                  });
                  if (!conceptMap.has(startLabel)) {
                    conceptMap.set(startLabel, {
                      concept: { label: startLabel, type: seg.start?.labels?.[0] || 'Entity', uri: seg.start?.properties?.uri },
                      relations: [],
                      score: 0.6
                    });
                  }
                  if (!conceptMap.has(endLabel)) {
                    conceptMap.set(endLabel, {
                      concept: { label: endLabel, type: seg.end?.labels?.[0] || 'Entity', uri: seg.end?.properties?.uri },
                      relations: [],
                      score: 0.6
                    });
                  }
                }
              }
            }
          }

          concepts = Array.from(conceptMap.values());

          // Attach relations to concepts
          for (const rel of relations) {
            for (const [, concept] of conceptMap) {
              if (concept.concept.label === rel.source || concept.concept.uri === rel.source) {
                concept.relations.push({ predicate: rel.predicate, concept: rel.target });
              }
            }
          }

          // Resolve relation source/target from elementIds to labels
          const elementIdToLabel = new Map();
          for (const record of records) {
            for (const key of record.keys) {
              const val = record.get(key);
              if (val && val.labels && val.elementId) {
                elementIdToLabel.set(val.elementId, val.properties?.rdfs__label || val.properties?.name || 'Unknown');
              }
            }
          }
          relations = relations.map(r => ({
            source: elementIdToLabel.get(r.source) || r.source,
            predicate: r.predicate,
            target: elementIdToLabel.get(r.target) || r.target
          }));

        } finally {
          await session.close();
        }
      } catch (e) {
        console.warn(`   ⚠️ Ontology-guided Cypher failed: ${e.message}, falling back to keyword search`);
        // Fallback to keyword-based search
        const searchTerms = entityHints.length > 0 ? entityHints : this.extractKeyTermsFallback(question);
        return this.getGraphContext(searchTerms, graphDepth, { workspace_id });
      }

      return { concepts, relatedChunks, relations, rawResults, cypher: cleanCypher };
    }

  /**
   * Enrich chunks with document names from Neo4j if missing
   * This handles legacy chunks that were stored without documentName
   */
  async enrichChunksWithDocNames(chunks) {
    if (!chunks || chunks.length === 0) return chunks;
    
    // Find chunks missing document names
    const chunksNeedingNames = chunks.filter(c => !c.documentName || c.documentName === 'Unknown Document');
    if (chunksNeedingNames.length === 0) return chunks;
    
    // Get unique document IDs
    const docIds = [...new Set(chunksNeedingNames.map(c => c.documentId).filter(Boolean))];
    if (docIds.length === 0) return chunks;
    
    try {
      // Query Neo4j for document titles
      const session = neo4jService.getSession();
      try {
        const result = await session.run(`
          MATCH (d:Document)
          WHERE d.doc_id IN $docIds
          RETURN d.doc_id as docId, d.title as title
        `, { docIds });
        
        // Build lookup map
        const docNameMap = new Map();
        for (const record of result.records) {
          docNameMap.set(record.get('docId'), record.get('title'));
        }
        
        // Enrich chunks
        return chunks.map(chunk => {
          if (!chunk.documentName || chunk.documentName === 'Unknown Document') {
            const docName = docNameMap.get(chunk.documentId);
            if (docName) {
              return { ...chunk, documentName: docName };
            }
          }
          return chunk;
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      console.log('   Could not enrich document names from Neo4j:', error.message);
      return chunks;
    }
  }

  /**
   * Deduplicate concepts by URI
   */
  deduplicateConcepts(concepts) {
    const seen = new Map();
    for (const c of concepts) {
      if (c.concept?.uri && !seen.has(c.concept.uri)) {
        seen.set(c.concept.uri, c);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Merge vector search results with graph context
   * Improved relevance scoring
   */
  mergeContext(vectorChunks, graphContext, queryAnalysis) {
    const chunkMap = new Map();

    // Add vector chunks with similarity scores
    for (const chunk of vectorChunks) {
      const key = chunk.chunkId || chunk.documentId + '_' + chunk.chunkIndex;
      chunkMap.set(key, {
        ...chunk,
        source: 'vector',
        relevanceScore: chunk.similarity || 0.5
      });
    }

    // Add graph-related chunks with concept boost
    for (const item of graphContext.relatedChunks) {
      const chunk = item.chunk;
      const key = chunk.chunk_id || chunk.uri;

      if (chunkMap.has(key)) {
        // Boost existing chunk if it also appears in graph
        const existing = chunkMap.get(key);
        existing.concepts = item.concepts;
        existing.relevanceScore = Math.min(existing.relevanceScore + 0.15, 1.0);
        existing.source = 'both';
      } else {
        // Add new chunk from graph
        chunkMap.set(key, {
          chunkId: chunk.chunk_id,
          text: chunk.text,
          documentName: item.docTitle,
          documentUri: item.docUri,
          concepts: item.concepts,
          source: 'graph',
          relevanceScore: 0.6
        });
      }
    }

    // Sort by relevance and limit
    const chunks = Array.from(chunkMap.values())
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.maxContextChunks);

    return {
      chunks: chunks,
      concepts: graphContext.concepts,
      relations: graphContext.relations
    };
  }

  /**
   * Build context string from merged context
   * Structured for better LLM comprehension
   */
  buildContextString(mergedContext, queryAnalysis) {
    let context = '';

    // Add relevant document chunks
    if (mergedContext.chunks.length > 0) {
      context += '=== RELEVANT DOCUMENT EXCERPTS ===\n\n';
      mergedContext.chunks.forEach((chunk, i) => {
        const sourceInfo = chunk.documentName || 'Unknown Document';
        const sourceType = chunk.source === 'both' ? '📊+🔗' : (chunk.source === 'vector' ? '📊' : '🔗');
        const score = chunk.relevanceScore ? ` [Relevance: ${(chunk.relevanceScore * 100).toFixed(0)}%]` : '';
        context += `--- Source: ${sourceInfo} ${sourceType}${score} ---\n`;
        context += chunk.text + '\n\n';
      });
    }

    // Add knowledge graph context (concepts and their relationships)
    if (mergedContext.concepts.length > 0) {
      context += '\n=== KNOWLEDGE GRAPH CONTEXT ===\n\n';
      
      // Group concepts by type for better organization
      const conceptsByType = {};
      for (const item of mergedContext.concepts) {
        const c = item.concept;
        if (c) {
          const type = c.type || 'Concept';
          if (!conceptsByType[type]) conceptsByType[type] = [];
          conceptsByType[type].push({ ...c, relations: item.relations });
        }
      }

      for (const [type, concepts] of Object.entries(conceptsByType)) {
        context += `[${type}s]\n`;
        for (const c of concepts) {
          context += `• ${c.label}`;
          if (c.description) {
            context += `: ${c.description}`;
          }
          context += '\n';
          
          // Add relationships
          if (c.relations && c.relations.length > 0) {
            for (const rel of c.relations.slice(0, 3)) {
              if (rel.concept) {
                const predicate = rel.predicate || rel.type || 'relates to';
                context += `  → ${predicate}: ${rel.concept}\n`;
              }
            }
          }
        }
        context += '\n';
      }
    }

    // Add explicit relationships summary
    if (mergedContext.relations.length > 0) {
      context += '\n=== KEY RELATIONSHIPS ===\n\n';
      const uniqueRelations = new Set();
      for (const rel of mergedContext.relations.slice(0, 15)) {
        if (rel.source && rel.target) {
          const relStr = `${rel.source} --[${rel.predicate || rel.type}]--> ${rel.target}`;
          if (!uniqueRelations.has(relStr)) {
            uniqueRelations.add(relStr);
            context += `• ${relStr}\n`;
          }
        }
      }
    }

    return context;
  }

  /**
   * Get cached schema or fetch fresh
   */
  async getSchemaContext() {
    // Cache schema for 2 minutes
    if (!this._schemaCache || Date.now() - this._schemaCacheTime > 120000) {
      this._schemaCache = await neo4jService.getSchema();
      this._schemaCacheTime = Date.now();
      console.log('📋 Schema refreshed');
    }
    return neo4jService.formatSchemaForLLM(this._schemaCache);
  }

  /**
   * Clear schema cache (call after data changes)
   */
  clearSchemaCache() {
    this._schemaCache = null;
    this._schemaCacheTime = 0;
  }

  /**
   * Generate Cypher query from natural language
   */
  async generateCypher(question, workspaceId = null, documentIds = null) {
    const schemaContext = await this.getSchemaContext();

    const wsFilter = workspaceId
      ? `\nWORKSPACE ISOLATION (MANDATORY):\n- EVERY query MUST include: WHERE n.workspace_id = '${workspaceId}' (on ALL matched nodes)\n- This ensures data isolation between workspaces. NEVER omit this filter.\n`
      : '';

    const docFilter = documentIds && documentIds.length > 0
      ? `\nDOCUMENT SCOPE (MANDATORY):\n- EVERY query MUST filter nodes to only those from specific source documents.\n- Add this filter on ALL matched nodes: WHERE n.source_document IN [${documentIds.slice(0, 50).map(id => `'${id}'`).join(', ')}]\n- This ensures the agent only sees data from its attached folders. NEVER omit this filter.\n`
      : '';
    
    const prompt = `You are a Neo4j Cypher expert. Generate a Cypher query for the user's question.

${schemaContext}
${wsFilter}${docFilter}
AUDIT / CHANGE TRACKING:
- Change history is stored in GraphDB's audit graph (not in Neo4j)
- For questions about history, changes, edits, or audit trail, explain that audit data is available via the audit log feature
- Do NOT query for ChangeEvent nodes in Neo4j — they do not exist here

CRITICAL RULES:
1. ONLY use relationships from the "Connection Patterns" section — those are the ONLY relationships that exist
2. MATCH the EXACT direction shown in patterns: (A)-[:REL]->(B) means A points to B, never reverse it
3. Property names like "customerId", "accountId" are DATA PROPERTIES on nodes, NOT relationship types
4. Use EXACT property names (case-sensitive) and EXACT sample values shown
5. If schema shows numeric-looking strings like "0", "1", use string comparison: WHERE n.prop = "1"
6. If no sample values match the user's intent, use CONTAINS or toLower() for flexible text matching
7. Return a valid Cypher query that answers the question
8. Include RETURN clause with meaningful aliases
9. Add LIMIT 25 unless counting/aggregating
10. For aggregations, use count(), sum(), avg(), collect() as appropriate

USER QUESTION: ${question}

Respond with ONLY the Cypher query, no explanation.`;

    try {
      let cypher = await this._llmChat([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 500 });
      
      cypher = cypher.trim();
      // Clean up markdown code blocks if present
      cypher = cypher.replace(/```cypher\n?/gi, '').replace(/```\n?/g, '').trim();
      return cypher;
    } catch (error) {
      console.error('Error generating Cypher:', error);
      return null;
    }
  }

  /**
   * Execute generated Cypher and format results
   */
  async executeCypherQuery(cypher) {
    const session = neo4jService.getSession();
    try {
      const result = await session.run(cypher);
      return result.records.map(record => {
        const obj = {};
        record.keys.forEach(key => {
          obj[key] = neo4jService.toNative(record.get(key));
        });
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Generate response using LLM with strict grounding
   */
  async generateResponse(question, context, mergedContext) {
    const systemPrompt = `You are a precise assistant that answers questions STRICTLY based on the provided context.

CRITICAL RULES - FOLLOW EXACTLY:
1. ONLY use information explicitly stated in the provided context
2. NEVER make up, infer, or add information not in the context
3. If the answer is not in the context, say: "Based on the available documents, I don't have information about [topic]. The documents cover [brief summary of what IS covered]."
4. When citing information, mention the source document name
5. Be direct and concise - no filler phrases

RESPONSE STRUCTURE:
- Start with a direct answer
- Support with specific references from documents
- If partial information exists, share what you found and note what's missing`;

    const userPrompt = `CONTEXT (use ONLY this information):
${context}

---
QUESTION: ${question}
---

Answer using ONLY the information above. Cite sources when possible.`;

    try {
      return await this._llmChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.3, maxTokens: 1500 });
    } catch (error) {
      console.error('Error generating response:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  /**
   * Get Graph RAG statistics
   */
  async getStats() {
    const vectorStats = await vectorStoreService.getStats();
    let graphStats = {
      documents: 0,
      chunks: 0,
      concepts: 0,
      relations: 0
    };

    try {
      await driver.verifyConnectivity();
      const session = neo4jService.getSession();

      try {
        const docResult = await session.run('MATCH (d:Document) RETURN count(d) as count');
        graphStats.documents = neo4jService.toNumber(docResult.records[0].get('count'));

        const chunkResult = await session.run('MATCH (ch:Chunk) RETURN count(ch) as count');
        graphStats.chunks = neo4jService.toNumber(chunkResult.records[0].get('count'));

        const conceptResult = await session.run('MATCH (c:Concept) RETURN count(c) as count');
        graphStats.concepts = neo4jService.toNumber(conceptResult.records[0].get('count'));

        const relResult = await session.run(`
          MATCH ()-[r:PART_OF|MENTIONED_IN|RELATED_TO|IS_A]->()
          RETURN count(r) as count
        `);
        graphStats.relations = neo4jService.toNumber(relResult.records[0].get('count'));
      } finally {
        await session.close();
      }
    } catch (error) {
      console.log('Could not get graph stats:', error.message);
    }

    return {
      vectorStore: vectorStats,
      knowledgeGraph: graphStats
    };
  }

  /**
   * Clear all data
   */
  async clearAll() {
    try {
      await driver.verifyConnectivity();
      const session = neo4jService.getSession();

      try {
        await session.run('MATCH (n) DETACH DELETE n');
        console.log('Cleared all Neo4j data');
      } finally {
        await session.close();
      }
    } catch (error) {
      console.log('Could not clear Neo4j data:', error.message);
    }

    return { success: true };
  }
}

module.exports = new GraphRAGService();
