# Merge Plan: `neo4j copy` ← `neo4j_vkg`

## Situation

Two codebases diverged from the same base:

- **`neo4j copy`** — has newer/better code for ontology management, graph features, entity handling, document processing, and UI polish
- **`neo4j_vkg`** — has all VKG (Virtual Knowledge Graph) integration: Trino federated queries, catalog management, VKG ontology generation, context graphs, reasoning traces

**Target**: Merge into one codebase with the latest of both. Use `neo4j copy` as the base (it has the more evolved core) and layer in VKG additions from `neo4j_vkg`.

---

## File Classification

### A. Files only in `neo4j_vkg` — COPY AS-IS into `neo4j copy`

These are pure VKG additions with no conflicts:

**Server Config:**
- `server/config/trino.js`

**Server Services:**
- `server/services/trinoCatalogService.js`
- `server/services/vkgOntologyService.js`
- `server/services/vkgQueryService.js`
- `server/services/sqlValidatorService.js`
- `server/services/contextGraphBuilder.js`
- `server/services/prompts/` (entire directory)

**Server Routes:**
- `server/routes/trinoCatalogs.js`
- `server/routes/vkgQuery.js`

**Server Job Processors:**
- `server/services/jobProcessors/vkgProcessor.js`

**Client Components (+ matching CSS):**
- `client/src/components/VKGQuery.js` + `.css`
- `client/src/components/DataSourcesManager.js` + `.css`
- `client/src/components/ContextGraphView.js` + `.css`
- `client/src/components/ReasoningTrace.js` + `.css`
- `client/src/components/SystemStatus.js` + `.css`

**Scripts:**
- `scripts/check-mapping-catalogs.js`
- `scripts/debug-catalogs.js`
- `scripts/diagnose-vkg-schema.js`
- `scripts/test-bedrock-token.js`

**Infrastructure:**
- `trino/` directory (config.properties, jvm.config, node.properties)
- `trino/catalog/` directory

**Docs:**
- `docs/VKG_MERGE_PLAN.md` (reference only)

---

### B. Files only in `neo4j copy` — KEEP (already in base)

- `docs/architecture.html`
- `docs/architecture.md`

---

### C. Identical files — NO ACTION

These services/files are byte-identical in both repos:
- `server/services/entityResolutionService.js`
- `server/services/multiHopReasoningService.js`
- `server/services/graphAlgorithmsService.js`
- `server/services/graphSchemaService.js`
- `server/services/neo4jService.js`
- `server/services/extractionService.js`
- All other services not listed in section D
- All ontology route sub-files not listed in section D
- All client components not listed in section D

---

### D. Files that differ — MANUAL MERGE REQUIRED

Each file below has changes on BOTH sides or needs VKG additions layered onto the newer `neo4j copy` version.

#### D1. Keep `neo4j copy` version, then add VKG-only additions from `neo4j_vkg`

These files are newer/better in `neo4j copy` for core logic, but `neo4j_vkg` added VKG-specific code on top of the older base. Strategy: start from `neo4j copy`, surgically add VKG blocks.

| File | `neo4j copy` has (keep) | Add from `neo4j_vkg` |
|------|------------------------|---------------------|
| **`server/index.js`** | In-process commit worker startup | `require('./routes/trinoCatalogs')`, `require('./routes/vkgQuery')`, Trino health check in `/api/health`, route registration for `/api/trino` and `/api/vkg` |
| **`server/services/graphRAGService.js`** | Correct `return` per search mode (no dangling `result`), updated ChangeEvent audit instructions in Neo4j prompt | Add Phase 7 context graph enrichment block (lines 232-276 in vkg) that wraps result with `contextGraphBuilder` after the switch statement |
| **`server/services/graphDBStore.js`** | Cleaner `getClasses()`, `getObjectProperties()`, `getDataProperties()` without extra `options` param | Add `importTurtleToGraph()` method, add `includeWorkspaceOntologies` + `vkgGraphPattern` params to `buildFromClauses()`, pass `options` through to `executeSPARQL` in getClasses/getObjectProperties/getDataProperties |
| **`server/services/ontologyVersioningService.js`** | Proper error handling (throws on missing ontology instead of mock data), first-version detection, auto-tagging `initial`, richer version metadata | No VKG additions needed — keep `neo4j copy` as-is |
| **`server/services/owlOntologyService.js`** | Deprecated `createVersion()`/`getVersionHistory()` that delegate to `ontologyVersioningService` (correct architecture) | No VKG additions needed — keep `neo4j copy` as-is |
| **`server/services/entityService.js`** | Split relationship queries (avoids session conflicts), `mode: 'focused'` with fan-out capping, `concept_id` extraction from URI, `tenant_id`/`workspace_id` on nodes | No VKG additions — keep `neo4j copy` as-is |
| **`server/services/graphDBTripleService.js`** | Domain-aware data property routing (resolves `mapping.domain` to correct target entity), `sourceDocument` triple on linked entities | No VKG additions — keep `neo4j copy` as-is |
| **`server/services/graphDBNeo4jSyncService.js`** | `concept_id` extraction, `tenant_id`/`workspace_id` on synced nodes | Add ChangeEvent/audit graph sync logic (audit graph IRI in SPARQL, `isChangeEvent` detection, `CHANGED` relationship, `ChangeEvent` label) |
| **`server/services/llmService.js`** | Basic bearer token handling | Add `bedrock-api-key-` prefix enforcement, `parseTokenRegion()` static method, `parseTokenExpiry()`, region extraction from token, `maxTokens` default 4096 |
| **`server/services/embeddingService.js`** | Basic bearer token + region | Add `bedrock-api-key-` prefix enforcement, region extraction from token, `encodeURIComponent` on model name |
| **`server/services/minimalGraphSchemaService.js`** | Base Neo4j indexes | Add 3 new indexes: `node_uri_index`, `entity_label`, `canonical_id_index` |
| **`server/routes/chat.js`** | Inline per-user token lookup | Remove inline token lookup (handled by middleware now), add comment about `injectUserLLMToken` middleware |
| **`server/routes/owl.js`** | Uses `ontologyVersioningService` for version history (correct) | No VKG additions — keep `neo4j copy` as-is |
| **`server/routes/entities.js`** | Passes `mode` param for focused graph | No VKG additions — keep `neo4j copy` as-is |
| **`server/routes/auth.js`** | Conditional `setBedrockToken` | Always call `setBedrockToken` + add debug logging |
| **`server/routes/ontology/documents.js`** | Entity type/predicate counts in filter options, `lastUpdatedBy` filter, relaxed `sourceDocument` filter for stub entities, Neo4j entity cleanup on delete | No VKG additions — keep `neo4j copy` as-is |
| **`server/routes/ontology/sheetData.js`** | ~59 lines diff | Check if VKG-specific — likely keep `neo4j copy` |
| **`server/middleware/llmToken.js`** | Base token lookup | Add fallback to `default` key (admin-set server token), add debug logging |
| **`server/middleware/auth.js`** | `req.user.id \|\| req.user.email` | Change to `req.user.email \|\| req.user.id` (email-first, from vkg) |
| **`server/config/queue.js`** | Base queues | Add 3 VKG queues: `vkg-schema-introspection`, `vkg-ontology-generation`, `vkg-schema-drift-check` |
| **`server/config/roles.js`** | Base permissions | Add VKG permissions: `VKG_QUERY`, `VKG_CATALOG_MANAGE`, `VKG_ONTOLOGY_GEN`, `VKG_SCHEMA_DRIFT` |
| **`server/services/redisService.js`** | Base Redis ops | Add hash operations: `hSet`, `hGet`, `hGetAll`, `hDel` |
| **`server/services/metricsService.js`** | Base metrics | Add VKG metrics: `VKG_QUERIES`, `VKG_QUERY_FAILURES`, `VKG_AVG_LATENCY_MS`, etc. |
| **`server/workers/index.js`** | Base workers | Add `vkgProcessor` import and `closeVKGWorkers` in shutdown |

#### D2. Client files — Keep `neo4j copy`, add VKG UI hooks

| File | `neo4j copy` has (keep) | Add from `neo4j_vkg` |
|------|------------------------|---------------------|
| **`client/src/App.js`** | `ConnectionStatus` component | Add VKG imports (`VKGQuery`, `DataSourcesManager`, `DatabaseManager`), add nav items (`databases`, `datasources`, `vkg`), add section renders |
| **`client/src/components/Chat.js`** | Cleaner message handling | Add `vkg` search mode option, VKG endpoint routing (`/api/vkg/query`), VKG response rendering (context graph, reasoning trace, SQL citations, DB badges) |
| **`client/src/components/Chat.css`** | Base styles | Add VKG evidence panel styles (`.vkg-evidence-panels`, `.vkg-sql-citation`, `.vkg-db-badges`, etc.) |
| **`client/src/components/AdminPanel.js`** | `DatabaseManager` tab | Add `SystemStatus`, `SyncStatus`, `PopularEntities` tabs |
| **`client/src/components/EntityGraphView.js`** | Major rewrite — SVG-based with zoom/pan, dark theme, labels inside nodes, depth 2, focused mode | Keep `neo4j copy` entirely — it's a complete rewrite (851 lines diff) |
| **`client/src/components/EntityDetail.js`** | Minor diff (8 lines) | Trivial — check and merge if needed |
| **`client/src/components/FileManager.js`** | `useMemo` for filter options, entity type tabs with counts, richer entity display (confidence badges, claim status, evidence quotes) | Keep `neo4j copy` — it's the more polished version |
| **`client/src/components/OntologiesPage.js`** | Inline version action handler | Add `VersionHistoryModal` import and `handleVersionRollback` (from vkg) — but verify it works with `neo4j copy`'s versioning service |
| **`client/src/components/OntologyJobs.js`** | Retry embeddings button, embedding failure warnings, richer entity display (confidence badges, claim status) | Keep `neo4j copy` — it has more features |
| **`client/src/components/ontology/OntologyVersioningModal.js`** | `encodeURIComponent` on IDs, error state, confirmation dialogs, branch switching with GraphDB warning | Keep `neo4j copy` — it's more robust |
| **`client/src/components/ontology/StagedDocumentReview.js`** | Domain resolution in mappings, low-overlap detection for saved mappings, per-sheet primary class restore | Keep `neo4j copy` — significantly more complete (368 lines diff) |
| **`client/src/components/ontology/SheetView.js`** | Minor (7 lines) | Check and merge |
| **`client/src/components/ontology/EnhancedOntologyViewer.js`** | Minor (4 lines) | Check and merge |
| **`client/src/components/OntologiesPage.css`** | Diff exists | Compare and keep newer styles |
| **`client/src/components/OntologyJobs.css`** | Diff exists | Keep `neo4j copy` (matches its JS) |
| **`client/src/components/EntityGraphView.css`** | Diff exists | Keep `neo4j copy` (matches its JS rewrite) |
| **`client/src/components/FileManager.css`** | Diff exists | Keep `neo4j copy` (matches its JS) |
| **`client/src/components/ontology/OntologyVersioningModal.css`** | Diff exists | Keep `neo4j copy` |
| **`client/src/components/ontology/StagedDocumentReview.css`** | Diff exists | Keep `neo4j copy` |

#### D3. Infrastructure

| File | Action |
|------|--------|
| **`docker-compose.yml`** | Keep `neo4j copy` base, add Trino service block + `TRINO_URL` env + `trino-catalog` volume from `neo4j_vkg` |
| **`.env.template`** | Add `TRINO_URL` and `TRINO_USER` |
| **`client/package.json`** | Keep `neo4j copy` (proxy port 5002). Dependencies are identical. |

---

## Execution Order

### Phase 1: Copy VKG-only files (no conflicts)
1. Copy `trino/` directory
2. Copy `server/config/trino.js`
3. Copy all 7 VKG service files
4. Copy `server/services/prompts/` directory
5. Copy `server/services/jobProcessors/vkgProcessor.js`
6. Copy 2 VKG route files
7. Copy 5 VKG client components (+ CSS)
8. Copy 4 VKG scripts

### Phase 2: Merge infrastructure config
1. Add Trino to `docker-compose.yml`
2. Update `.env.template`
3. Add VKG queues to `server/config/queue.js`
4. Add VKG permissions to `server/config/roles.js`
5. Add VKG metrics to `server/services/metricsService.js`
6. Add hash ops to `server/services/redisService.js`
7. Add Neo4j indexes to `server/services/minimalGraphSchemaService.js`

### Phase 3: Merge server-side logic
1. `server/index.js` — add VKG route imports + registration + Trino health
2. `server/workers/index.js` — add VKG processor
3. `server/services/graphDBStore.js` — add `importTurtleToGraph()`, update `buildFromClauses()` signature, pass `options` to SPARQL methods
4. `server/services/graphRAGService.js` — add context graph enrichment block (after switch, before return)
5. `server/services/graphDBNeo4jSyncService.js` — add ChangeEvent sync logic
6. `server/services/llmService.js` — add token prefix/region/expiry parsing
7. `server/services/embeddingService.js` — add token prefix/region handling
8. `server/middleware/llmToken.js` — add default token fallback + logging
9. `server/middleware/auth.js` — email-first user ID
10. `server/routes/auth.js` — always set bedrock token + logging
11. `server/routes/chat.js` — remove inline token lookup (middleware handles it)

### Phase 4: Merge client-side
1. `App.js` — add VKG nav items + imports + section renders
2. `Chat.js` — add VKG mode + endpoint routing + response rendering
3. `Chat.css` — add VKG styles
4. `AdminPanel.js` — add SystemStatus/SyncStatus/Popular tabs
5. `OntologiesPage.js` — add VersionHistoryModal if compatible
6. Minor merges: `EntityDetail.js`, `SheetView.js`, `EnhancedOntologyViewer.js`

### Phase 5: Verify
1. `npm install` (dependencies are identical, no new packages needed)
2. Check `server/services/graphDBStore.js` — the `options` param threading through `getClasses`/`getObjectProperties`/`getDataProperties` needs care since `neo4j copy` doesn't have it. VKG services call these with options, so add the param but default to `{}`.
3. Verify `contextGraphBuilder.js` imports work in `graphRAGService.js`
4. Verify VKG routes have correct middleware chain
5. Test health endpoint includes Trino
6. Test Chat component renders both materialized and VKG modes

---

## Risk Areas

1. **`graphDBStore.js`** — Largest merge (327 lines diff). The `buildFromClauses()` signature change and `options` threading through SPARQL methods touches many callers. Must ensure existing callers still work with default params.

2. **`graphRAGService.js`** — The context graph enrichment block references `contextGraphBuilder` which is a new file. The `neo4j copy` version uses direct `return` per mode; `neo4j_vkg` captures into `result` variable then enriches. Need to refactor `neo4j copy`'s returns into a `result` variable pattern.

3. **`graphDBNeo4jSyncService.js`** — The ChangeEvent sync adds audit graph to SPARQL queries and special-cases `pf:entity` as a `CHANGED` relationship. Must verify this doesn't break existing sync for non-ChangeEvent entities.

4. **`llmService.js` / `embeddingService.js`** — Token handling changes are improvements but change auth flow. Test with both bearer token and IAM auth paths.

5. **`OntologiesPage.js`** — The versioning modal integration differs significantly. `neo4j copy` uses inline callbacks; `neo4j_vkg` uses a separate `VersionHistoryModal`. Since `neo4j copy`'s `ontologyVersioningService` is more mature, keep its approach and skip the vkg modal pattern.

---

## What NOT to merge from `neo4j_vkg`

- `schemaDriftService.js` — Listed in VKG_MERGE_PLAN.md but does NOT exist in `neo4j_vkg/server/services/`. It's planned but not implemented yet. Skip.
- `neo4j_vkg`'s version of `owlOntologyService.js` — it has live `createVersion()`/`getVersionHistory()` implementations that bypass `ontologyVersioningService`. `neo4j copy` correctly deprecates these and delegates. Keep `neo4j copy`.
- `neo4j_vkg`'s version of `ontologyVersioningService.js` — uses mock data fallback on error. `neo4j copy` properly throws. Keep `neo4j copy`.
- `neo4j_vkg`'s version of `EntityGraphView.js` — canvas-based, simpler. `neo4j copy` has a full SVG rewrite with zoom/pan/dark theme. Keep `neo4j copy`.
- `neo4j_vkg`'s version of `FileManager.js` — missing entity type tabs, simpler filter options. Keep `neo4j copy`.
- `neo4j_vkg`'s version of `OntologyJobs.js` — missing retry embeddings. Keep `neo4j copy`.
- `neo4j_vkg`'s version of `StagedDocumentReview.js` — missing domain resolution, low-overlap detection. Keep `neo4j copy`.
