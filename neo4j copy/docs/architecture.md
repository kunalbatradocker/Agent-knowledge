# Purple Fabric — Technical Architecture Document

**Version:** 2.0  
**Date:** February 2026  
**Classification:** Internal — Technical Leadership  

---

## 1. Executive Summary

Purple Fabric is an enterprise-grade, multi-tenant knowledge graph platform that combines semantic web technologies (OWL/RDF/SPARQL), property graph analytics (Neo4j), vector embeddings (Redis), and AI-powered document processing (AWS Bedrock / OpenAI / Ollama) into a unified system for automated knowledge extraction, ontology management, and conversational graph querying.

The platform ingests structured (CSV/Excel) and unstructured (PDF/text) documents, extracts entities and relationships using LLM-powered pipelines, stores them as RDF triples in GraphDB with full ontology conformance, syncs to Neo4j for graph analytics and visualization, and provides a Graph RAG conversational interface for natural-language querying across the knowledge graph.

---

## 2. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLIENT (React SPA)                               │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌──────────┐ │
│  │ Knowledge │ │   Data    │ │ Ontology  │ │   Jobs    │ │  Admin   │ │
│  │ Assistant │ │Management │ │  Manager  │ │  Monitor  │ │  Panel   │ │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └────┬─────┘ │
└────────┼──────────────┼─────────────┼─────────────┼────────────┼────────┘
         │              │             │             │            │
         ▼              ▼             ▼             ▼            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    NGINX REVERSE PROXY (Port 80/443)                    │
│                    SSL Termination · Static Assets                      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    EXPRESS.JS SERVER (Port 5002)                        │
│                                                                         │
│  ┌─── Middleware Stack ──────────────────────────────────────────────┐  │
│  │ CORS → JSON Parser → CSRF → Rate Limiter → Activity Logger      │  │
│  │ → JWT Auth → RBAC → Tenant Context                              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── API Routes ───────────────────────────────────────────────────┐  │
│  │ /api/auth      /api/owl         /api/sparql     /api/entities   │  │
│  │ /api/chat      /api/ontology/*  /api/graph      /api/evidence   │  │
│  │ /api/admin     /api/tenants     /api/metrics    /api/settings   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── Service Layer ────────────────────────────────────────────────┐  │
│  │ GraphRAGService    ExtractionService    OWLOntologyService      │  │
│  │ LLMService         ChunkingService      VersioningService       │  │
│  │ EntityService      EmbeddingService     GraphDBTripleService    │  │
│  │ SchemaAnalysis     DataProfileService   GraphDBNeo4jSyncService │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────┬──────────────────┬──────────────────┬──────────────────────┘
             │                  │                  │
             ▼                  ▼                  ▼
┌────────────────────┐ ┌────────────────┐ ┌────────────────────┐
│     GraphDB        │ │     Neo4j      │ │      Redis         │
│  (RDF Triplestore) │ │ (Property Graph│ │ (Vector Store +    │
│                    │ │  + Analytics)  │ │  Cache + Queue)    │
│  Port 7200         │ │  Port 7687     │ │  Port 6379         │
│                    │ │                │ │                    │
│ • Schema graphs    │ │ • Entity nodes │ │ • Vector embeddings│
│ • Data graphs      │ │ • Relationships│ │ • Staging data     │
│ • Audit graphs     │ │ • Graph viz    │ │ • Column mappings  │
│ • Deprecated graphs│ │ • BFS traversal│ │ • Ontology versions│
│ • Global ontologies│ │                │ │ • Session/auth     │
│ • SPARQL engine    │ │                │ │ • BullMQ queues    │
└────────────────────┘ └────────────────┘ └────────────────────┘
```

---

## 3. Database Responsibilities (Separation of Concerns)

### 3.1 GraphDB (Authoritative RDF Store)

| Concern | Details |
|---------|---------|
| Role | Single source of truth for all semantic data |
| Format | RDF triples in Turtle (TTL) syntax |
| Query | SPARQL 1.1 |
| Isolation | Named graphs per tenant/workspace/ontology |

Named graph IRI patterns:

```
Global ontology:     http://example.org/graphs/global/ontology/{ontologyId}
Workspace schema:    http://purplefabric.ai/graphs/tenant/{t}/workspace/{w}/schema
Workspace data:      http://purplefabric.ai/graphs/tenant/{t}/workspace/{w}/data
Audit graph:         http://purplefabric.ai/graphs/tenant/{t}/workspace/{w}/audit
Deprecated graph:    http://purplefabric.ai/graphs/tenant/{t}/workspace/{w}/deprecated
```

What lives in GraphDB:
- OWL ontology definitions (classes, object properties, datatype properties, restrictions)
- Entity instance triples (rdf:type, rdfs:label, properties, relationships)
- Document provenance (pf:sourceDocument links)
- Audit/change events (who changed what, when)
- Deprecated schema elements (accumulation graph, never cleared)

### 3.2 Neo4j (Serving / Analytics Graph)

| Concern | Details |
|---------|---------|
| Role | Read-optimized property graph for visualization and traversal |
| Query | Cypher |
| Sync | One-way from GraphDB via `GraphDBNeo4jSyncService` |
| Scoping | `tenant_id` + `workspace_id` properties on every node |

What lives in Neo4j:
- Entity nodes with labels matching ontology classes
- Relationships matching ontology object properties
- Properties: `concept_id`, `tenant_id`, `workspace_id`, `name`, `label`
- Used for: entity listing, graph visualization (BFS), relationship traversal

### 3.3 Redis (Vector Store + Cache + Queue)

| Concern | Details |
|---------|---------|
| Role | Vector embeddings for RAG, staging area, cache, job queues |
| Index | RediSearch HNSW (cosine similarity, 1024-dim) |
| Persistence | AOF (append-only file) |

Key patterns:

```
chunk:{chunkId}              → Vector embedding + text + metadata (permanent)
staged:{docId}               → Staging data for uncommitted documents (7-day TTL)
doc:{docId}                  → Committed document metadata (permanent)
colmap:{workspaceId}:{ontId} → Column mapping configuration (permanent)
colmap_history:{w}:{o}       → Mapping version history (permanent)
ontology_version:{ontId}:*   → Ontology version snapshots (permanent)
session:{token}              → User session data
bull:*                       → BullMQ job queues
```

---

## 4. Multi-Tenant Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GLOBAL ONTOLOGY LIBRARY                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  Resume  │ │  Legal   │ │ Banking  │ │   AML    │          │
│  │ Ontology │ │ Contract │ │ Ontology │ │ Ontology │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│              (Read-only, shared across all tenants)             │
└─────────────────────────────┬───────────────────────────────────┘
                              │ fork / copy
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│    Tenant A      │ │    Tenant B      │ │    Tenant C      │
│ ┌──────────────┐ │ │ ┌──────────────┐ │ │ ┌──────────────┐ │
│ │ Workspace 1  │ │ │ │ Workspace 1  │ │ │ │ Workspace 1  │ │
│ │ • Schema     │ │ │ │ • Schema     │ │ │ │ • Schema     │ │
│ │ • Data       │ │ │ │ • Data       │ │ │ │ • Data       │ │
│ │ • Audit      │ │ │ │ • Audit      │ │ │ │ • Audit      │ │
│ └──────────────┘ │ │ └──────────────┘ │ │ └──────────────┘ │
│ ┌──────────────┐ │ │ ┌──────────────┐ │ └──────────────────┘
│ │ Workspace 2  │ │ │ │ Workspace 2  │ │
│ │ • Schema     │ │ │ │ • Schema     │ │
│ │ • Data       │ │ │ │ • Data       │ │
│ └──────────────┘ │ │ └──────────────┘ │
└──────────────────┘ └──────────────────┘
```

Isolation is enforced at every layer:
- **GraphDB**: Separate named graphs per tenant/workspace
- **Neo4j**: `tenant_id` + `workspace_id` properties on every node, filtered in all Cypher queries
- **Redis**: Key prefixes include workspace/tenant IDs
- **API**: `X-Tenant-Id` and `X-Workspace-Id` headers required on all requests
- **Middleware**: `tenantContext` middleware extracts and validates context before any route handler

---

## 5. Authentication & Authorization

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────┐
│  Client  │────▶│  CSRF Check  │────▶│  JWT Verify  │────▶│   RBAC   │
│ (Bearer) │     │ (X-Requested │     │  (Bearer     │     │ (Role +  │
│          │     │  -With hdr)  │     │   token)     │     │  Perms)  │
└──────────┘     └──────────────┘     └──────────────┘     └──────────┘
                                                                 │
                                                                 ▼
                                                          ┌──────────┐
                                                          │  Route   │
                                                          │ Handler  │
                                                          └──────────┘
```

### Role Hierarchy

| Role | Inherits | Key Permissions |
|------|----------|-----------------|
| `viewer` | — | Read dashboards, execute queries, use chat, read documents/entities |
| `member` | viewer | Upload documents, run extractions, delete own content |
| `manager` | member | Manage ontologies, clear data, manage folders, trigger sync |
| `admin` | manager | Manage users/tenants, system settings, LLM config, purge |

### Token Flow

```
POST /api/auth/login { email, password }
  → Validate credentials
  → Generate JWT (24h expiry) + Refresh token (7d)
  → Return { token, refreshToken, user }

All subsequent requests:
  Authorization: Bearer <jwt>
  X-Requested-With: XMLHttpRequest  (CSRF protection)
  X-Tenant-Id: <tenantId>
  X-Workspace-Id: <workspaceId>
```

---

## 6. Document Processing Pipeline

This is the core data ingestion flow. Documents go through a multi-stage pipeline from upload to committed knowledge graph data.

### 6.1 Sequence Diagram — Document Upload & Staging

```
┌──────┐     ┌──────────┐     ┌──────────┐     ┌───────┐     ┌───────┐
│Client│     │ Documents│     │ Parsers  │     │Chunker│     │ Redis │
│      │     │  Route   │     │PDF/CSV/  │     │       │     │       │
│      │     │          │     │Text      │     │       │     │       │
└──┬───┘     └────┬─────┘     └────┬─────┘     └───┬───┘     └───┬───┘
   │              │                │               │             │
   │ POST /upload │                │               │             │
   │ (multipart)  │                │               │             │
   │─────────────▶│                │               │             │
   │              │  Parse file    │               │             │
   │              │───────────────▶│               │             │
   │              │                │               │             │
   │              │  Parsed data   │               │             │
   │              │◀───────────────│               │             │
   │              │                │               │             │
   │              │  Chunk text    │               │             │
   │              │────────────────────────────────▶│             │
   │              │                │               │             │
   │              │  Chunks[]      │               │             │
   │              │◀────────────────────────────────│             │
   │              │                │               │             │
   │              │  Store staged:{docId}           │             │
   │              │──────────────────────────────────────────────▶│
   │              │                │               │  (7-day TTL)│
   │              │                │               │             │
   │  { docId,    │                │               │             │
   │    staged }  │                │               │             │
   │◀─────────────│                │               │             │
```

### 6.2 Sequence Diagram — Schema Analysis & Ontology Creation

```
┌──────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐     ┌───────┐
│Client│     │ Documents│     │ Schema  │     │   LLM   │     │GraphDB│
│      │     │  Route   │     │ Analyzer│     │ Service │     │       │
└──┬───┘     └────┬─────┘     └────┬────┘     └────┬────┘     └───┬───┘
   │              │                │               │             │
   │ POST /analyze│                │               │             │
   │─────────────▶│                │               │             │
   │              │  Analyze text  │               │             │
   │              │───────────────▶│               │             │
   │              │                │  LLM prompt:  │             │
   │              │                │  "Identify    │             │
   │              │                │   classes,    │             │
   │              │                │   properties, │             │
   │              │                │   relations"  │             │
   │              │                │──────────────▶│             │
   │              │                │               │             │
   │              │                │  Suggested    │             │
   │              │                │  schema       │             │
   │              │                │◀──────────────│             │
   │              │                │               │             │
   │              │  { classes,    │               │             │
   │              │    properties, │               │             │
   │              │    relations } │               │             │
   │              │◀───────────────│               │             │
   │              │                │               │             │
   │  Schema      │                │               │             │
   │  results     │                │               │             │
   │◀─────────────│                │               │             │
   │              │                │               │             │
   │ POST /owl    │  (User saves as ontology)      │             │
   │─────────────▶│                │               │             │
   │              │  Generate Turtle + import       │             │
   │              │──────────────────────────────────────────────▶│
   │              │                │               │  (schema    │
   │              │                │               │   graph)    │
```

### 6.3 Sequence Diagram — Column Mapping (CSV/Excel)

```
┌──────┐     ┌──────────────┐     ┌──────────┐     ┌───────┐
│Client│     │StagedDocument│     │ OWL      │     │ Redis │
│(SDR) │     │Review (UI)   │     │ Service  │     │       │
└──┬───┘     └──────┬───────┘     └────┬─────┘     └───┬───┘
   │               │                   │               │
   │ Select        │                   │               │
   │ ontology      │                   │               │
   │──────────────▶│                   │               │
   │               │ GET /owl/structure│               │
   │               │──────────────────▶│               │
   │               │                   │               │
   │               │ { classes,        │               │
   │               │   properties      │               │
   │               │   with domain }   │               │
   │               │◀──────────────────│               │
   │               │                   │               │
   │               │ GET /column-mappings              │
   │               │──────────────────────────────────▶│
   │               │                   │               │
   │               │ Saved mappings    │               │
   │               │ (or empty)        │               │
   │               │◀──────────────────────────────────│
   │               │                   │               │
   │ autoMapColumns│                   │               │
   │ (match cols   │                   │               │
   │  to ontology  │                   │               │
   │  properties,  │                   │               │
   │  resolve      │                   │               │
   │  rdfs:domain) │                   │               │
   │◀──────────────│                   │               │
   │               │                   │               │
   │ User edits:   │                   │               │
   │ • Property    │                   │               │
   │ • Links To    │                   │               │
   │ • Belongs To  │ ◀── NEW: domain   │               │
   │ • Skip        │     routing for   │               │
   │               │     literal props │               │
   │──────────────▶│                   │               │
   │               │                   │               │
   │               │ POST /column-mappings             │
   │               │──────────────────────────────────▶│
   │               │                   │  colmap:{w}:{o}
```

Each column mapping entry:
```json
{
  "property": "http://example.org#branchName",
  "propertyLabel": "branchName",
  "linkedClass": "",
  "linkedClassLabel": "",
  "domain": "http://example.org#Branch",
  "domainLabel": "Branch",
  "ignore": false
}
```

- `linkedClass` set → Object property (creates relationship to another entity)
- `linkedClass` empty → Datatype property (literal value)
- `domain` → Which entity class this literal belongs to (resolved from `rdfs:domain`)
- For multi-sheet Excel: `sheetClassMap` maps each sheet to a primary class

### 6.4 Sequence Diagram — Commit (Triple Generation & Storage)

```
┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐  ┌─────┐  ┌─────┐
│Client│  │ Documents│  │ Triple   │  │ Embedding│  │GraphDB│  │Redis│  │Neo4j│
│      │  │  Route   │  │ Service  │  │ Service  │  │       │  │     │  │     │
└──┬───┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬───┘  └──┬──┘  └──┬──┘
   │           │              │             │            │         │        │
   │ POST      │              │             │            │         │        │
   │ /commit   │              │             │            │         │        │
   │──────────▶│              │             │            │         │        │
   │           │              │             │            │         │        │
   │           │ Load staged  │             │            │         │        │
   │           │ data         │             │            │         │        │
   │           │─────────────────────────────────────────────────▶│        │
   │           │              │             │            │         │        │
   │           │ Load ontology│             │            │         │        │
   │           │──────────────────────────────────────▶│         │        │
   │           │              │             │            │         │        │
   │           │ generateCSV  │             │            │         │        │
   │           │ Triples()    │             │            │         │        │
   │           │─────────────▶│             │            │         │        │
   │           │              │             │            │         │        │
   │           │              │ PASS 1: Build entity URIs          │        │
   │           │              │ (natural key detection,            │        │
   │           │              │  cross-sheet FK resolution)        │        │
   │           │              │             │            │         │        │
   │           │              │ PASS 2: Generate triples           │        │
   │           │              │ • rdf:type for each entity         │        │
   │           │              │ • Object props → link to entity    │        │
   │           │              │ • Literal props → domain routing   │        │
   │           │              │   (attach to correct entity based  │        │
   │           │              │    on rdfs:domain, not just row)   │        │
   │           │              │             │            │         │        │
   │           │  triples[]   │             │            │         │        │
   │           │◀─────────────│             │            │         │        │
   │           │              │             │            │         │        │
   │           │ POST triples (Turtle)      │            │         │        │
   │           │──────────────────────────────────────▶│         │        │
   │           │              │             │  (data     │         │        │
   │           │              │             │   graph)   │         │        │
   │           │              │             │            │         │        │
   │           │ Embed chunks │             │            │         │        │
   │           │─────────────────────────▶│            │         │        │
   │           │              │             │            │         │        │
   │           │              │  Store vectors           │         │        │
   │           │              │  ──────────────────────────────▶│        │
   │           │              │             │            │         │        │
   │           │ Store doc metadata         │            │         │        │
   │           │─────────────────────────────────────────────────▶│        │
   │           │              │             │            │  doc:{id}        │
   │           │              │             │            │         │        │
   │           │ Save column mappings       │            │         │        │
   │           │─────────────────────────────────────────────────▶│        │
   │           │              │             │            │ colmap: │        │
   │           │              │             │            │         │        │
   │           │ Trigger sync │             │            │         │        │
   │           │ (GraphDB → Neo4j)          │            │         │        │
   │           │──────────────────────────────────────────────────────────▶│
   │           │              │             │            │         │        │
   │  { success,│             │             │            │         │        │
   │    jobId } │             │             │            │         │        │
   │◀──────────│              │             │            │         │        │
```

### 6.5 Domain-Aware Property Routing (New)

When committing CSV/Excel data, literal properties are routed to the correct entity based on `rdfs:domain`:

```
CSV Row: BranchID=BR001, BranchName="Downtown", CustomerID=CUST001, FullName="Brian Brown"

Mapping:
  BranchID   → linkedClass: Branch    (object property → creates Branch:BR001)
  BranchName → literal, domain: Branch (attach to Branch:BR001, NOT Customer)
  CustomerID → linkedClass: Customer   (object property → creates Customer:CUST001)
  FullName   → literal, domain: ""     (attach to row entity = Customer)

Generated Triples:
  Customer:CUST001  rdf:type        Customer .
  Customer:CUST001  hasBranch       Branch:BR001 .
  Customer:CUST001  fullName        "Brian Brown" .
  Branch:BR001      rdf:type        Branch .
  Branch:BR001      branchName      "Downtown" .     ← routed to Branch, not Customer
```

Resolution algorithm:
1. Check `mapping.domain` for the literal column
2. If domain class ≠ row entity class → scan other columns in same row
3. Find a column with `linkedClass` matching the domain class
4. Use that column's value to resolve the target entity URI via `idLookup`
5. Attach the literal triple to the resolved entity

---

## 7. GraphDB → Neo4j Sync

```
┌───────┐                    ┌──────────────────┐                    ┌─────┐
│GraphDB│                    │GraphDBNeo4jSync  │                    │Neo4j│
│       │                    │Service           │                    │     │
└───┬───┘                    └────────┬─────────┘                    └──┬──┘
    │                                 │                                 │
    │  SPARQL: SELECT all instances   │                                 │
    │  from data graph                │                                 │
    │◀────────────────────────────────│                                 │
    │                                 │                                 │
    │  Bindings (batches of 10000)    │                                 │
    │────────────────────────────────▶│                                 │
    │                                 │                                 │
    │                                 │ PASS 1: Create/merge nodes      │
    │                                 │ (concept_id, labels, properties,│
    │                                 │  tenant_id, workspace_id)       │
    │                                 │────────────────────────────────▶│
    │                                 │                                 │
    │  SPARQL: SELECT all             │                                 │
    │  relationships from data graph  │                                 │
    │◀────────────────────────────────│                                 │
    │                                 │                                 │
    │  Relationship bindings          │                                 │
    │────────────────────────────────▶│                                 │
    │                                 │                                 │
    │                                 │ PASS 2: Create relationships    │
    │                                 │ (two directed queries to avoid  │
    │                                 │  ASTCachedProperty bug)         │
    │                                 │────────────────────────────────▶│
    │                                 │                                 │
    │                                 │ Remove orphan nodes             │
    │                                 │ (in Neo4j but not in GraphDB)   │
    │                                 │────────────────────────────────▶│
```

Key constraints:
- Neo4j sessions cannot run concurrent queries — all operations are sequential `await`
- `properties()` function on collected nodes triggers internal ASTCachedProperty bug — avoided
- `startNode(r)` / `endNode(r)` property access also triggers the bug — use two directed queries instead
- Sync runs on server startup and after each document commit

---

## 8. Graph RAG Query Flow

```
┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐  ┌─────┐  ┌─────┐
│Client│  │  Chat    │  │ GraphRAG │  │   LLM    │  │ Redis │  │Neo4j│  │GDB  │
│      │  │  Route   │  │ Service  │  │ Service  │  │Vector │  │     │  │     │
└──┬───┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬───┘  └──┬──┘  └──┬──┘
   │           │              │             │            │         │        │
   │ POST /chat│              │             │            │         │        │
   │ { query,  │              │             │            │         │        │
   │   mode }  │              │             │            │         │        │
   │──────────▶│              │             │            │         │        │
   │           │  query()     │             │            │         │        │
   │           │─────────────▶│             │            │         │        │
   │           │              │             │            │         │        │
   │           │              │─── Mode Selection ───────────────────────────
   │           │              │                          │         │        │
   │           │              │ [RAG mode]               │         │        │
   │           │              │ Embed query              │         │        │
   │           │              │─────────────────────────▶│         │        │
   │           │              │ KNN search (top-K)       │         │        │
   │           │              │◀─────────────────────────│         │        │
   │           │              │                          │         │        │
   │           │              │ [Graph mode]             │         │        │
   │           │              │ Traverse neighbors       │         │        │
   │           │              │──────────────────────────────────▶│        │
   │           │              │ Subgraph context         │         │        │
   │           │              │◀──────────────────────────────────│        │
   │           │              │                          │         │        │
   │           │              │ [SPARQL mode]            │         │        │
   │           │              │ LLM generates SPARQL     │         │        │
   │           │              │─────────────▶│           │         │        │
   │           │              │              │ Execute   │         │        │
   │           │              │              │──────────────────────────▶│
   │           │              │              │           │         │     │
   │           │              │              │◀──────────────────────────│
   │           │              │◀─────────────│           │         │        │
   │           │              │                          │         │        │
   │           │              │ [Cypher mode]            │         │        │
   │           │              │ LLM generates Cypher     │         │        │
   │           │              │─────────────▶│           │         │        │
   │           │              │              │ Execute   │         │        │
   │           │              │              │─────────────────▶│        │
   │           │              │              │◀─────────────────│        │
   │           │              │◀─────────────│           │         │        │
   │           │              │                          │         │        │
   │           │              │ Merge context + LLM answer         │        │
   │           │              │─────────────▶│           │         │        │
   │           │              │◀─────────────│           │         │        │
   │           │              │             │            │         │        │
   │  { answer,│              │             │            │         │        │
   │    sources,│             │             │            │         │        │
   │    query } │             │             │            │         │        │
   │◀──────────│              │             │            │         │        │
```

Query modes:
| Mode | Sources | Best For |
|------|---------|----------|
| `rag` | Vector search only | Free-text questions about document content |
| `graph` | Neo4j traversal only | Entity relationship questions |
| `neo4j-direct` | LLM-generated Cypher | Complex graph pattern queries |
| `graphdb-direct` | LLM-generated SPARQL | Semantic/ontology-aware queries |
| `hybrid` | Vector + Graph combined | General questions (default) |
| `compare` | All sources side-by-side | Debugging / comparison |

---

## 9. Ontology Versioning

```
┌──────────────────────────────────────────────────────────────────┐
│                    Ontology Lifecycle                             │
│                                                                  │
│  Create ──▶ Edit ──▶ Version ──▶ Branch ──▶ Tag ──▶ Restore    │
│                                                                  │
│  Storage: Redis (single source of truth)                         │
│  GraphDB: ONE version per ontology (latest) in schema graph      │
│  Version snapshots: Redis at ontology_version:{ontId}:{verId}    │
└──────────────────────────────────────────────────────────────────┘
```

```
                    main branch
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    v1 ──── v2 ──── v3 ──── v4 (HEAD)        │
                    │       │                                 │
                    │       └──── experimental branch          │
                    │             v2.1 ──── v2.2              │
                    │                                         │
                    tag: "initial" (v1)                        │
                    tag: "production-2026-02" (v3)             │
                    └─────────────────────────────────────────┘
```

- First version auto-tagged as `initial` on `main` branch
- Branches work like Git checkout — one active at a time per ontology
- Each committed document records `ontology_version_id` it was committed against
- Mapping staleness detection: compares mapping's `ontologyVersionId` against current version
- Impact analysis: shows which classes/properties were added/removed between versions

---

## 10. Entity Visualization

```
┌──────┐     ┌──────────┐     ┌──────────┐     ┌─────┐
│Client│     │ Entity   │     │ Entity   │     │Neo4j│
│Graph │     │  Route   │     │ Service  │     │     │
│View  │     │          │     │          │     │     │
└──┬───┘     └────┬─────┘     └────┬─────┘     └──┬──┘
   │              │                │               │
   │ GET /graph   │                │               │
   │ ?depth=2     │                │               │
   │─────────────▶│                │               │
   │              │ getEntityGraph │               │
   │              │───────────────▶│               │
   │              │                │               │
   │              │                │ BFS traversal  │
   │              │                │ (depth levels) │
   │              │                │───────────────▶│
   │              │                │               │
   │              │                │ Two directed   │
   │              │                │ queries per    │
   │              │                │ level (avoid   │
   │              │                │ ASTCached bug) │
   │              │                │◀──────────────│
   │              │                │               │
   │              │ { nodes[],     │               │
   │              │   edges[] }    │               │
   │              │◀───────────────│               │
   │              │                │               │
   │  Render SVG  │                │               │
   │  • Concentric ring layout    │               │
   │  • Labels inside nodes       │               │
   │  • Directed arrows           │               │
   │  • Curved parallel edges     │               │
   │◀─────────────│                │               │
```

Node IDs use composite format: `class::rawId` (e.g., `Customer::CUST000010`) to prevent collisions between different entity types sharing the same concept_id.

---

## 11. Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Docker Compose Stack                         │
│                                                                     │
│  ┌──────────┐                                                       │
│  │  nginx   │ ◀── Port 80/443 (public)                             │
│  │ (reverse │     SSL termination, static assets                    │
│  │  proxy)  │                                                       │
│  └────┬─────┘                                                       │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────┐     ┌──────────┐                                      │
│  │   app    │     │ workers  │                                      │
│  │ (Node.js │     │ (BullMQ  │                                      │
│  │  :5002)  │     │  procs)  │                                      │
│  └────┬─────┘     └────┬─────┘                                      │
│       │                │                                            │
│       ├────────────────┤                                            │
│       │                │                                            │
│       ▼                ▼                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                          │
│  │ graphdb  │  │  neo4j   │  │  redis   │                          │
│  │ (10.7.3) │  │  (v5)    │  │ (7.4.0)  │                          │
│  │ :7200    │  │  :7687   │  │ :6379    │                          │
│  └──────────┘  └──────────┘  └──────────┘                          │
│       │              │             │                                │
│       ▼              ▼             ▼                                │
│  [graphdb_data] [neo4j_data] [redis_data]  ← Docker volumes        │
│                                                                     │
│  ┌──────────┐                                                       │
│  │ db-init  │ ← One-shot: creates GraphDB repo, Neo4j indexes,     │
│  │          │   Redis search index                                  │
│  └──────────┘                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Container Specifications

| Service | Image | Resources | Health Check |
|---------|-------|-----------|-------------|
| graphdb | ontotext/graphdb:10.7.3 | 2GB heap | REST API `/rest/repositories` |
| neo4j | neo4j:5 | Default | `cypher-shell RETURN 1` |
| redis | redis/redis-stack-server:7.4.0-v2 | AOF persistence | `redis-cli ping` |
| app | iaikunal/enterprise-kg:latest | Node 18 Alpine | — |
| workers | iaikunal/enterprise-kg:latest | Node 18 Alpine | — |
| nginx | nginx:alpine | — | — |

---

## 12. Client Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     React SPA (CRA)                             │
│                                                                 │
│  ┌─── Contexts ──────────────────────────────────────────────┐  │
│  │ AuthContext (JWT, login/logout, token refresh)             │  │
│  │ TenantContext (workspace selection, tenant headers)        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─── Hooks ─────────────────────────────────────────────────┐  │
│  │ useApi (fetch wrapper with auth headers)                   │  │
│  │ usePermissions (role-based UI gating)                      │  │
│  │ useOntologies (ontology list + selection)                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─── Pages / Sections ──────────────────────────────────────┐  │
│  │                                                           │  │
│  │  💬 Knowledge Assistant (Chat)                            │  │
│  │     Graph RAG conversational interface                    │  │
│  │     Multiple query modes (RAG, Graph, SPARQL, Cypher)     │  │
│  │                                                           │  │
│  │  📁 Data Management                                       │  │
│  │     ├── FileManager (documents, chunks, entities, mapping)│  │
│  │     └── EntitiesPage (entity registry + graph view)       │  │
│  │                                                           │  │
│  │  📚 Ontologies                                            │  │
│  │     ├── OntologiesPage (list, create, import)             │  │
│  │     ├── EnhancedOntologyEditor (visual editor)            │  │
│  │     ├── EnhancedOntologyViewer (read-only view)           │  │
│  │     └── OntologyVersioningModal (version history)         │  │
│  │                                                           │  │
│  │  ⚙️ Jobs                                                  │  │
│  │     └── OntologyJobs (extraction, commit, analysis jobs)  │  │
│  │                                                           │  │
│  │  🔧 Administration                                        │  │
│  │     ├── DatabaseManager (Neo4j, GraphDB, Redis status)    │  │
│  │     ├── Users / Tenants / Roles management                │  │
│  │     ├── Audit Log (activity history)                      │  │
│  │     ├── LLM Monitor (token usage)                         │  │
│  │     └── Settings (system configuration)                   │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 13. Service Dependency Graph

```
                        ┌─────────────────┐
                        │   llmService    │
                        │ (Bedrock/OpenAI/│
                        │  Ollama)        │
                        └────────┬────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ extractionSvc   │  │ graphRAGService │  │schemaAnalysisSvc│
│                 │  │                 │  │                 │
│ • chunkingSvc   │  │ • vectorStore   │  │ • llmService    │
│ • embeddingSvc  │  │ • neo4jService  │  │ • dataProfileSvc│
│ • conceptExtSvc │  │ • graphDBStore  │  └─────────────────┘
│ • entityResSvc  │  │ • llmService    │
│ • tripleService │  └─────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ graphDBTripleSvc│  │owlOntologySvc   │  │ entityService   │
│                 │  │                 │  │                 │
│ • graphDBStore  │  │ • graphDBStore  │  │ • neo4jService  │
│ • entityUriSvc  │  │ • versioningSvc │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                   │                      │
         ▼                   ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│    GraphDB      │  │     Redis       │  │     Neo4j       │
│  (RDF Store)    │  │ (Vectors/Cache) │  │ (Property Graph)│
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 14. Security Architecture

| Layer | Mechanism |
|-------|-----------|
| Transport | HTTPS via nginx SSL termination (Let's Encrypt) |
| Authentication | JWT Bearer tokens (24h expiry) + refresh tokens (7d) |
| CSRF | `X-Requested-With: XMLHttpRequest` header required on all state-changing requests |
| Authorization | RBAC with 4-tier role hierarchy and 26 granular permissions |
| Rate Limiting | 200 requests/minute per user/IP on all `/api` routes |
| Input Validation | LLM output validator, prompt sanitizer, Turtle syntax validation |
| Audit | Activity logger captures all API requests with user, method, path, status |
| Tenant Isolation | Named graphs (GraphDB), node properties (Neo4j), key prefixes (Redis) |
| Data Scoping | Every query includes tenant/workspace filters — no cross-tenant data leakage |

---

## 15. Background Job Processing

```
┌──────────────────────────────────────────────────────────────────┐
│                      BullMQ (Redis-backed)                       │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │
│  │  extraction    │  │   commit       │  │  schema-       │     │
│  │  queue         │  │   queue        │  │  analysis      │     │
│  │                │  │                │  │  queue         │     │
│  │ • Parse doc    │  │ • Gen triples  │  │ • LLM analyze  │     │
│  │ • LLM extract  │  │ • Store GraphDB│  │ • Suggest      │     │
│  │ • Embed chunks │  │ • Embed chunks │  │   classes      │     │
│  │ • Store vectors│  │ • Sync Neo4j   │  │ • Suggest      │     │
│  └────────────────┘  └────────────────┘  │   properties   │     │
│                                          └────────────────┘     │
│                                                                  │
│  Job lifecycle: pending → active → completed/failed              │
│  Progress updates via ontologyJobService                         │
│  UI polls OntologyJobs component for status                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 16. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| GraphDB as source of truth | OWL/RDF provides formal semantics, reasoning, and SPARQL for complex queries |
| Neo4j as serving layer | Optimized for graph traversal, visualization, and Cypher pattern matching |
| Redis for vectors | RediSearch HNSW index provides sub-millisecond semantic search |
| One-way sync (GraphDB → Neo4j) | Avoids dual-write consistency issues; GraphDB is authoritative |
| Redis for ontology versions | Fast read/write for version snapshots; GraphDB stores only latest |
| Staging in Redis with TTL | Uncommitted data auto-expires; no orphan cleanup needed |
| Deterministic entity URIs | Natural key-based URIs enable cross-document entity deduplication |
| Domain-aware property routing | Literal properties attach to the correct entity based on `rdfs:domain` |
| Composite node IDs (`class::rawId`) | Prevents collisions between different entity types sharing same concept_id |
| Sequential Neo4j operations | Avoids ASTCachedProperty internal bug with concurrent session queries |

---

*Document generated from codebase analysis. For API reference, see `/api-docs` (Swagger UI).*
