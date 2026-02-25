# Implementation Plan: Audit Graph for Change Tracking

## Overview

Phased implementation that builds the audit system bottom-up: core utilities first, then diff engine, then commit flow integration, then Neo4j sync, and finally REST API. Each phase ends with a checkpoint to verify correctness before proceeding.

## Tasks

- [x] 1. Set up audit infrastructure and core utilities
  - [x] 1.1 Add `getAuditGraphIRI(tenantId, workspaceId)` method to `server/services/graphDBStore.js`
    - Follow the existing pattern of `getDataGraphIRI` and `getSchemaGraphIRI`
    - Return `http://purplefabric.ai/graphs/tenant/{tenantId}/workspace/{workspaceId}/audit`
    - Throw descriptive errors for missing/invalid tenantId or workspaceId
    - _Requirements: 1.2, 1.3, 1.4_
  - [x] 1.2 Write property test for audit graph IRI generation
    - **Property 1: Audit graph IRI determinism**
    - **Validates: Requirements 1.2**
  - [x] 1.3 Create `server/services/auditService.js` with triple parsing utilities
    - Implement `parseTriple(turtleLine)` to extract subject, predicate, object from a Turtle triple string
    - Implement `extractEntityURIs(triples)` to get unique entity subject URIs, excluding Document URIs and OWL declarations
    - Implement `groupTriplesByEntity(triples)` to organize parsed triples by subject URI
    - Define `SKIP_PREDICATES` set for metadata predicates excluded from diff (`rdf:type`, `pf:sourceDocument`, `pf:rowIndex`, `pf:lastUpdatedBy`, `pf:updatedAt`, `rdfs:label`)
    - _Requirements: 2.1_
  - [x] 1.4 Write property test for entity URI extraction
    - **Property 2: Entity URI extraction from triples**
    - **Validates: Requirements 2.1**

- [x] 2. Implement diff engine
  - [x] 2.1 Implement `computeDiff(existingByEntity, newTriplesByEntity)` in `auditService.js`
    - Compare old and new triple sets per entity per predicate
    - Classify as INSERT (new predicate not in old), UPDATE (same predicate, different object), DELETE (old predicate not in new)
    - Skip predicates in `SKIP_PREDICATES` set
    - Return array of ChangeEvent objects with entityURI, property, previousValue, newValue, changeType
    - Handle edge cases: empty old (all INSERTs), empty new for an entity (all DELETEs), identical sets (no changes)
    - _Requirements: 2.2, 2.3, 2.4, 2.5_
  - [x] 2.2 Write property test for diff classification
    - **Property 3: Diff classification correctness**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
  - [x] 2.3 Write property test for unchanged triples
    - **Property 4: Unchanged triples produce no ChangeEvents**
    - **Validates: Requirements 2.5**

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement ChangeEvent RDF generation
  - [x] 4.1 Implement `generateChangeEventTriples(changes, auditGraphIRI, sourceDocumentURI)` in `auditService.js`
    - Generate a unique URI for each ChangeEvent using `uuid` (already a project dependency)
    - Produce Turtle triples with all required predicates: `rdf:type pf:ChangeEvent`, `pf:entity`, `pf:property`, `pf:previousValue` (for UPDATE/DELETE), `pf:newValue` (for INSERT/UPDATE), `pf:changeType`, `pf:changedAt`, `pf:sourceDocument`
    - Use `graphDBTripleService.escapeTurtleLiteral()` for value escaping
    - All audit predicates use the PF namespace `http://purplefabric.ai/ontology#`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 4.2 Write property test for ChangeEvent triple completeness
    - **Property 5: ChangeEvent triple completeness**
    - **Validates: Requirements 3.1, 3.3**
  - [x] 4.3 Write property test for ChangeEvent URI uniqueness
    - **Property 6: ChangeEvent URI uniqueness**
    - **Validates: Requirements 3.2**
  - [x] 4.4 Write property test for ChangeEvent Turtle round-trip
    - **Property 7: ChangeEvent Turtle round-trip validity**
    - **Validates: Requirements 3.4**

- [x] 5. Implement audit graph write and batching
  - [x] 5.1 Implement `writeAuditTriples(tenantId, workspaceId, auditTriples)` in `auditService.js`
    - Use `graphDBStore._fetchWithPool` for HTTP POST to audit graph (same pattern as `writeTriplesToGraphDB`)
    - Batch triples with `BATCH_SIZE = 10000` (same as data graph writes)
    - Include Turtle prefixes header
    - _Requirements: 8.3_
  - [x] 5.2 Write property test for audit triple batching
    - **Property 8: Audit triple batching preserves all events**
    - **Validates: Requirements 8.3**
  - [x] 5.3 Implement `getExistingTriples(tenantId, workspaceId, entityURIs)` in `auditService.js`
    - SPARQL SELECT query against the data graph for all triples of the given entity URIs
    - Batch entity URIs in groups of 100 to avoid query size limits
    - Return Map of entityURI → array of {predicate, object, objectType}
    - _Requirements: 2.1_
  - [x] 5.4 Implement `preCommitAudit(tenantId, workspaceId, newTriples, sourceDocumentURI)` in `auditService.js`
    - Orchestrate: extract entity URIs → query existing → compute diff → generate ChangeEvent triples → write to audit graph
    - Return `{ changeCount, entityURIsToDelete }` for the caller
    - _Requirements: 4.3, 4.6_

- [x] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Modify commit flow for delete-before-insert with audit
  - [x] 7.1 Add `deleteEntityTriples(tenantId, workspaceId, entityURIs)` to `graphDBTripleService.js`
    - SPARQL UPDATE DELETE WHERE for all triples of the given entity URIs in the data graph
    - Batch entity URIs to avoid query size limits
    - _Requirements: 4.4_
  - [x] 7.2 Modify `writeTriplesToGraphDB` in `graphDBTripleService.js` to integrate audit
    - Accept new `options` parameter with `sourceDocumentURI`
    - Before writing: call `auditService.preCommitAudit()` to diff and write ChangeEvents
    - If audit write fails, abort and throw error (do not modify data graph)
    - Delete old triples for affected entities via `deleteEntityTriples()`
    - Then insert new triples using existing batch POST logic
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 7.3 Update `processCommitInBackground` in `server/routes/ontology/documents.js` to pass `sourceDocumentURI` to `writeTriplesToGraphDB`
    - Pass `{ sourceDocumentURI: staged.document.uri }` as options
    - No other changes needed — the audit logic is encapsulated in the service layer
    - _Requirements: 4.1_

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Extend Neo4j sync for audit data
  - [x] 9.1 Modify `syncInstanceData` in `graphDBNeo4jSyncService.js` to include audit graph
    - Add the audit graph IRI to the SPARQL query's GRAPH filter alongside the data graph pattern
    - ChangeEvent nodes get the `ChangeEvent` label in Neo4j
    - Create `[:CHANGED]` relationships from ChangeEvent nodes to their referenced entity nodes using `pf:entity` predicate
    - Include all ChangeEvent properties: changeType, property, previousValue, newValue, changedAt, sourceDocument
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 10. Implement REST API endpoints for audit data
  - [x] 10.1 Add audit query methods to `auditService.js`
    - `getEntityChangeHistory(tenantId, workspaceId, entityURI)` — SPARQL query for ChangeEvents by entity, ordered by changedAt DESC
    - `getWorkspaceAuditLog(tenantId, workspaceId, options)` — SPARQL query with pagination (limit/offset), optional filters for changeType, dateFrom, dateTo
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 10.2 Add REST API routes in `server/routes/ontology/documents.js`
    - `GET /api/ontology/audit/entity` — query param `uri`, returns entity change history
    - `GET /api/ontology/audit/log` — query params `workspaceId`, `limit`, `offset`, `changeType`, `dateFrom`, `dateTo`
    - Validate required parameters, return 400 for invalid input
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All tasks including property tests are required (comprehensive testing)
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each phase
- Property tests use `fast-check` library — install via `npm install --save-dev fast-check`
- No mocking in tests — test real logic with in-memory data structures
- The `documents.js` file is NOT split (per user request)
