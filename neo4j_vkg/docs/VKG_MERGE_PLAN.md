# Enterprise Merge Plan: VKG + Knowledge Graph Platform

## Overview

Merge the VKG POC (virtual federated querying) into the Enterprise Knowledge Graph Platform (neo4j project) as a new capability. The platform gains the ability to query live source databases without materializing data, while keeping all existing document ingestion and materialized graph features intact.

**Result**: One platform, two data paths — materialized (documents → graph) and virtual (live databases → federated SQL) — sharing the same ontology layer, LLM service, and UI.

---

## Phase 1: Trino Infrastructure (Week 1-2)

**Goal**: Add Trino as a federated query engine alongside existing GraphDB/Neo4j/Redis.

### 1.1 Docker Compose — Add Trino Service

File: `docker-compose.yml`

Add Trino coordinator container. No source databases bundled — those are configured per-tenant at runtime.

```yaml
trino:
  image: trinodb/trino:435
  expose:
    - "8080"
  volumes:
    - trino_catalog:/etc/trino/catalog
    - ./trino/config.properties:/etc/trino/config.properties:ro
    - ./trino/jvm.config:/etc/trino/jvm.config:ro
  environment:
    TRINO_HEAP_SIZE: 2G
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8080/v1/info"]
    interval: 10s
    timeout: 5s
    retries: 10
  restart: unless-stopped
```

### 1.2 Trino Base Configuration

Create `trino/config.properties`:
```properties
coordinator=true
node-scheduler.include-coordinator=true
http-server.http.port=8080
discovery.uri=http://localhost:8080
query.max-memory=1GB
query.max-memory-per-node=512MB
```

### 1.3 Environment Variables

Add to `.env.template`:
```
# Trino (Federated Query Engine)
TRINO_URL=http://localhost:8080
TRINO_USER=trino
```

### 1.4 Trino Config Module

New file: `server/config/trino.js`

Manages Trino HTTP client for executing SQL and introspecting catalogs. Uses Trino's REST API (`/v1/statement`) to submit queries and poll for results.

### Deliverables
- [ ] Trino container in docker-compose
- [ ] Trino base config files
- [ ] `server/config/trino.js` — connection module
- [ ] Health check includes Trino status
- [ ] Trino accessible from app container

---

## Phase 2: Catalog Management Service (Week 2-3)

**Goal**: Allow users to register external databases as Trino catalogs, per-tenant.

### 2.1 Trino Catalog Manager Service

New file: `server/services/trinoCatalogService.js`

This service dynamically creates Trino catalog `.properties` files and triggers catalog reload. Each catalog maps to one external database.

```
Key Methods:
  registerCatalog(tenantId, config)
    → Validates connection params
    → Writes catalog .properties file to Trino volume
    → Triggers Trino catalog refresh
    → Stores catalog metadata in Redis (per-tenant)

  removeCatalog(tenantId, catalogName)
    → Removes .properties file
    → Cleans up Redis metadata

  listCatalogs(tenantId)
    → Returns registered catalogs for tenant

  testCatalog(tenantId, catalogName)
    → Runs "SELECT 1" via Trino to verify connectivity

  introspectCatalog(tenantId, catalogName)
    → Queries Trino information_schema
    → Returns tables, columns, PKs, FKs
    → Detects relationships from foreign keys
```

Supported connector types (Trino built-in):
- `postgresql`
- `mysql`
- `mariadb`
- `sqlserver`
- `oracle`
- `clickhouse`
- `mongodb` (via Trino MongoDB connector)

### 2.2 Catalog Metadata Storage

Store in Redis per-tenant:
```
Key: tenant:{tenantId}:trino:catalogs
Value: {
  "customer_db": {
    "connector": "postgresql",
    "host": "db.example.com",
    "port": 5432,
    "database": "customers_db",
    "schema": "public",
    "registeredAt": "2026-02-22T...",
    "status": "active"
  }
}
```

### 2.3 API Route

New file: `server/routes/trinoCatalogs.js`

```
POST   /api/trino/catalogs              — Register new catalog
GET    /api/trino/catalogs              — List catalogs for tenant
DELETE /api/trino/catalogs/:name        — Remove catalog
POST   /api/trino/catalogs/:name/test   — Test connectivity
GET    /api/trino/catalogs/:name/schema — Introspect schema
```

### 2.4 Relationship to Existing JDBC Service

The existing `jdbcConnectorService.js` connects directly to databases (pg, mysql, sqlite). The new `trinoCatalogService.js` registers databases with Trino instead. Both use similar schema introspection logic. Refactor shared introspection code into a common `schemaIntrospector.js` utility.

### Deliverables
- [ ] `server/services/trinoCatalogService.js`
- [ ] `server/routes/trinoCatalogs.js`
- [ ] Redis schema for catalog metadata
- [ ] Shared `server/utils/schemaIntrospector.js`
- [ ] Catalog CRUD + test + introspect working

---

## Phase 3: VKG Ontology Bootstrapping (Week 3-4)

**Goal**: Auto-generate an ontology from Trino catalog schemas and store it in GraphDB with mapping annotations.

### 3.1 VKG Ontology Generator

New file: `server/services/vkgOntologyService.js`

This is the bridge between Trino schemas and the ontology layer. It reads database schemas from Trino, uses the LLM to generate a semantic ontology, and stores it in GraphDB with source-mapping annotations.

```
Key Methods:
  generateFromCatalogs(tenantId, workspaceId, catalogNames)
    → Step 1: Introspect each catalog via trinoCatalogService
    → Step 2: Build schema description (tables, columns, PKs, FKs)
    → Step 3: Send to LLM with ontology generation prompt
    → Step 4: LLM returns OWL/Turtle with mapping annotations
    → Step 5: Store in GraphDB as named graph:
              graphs/tenant/{id}/workspace/{id}/vkg-schema
    → Step 6: Return ontology for user review

  refreshFromCatalogs(tenantId, workspaceId)
    → Re-introspect catalogs
    → Diff against existing ontology
    → Surface changes (new tables, removed columns, etc.)
    → User approves changes

  getMappingAnnotations(tenantId, workspaceId)
    → SPARQL query to extract :sourceTable, :sourceColumn,
      :sourceIdColumn, :joinPath annotations from GraphDB
    → Returns structured mapping object for SQL generation
```

### 3.2 LLM Prompt for Schema-to-Ontology

The prompt sends the LLM:
1. Table/column metadata from all catalogs
2. Foreign key relationships
3. Instructions to output Turtle format with custom mapping predicates

Custom mapping predicates (stored as RDF in GraphDB):
```turtle
@prefix vkgmap: <http://example.org/vkg/mapping/> .

:Customer a owl:Class ;
    rdfs:label "Customer" ;
    vkgmap:sourceTable "customer_db.public.customers" ;
    vkgmap:sourceIdColumn "customer_id" .

:firstName a owl:DatatypeProperty ;
    rdfs:domain :Customer ;
    rdfs:range xsd:string ;
    vkgmap:sourceColumn "first_name" .

:hasTransaction a owl:ObjectProperty ;
    rdfs:domain :Customer ;
    rdfs:range :Transaction ;
    vkgmap:joinSQL "customers.customer_id = transactions.customer_id" ;
    vkgmap:sourceCatalog "payments_db" .
```

### 3.3 Integration with Existing Ontology Management

The generated VKG ontology appears in the existing Ontologies page alongside uploaded ontologies. Users can:
- Edit classes/properties (existing ontology editor)
- Version the ontology (existing `ontologyVersioningService.js`)
- Merge with other ontologies
- Mark it as `scope: vkg` to distinguish from document-sourced ontologies

### 3.4 Schema Drift Detection

New file: `server/services/schemaDriftService.js`

Periodically (or on-demand) re-introspects Trino catalogs and compares against stored ontology. Surfaces:
- New tables/columns not in ontology
- Removed tables/columns still referenced
- Type changes
- New foreign keys (potential new relationships)

Uses existing `schemaVersioningService.js` patterns.

### Deliverables
- [ ] `server/services/vkgOntologyService.js`
- [ ] LLM prompt for schema-to-ontology generation
- [ ] Custom `vkgmap:` predicates stored in GraphDB
- [ ] VKG ontologies visible in existing Ontologies UI
- [ ] `server/services/schemaDriftService.js`
- [ ] Schema diff and refresh flow

---

## Phase 4: VKG Query Engine (Week 4-6)

**Goal**: Natural language → Trino SQL → Results, using ontology from GraphDB.

### 4.1 VKG Query Service

New file: `server/services/vkgQueryService.js`

The core query engine. This is the Node.js equivalent of the VKG POC's `runner.py`, but uses existing platform services instead of standalone Python classes.

```
Key Methods:
  async query(question, tenantId, workspaceId, options)
    → Step 1: Load ontology schema from GraphDB
              (reuse graphDBStore.getClasses/getObjectProperties/getDataProperties)
    → Step 2: Load mapping annotations from GraphDB
              (vkgOntologyService.getMappingAnnotations)
    → Step 3: Load Trino catalog schemas from cache/introspection
    → Step 4: LLM generates execution plan
              (entities, relationships, single/multi-hop)
    → Step 5: LLM generates Trino SQL
              (using ontology + mappings + catalog schemas as context)
    → Step 6: Validate SQL offline
              (table/column existence check against cached schema)
    → Step 7: Execute SQL on Trino
              (via server/config/trino.js)
    → Step 8: Build context graph from results + ontology
    → Step 9: Build reasoning trace with provenance
    → Step 10: LLM generates natural language answer
    → Return unified response
```

### 4.2 SQL Validator

New file: `server/services/sqlValidatorService.js`

Lightweight offline validation before Trino execution:
- Parse SQL syntax (basic regex + structure check)
- Verify all `catalog.schema.table` references exist in registered catalogs
- Verify column names exist in introspected schema
- Check JOIN keys reference valid columns
- No LLM call — fast and deterministic

### 4.3 Context Graph Builder

New file: `server/services/contextGraphBuilder.js`

Builds an ephemeral evidence graph from query results + ontology. Ported from VKG POC's `ContextGraphBuilder` Python class, rewritten in Node.js.

```
Key Methods:
  buildGraph(rows, columns, ontologySchema, mappingAnnotations)
    → For each column, resolve to ontology class via mapping annotations
    → For each row, create typed nodes (deduplicated)
    → For each pair of related columns, create edges using ontology relationships
    → Attach provenance: source catalog, table, SQL, row index
    → Return { nodes, edges, statistics }

  buildReasoningTrace(graph, rows, question)
    → Walk the graph structure
    → Generate step-by-step evidence chain
    → Each step references specific nodes/edges
    → Include database sources traversed
    → Return [ { step, evidence, sources } ]
```

### 4.4 LLM Prompts for VKG

New directory: `server/services/prompts/vkg/`

```
plan-generator.md     — Analyzes question, identifies entities/relationships
sql-generator.md      — Generates Trino SQL from ontology + mappings + question
answer-generator.md   — Generates natural language answer from results
```

These are versioned prompt files, similar to VKG POC's `queries_and_prompts/prompts/` directory.

### 4.5 Caching Layer

Use Redis to cache:
- Trino catalog schemas (TTL: 1 hour)
- Ontology schema + mappings (TTL: 5 minutes, invalidate on edit)
- Query results (optional, keyed by normalized SQL, TTL: configurable)

### 4.6 Integration with GraphRAGService

Add `queryVKG()` method to existing `graphRAGService.js` as a new query mode. The Chat component's mode selector gains a "Federated (VKG)" option alongside existing RAG/Graph/Hybrid modes.

Alternatively, keep `vkgQueryService.js` standalone and route to it from the chat route based on selected mode. Cleaner separation.

### Deliverables
- [ ] `server/services/vkgQueryService.js`
- [ ] `server/services/sqlValidatorService.js`
- [ ] `server/services/contextGraphBuilder.js`
- [ ] LLM prompt files for VKG
- [ ] Redis caching for schemas and results
- [ ] VKG query mode accessible from chat route
- [ ] Unified response format with context graph + reasoning trace

---

## Phase 5: API Routes & Response Format (Week 5-6)

### 5.1 VKG Query Route

New file: `server/routes/vkgQuery.js`

```
POST /api/vkg/query
  Body: { question, workspaceId }
  Response: {
    answer: "Customer 1 purchased from 7 categories...",
    context_graph: {
      nodes: [ { id, type, value, source, provenance } ],
      edges: [ { source, target, relation, provenance } ],
      statistics: { node_count, edge_count, cardinality, databases_queried }
    },
    reasoning_trace: [
      { step: "Identified Customer...", evidence: [...], sources: ["postgresql"] }
    ],
    citations: {
      sql: "SELECT DISTINCT mc.category_name FROM...",
      databases: ["postgresql.public", "mysql.payments_db", "mariadb.commerce_db"]
    },
    execution_stats: {
      total_ms: 3200,
      plan_generation_ms: 800,
      sql_generation_ms: 1200,
      validation_ms: 50,
      execution_ms: 400,
      graph_build_ms: 100,
      answer_generation_ms: 600,
      rows_returned: 7,
      databases_queried: 3
    },
    query_mode: "vkg_federated"
  }
```

### 5.2 Unified Response Format

Both materialized (chat) and VKG paths return the same response shape. Extend existing chat response to include optional `context_graph` and `reasoning_trace` fields. This means the materialized path can also benefit from context graph building in the future.

```javascript
// Unified response shape (both paths)
{
  answer: String,
  sources: Array,           // existing (materialized path)
  context_graph: Object,    // new (VKG path, optional for materialized)
  reasoning_trace: Array,   // new (VKG path, optional for materialized)
  citations: Object,        // new (SQL/SPARQL used)
  execution_stats: Object,  // new (timing breakdown)
  query_mode: String        // "rag" | "graph" | "hybrid" | "vkg_federated"
}
```

### Deliverables
- [ ] `server/routes/vkgQuery.js`
- [ ] Unified response format documented
- [ ] Route registered in `server/index.js`
- [ ] Tenant/workspace context middleware applied

---

## Phase 6: Frontend — VKG UI Components (Week 6-8)

### 6.1 New Navigation Item

Add to sidebar in `App.js`:
```javascript
{ id: 'vkg', icon: '🔗', label: 'Federated Query', minRole: 'viewer' }
```

### 6.2 Data Sources Manager (Extend DatabaseManager)

Extend existing `DatabaseManager.js` or create new `DataSourcesManager.js`:
- Register Trino catalogs (database type, host, port, credentials)
- Test connectivity
- View introspected schema (tables, columns, relationships)
- Trigger ontology generation from selected catalogs
- View schema drift alerts

### 6.3 VKG Query Interface

New file: `client/src/components/VKGQuery.js`

Main query interface for federated queries:
- Natural language input
- Suggested questions (generated from ontology entities)
- Results display:
  - Answer text
  - Context graph visualization (Cytoscape.js — reuse existing graph component)
  - Reasoning trace (collapsible step-by-step)
  - SQL citation (syntax-highlighted, collapsible)
  - Execution pipeline (timing breakdown per step)
  - Database sources badge (which DBs were queried)

### 6.4 Context Graph Visualization

New file: `client/src/components/ContextGraphView.js`

Reuses existing `GraphVisualization.js` Cytoscape.js setup but with:
- Color-coded nodes by ontology class type
- Edge labels from ontology relationship names
- Provenance tooltips (hover shows source database + table)
- Database source legend

### 6.5 Reasoning Trace Panel

New file: `client/src/components/ReasoningTrace.js`

Displays the step-by-step evidence chain:
- Each step is collapsible
- Shows evidence nodes/edges referenced
- Shows which database each piece of evidence came from
- Clickable evidence items highlight corresponding graph nodes

### 6.6 VKG Mode in Chat

Add "Federated" as a query mode option in the existing Chat component. When selected, queries route through `/api/vkg/query` instead of `/api/chat/query`. Response renders with context graph and reasoning trace panels below the answer.

### Deliverables
- [ ] Sidebar navigation updated
- [ ] Data Sources Manager UI
- [ ] `VKGQuery.js` — main query interface
- [ ] `ContextGraphView.js` — graph visualization
- [ ] `ReasoningTrace.js` — evidence display
- [ ] VKG mode in Chat component
- [ ] CSS for all new components

---

## Phase 7: Context Graph for Materialized Path (Week 8-9)

**Goal**: Bring context graph + reasoning trace to the existing materialized query path too.

### 7.1 Extend GraphRAGService Responses

When `graphRAGService` queries GraphDB or Neo4j, pass the results through `contextGraphBuilder.buildGraph()` before returning. The ontology schema is already available in GraphDB.

This gives the materialized path the same explainability as the VKG path:
- Context graph showing which entities and relationships were used
- Reasoning trace showing how the answer was derived
- Citations showing the SPARQL/Cypher query used

### 7.2 Unified Evidence UI

Both paths now render the same `ContextGraphView` and `ReasoningTrace` components. The Chat component detects if `context_graph` is present in the response and renders the evidence panels.

### Deliverables
- [ ] Context graph building for GraphDB query results
- [ ] Context graph building for Neo4j query results
- [ ] Chat component renders evidence panels for all query modes

---

## Phase 8: Security, Multi-Tenancy & RBAC (Week 9-10)

### 8.1 Catalog Isolation

Each tenant's Trino catalogs are namespaced:
- Catalog names: `{tenantId}_{catalogName}` (e.g., `tenant1_customers_db`)
- Catalog metadata in Redis: `tenant:{tenantId}:trino:catalogs`
- VKG ontology in GraphDB: `graphs/tenant/{id}/workspace/{id}/vkg-schema`

### 8.2 Credential Encryption

Database credentials for Trino catalogs encrypted at rest using existing `server/utils/tokenEncryption.js`. Credentials stored in Redis, decrypted only when writing Trino catalog `.properties` files.

### 8.3 RBAC for VKG

Extend existing `rbacService.js`:
- `viewer`: Can run VKG queries
- `member`: Can run VKG queries
- `manager`: Can register/remove catalogs, trigger ontology generation
- `admin`: Full access + cross-tenant catalog management

### 8.4 Query Audit Trail

Extend existing `activityAuditService.js` to log VKG queries:
- Question asked
- SQL generated
- Databases queried
- Rows returned
- Execution time
- User who ran the query

### 8.5 SQL Injection Prevention

The SQL validator (Phase 4) also checks for:
- No DDL statements (CREATE, DROP, ALTER, TRUNCATE)
- No DML statements (INSERT, UPDATE, DELETE)
- Only SELECT queries allowed
- No system table access (information_schema queries blocked at query time)
- Parameterized values where possible

### Deliverables
- [ ] Tenant-namespaced Trino catalogs
- [ ] Credential encryption for catalog configs
- [ ] RBAC rules for VKG operations
- [ ] Audit trail for VKG queries
- [ ] SQL injection prevention in validator

---

## Phase 9: Background Jobs & Monitoring (Week 10-11)

### 9.1 VKG Job Processors

Extend existing BullMQ workers (`server/workers/index.js`):

```
New queues:
  vkg-schema-introspection  — Introspect catalog schemas (can be slow for large DBs)
  vkg-ontology-generation   — LLM ontology generation from schemas
  vkg-schema-drift-check    — Periodic schema drift detection
```

These run as background jobs so the UI doesn't block on slow operations.

### 9.2 Monitoring & Metrics

Extend existing `metricsService.js`:
- VKG queries per minute
- Average query latency (broken down by step)
- Trino query success/failure rate
- Catalog health status
- Schema drift alerts count

### 9.3 Health Check

Extend existing `scripts/health-check.js`:
- Trino coordinator reachable
- Each registered catalog connectable
- VKG ontology exists for workspace

### Deliverables
- [ ] BullMQ queues for VKG background jobs
- [ ] Job status visible in existing Jobs UI
- [ ] Metrics for VKG operations
- [ ] Health check includes Trino + catalogs

---

## Phase 10: Testing & Documentation (Week 11-12)

### 10.1 Test Suite

```
server/services/__tests__/
  vkgQueryService.test.js        — Unit tests for query pipeline
  trinoCatalogService.test.js    — Catalog CRUD tests
  vkgOntologyService.test.js     — Ontology generation tests
  contextGraphBuilder.test.js    — Graph building tests
  sqlValidatorService.test.js    — SQL validation tests
  schemaDriftService.test.js     — Schema drift detection tests
```

### 10.2 Integration Tests

- End-to-end: Register catalog → Generate ontology → Ask question → Get answer with evidence
- Multi-tenant isolation: Tenant A can't query Tenant B's catalogs
- Schema drift: Change source DB schema → Detect drift → Refresh ontology

### 10.3 Documentation

- Update `README.md` with VKG setup instructions
- Update `ARCHITECTURE_FLOW.md` with merged flow diagrams
- Update `docs/openapi.yaml` with new VKG endpoints
- Add `DEVELOPMENT_GUIDELINES.md` section for VKG development

### Deliverables
- [ ] Unit tests for all new services
- [ ] Integration test suite
- [ ] Updated documentation
- [ ] Updated OpenAPI spec

---

## New Files Summary

```
server/
  config/
    trino.js                          — Trino connection module
  services/
    trinoCatalogService.js            — Catalog CRUD + introspection
    vkgOntologyService.js             — Schema → Ontology generation
    vkgQueryService.js                — Core VKG query engine
    sqlValidatorService.js            — Offline SQL validation
    contextGraphBuilder.js            — Evidence graph construction
    schemaDriftService.js             — Schema change detection
    prompts/
      vkg/
        plan-generator.md             — Query plan prompt
        sql-generator.md              — SQL generation prompt
        answer-generator.md           — Answer generation prompt
  routes/
    trinoCatalogs.js                  — Catalog management API
    vkgQuery.js                       — VKG query API
  utils/
    schemaIntrospector.js             — Shared schema introspection

client/src/components/
  VKGQuery.js                         — Federated query interface
  VKGQuery.css
  DataSourcesManager.js               — Catalog registration UI
  DataSourcesManager.css
  ContextGraphView.js                 — Evidence graph visualization
  ContextGraphView.css
  ReasoningTrace.js                   — Step-by-step evidence display
  ReasoningTrace.css

trino/
  config.properties                   — Trino coordinator config
  jvm.config                          — JVM settings
```

## Modified Files Summary

```
docker-compose.yml                    — Add Trino service
.env.template                         — Add TRINO_URL, TRINO_USER
server/index.js                       — Register new routes
server/workers/index.js               — Add VKG job queues
server/services/graphRAGService.js    — Add VKG query mode option
server/middleware/auth.js             — VKG route auth
server/config/roles.js                — VKG RBAC permissions
client/src/App.js                     — Add VKG navigation + section
client/src/components/Chat.js         — Add "Federated" query mode
scripts/health-check.js              — Add Trino health check
docs/openapi.yaml                     — Add VKG endpoints
README.md                             — Add VKG setup section
ARCHITECTURE_FLOW.md                  — Add merged flow diagrams
```

---

## Timeline Summary

| Phase | What | Duration |
|-------|------|----------|
| 1 | Trino Infrastructure | Week 1-2 |
| 2 | Catalog Management Service | Week 2-3 |
| 3 | VKG Ontology Bootstrapping | Week 3-4 |
| 4 | VKG Query Engine | Week 4-6 |
| 5 | API Routes & Response Format | Week 5-6 |
| 6 | Frontend — VKG UI Components | Week 6-8 |
| 7 | Context Graph for Materialized Path | Week 8-9 |
| 8 | Security, Multi-Tenancy & RBAC | Week 9-10 |
| 9 | Background Jobs & Monitoring | Week 10-11 |
| 10 | Testing & Documentation | Week 11-12 |

Phases 4+5 and 6 can overlap. Phases 8+9 can overlap. Realistic total: **10-12 weeks** for a single developer, **6-8 weeks** with two developers working in parallel (one backend, one frontend).

---

## What Gets Retired from VKG POC

After merge, the entire `vkg-poc/` project is retired:
- `runner.py` → Logic absorbed into `vkgQueryService.js`
- `ui/app.py` → Replaced by React frontend
- `ontology/poc.ttl` → Imported as a sample ontology into GraphDB
- `mappings/poc.obda` → Replaced by mapping annotations in GraphDB
- `docker-compose.yml` → Source DB containers not bundled; Trino config merged
- `queries_and_prompts/prompts/` → Ported to `server/services/prompts/vkg/`
- `validation/` → Test patterns absorbed into Jest test suite

The VKG POC's sample databases (PostgreSQL customers, MySQL transactions, MariaDB merchants, ClickHouse analytics) can be kept as a separate `docker-compose.sample-data.yml` for demo/testing purposes.
