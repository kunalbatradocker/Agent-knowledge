# Graph-RAG Platform: Technical Design

**Version:** 1.0  
**Date:** 2026-01-08

## Architecture Overview

### Service Architecture
The platform follows a microservices architecture with clear separation of concerns:

- **API Gateway**: Auth, RBAC, rate limits, request validation, routing
- **Ingestion Service**: Upload/presigned URLs, checksum, AV scan, metadata
- **Doc Processing Service**: Parsing + structure extraction + chunking
- **Embedding Service**: Chunk embeddings + optional entity embeddings
- **Ontology Service**: Ontology induction, diff, validation, versioning, approvals
- **Extraction Service**: Entity + relation extraction guided by active ontology; emits triples
- **Entity Resolution Service**: Candidate matching, merges/splits, canonicalization
- **Graph Writer**: Idempotent commits of nodes/edges/triples + provenance
- **Query Orchestrator (Graph-RAG)**: Classifies query, finds entities, traverses graph, retrieves text, synthesizes answer
- **Admin/UI Backend**: Aggregations for UI, moderation queues, audit views

### Control Plane vs Data Plane
- **Control plane:** tenants, workspaces, roles, policies, quotas, model configs, ontology approvals
- **Data plane:** documents, chunks, embeddings, extracted triples, entity resolution decisions, query traces

## Technology Stack

### Recommended Production Stack
- **Cloud:** AWS (or similar)
- **Compute:** Kubernetes (EKS) or ECS; extraction workers autoscaled separately
- **Workflow/Queue:** SQS + Step Functions (or Temporal)
- **Object Store:** S3
- **Metadata Store:** Postgres (Aurora)
- **Graph Store:** Neo4j (Aura / self-hosted) *or* Neptune (property graph)
- **Vector Store:** OpenSearch (hybrid BM25 + vector) *or* Neo4j vector index (smaller scale)
- **Cache:** Redis (rate-limit tokens, job state cache, session caching)
- **LLM Provider:** Pluggable (Bedrock/OpenAI/others) with JSON schema enforcement
- **Observability:** OpenTelemetry + Prometheus/Grafana + centralized logs (ELK/OpenSearch)

### Database Design Decisions

#### Graph Database Options
**Option A — Neo4j (Property Graph) - RECOMMENDED**
- Excellent traversal performance and developer tooling
- Great for graph explorer UI and operational graph queries
- Good fit for entity resolution and neighbor similarity features
- **Trade-off:** RDF-native semantics require mapping layer

**Option B — Neptune RDF / RDF Triplestore (SPARQL-first)**
- RDF-native, named graphs for provenance are natural
- SPARQL + RDF ecosystem
- **Trade-off:** ER workflows and operational traversal patterns may be less ergonomic

#### Vector Store Options
- **OpenSearch (recommended for enterprise search):** hybrid retrieval, scalable, mature
- **Neo4j vector:** simpler stack, works well when everything is already in Neo4j
- **pgvector:** simple for smaller/medium scale, less specialized search features

## Data Model

### Canonical IDs
- `tenantId`, `workspaceId` always present
- Entity URI: `urn:tenant:{tenantId}:entity:{entityId}`
- Ontology URI: `urn:tenant:{tenantId}:onto:{nameOrId}`
- Triple ID: `urn:tenant:{tenantId}:triple:{tripleId}`
- Chunk ID: `urn:tenant:{tenantId}:doc:{docId}:chunk:{chunkId}`

### Ontology Schema (RDF Triples)
```json
{
  "classes": [
    {
      "uri": "urn:tenant:t1:onto:Person",
      "label": "Person",
      "description": "Individual human being",
      "aliases": ["Individual", "Human"]
    }
  ],
  "properties": [
    {
      "uri": "urn:tenant:t1:onto:worksFor",
      "label": "worksFor",
      "domain": "urn:tenant:t1:onto:Person",
      "range": "urn:tenant:t1:onto:Organization"
    }
  ]
}
```

### Instance Triples (Facts)
Each triple stores:
- `s, p, o` (subject, predicate, object)
- `o_type`: `ENTITY|LITERAL`
- `confidence`: 0..1 composite score
- `status`: `PROPOSED|APPROVED|REJECTED|RETRACTED`
- `runId`, `ontologyVersionId`, `modelId`, `promptHash`
- `provenance[]`: evidence records

### Provenance Model
```json
{
  "docId": "doc_123",
  "chunkId": "chunk_456",
  "quote": "John works for Acme Corp",
  "charStart": 150,
  "charEnd": 175,
  "pageNumber": 2
}
```

### Property Graph Mapping (Neo4j)
**Nodes:**
- `:Entity {uri, tenantId, workspaceId, canonicalName, typeUri, aliases[], attrsJson, createdAt}`
- `:Document {docId, tenantId, workspaceId, checksum, mimeType, metadataJson, createdAt}`
- `:Chunk {chunkId, docId, tenantId, workspaceId, text, charStart, charEnd, embeddingRef}`
- `:OntologyClass {uri, tenantId, workspaceId, label}`
- `:OntologyProperty {uri, tenantId, workspaceId, label, domainUri, rangeUri}`

**Edges:**
- `(:Entity)-[:REL {predicateUri, confidence, status, runId, evidenceJson}]->(:Entity|:Literal)`
- `(:Chunk)-[:MENTIONS {confidence, spans}]->(:Entity)`
- `(:Entity)-[:INSTANCE_OF]->(:OntologyClass)`

## Data Flow Architecture

### End-to-End Pipeline
1. **Upload document** → store raw in object store
2. **Parse** → structured text blocks + normalized text
3. **Chunk** → store chunks + offsets
4. **Embed chunks** → store embeddings in vector store
5. **Ontology induction/update proposal** → validation → approval → activate version
6. **Extraction run** → entity/relation extraction → candidate triples
7. **Entity resolution** → map to canonical entities (or create new)
8. **Write triples/edges** to graph + provenance
9. **Query** → entity linking → graph traversal → chunk retrieval → LLM answer with citations

### Idempotency Strategy
- `docId` derived from `(tenantId, checksum)` by default to avoid duplicates
- Each pipeline stage writes with **idempotency keys**:
  - `parse:{docId}:{parserVersion}`
  - `chunk:{docId}:{chunkerVersion}`
  - `embed:{docId}:{embedModel}:{embedVersion}`
  - `extract:{docId}:{ontologyVersion}:{extractPromptHash}`
  - `commit:{runId}`

## Processing Pipeline Design

### Document Parsing
- **File Type Detection**: PDF, DOCX, HTML, CSV, JSON
- **Structure Extraction**: Headers, paragraphs, tables, lists
- **Text Normalization**: Clean formatting, preserve semantic structure
- **Output**: `parsed_text` + `blocks[]` with type/text/offsets

### Chunking Strategy
- **Structure-aware chunking** first (sections/headings)
- **Semantic chunking** within sections if too large
- **Target size**: 350–900 tokens per chunk (configurable)
- **Overlap**: 10–15%
- **Offset mapping**: chunk → parsed_text positions

### Ontology Lifecycle
1. **Bootstrap**: Sample representative chunks from initial corpus
2. **Incremental Evolution**: New docs trigger ontology extension proposals
3. **Validation**: Schema consistency, no duplicates, domain/range validation
4. **Approval Workflow**: Human review for schema changes
5. **Versioning**: Track changes with diffs and rollback capability

### Extraction Pipeline
- **Input**: Chunks + Active Ontology Version
- **LLM Prompt**: Structured JSON output with entity/relation extraction
- **Validation**: Strict predicate whitelist from ontology
- **Output**: Candidate triples with confidence scores and evidence

### Entity Resolution
- **Matching Signals**: Name similarity, attribute overlap, context similarity
- **Decision Thresholds**: Auto-link (high), review queue (medium), create new (low)
- **Merge/Split Operations**: Maintain provenance and redirect URIs
- **Quality Control**: Monitor duplicate rates and orphan entities

## Graph-RAG Query Architecture

### Query Processing Steps
1. **Query Classification**: Factoid, relationship, timeline, exploratory
2. **Entity Linking**: Find candidate entities from graph + vector search
3. **Graph Expansion**: N-hop traversal with predicate constraints
4. **Chunk Retrieval**: Hybrid BM25 + vector search for supporting text
5. **Answer Synthesis**: LLM generation with citations and uncertainty

### Response Format
```json
{
  "answer": "Generated response text",
  "citations": [
    {
      "docId": "doc_123",
      "chunkId": "chunk_456", 
      "quote": "Supporting evidence text"
    }
  ],
  "paths": [
    {
      "entities": ["Person:John", "Organization:Acme"],
      "predicates": ["worksFor"]
    }
  ],
  "confidence": 0.85
}
```

## Security & Multi-Tenancy

### Tenant Isolation
- **Graph-level isolation**: All nodes/edges tagged with tenantId/workspaceId
- **Query filtering**: Automatic tenant context injection
- **Storage isolation**: Separate vector indices per tenant
- **Access control**: RBAC with workspace-level permissions

### Data Protection
- **Encryption**: TLS in transit, KMS at rest
- **PII Detection**: Configurable redaction at ingestion or query time
- **Audit Logging**: All operations tracked with user context
- **Secrets Management**: Vault/KMS for credentials

## Performance & Scalability

### Scaling Strategy
- **Horizontal scaling**: Stateless services behind load balancers
- **Worker autoscaling**: Extraction workers scale on queue depth
- **Database sharding**: Tenant-based partitioning for large deployments
- **Caching**: Redis for frequent queries and intermediate results

### Performance Targets
- **Ingestion**: 1000 pages/hour per worker
- **Query latency**: <8s P95 for Graph-RAG queries
- **Extraction accuracy**: >90% precision on factual triples
- **System availability**: 99.5% uptime

## Integration Points

### External Systems
- **Document Management**: Integration with existing DMS via APIs
- **Authentication**: SSO/SAML integration for enterprise auth
- **Monitoring**: OpenTelemetry for observability
- **Backup/Recovery**: Automated backups with point-in-time recovery

### API Design
- **RESTful APIs**: OpenAPI 3.0 specification
- **Async Operations**: Job-based processing with status endpoints
- **Webhooks**: Event notifications for pipeline completion
- **Rate Limiting**: Per-tenant quotas and throttling
