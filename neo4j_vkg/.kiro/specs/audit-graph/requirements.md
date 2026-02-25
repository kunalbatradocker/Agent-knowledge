# Requirements Document

## Introduction

The Purple Fabric Graph RAG platform currently has no change tracking. When documents are re-uploaded with updated data, GraphDB appends new triples alongside old ones (no deduplication), and Neo4j overwrites via MERGE+SET (last-write-wins). This feature introduces an audit graph that records every data change as a ChangeEvent RDF node, enabling full change history, regulatory compliance for AML workflows, and suspicious pattern detection.

## Glossary

- **Audit_Graph**: A dedicated RDF named graph per workspace that stores ChangeEvent triples. IRI pattern: `http://purplefabric.ai/graphs/tenant/{tenantId}/workspace/{workspaceId}/audit`
- **ChangeEvent**: An RDF node representing a single property change on an entity, with metadata including previous value, new value, change type, timestamp, and source document.
- **Data_Graph**: The existing RDF named graph that stores entity instance triples for a workspace.
- **Commit_Flow**: The background process in `processCommitInBackground` that generates triples, writes them to GraphDB, stores metadata in Redis, and syncs to Neo4j.
- **Diff_Engine**: The component that compares existing triples in the Data_Graph against newly generated triples to detect INSERTs, UPDATEs, and DELETEs.
- **Audit_Service**: A new service (`server/services/auditService.js`) that encapsulates diff logic, ChangeEvent generation, and audit graph read/write operations.
- **Neo4j_Sync**: The process that replicates RDF data from GraphDB into Neo4j property graph nodes and relationships for visualization.
- **PF_Namespace**: The Purple Fabric ontology namespace `http://purplefabric.ai/ontology#`.

## Requirements

### Requirement 1: Audit Graph Lifecycle Management

**User Story:** As a platform operator, I want the system to automatically create and manage an audit graph per workspace, so that change tracking infrastructure is always available when documents are committed.

#### Acceptance Criteria

1. WHEN a workspace commits its first document, THE Audit_Service SHALL create the audit named graph if it does not already exist.
2. THE GraphDBStore SHALL provide a method `getAuditGraphIRI(tenantId, workspaceId)` that returns the IRI `http://purplefabric.ai/graphs/tenant/{tenantId}/workspace/{workspaceId}/audit`.
3. WHEN the audit graph IRI is requested with valid tenantId and workspaceId, THE GraphDBStore SHALL return a deterministic IRI following the established naming convention.
4. IF tenantId or workspaceId is missing or invalid, THEN THE GraphDBStore SHALL throw a descriptive error.

### Requirement 2: Pre-Commit Diff Detection

**User Story:** As a data steward, I want the system to detect what changed when a document is re-uploaded, so that I have a precise record of every data modification.

#### Acceptance Criteria

1. WHEN new triples are generated for a commit, THE Diff_Engine SHALL query the Data_Graph for all existing triples of the entities being written.
2. WHEN comparing old and new triples for the same entity and property, THE Diff_Engine SHALL classify each difference as INSERT (new property not previously present), UPDATE (property value changed), or DELETE (property previously present but absent in new data).
3. WHEN an entity has no prior triples in the Data_Graph, THE Diff_Engine SHALL classify all its properties as INSERT changes.
4. WHEN an entity exists in the Data_Graph but is absent from the new triples, THE Diff_Engine SHALL classify all its properties as DELETE changes.
5. WHEN old and new values for a property are identical, THE Diff_Engine SHALL not generate a ChangeEvent for that property.

### Requirement 3: ChangeEvent RDF Generation

**User Story:** As a compliance officer, I want every data change recorded as a structured RDF node with full context, so that I can trace exactly what changed, when, and why.

#### Acceptance Criteria

1. WHEN a diff is detected, THE Audit_Service SHALL generate a ChangeEvent RDF node with properties: `pf:entity` (URI of changed entity), `pf:property` (the property that changed), `pf:previousValue` (old value or empty for INSERTs), `pf:newValue` (new value or empty for DELETEs), `pf:changeType` (INSERT, UPDATE, or DELETE), `pf:changedAt` (ISO 8601 timestamp), and `pf:sourceDocument` (URI of the document that triggered the change).
2. THE Audit_Service SHALL assign each ChangeEvent a unique URI within the audit graph namespace.
3. WHEN generating ChangeEvent triples, THE Audit_Service SHALL use the PF_Namespace for all audit-specific predicates.
4. THE Audit_Service SHALL serialize ChangeEvent triples as valid Turtle that can be written to GraphDB.

### Requirement 4: Modified Commit Flow with Audit Integration

**User Story:** As a platform developer, I want the commit flow to perform diff-before-write with atomic audit logging, so that no data change goes unrecorded.

#### Acceptance Criteria

1. WHEN `writeTriplesToGraphDB` is called, THE GraphDBTripleService SHALL first query existing triples for the entities being written.
2. WHEN existing triples are retrieved, THE GraphDBTripleService SHALL invoke the Diff_Engine to compute changes.
3. WHEN changes are computed, THE GraphDBTripleService SHALL write ChangeEvent triples to the audit graph before modifying the data graph.
4. WHEN writing to the data graph, THE GraphDBTripleService SHALL delete old triples for affected entities before inserting new triples, replacing the current append-only POST behavior.
5. IF the audit graph write fails, THEN THE GraphDBTripleService SHALL abort the data graph write and report the error.
6. WHEN a document is committed for the first time (no existing triples), THE GraphDBTripleService SHALL record all properties as INSERT ChangeEvents.

### Requirement 5: Audit Data Queryability via SPARQL

**User Story:** As an AML analyst, I want to query the audit graph using SPARQL to find suspicious change patterns, so that I can detect potential money laundering indicators.

#### Acceptance Criteria

1. THE Audit_Service SHALL provide a method to query ChangeEvents by entity URI, returning all changes for that entity ordered by timestamp.
2. THE Audit_Service SHALL provide a method to query ChangeEvents by time range, returning all changes within the specified period.
3. THE Audit_Service SHALL provide a method to query ChangeEvents by change type (INSERT, UPDATE, DELETE), returning filtered results.
4. WHEN querying for AML-relevant patterns, THE Audit_Service SHALL support SPARQL queries that correlate change timestamps with entity property values (e.g., "entities where amount changed more than 30 days after transaction date").

### Requirement 6: Neo4j Audit Sync

**User Story:** As a graph analyst, I want audit data visible in Neo4j, so that I can visualize change history alongside entity relationships in the UI.

#### Acceptance Criteria

1. WHEN ChangeEvents are written to the audit graph in GraphDB, THE Neo4j_Sync SHALL create corresponding ChangeEvent nodes in Neo4j.
2. THE Neo4j_Sync SHALL create `[:CHANGED]` relationships from ChangeEvent nodes to the entity nodes they reference.
3. WHEN syncing ChangeEvent nodes, THE Neo4j_Sync SHALL include all ChangeEvent properties (changeType, previousValue, newValue, changedAt, sourceDocument, property).
4. WHEN an incremental sync is triggered after a commit, THE Neo4j_Sync SHALL include audit graph data in addition to data graph data.

### Requirement 7: Audit REST API

**User Story:** As a frontend developer, I want REST API endpoints to retrieve audit data, so that I can display change history in the UI.

#### Acceptance Criteria

1. WHEN a GET request is made to the entity change history endpoint with a valid entity URI, THE API SHALL return all ChangeEvents for that entity ordered by timestamp descending.
2. WHEN a GET request is made to the workspace audit log endpoint, THE API SHALL return recent ChangeEvents across all entities in the workspace with pagination support.
3. WHEN a GET request is made with optional query parameters for changeType, dateFrom, and dateTo, THE API SHALL filter results accordingly.
4. IF an invalid entity URI or workspace is provided, THEN THE API SHALL return an appropriate error response with a descriptive message.

### Requirement 8: Data Integrity and Error Handling

**User Story:** As a platform operator, I want the audit system to maintain data integrity even under failure conditions, so that audit records are never lost or corrupted.

#### Acceptance Criteria

1. IF the GraphDB connection fails during audit write, THEN THE Audit_Service SHALL retry the operation with exponential backoff using the existing `_fetchWithPool` mechanism.
2. IF the audit graph write succeeds but the data graph write fails, THEN THE Audit_Service SHALL log the inconsistency and report the error without rolling back the audit record.
3. WHEN processing large documents with many entity changes, THE Audit_Service SHALL batch ChangeEvent writes to avoid exceeding GraphDB request size limits.
4. THE Audit_Service SHALL validate that all ChangeEvent triples are well-formed before writing to GraphDB.
