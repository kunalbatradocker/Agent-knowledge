# GraphDB Flow Fixes - No Fallbacks Approach

## Summary of Changes

All fixes enforce strict validation with no fallbacks. Operations will fail with clear error messages rather than silently proceeding with defaults.

---

## 1. NEW: GraphDB Triple Service (`server/services/graphDBTripleService.js`)

A new strict service for generating and writing triples to GraphDB:

- **`detectXSDType(value)`** - Strict XSD datatype detection (integer, decimal, date, dateTime, boolean, string)
- **`validateClass(classIRI, ontology)`** - Throws if class not found in ontology
- **`validateProperty(propIRI, ontology)`** - Throws if property not found in ontology
- **`generateCSVTriples()`** - Generates triples for CSV with:
  - Required: ontology, primaryClass, columnMappings
  - Validates all classes and properties exist in ontology
  - Proper XSD datatype annotations on all literals
  - Throws if any column is unmapped (must be explicitly mapped or ignored)
- **`generateEntityTriples()`** - Generates triples for extracted entities with:
  - Required: ontology, entities array
  - Validates all entity types exist in ontology
  - Validates all relationship predicates exist in ontology
  - Creates reified statements for confidence scores
- **`writeTriplesToGraphDB()`** - Atomic write with proper prefixes

---

## 2. FIXED: Commit Staged Endpoint (`POST /api/ontology/documents/commit-staged`)

**Before:** Used defaults for tenantId, workspaceId, ontologyId; generated property URIs that might not exist in ontology.

**After:**
- **Required parameters:** `docId`, `tenantId`, `workspaceId`, `ontologyId`
- **For CSV:** Also requires `primaryClass` and `columnMappings`
- All classes and properties validated against ontology before writing
- Proper XSD datatypes on all literals
- Clear error messages on validation failure

---

## 3. FIXED: Approve Extraction Endpoint (`POST /api/ontology/documents/:id/approve-extraction`)

**Before:** Only wrote to Neo4j, never to GraphDB. Used fallback type "Concept".

**After:**
- **Required parameters:** `entities`, `ontologyId`, `tenantId`, `workspaceId`
- Writes to BOTH GraphDB AND Neo4j
- Validates all entity types exist in ontology
- Validates all relationship predicates exist in ontology
- GraphDB write happens first - if it fails, Neo4j write is skipped

---

## 4. FIXED: GraphDB Import (`graphDBStore.importTurtle`)

**Before:** Generated fallback ontologyId with timestamp if not provided; no rollback on failure.

**After:**
- **Required:** ontologyId must be extractable from content or provided explicitly
- **Atomic operation:** Backs up existing graph before clear
- **Rollback:** If import fails after clear, restores from backup
- Validates turtle content is not empty
- Validates scope-specific requirements (tenantId for tenant scope, etc.)

---

## 5. FIXED: OWL Ontology Import (`owlOntologyService.importOntology`)

**Before:** Generated fallback ontologyId with timestamp.

**After:**
- **Required:** ontologyId must be extractable or provided
- Validates scope-specific requirements
- Validates import produced at least 1 triple
- Warns if ontology has no OWL classes defined

---

## 6. FIXED: Document Staging TTL

**Before:** 24-hour TTL with no warning.

**After:**
- **7-day TTL** for staged documents
- Tracks `stagedAt` and `expiresAt` timestamps
- `GET /api/ontology/documents/staged` returns:
  - `expiresAt` for each document
  - `expiringWarning: true` if expiring within 24 hours
  - `hoursUntilExpiry` countdown
  - Summary with count of expiring documents

---

## API Changes

### Breaking Changes

1. **`POST /api/ontology/documents/commit-staged`**
   - Now requires: `ontologyId`, `tenantId`, `workspaceId`
   - For CSV: Also requires `primaryClass`, `columnMappings`
   - No longer accepts defaults

2. **`POST /api/ontology/documents/:id/approve-extraction`**
   - Now requires: `ontologyId`, `tenantId`, `workspaceId`
   - No longer accepts defaults

3. **`POST /api/owl/import`**
   - `ontologyId` must be extractable from content or provided
   - No longer generates fallback IDs

### New Response Fields

**`GET /api/ontology/documents/staged`**
```json
{
  "success": true,
  "staged": [
    {
      "docId": "...",
      "stagedAt": "2024-01-23T...",
      "expiresAt": "2024-01-30T...",
      "expiringWarning": false,
      "hoursUntilExpiry": 168
    }
  ],
  "summary": {
    "total": 5,
    "expiringSoon": 1,
    "warning": "1 document(s) expiring within 24 hours"
  }
}
```

---

## Error Messages

All validation errors now provide clear, actionable messages:

- `"ontologyId is required - documents must be mapped to an ontology"`
- `"primaryClass is required for CSV documents"`
- `"columnMappings is required for CSV documents - all columns must be mapped or ignored"`
- `"Class 'XYZ' not found in ontology. Available: Person, Organization, ..."`
- `"Property 'abc' not found in ontology. Available: hasName, worksAt, ..."`
- `"Column 'xyz' must have a property mapping"`
- `"No mapping provided for column 'xyz'. All columns must be explicitly mapped or ignored."`
- `"Relationship source 'John' not found in entities"`
- `"ontologyId is required - could not extract from ontologyIRI or turtle content. Provide ontologyId explicitly."`
