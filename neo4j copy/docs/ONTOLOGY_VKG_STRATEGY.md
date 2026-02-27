# Ontology, VKG & Agent Memory — Strategic Overview

**Audience:** Leadership & Technical Decision Makers
**Platform:** Purple Fabric — Enterprise Semantic Data Platform
**Date:** February 2026

---

## Executive Summary

Purple Fabric is a multi-tenant semantic data platform that uses ontologies as the intelligence layer connecting four capabilities: document search (RAG), entity graph traversal (Neo4j), federated database queries (VKG/Trino), and agent long-term memory. An ontology is a formal model of a domain — it defines what entity types exist (Customer, Account, Branch), what properties they have, and how they relate. This single model drives schema-aware AI queries across all data sources, eliminating the need for users to know SQL, Cypher, or SPARQL.

The VKG (Virtual Knowledge Graph) layer maps ontology concepts directly to live database tables, enabling natural language queries against MySQL, PostgreSQL, and other databases without moving data.

Agent memory adds a persistent learning layer — agents remember facts, user preferences, and decisions across conversations, creating AI assistants that get smarter over time. Memory is organized in a dual-pool architecture (agent-scoped domain knowledge + user-scoped personal preferences) with vector search for semantic recall.

A strategic opportunity exists to adopt GraphDB's native Ontop and FedX capabilities, which could replace or augment the current custom VKG pipeline with standards-based SPARQL federation and R2RML-driven data virtualization.

---

## 1. What the Ontology Does in Practice

### Without Ontology (Keyword Fallback)

When an agent has no ontology attached, Neo4j queries fall back to keyword-based graph traversal:

```
User: "Tell me about Customer000022"
→ System extracts keywords: ["Customer000022"]
→ Fuzzy label match across all Neo4j nodes
→ BFS walk outward N hops from any matches
→ Generic results, no understanding of entity types or relationships
```

This approach cannot generate targeted Cypher like `WHERE c.CustomerID = 'CUST000022'`. It doesn't know the schema's relationship types, property names, or how entities connect.

### With Ontology (Schema-Aware)

When an ontology is attached, the system loads the full semantic model from GraphDB and combines it with the live Neo4j schema:

```
User: "Tell me about Customer000022"
→ Ontology provides: Customer has relationships [hasBranch → Branch, hasAccount → Account]
→ Neo4j schema provides: exact property names (CustomerID, FullName), sample values
→ LLM generates precise Cypher:
    MATCH (c:Customer) WHERE c.CustomerID = 'CUST000022'
    OPTIONAL MATCH (c)-[:hasBranch]->(b:Branch)
    OPTIONAL MATCH (a:Account)-[:hasCustomer]->(c)
    OPTIONAL MATCH (rs:RiskScore)-[:hasCustomer]->(c)
    RETURN c, b, collect(DISTINCT a) AS accounts, rs
→ Returns complete customer profile with all relationships
```

The ontology tells the LLM *how entity types relate* (semantic relationships). The Neo4j schema tells it *what actually exists* (exact property names, values). When they conflict, Neo4j schema is authoritative.

---

## 2. The Four Query Paths

```
                    ┌─────────────────────────────────────────┐
                    │           USER QUESTION                  │
                    │   "Show me high-risk retail customers"   │
                    └──────────────┬──────────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  QUERY PLANNER   │
                          │  (LLM-based)     │
                          │  Routes to 1-4   │
                          │  sources based   │
                          │  on question     │
                          └────────┬────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │              ┌──────────┼──────────┐              │
         ▼              ▼          ▼          ▼              │
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────▼─────┐
│ PATH A: RAG  │ │ PATH B: Graph│ │ PATH C: VKG  │ │ PATH D:      │
│ (Vector)     │ │ (Neo4j)      │ │ (Fed. SQL)   │ │ Memory       │
│              │ │              │ │              │ │              │
│ Redis HNSW   │ │ Ontology     │ │ Ontology     │ │ Dual-pool    │
│ cosine sim   │ │ guides       │ │ maps to SQL  │ │ vector       │
│ over doc     │ │ Cypher gen   │ │ tables via   │ │ search over  │
│ chunks       │ │              │ │ Trino        │ │ past context │
│              │ │              │ │              │ │              │
│ No ontology  │ │ NEEDS        │ │ NEEDS        │ │ Always       │
│ needed       │ │ ontology     │ │ ontology +   │ │ available    │
│              │ │ for precision│ │ VKG mappings │ │ when enabled │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

| Path | Data Source | Ontology Required? | Best For |
|------|-----------|-------------------|----------|
| RAG (Vector) | Redis embeddings | No | Finding passages in documents, factual lookups |
| Graph (Neo4j) | Neo4j property graph | Strongly recommended | Entity relationships, multi-hop reasoning |
| VKG (Trino) | External databases | Yes (with mapping annotations) | Aggregations, counts, rankings, structured data |
| Memory | Redis (dual-pool) | No | Past context, user preferences, accumulated knowledge |

All four paths run in parallel via `Promise.all`. Results are fused, deduplicated, and ranked before the final LLM generates a unified answer.

---

## 3. How the Ontology Flows Through the System

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ONTOLOGY LIFECYCLE                                 │
│                                                                      │
│  ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌───────────────┐  │
│  │ CREATE   │───▶│  STORE   │───▶│  GUIDE   │───▶│  QUERY        │  │
│  │          │    │          │    │          │    │               │  │
│  │ Upload   │    │ GraphDB  │    │ Enrichment│   │ Agent uses    │  │
│  │ .ttl file│    │ (RDF     │    │ pipeline  │   │ ontology to   │  │
│  │   OR     │    │  named   │    │ extracts  │   │ generate      │  │
│  │ Generate │    │  graphs) │    │ entities  │   │ precise       │  │
│  │ from DB  │    │          │    │ per       │   │ Cypher/SQL    │  │
│  │ schema   │    │ Versioned│    │ ontology  │   │               │  │
│  │   OR     │    │ in Redis │    │ classes   │   │ Planner picks │  │
│  │ Generate │    │          │    │           │   │ sources based │  │
│  │ from     │    │          │    │ Syncs to  │   │ on what agent │  │
│  │ prompt   │    │          │    │ Neo4j     │   │ has attached  │  │
│  └─────────┘    └──────────┘    └──────────┘    └───────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Ontology Creation (Three Methods)

1. **Manual Upload** — Import OWL/Turtle (.ttl) files via the OWL API. Supports global, tenant, and workspace scopes.

2. **LLM Generation from Prompt** — Describe a domain in natural language ("banking with customers, accounts, transactions, and risk scores") and the system generates a complete OWL ontology with classes, properties, and relationships.

3. **VKG Auto-Generation from Database Schema** — The VKG ontology service introspects connected Trino catalogs, analyzes table structures and column types, and uses an LLM to generate an ontology with mapping annotations that link each class to its source table and each property to its source column.

### 3.2 Storage & Versioning

Ontologies are stored as RDF triples in GraphDB using named graphs for isolation:

```
Global ontology:     http://example.org/graphs/global/ontology/{ontologyId}
Workspace schema:    http://purplefabric.ai/graphs/tenant/{t}/workspace/{w}/schema
```

Every ontology change creates a version snapshot in Redis with:
- Full structure (classes, properties)
- Metadata (author, timestamp, parent version)
- Structure hash for change detection
- Branch and tag support (main, feature branches)

### 3.3 Enrichment Pipeline (Ontology → Entity Graph)

When a document is enriched (not just uploaded), the ontology drives entity extraction:

```
Document → LLM extracts entities per ontology classes
         → Column mapping (for CSV/Excel) routes properties to correct entity types
         → RDF triples generated with strict ontology validation
         → Triples stored in GraphDB
         → Synced to Neo4j (batched, 10,000 per pass)
```

The column mapping system is particularly important for structured data:
- Each CSV column maps to an ontology property
- `linkedClass` set → creates a relationship (object property)
- `linkedClass` empty → stores as literal value (datatype property)
- `domain` routes the property to the correct entity class
- Multi-sheet Excel files get per-sheet class mapping with cross-sheet FK detection

---

## 4. VKG: Virtual Knowledge Graph

### 4.1 What VKG Solves

Traditional approaches require ETL to move data from operational databases into a graph. VKG eliminates this by querying databases in place:

```
Traditional:  Database → ETL → Graph Store → Query
VKG:          Database ← Ontology Mapping → Query directly via Trino
```

This means:
- No data duplication
- Always-current results (queries hit live databases)
- No ETL pipeline to maintain
- Works across multiple databases simultaneously (federated)

### 4.2 How VKG Works

```
┌──────────────────────────────────────────────────────────────────┐
│                    VKG QUERY PIPELINE                             │
│                                                                  │
│  Step 1: Load ontology + mapping annotations from GraphDB        │
│          (which class → which table, which property → which col) │
│                                                                  │
│  Step 2: LLM generates execution plan + SQL in one call          │
│          Using the plan-and-sql-generator prompt                 │
│          Includes: entity routing, JOIN conditions, filters      │
│                                                                  │
│  Step 3: SQL validation (offline, no DB hit)                     │
│          Checks: 3-part table names, column existence,           │
│          JOIN correctness, no DDL/DML                            │
│                                                                  │
│  Step 4: Execute on Trino (federated SQL engine)                 │
│          Cross-database JOINs, catalog isolation                 │
│                                                                  │
│  Step 5: Build context graph + reasoning trace                   │
│          Visual representation of query results                  │
│                                                                  │
│  Step 6: LLM generates natural language answer                   │
│          From structured results + context                       │
│                                                                  │
│  Retry: Up to 3 attempts with error feedback if SQL fails        │
│  Drift: Background schema drift detection (non-blocking)         │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 Mapping Annotations

The VKG ontology includes special mapping predicates that link semantic concepts to physical database structures:

```turtle
# Class → Table mapping
:Customer vkgmap:table "postgresql.public.customers" .

# Property → Column mapping  
:customerName vkgmap:column "full_name" .
:customerName vkgmap:sqlType "varchar" .

# Relationship → JOIN mapping
:hasAccount vkgmap:joinSQL "customers.customer_id = accounts.customer_id" .
```

These mappings are augmented at query time with FK relationships detected from Trino introspection, providing accurate JOIN conditions even when the LLM-generated mappings are incomplete.

### 4.4 Schema Drift Detection

VKG includes a non-blocking drift detection system that runs in parallel with every query:
- Detects tables that no longer exist in the database
- Detects columns that have been removed
- Identifies new tables not yet in the ontology
- Warnings are appended to query responses without blocking execution

---

## 5. Agent Long-Term Memory

Memory is the fourth pillar of the platform. While ontologies provide structural intelligence (what types of things exist and how they relate), memory provides experiential intelligence (what happened, what the user prefers, what was decided).

### 5.1 Architecture: Dual-Pool, 3-Tier

```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT MEMORY SYSTEM                           │
│                                                                 │
│  ┌─── AGENT POOL ──────────────────────────────────────────┐   │
│  │ Domain knowledge tied to a specific agent+user pair.     │   │
│  │ Types: semantic (facts), event (notable occurrences)     │   │
│  │ Lifecycle: deleted when the agent is deleted             │   │
│  │ Key: memory:agent:{agentId}:{userId}:{memoryId}          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─── USER POOL ───────────────────────────────────────────┐   │
│  │ Personal preferences/decisions that follow the user.     │   │
│  │ Types: preference (user prefs), decision (choices made)  │   │
│  │ Lifecycle: survives agent deletion, deleted with user    │   │
│  │ Key: memory:user:{userId}:{memoryId}                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─── 3 TIERS ────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │  Tier 1: CORE MEMORY                                    │   │
│  │  Always-present summary of the most important facts.    │   │
│  │  Updated by LLM when high-importance memories (≥0.8)    │   │
│  │  are extracted. Kept under 500 words. Bullet-point.     │   │
│  │  → Included in EVERY agent query as persistent context  │   │
│  │                                                         │   │
│  │  Tier 2: SEMANTIC RECALL                                │   │
│  │  Individual memory entries with vector embeddings.       │   │
│  │  Searched via KNN when assembling context for a query.   │   │
│  │  Both pools searched and merged at query time.           │   │
│  │  → Top 5 most relevant memories included per query      │   │
│  │                                                         │   │
│  │  Tier 3: SESSION HISTORY                                │   │
│  │  Full conversation transcripts per session.              │   │
│  │  Lazy-created: only persisted on first message.          │   │
│  │  Empty sessions are never stored.                        │   │
│  │  → Browsable in UI, loadable for continuity             │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 How Memory Works in the Query Pipeline

```
User sends message
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  BEFORE QUERY: assembleMemoryContext()                   │
│                                                         │
│  1. Load Core Memory (Tier 1) — always present          │
│  2. Vector search both pools for query-relevant          │
│     memories (Tier 2) — top 5 by cosine similarity      │
│  3. Combine into memoryContext string                    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  DURING QUERY: Unified Pipeline                         │
│                                                         │
│  • memoryContext passed to Query Planner (Phase 1)      │
│    → Planner sees past context, can resolve references  │
│  • Memory is one of the 4 parallel retrieval sources    │
│  • In Phase 4 (answer generation), core memory and      │
│    recalled memories are included in the system prompt   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  AFTER QUERY: extractMemories() — fire-and-forget       │
│                                                         │
│  1. LLM analyzes the conversation turn                  │
│  2. Extracts memories with type + importance score      │
│     • semantic/event → AGENT pool                       │
│     • preference/decision → USER pool                   │
│  3. Each memory is consolidated (deduplicated)          │
│  4. High-importance (≥0.8) memories promote to Core     │
│  5. Session messages appended (lazy session creation)   │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Memory + Ontology Synergy

The combination of ontologies and memory creates a compounding intelligence effect:

| Scenario | Ontology Alone | Memory Alone | Ontology + Memory |
|----------|---------------|-------------|-------------------|
| "Tell me about CUST000022" | Precise Cypher query, full entity profile | Nothing (no structural knowledge) | Full profile + "You asked about this customer last week regarding their loan status" |
| "What changed since last quarter?" | Current state from graph | Past discussions recalled | Graph data (current) + memory (what user discussed before) = delta analysis |
| "Show amounts in EUR" | N/A | Preference stored, applied next time | Ontology structures the data, memory ensures it's formatted per user preference |
| "What did we decide about the AML threshold?" | AML ontology provides entity context | Decision memory recalled | Decision recalled with full entity context from the ontology |

### 5.4 Memory Graph Visualization

The memory system includes an LLM-powered graph extraction that builds a visual knowledge graph from accumulated memories. This graph shows entities (people, concepts, systems, preferences) and their relationships as discovered across conversations. It's cached in Redis with a 10-minute TTL and can be force-refreshed.

This is distinct from the Neo4j entity graph — the memory graph represents the agent's learned understanding of the user's world, not the formal ontology-structured data.

---

## 6. Strategic Opportunity: GraphDB Ontop & FedX

Purple Fabric currently implements its own VKG pipeline (LLM-based NL → SQL → Trino). GraphDB, which we already use as the ontology store, offers two built-in capabilities that could significantly enhance or partially replace this custom pipeline.

### 6.1 Ontop (Virtual SPARQL Endpoint over Relational Databases)

[Ontop](https://ontop-vkg.org/guide/) is an open-source Virtual Knowledge Graph system integrated into GraphDB. It translates SPARQL queries into SQL and executes them against relational databases, using R2RML or OBDA mappings. Ontotext and Ontopic have a [strategic partnership](https://www.prnewswire.com/news-releases/ontotext-and-ontopic-join-forces-to-revolutionize-data-virtualization-301987891.html) to deliver this as a first-class GraphDB feature.

(Content was rephrased for compliance with licensing restrictions)

**What Ontop provides:**
- Standards-based R2RML mappings (W3C standard) instead of custom `vkgmap:` predicates
- SPARQL-to-SQL translation with sophisticated query optimization (outperforms many custom approaches)
- Supports PostgreSQL, MySQL, SQL Server, Oracle, DB2, Snowflake, Databricks, BigQuery, Redshift, DuckDB, and Trino
- Can materialize virtual graphs into RDF files or keep them virtual
- Hybrid mode: decide which data to materialize in GraphDB vs. keep virtual

**How it fits Purple Fabric:**

```
CURRENT PIPELINE:
  NL Question → LLM Planner → LLM SQL Generator → Trino → LLM Answer
  (3-4 LLM calls, custom mapping format, custom validation)

POTENTIAL ONTOP PIPELINE:
  NL Question → LLM SPARQL Generator → GraphDB Ontop → SQL → Database → LLM Answer
  (2 LLM calls, W3C standard mappings, proven query optimizer)
```

| Aspect | Current VKG (Custom) | Ontop Integration |
|--------|---------------------|-------------------|
| Mapping format | Custom `vkgmap:` predicates | W3C R2RML standard |
| Query language | LLM generates raw SQL | LLM generates SPARQL (higher-level, less error-prone) |
| Query optimization | Trino optimizer only | Ontop optimizer + database optimizer |
| LLM calls per query | 3-4 (plan + SQL + validate + answer) | 2 (SPARQL + answer) |
| Error surface | LLM can hallucinate column names, table names, JOIN conditions | SPARQL is higher-level; R2RML mappings handle column/table resolution |
| Multi-DB federation | Trino (requires catalog setup) | Ontop supports Trino as a backend, or direct DB connections |
| Standards compliance | Proprietary | W3C R2RML, SPARQL 1.1 |
| Tooling | Custom UI for mapping review | Ontopic Studio (visual mapping editor), Protégé plugin |

**Key advantage:** SPARQL is a higher-level query language than SQL. When an LLM generates SPARQL against an ontology, it operates at the semantic level ("find Customers with high risk scores") rather than the physical level ("SELECT * FROM postgresql.public.customers c JOIN postgresql.public.risk_scores r ON c.customer_id = r.customer_id WHERE r.score > 400"). This reduces hallucination because the LLM doesn't need to know table names, column names, or JOIN conditions — the R2RML mappings handle that translation.

**Migration path:**
1. Convert existing `vkgmap:` annotations to R2RML mappings (automatable)
2. Create Ontop virtual repository in GraphDB pointing to existing databases
3. Replace LLM SQL generation with LLM SPARQL generation
4. Keep Trino as a backend for cross-database federation, or use Ontop's native multi-DB support
5. Retain the existing retry and drift detection logic

### 6.2 FedX (Federated SPARQL Across Multiple Endpoints)

[FedX](https://graphdb.ontotext.com/documentation/10.8/fedx-federation.html) is GraphDB's built-in federation engine (from the RDF4J framework). It creates a virtual SPARQL endpoint that transparently queries multiple SPARQL endpoints and joins results.

(Content was rephrased for compliance with licensing restrictions)

**What FedX provides:**
- Transparent federation of multiple SPARQL endpoints under a single virtual endpoint
- Automatic source selection — no need for explicit SERVICE clauses
- Optimized join processing to minimize remote requests
- Can federate: local GraphDB repositories, remote SPARQL endpoints, and Ontop virtual repositories

**How it fits Purple Fabric:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    FedX VIRTUAL ENDPOINT                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  GraphDB      │  │  Ontop       │  │  External SPARQL     │ │
│  │  (Ontology +  │  │  (Virtual    │  │  Endpoints           │ │
│  │   Enriched    │  │   DB access) │  │  (Partner data,      │ │
│  │   Data)       │  │              │  │   public datasets)   │ │
│  └──────────────┘  └──────────────┘  └──────────────────────┘ │
│                                                                 │
│  Single SPARQL query → FedX routes to relevant sources          │
│  → Joins results transparently → Returns unified result         │
└─────────────────────────────────────────────────────────────────┘
```

**Use cases for Purple Fabric:**

1. **Unified ontology + live data queries** — A single SPARQL query could join ontology definitions (from GraphDB) with live database records (via Ontop) without the application needing to orchestrate two separate queries.

2. **Cross-workspace federation** — FedX could federate across multiple GraphDB repositories (one per workspace or tenant), enabling cross-workspace analytics without violating data isolation at the storage level.

3. **External data enrichment** — Federate with public SPARQL endpoints (DBpedia, Wikidata, domain-specific datasets) to enrich local data with external context.

4. **Hybrid materialized + virtual** — Keep frequently-queried data materialized in GraphDB for speed, while keeping rarely-accessed or large datasets virtual via Ontop. FedX makes both look like one graph.

### 6.3 Combined Vision: Ontop + FedX

The most powerful configuration combines both:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PURPLE FABRIC — FUTURE STATE                  │
│                                                                 │
│  User: "Show me high-risk customers from our banking DB         │
│         who also appear in the AML watchlist documents"          │
│                                                                 │
│  LLM generates ONE SPARQL query                                 │
│         │                                                       │
│         ▼                                                       │
│  ┌─── FedX Virtual Endpoint ──────────────────────────────┐    │
│  │                                                         │    │
│  │  Source 1: GraphDB (enriched document entities)          │    │
│  │  → Finds AML watchlist entities from enriched PDFs      │    │
│  │                                                         │    │
│  │  Source 2: Ontop (virtual DB access)                     │    │
│  │  → Queries live banking database for risk scores         │    │
│  │                                                         │    │
│  │  FedX joins results transparently                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│         │                                                       │
│         ▼                                                       │
│  LLM generates natural language answer with citations           │
└─────────────────────────────────────────────────────────────────┘
```

This would allow a single SPARQL query to span enriched document data (materialized in GraphDB) and live database records (virtual via Ontop), joined transparently by FedX. The current architecture requires the LLM planner to orchestrate separate graph and VKG retrievals and fuse them in application code.

### 6.4 Adoption Considerations

| Factor | Assessment |
|--------|-----------|
| GraphDB licensing | Ontop and FedX are available in all GraphDB editions (Free, Standard, Enterprise) |
| Migration effort | Medium — R2RML mapping generation can be automated from existing `vkgmap:` annotations |
| Risk | Low — can run in parallel with existing VKG pipeline during transition |
| LLM SPARQL generation | Proven approach — LangChain has a [GraphDB integration](https://docs.langchain.com/oss/python/integrations/graphs/ontotext) for NLQ-to-SPARQL |
| FedX maturity | Experimental in GraphDB — suitable for non-critical paths first |
| Ontop maturity | Production-grade — used in enterprise deployments, backed by academic research since 2014 |
| Performance | Ontop's query optimizer is well-benchmarked; may outperform LLM-generated SQL for complex joins |

---

## 7. Advantages

### 7.1 For the Business

| Advantage | Impact |
|-----------|--------|
| Natural language access to all data | Non-technical users can query databases, documents, and entity graphs without SQL/Cypher |
| Single semantic model | One ontology governs all query paths — consistency across the platform |
| No data movement for VKG | Query live databases without ETL, always-current results |
| Agents that learn | Memory accumulates domain knowledge and user preferences over time |
| Multi-tenant isolation | Ontologies, data, memory, and queries are fully isolated per tenant/workspace |
| Domain-specific agents | Each agent can have different ontologies + memory, creating specialized AI assistants |

### 7.2 For Engineering

| Advantage | Impact |
|-----------|--------|
| Ontology-guided Cypher generation | LLM produces precise, schema-aware queries instead of generic keyword searches |
| Strict validation pipeline | GraphDB triple service validates every triple against the ontology — no force-mapping |
| Versioned ontologies | Full version history with rollback, branching, and tagging |
| Dual-pool memory | User preferences survive agent deletion; domain knowledge is agent-scoped |
| Deterministic data profiling | Column type detection and FK discovery without LLM (faster, cheaper, reproducible) |
| Self-healing SQL | VKG retries failed queries up to 3 times with error feedback to the LLM |
| Federated queries | Trino enables cross-database JOINs (MySQL + PostgreSQL in one query) |

### 7.3 Compared to Alternatives

| Approach | Purple Fabric | Traditional ETL + DW | Direct LLM SQL | ChatGPT/Copilot |
|----------|--------------|----------------------|----------------|-----------------|
| Data freshness | Real-time (VKG) | Stale (batch ETL) | Real-time | N/A (no DB access) |
| Schema understanding | Formal ontology | Implicit in ETL | None (guesses) | None |
| Cross-DB queries | Yes (Trino) | After consolidation | No | No |
| Query accuracy | High (ontology + validation) | N/A (pre-built) | Low | Low |
| Long-term memory | Yes (dual-pool, 3-tier) | No | No | Limited (session only) |
| Multi-tenant | Built-in | Complex | Not addressed | Not addressed |
| Standards path | R2RML/SPARQL via Ontop | Proprietary | Proprietary | Proprietary |

---

## 8. Challenges & Mitigations

### 8.1 Ontology Design Complexity

**Challenge:** Creating a good ontology requires domain expertise. A poorly designed ontology leads to poor query results.

**Current Mitigations:**
- LLM-assisted ontology generation from prompts and database schemas
- Global ontology library (pre-built for common domains: banking, legal, AML)
- Fork-and-customize model (start from global, adapt per workspace)
- CSV schema analyzer suggests entity types and relationships from data

**Remaining Risk:** Medium. Ontology quality directly impacts query quality. Requires domain expert review.

### 8.2 LLM Dependency in Query Pipeline

**Challenge:** Both Neo4j Cypher generation and VKG SQL generation depend on LLM calls. LLM errors propagate to query failures.

**Current Mitigations:**
- VKG has 3-attempt retry loop with error feedback
- SQL validation catches column/table mismatches before execution
- Ontology-guided Cypher falls back to keyword search on failure
- Conversation history enables follow-up resolution

**Future Mitigation:** Ontop adoption would reduce LLM error surface — SPARQL is higher-level than SQL, and R2RML mappings handle physical-to-logical translation.

**Remaining Risk:** Low-Medium. LLM hallucination of column names is the most common failure mode.

### 8.3 Schema Drift

**Challenge:** Database schemas change over time. Ontology mappings can become stale.

**Current Mitigations:**
- Background drift detection on every VKG query
- Warnings surfaced in query responses
- "Regenerate ontology" option to rebuild from current schema

**Remaining Risk:** Low. Drift is detected but not auto-corrected.

### 8.4 Memory Scaling & Relevance Decay

**Challenge:** As agents accumulate hundreds of memories, recall quality may degrade. Irrelevant old memories could pollute context.

**Current Mitigations:**
- Vector search ensures only query-relevant memories are recalled (top 5 by cosine similarity)
- Memory consolidation deduplicates redundant entries
- Core memory is capped at 500 words and updated by LLM
- Memory decay function available (reduces importance over time)
- Dual-pool separation prevents agent domain knowledge from mixing with user preferences

**Remaining Risk:** Low-Medium. May need periodic memory pruning or summarization for very long-lived agents.

### 8.5 Memory Privacy & Cross-Tenant Isolation

**Challenge:** Memory contains potentially sensitive information (user preferences, business decisions, entity references). Must be strictly isolated.

**Current Mitigations:**
- Agent pool: scoped to `agentId:userId` — no cross-agent or cross-user leakage
- User pool: scoped to `userId` — follows the user but never shared across users
- Redis key prefixes enforce isolation at the storage level
- Memory is never included in responses to other users

**Remaining Risk:** Low. Isolation is enforced at the key-prefix level in Redis.

### 8.6 Performance at Scale

**Challenge:** Multiple LLM calls per query (planner + Cypher/SQL generation + answer generation + memory extraction). GraphDB SPARQL queries for schema loading.

**Current Mitigations:**
- Parallel retrieval (vector, graph, VKG, memory all run simultaneously)
- Schema caching (compact schema summaries)
- Token budgeting in context fusion (caps context to 6000 tokens)
- Memory extraction is fire-and-forget (never blocks the response)
- Trino handles database-level query optimization

**Remaining Risk:** Medium. Each agent query involves 3-4 LLM calls. Acceptable for conversational use, may need optimization for batch workloads.

### 8.7 Ontology-Neo4j Schema Mismatch

**Challenge:** The ontology (in GraphDB) and the actual Neo4j data may diverge.

**Current Mitigation:** When generating Cypher, the system loads both the ontology AND the live Neo4j schema. The prompt explicitly states: "When they conflict, trust the Neo4j schema."

**Remaining Risk:** Low. The dual-schema approach handles this well.

---

## 9. Implementation Maturity

| Component | Status | Notes |
|-----------|--------|-------|
| OWL ontology import/export | Production | Turtle, RDF/XML, JSON-LD support |
| GraphDB storage with named graphs | Production | Full tenant/workspace isolation |
| Ontology versioning | Production | Versions, branches, tags, rollback |
| Ontology-guided Neo4j Cypher | Production | With conversation history for follow-ups |
| VKG ontology generation from DB | Production | LLM + deterministic profiling |
| VKG NL-to-SQL pipeline | Production | 3-attempt retry, validation, drift detection |
| Column mapping for CSV/Excel | Production | Domain-aware routing, multi-sheet FK detection |
| GraphDB → Neo4j sync | Production | Batched (10K), orphan cleanup |
| Extraction with ontology validation | Production | Strict — rejects unmapped entities |
| Global ontology library | Production | Pre-built domain ontologies |
| LLM ontology generation from prompt | Production | Generates OWL from natural language |
| Schema drift detection | Production | Non-blocking, per-query |
| Agent memory (dual-pool, 3-tier) | Production | Vector search, core memory, session history |
| Memory extraction & consolidation | Production | LLM-based, fire-and-forget |
| Memory graph visualization | Production | LLM-extracted entity graph from memories |
| Session management (lazy creation) | Production | No empty sessions stored, timestamps, UI |
| GraphDB Ontop integration | Not started | Strategic opportunity — see Section 6 |
| FedX federation | Not started | Experimental in GraphDB — evaluate for cross-workspace |

---

## 10. Recommended Next Steps

### Near-Term (Current Architecture)

1. **Ontology Quality Dashboard** — Surface metrics on ontology coverage, query success rates per ontology, and common LLM failures.

2. **Memory Analytics** — Track memory accumulation rates, recall hit rates, and core memory update frequency per agent to identify which agents are learning effectively.

3. **Auto-Correction for Schema Drift** — When drift is detected, automatically suggest ontology patches rather than requiring full regeneration.

4. **Ontology Diff & Merge** — Enable comparing two ontology versions side-by-side and merging changes across workspaces.

### Medium-Term (Ontop Adoption)

5. **Ontop Proof of Concept** — Set up a GraphDB Ontop virtual repository against one existing database. Convert `vkgmap:` annotations to R2RML mappings. Compare query accuracy and latency against the current LLM-SQL pipeline.

6. **SPARQL Generation Evaluation** — Test LLM SPARQL generation (using the ontology as context) against the current LLM SQL generation. Measure: error rate, retry frequency, latency, and answer quality.

7. **R2RML Mapping Generator** — Build a tool to automatically convert existing `vkgmap:` annotations to R2RML format, enabling gradual migration.

### Long-Term (Federation)

8. **FedX Evaluation** — Test FedX federation across a local GraphDB repository and an Ontop virtual repository. Measure: query latency, join accuracy, and failure modes.

9. **Cross-Workspace Analytics** — Use FedX to enable controlled cross-workspace queries for admin/analytics use cases without violating tenant isolation at the storage level.

10. **External Data Federation** — Evaluate federating with public SPARQL endpoints (industry datasets, regulatory databases) to enrich local data with external context.
