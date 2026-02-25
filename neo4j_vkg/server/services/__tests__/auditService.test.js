const fc = require('fast-check');
const graphDBStore = require('../graphDBStore');
const auditService = require('../auditService');

/**
 * Property 1: Audit graph IRI determinism
 * **Validates: Requirements 1.2**
 *
 * For any valid tenantId and workspaceId strings,
 * getAuditGraphIRI(tenantId, workspaceId) should return a string matching
 * the pattern http://purplefabric.ai/graphs/tenant/{tenantId}/workspace/{workspaceId}/audit,
 * and calling it twice with the same inputs should return the same result.
 */
describe('Property 1: Audit graph IRI determinism', () => {
  // Arbitrary that produces non-empty strings that won't be rejected by the method
  const validId = fc.string({ minLength: 1 })
    .filter(s => s !== 'undefined' && s.trim().length > 0);

  it('should return the correct IRI pattern and be deterministic (min 100 runs)', () => {
    fc.assert(
      fc.property(validId, validId, (tenantId, workspaceId) => {
        const result1 = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
        const result2 = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);

        // Determinism: same inputs → same output
        expect(result1).toBe(result2);

        // Pattern: must match the expected IRI format
        const expected = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/audit`;
        expect(result1).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('should throw for missing or invalid tenantId', () => {
    fc.assert(
      fc.property(validId, (workspaceId) => {
        expect(() => graphDBStore.getAuditGraphIRI(null, workspaceId)).toThrow();
        expect(() => graphDBStore.getAuditGraphIRI('', workspaceId)).toThrow();
        expect(() => graphDBStore.getAuditGraphIRI('undefined', workspaceId)).toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('should throw for missing or invalid workspaceId', () => {
    fc.assert(
      fc.property(validId, (tenantId) => {
        expect(() => graphDBStore.getAuditGraphIRI(tenantId, null)).toThrow();
        expect(() => graphDBStore.getAuditGraphIRI(tenantId, '')).toThrow();
        expect(() => graphDBStore.getAuditGraphIRI(tenantId, 'undefined')).toThrow();
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 2: Entity URI extraction from triples
 * **Validates: Requirements 2.1**
 *
 * For any set of valid Turtle triple strings, the entity URI extraction function
 * should return exactly the set of unique subject URIs present in those triples
 * (excluding metadata-only subjects like Document URIs and OWL declarations).
 */
describe('Property 2: Entity URI extraction from triples', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const PF_DOC = 'http://purplefabric.ai/ontology#Document';
  const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
  const OWL_OBJ_PROP = 'http://www.w3.org/2002/07/owl#ObjectProperty';
  const OWL_DT_PROP = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  // Generate a simple alphanumeric identifier for URIs
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);

  // Generate an entity URI
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);

  // Generate a predicate URI (non-rdf:type)
  const arbPredicateURI = arbId.map(id => `http://example.org/ontology#${id}`);

  // Generate a class URI for rdf:type (not an excluded type)
  const arbClassURI = arbId.map(id => `http://example.org/ontology#Class${id}`);

  // Generate a literal value (simple alphanumeric, no special chars to avoid escaping issues)
  const arbLiteralValue = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);

  // Build a typed literal triple
  const arbEntityTriple = fc.tuple(arbEntityURI, arbPredicateURI, arbLiteralValue).map(
    ([subj, pred, val]) =>
      `<${subj}> <${pred}> "${val}"^^<${XSD_STRING}> .`
  );

  // Build an rdf:type triple with a non-excluded class
  const arbEntityTypeTriple = fc.tuple(arbEntityURI, arbClassURI).map(
    ([subj, cls]) =>
      `<${subj}> <${RDF_TYPE}> <${cls}> .`
  );

  // Build a Document type triple (should be excluded)
  const arbDocTriple = arbEntityURI.map(
    subj => `<${subj}> <${RDF_TYPE}> <${PF_DOC}> .`
  );

  // Build an OWL declaration triple (should be excluded)
  const arbOwlTriple = fc.tuple(
    arbEntityURI,
    fc.constantFrom(OWL_CLASS, OWL_OBJ_PROP, OWL_DT_PROP)
  ).map(
    ([subj, owlType]) => `<${subj}> <${RDF_TYPE}> <${owlType}> .`
  );

  it('should return exactly the unique entity URIs, excluding Document and OWL subjects (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbEntityTriple, { minLength: 0, maxLength: 10 }),
        fc.array(arbEntityTypeTriple, { minLength: 0, maxLength: 5 }),
        fc.array(arbDocTriple, { minLength: 0, maxLength: 5 }),
        fc.array(arbOwlTriple, { minLength: 0, maxLength: 5 }),
        (entityTriples, typeTriples, docTriples, owlTriples) => {
          const allTriples = [...entityTriples, ...typeTriples, ...docTriples, ...owlTriples];

          // Compute expected: collect all subjects, then remove excluded ones
          const allSubjects = new Set();
          const excludedSubjects = new Set();
          const excludedTypes = new Set([PF_DOC, OWL_CLASS, OWL_OBJ_PROP, OWL_DT_PROP]);

          for (const line of allTriples) {
            const match = line.match(/^<([^>]+)>/);
            if (match) allSubjects.add(match[1]);

            // Check for excluded rdf:type declarations
            const typeMatch = line.match(
              new RegExp(`^<([^>]+)>\\s+<${RDF_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\s+<([^>]+)>`)
            );
            if (typeMatch && excludedTypes.has(typeMatch[2])) {
              excludedSubjects.add(typeMatch[1]);
            }
          }

          const expectedURIs = new Set([...allSubjects].filter(u => !excludedSubjects.has(u)));
          const result = auditService.extractEntityURIs(allTriples);
          const resultSet = new Set(result);

          // Result should have no duplicates
          expect(result.length).toBe(resultSet.size);

          // Result set should match expected set exactly
          expect(resultSet).toEqual(expectedURIs);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return empty array for empty input', () => {
    expect(auditService.extractEntityURIs([])).toEqual([]);
    expect(auditService.extractEntityURIs(null)).toEqual([]);
    expect(auditService.extractEntityURIs(undefined)).toEqual([]);
  });

  it('should exclude subjects that appear as both entity and excluded type', () => {
    fc.assert(
      fc.property(arbEntityURI, arbPredicateURI, arbLiteralValue, (subj, pred, val) => {
        // Same subject has both a data triple and a Document type declaration
        const triples = [
          `<${subj}> <${pred}> "${val}"^^<${XSD_STRING}> .`,
          `<${subj}> <${RDF_TYPE}> <${PF_DOC}> .`,
        ];

        const result = auditService.extractEntityURIs(triples);
        // Subject should be excluded because it has an excluded rdf:type
        expect(result).not.toContain(subj);
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 3: Diff classification correctness
 * **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
 *
 * For any pair of old triple sets and new triple sets for the same entity,
 * the diff engine should produce: INSERT for every (entity, predicate) pair
 * present in new but not in old; UPDATE for every (entity, predicate) pair
 * present in both with different object values; DELETE for every (entity, predicate)
 * pair present in old but not in new; and no ChangeEvent for pairs with identical
 * values. The total number of ChangeEvents should equal the number of INSERTs +
 * UPDATEs + DELETEs, with no duplicates.
 */
describe('Property 3: Diff classification correctness', () => {
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  // Generate a simple alphanumeric identifier for URIs
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);

  // Generate an entity URI
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);

  // Generate a predicate URI that is NOT in SKIP_PREDICATES
  const arbPredicateURI = arbId.map(id => `http://example.org/ontology#${id}`);

  // Generate a simple literal value (alphanumeric, no special chars)
  const arbLiteralValue = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/);

  /**
   * Build a triple entry as used by computeDiff.
   * Old triples have: { predicate, object, objectType }
   * New triples have: { predicate, object, objectValue, objectType }
   */
  const makeOldTriple = (predicate, value) => ({
    predicate,
    object: `"${value}"^^<${XSD_STRING}>`,
    objectType: 'literal',
  });

  const makeNewTriple = (predicate, value) => ({
    predicate,
    object: `"${value}"^^<${XSD_STRING}>`,
    objectValue: value,
    objectType: 'literal',
  });

  /**
   * Arbitrary that generates a test scenario for a single entity:
   * - A set of predicates only in old (should produce DELETE)
   * - A set of predicates only in new (should produce INSERT)
   * - A set of predicates in both with different values (should produce UPDATE)
   * - A set of predicates in both with same values (should produce no change)
   */
  const arbDiffScenario = fc.record({
    entityURI: arbEntityURI,
    deleteOnlyPreds: fc.uniqueArray(arbPredicateURI, { minLength: 0, maxLength: 5 }),
    insertOnlyPreds: fc.uniqueArray(arbPredicateURI, { minLength: 0, maxLength: 5 }),
    updatePreds: fc.uniqueArray(arbPredicateURI, { minLength: 0, maxLength: 5 }),
    unchangedPreds: fc.uniqueArray(arbPredicateURI, { minLength: 0, maxLength: 5 }),
    oldValues: fc.array(arbLiteralValue, { minLength: 20, maxLength: 20 }),
    newValues: fc.array(arbLiteralValue, { minLength: 20, maxLength: 20 }),
    unchangedValues: fc.array(arbLiteralValue, { minLength: 5, maxLength: 5 }),
  }).chain(scenario => {
    // Ensure all predicate sets are disjoint by deduplicating across sets
    const allPreds = new Set();
    const deletePreds = [];
    const insertPreds = [];
    const updatePreds = [];
    const unchangedPreds = [];

    for (const p of scenario.deleteOnlyPreds) {
      if (!allPreds.has(p)) { allPreds.add(p); deletePreds.push(p); }
    }
    for (const p of scenario.insertOnlyPreds) {
      if (!allPreds.has(p)) { allPreds.add(p); insertPreds.push(p); }
    }
    for (const p of scenario.updatePreds) {
      if (!allPreds.has(p)) { allPreds.add(p); updatePreds.push(p); }
    }
    for (const p of scenario.unchangedPreds) {
      if (!allPreds.has(p)) { allPreds.add(p); unchangedPreds.push(p); }
    }

    return fc.constant({
      entityURI: scenario.entityURI,
      deletePreds,
      insertPreds,
      updatePreds,
      unchangedPreds,
      oldValues: scenario.oldValues,
      newValues: scenario.newValues,
      unchangedValues: scenario.unchangedValues,
    });
  }).filter(s => {
    // Ensure UPDATE predicates have genuinely different old/new values
    for (let i = 0; i < s.updatePreds.length; i++) {
      const oldObj = `"${s.oldValues[i]}"^^<${XSD_STRING}>`;
      const newObj = `"${s.newValues[i]}"^^<${XSD_STRING}>`;
      if (oldObj === newObj) return false;
    }
    return true;
  });

  it('should correctly classify INSERTs, UPDATEs, DELETEs, and unchanged (min 100 runs)', () => {
    fc.assert(
      fc.property(arbDiffScenario, (scenario) => {
        const { entityURI, deletePreds, insertPreds, updatePreds, unchangedPreds,
                oldValues, newValues, unchangedValues } = scenario;

        // Build old triples for this entity
        const oldTriples = [];
        // DELETE predicates: only in old
        deletePreds.forEach((pred, i) => {
          oldTriples.push(makeOldTriple(pred, oldValues[i] || 'delVal'));
        });
        // UPDATE predicates: in old with old values
        updatePreds.forEach((pred, i) => {
          oldTriples.push(makeOldTriple(pred, oldValues[i + deletePreds.length] || 'oldUpd'));
        });
        // UNCHANGED predicates: in old with same values
        unchangedPreds.forEach((pred, i) => {
          oldTriples.push(makeOldTriple(pred, unchangedValues[i] || 'same'));
        });

        // Build new triples for this entity
        const newTriples = [];
        // INSERT predicates: only in new
        insertPreds.forEach((pred, i) => {
          newTriples.push(makeNewTriple(pred, newValues[i] || 'insVal'));
        });
        // UPDATE predicates: in new with new (different) values
        updatePreds.forEach((pred, i) => {
          newTriples.push(makeNewTriple(pred, newValues[i + insertPreds.length] || 'newUpd'));
        });
        // UNCHANGED predicates: in new with same values
        unchangedPreds.forEach((pred, i) => {
          newTriples.push(makeNewTriple(pred, unchangedValues[i] || 'same'));
        });

        // Build Maps
        const existingByEntity = new Map();
        if (oldTriples.length > 0) {
          existingByEntity.set(entityURI, oldTriples);
        }

        const newTriplesByEntity = new Map();
        if (newTriples.length > 0) {
          newTriplesByEntity.set(entityURI, newTriples);
        }

        // Run computeDiff
        const result = auditService.computeDiff(existingByEntity, newTriplesByEntity);
        const { changes } = result;

        // Classify changes by type
        const inserts = changes.filter(c => c.changeType === 'INSERT');
        const updates = changes.filter(c => c.changeType === 'UPDATE');
        const deletes = changes.filter(c => c.changeType === 'DELETE');

        // Verify INSERT count matches insert-only predicates
        expect(inserts.length).toBe(insertPreds.length);
        // Verify UPDATE count matches update predicates
        expect(updates.length).toBe(updatePreds.length);
        // Verify DELETE count matches delete-only predicates
        expect(deletes.length).toBe(deletePreds.length);

        // Verify total = INSERTs + UPDATEs + DELETEs (no extras from unchanged)
        expect(changes.length).toBe(inserts.length + updates.length + deletes.length);

        // Verify no duplicates: each (entityURI, property) pair appears at most once
        const changeKeys = changes.map(c => `${c.entityURI}|${c.property}`);
        const uniqueKeys = new Set(changeKeys);
        expect(changeKeys.length).toBe(uniqueKeys.size);

        // Verify each INSERT has the correct entity and predicate
        for (const ins of inserts) {
          expect(ins.entityURI).toBe(entityURI);
          expect(insertPreds).toContain(ins.property);
          expect(ins.previousValue).toBe('');
          expect(ins.newValue).not.toBe('');
        }

        // Verify each UPDATE has the correct entity and predicate
        for (const upd of updates) {
          expect(upd.entityURI).toBe(entityURI);
          expect(updatePreds).toContain(upd.property);
          expect(upd.previousValue).not.toBe('');
          expect(upd.newValue).not.toBe('');
          expect(upd.previousValue).not.toBe(upd.newValue);
        }

        // Verify each DELETE has the correct entity and predicate
        for (const del of deletes) {
          expect(del.entityURI).toBe(entityURI);
          expect(deletePreds).toContain(del.property);
          expect(del.previousValue).not.toBe('');
          expect(del.newValue).toBe('');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should produce all INSERTs when old triples are empty (Req 2.3)', () => {
    fc.assert(
      fc.property(
        arbEntityURI,
        fc.uniqueArray(arbPredicateURI, { minLength: 1, maxLength: 5 }),
        fc.array(arbLiteralValue, { minLength: 5, maxLength: 5 }),
        (entityURI, predicates, values) => {
          const existingByEntity = new Map(); // empty old
          const newTriplesByEntity = new Map();
          newTriplesByEntity.set(
            entityURI,
            predicates.map((pred, i) => makeNewTriple(pred, values[i] || 'val'))
          );

          const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);

          // All should be INSERTs
          expect(changes.length).toBe(predicates.length);
          for (const c of changes) {
            expect(c.changeType).toBe('INSERT');
            expect(c.entityURI).toBe(entityURI);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce all DELETEs when new triples are empty (Req 2.4)', () => {
    fc.assert(
      fc.property(
        arbEntityURI,
        fc.uniqueArray(arbPredicateURI, { minLength: 1, maxLength: 5 }),
        fc.array(arbLiteralValue, { minLength: 5, maxLength: 5 }),
        (entityURI, predicates, values) => {
          const existingByEntity = new Map();
          existingByEntity.set(
            entityURI,
            predicates.map((pred, i) => makeOldTriple(pred, values[i] || 'val'))
          );
          const newTriplesByEntity = new Map(); // empty new

          const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);

          // All should be DELETEs
          expect(changes.length).toBe(predicates.length);
          for (const c of changes) {
            expect(c.changeType).toBe('DELETE');
            expect(c.entityURI).toBe(entityURI);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce no changes when old and new are identical (Req 2.5)', () => {
    fc.assert(
      fc.property(
        arbEntityURI,
        fc.uniqueArray(arbPredicateURI, { minLength: 1, maxLength: 5 }),
        fc.array(arbLiteralValue, { minLength: 5, maxLength: 5 }),
        (entityURI, predicates, values) => {
          const triples = predicates.map((pred, i) => {
            const val = values[i] || 'val';
            return {
              predicate: pred,
              object: `"${val}"^^<${XSD_STRING}>`,
              objectValue: val,
              objectType: 'literal',
            };
          });

          const existingByEntity = new Map();
          existingByEntity.set(entityURI, triples.map(t => ({
            predicate: t.predicate,
            object: t.object,
            objectType: t.objectType,
          })));

          const newTriplesByEntity = new Map();
          newTriplesByEntity.set(entityURI, triples);

          const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);
          expect(changes.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 4: Unchanged triples produce no ChangeEvents
 * **Validates: Requirements 2.5**
 *
 * For any set of triples, if the old and new triple sets are identical,
 * the diff engine should produce zero ChangeEvents.
 */
describe('Property 4: Unchanged triples produce no ChangeEvents', () => {
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  // Generate a simple alphanumeric identifier for URIs
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);

  // Generate an entity URI
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);

  // Generate a predicate URI that is NOT in SKIP_PREDICATES
  const arbPredicateURI = arbId.map(id => `http://example.org/ontology#${id}`);

  // Generate a simple literal value
  const arbLiteralValue = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/);

  // Generate a URI value for URI-type objects
  const arbURIValue = arbId.map(id => `http://example.org/ref/${id}`);

  // Build an old-style triple entry (literal)
  const makeLiteralOldTriple = (predicate, value) => ({
    predicate,
    object: `"${value}"^^<${XSD_STRING}>`,
    objectType: 'literal',
  });

  // Build a new-style triple entry (literal)
  const makeLiteralNewTriple = (predicate, value) => ({
    predicate,
    object: `"${value}"^^<${XSD_STRING}>`,
    objectValue: value,
    objectType: 'literal',
  });

  // Build an old-style triple entry (URI)
  const makeURIOldTriple = (predicate, uriValue) => ({
    predicate,
    object: `<${uriValue}>`,
    objectType: 'uri',
  });

  // Build a new-style triple entry (URI)
  const makeURINewTriple = (predicate, uriValue) => ({
    predicate,
    object: `<${uriValue}>`,
    objectValue: uriValue,
    objectType: 'uri',
  });

  /**
   * Arbitrary: generates multiple entities, each with a mix of literal and URI predicates.
   * Returns { entities: Array<{ uri, triples: Array<{ old, new }> }> }
   */
  const arbMultiEntityScenario = fc.array(
    fc.record({
      entityURI: arbEntityURI,
      literalPreds: fc.uniqueArray(
        fc.record({ predicate: arbPredicateURI, value: arbLiteralValue }),
        { minLength: 0, maxLength: 5, selector: r => r.predicate }
      ),
      uriPreds: fc.uniqueArray(
        fc.record({ predicate: arbPredicateURI, value: arbURIValue }),
        { minLength: 0, maxLength: 5, selector: r => r.predicate }
      ),
    }),
    { minLength: 1, maxLength: 5 }
  ).map(entities => {
    // Deduplicate entity URIs — keep only the first occurrence
    const seen = new Set();
    return entities.filter(e => {
      if (seen.has(e.entityURI)) return false;
      seen.add(e.entityURI);
      return true;
    });
  }).map(entities =>
    // Ensure predicates within each entity are disjoint between literal and URI sets
    entities.map(e => {
      const usedPreds = new Set();
      const litPreds = [];
      const uPreds = [];
      for (const lp of e.literalPreds) {
        if (!usedPreds.has(lp.predicate)) { usedPreds.add(lp.predicate); litPreds.push(lp); }
      }
      for (const up of e.uriPreds) {
        if (!usedPreds.has(up.predicate)) { usedPreds.add(up.predicate); uPreds.push(up); }
      }
      return { entityURI: e.entityURI, literalPreds: litPreds, uriPreds: uPreds };
    })
  ).filter(entities =>
    // Ensure at least one entity has at least one predicate
    entities.some(e => e.literalPreds.length > 0 || e.uriPreds.length > 0)
  );

  it('should produce zero changes when old and new triple sets are identical across multiple entities (min 100 runs)', () => {
    fc.assert(
      fc.property(arbMultiEntityScenario, (entities) => {
        const existingByEntity = new Map();
        const newTriplesByEntity = new Map();

        for (const entity of entities) {
          const oldTriples = [];
          const newTriples = [];

          // Add literal triples
          for (const { predicate, value } of entity.literalPreds) {
            oldTriples.push(makeLiteralOldTriple(predicate, value));
            newTriples.push(makeLiteralNewTriple(predicate, value));
          }

          // Add URI triples
          for (const { predicate, value } of entity.uriPreds) {
            oldTriples.push(makeURIOldTriple(predicate, value));
            newTriples.push(makeURINewTriple(predicate, value));
          }

          if (oldTriples.length > 0) {
            existingByEntity.set(entity.entityURI, oldTriples);
            newTriplesByEntity.set(entity.entityURI, newTriples);
          }
        }

        const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);

        // The core property: identical old and new should produce zero changes
        expect(changes).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('should produce zero changes for a single entity with only URI-type objects', () => {
    fc.assert(
      fc.property(
        arbEntityURI,
        fc.uniqueArray(
          fc.record({ predicate: arbPredicateURI, value: arbURIValue }),
          { minLength: 1, maxLength: 5, selector: r => r.predicate }
        ),
        (entityURI, preds) => {
          const existingByEntity = new Map();
          const newTriplesByEntity = new Map();

          existingByEntity.set(entityURI, preds.map(p => makeURIOldTriple(p.predicate, p.value)));
          newTriplesByEntity.set(entityURI, preds.map(p => makeURINewTriple(p.predicate, p.value)));

          const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);
          expect(changes).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce zero changes for a single entity with only literal-type objects', () => {
    fc.assert(
      fc.property(
        arbEntityURI,
        fc.uniqueArray(
          fc.record({ predicate: arbPredicateURI, value: arbLiteralValue }),
          { minLength: 1, maxLength: 5, selector: r => r.predicate }
        ),
        (entityURI, preds) => {
          const existingByEntity = new Map();
          const newTriplesByEntity = new Map();

          existingByEntity.set(entityURI, preds.map(p => makeLiteralOldTriple(p.predicate, p.value)));
          newTriplesByEntity.set(entityURI, preds.map(p => makeLiteralNewTriple(p.predicate, p.value)));

          const { changes } = auditService.computeDiff(existingByEntity, newTriplesByEntity);
          expect(changes).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 5: ChangeEvent triple completeness
 * **Validates: Requirements 3.1, 3.3**
 *
 * For any ChangeEvent object with valid fields, the generated Turtle triples
 * should contain all required predicates: rdf:type pf:ChangeEvent, pf:entity,
 * pf:property, pf:changeType, pf:changedAt, and pf:sourceDocument.
 * For UPDATE and DELETE events, pf:previousValue should be present.
 * For INSERT and UPDATE events, pf:newValue should be present.
 * All audit-specific predicates should use the PF namespace.
 */
describe('Property 5: ChangeEvent triple completeness', () => {
  const PF = 'http://purplefabric.ai/ontology#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  // Required predicates for every ChangeEvent
  const ALWAYS_REQUIRED = [
    RDF_TYPE,
    `${PF}entity`,
    `${PF}property`,
    `${PF}changeType`,
    `${PF}changedAt`,
    `${PF}sourceDocument`,
  ];

  // Generators
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);
  const arbPropertyURI = arbId.map(id => `http://example.org/ontology#${id}`);
  const arbValue = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
  const arbChangeType = fc.constantFrom('INSERT', 'UPDATE', 'DELETE');
  const arbAuditGraphIRI = fc.constant('http://purplefabric.ai/graphs/tenant/t1/workspace/w1/audit');
  const arbSourceDocURI = arbId.map(id => `doc://${id}`);

  /**
   * Generate a valid ChangeEvent object with appropriate previousValue/newValue
   * based on changeType.
   */
  const arbChangeEvent = fc.record({
    entityURI: arbEntityURI,
    property: arbPropertyURI,
    previousValue: arbValue,
    newValue: arbValue,
    changeType: arbChangeType,
  }).map(evt => {
    // Align previousValue/newValue with changeType
    if (evt.changeType === 'INSERT') {
      return { ...evt, previousValue: '' };
    }
    if (evt.changeType === 'DELETE') {
      return { ...evt, newValue: '' };
    }
    // UPDATE keeps both
    return evt;
  });

  /**
   * Helper: extract all predicates from generated triples for a given event URI prefix.
   */
  function extractPredicates(triples) {
    const predicates = new Set();
    for (const line of triples) {
      const match = line.match(/^<[^>]+>\s+<([^>]+)>/);
      if (match) predicates.add(match[1]);
    }
    return predicates;
  }

  it('should include all required predicates for any ChangeEvent (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbChangeEvent, { minLength: 1, maxLength: 5 }),
        arbAuditGraphIRI,
        arbSourceDocURI,
        (changes, auditGraphIRI, sourceDocURI) => {
          const triples = auditService.generateChangeEventTriples(changes, auditGraphIRI, sourceDocURI);

          // Each change produces multiple triples sharing the same event URI.
          // Group triples by their subject (event URI).
          const triplesByEvent = new Map();
          for (const line of triples) {
            const subjMatch = line.match(/^<([^>]+)>/);
            if (subjMatch) {
              const subj = subjMatch[1];
              if (!triplesByEvent.has(subj)) triplesByEvent.set(subj, []);
              triplesByEvent.get(subj).push(line);
            }
          }

          // We should have exactly one event URI per change
          expect(triplesByEvent.size).toBe(changes.length);

          // Verify each event has all required predicates
          let eventIndex = 0;
          for (const [, eventTriples] of triplesByEvent) {
            const predicates = extractPredicates(eventTriples);
            const change = changes[eventIndex];

            // Always-required predicates
            for (const req of ALWAYS_REQUIRED) {
              expect(predicates).toContain(req);
            }

            // Conditional: previousValue for UPDATE and DELETE
            if (change.changeType === 'UPDATE' || change.changeType === 'DELETE') {
              expect(predicates).toContain(`${PF}previousValue`);
            }

            // Conditional: newValue for INSERT and UPDATE
            if (change.changeType === 'INSERT' || change.changeType === 'UPDATE') {
              expect(predicates).toContain(`${PF}newValue`);
            }

            // INSERT should NOT have previousValue
            if (change.changeType === 'INSERT') {
              expect(predicates).not.toContain(`${PF}previousValue`);
            }

            // DELETE should NOT have newValue
            if (change.changeType === 'DELETE') {
              expect(predicates).not.toContain(`${PF}newValue`);
            }

            eventIndex++;
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should use PF namespace for all audit-specific predicates (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbChangeEvent, { minLength: 1, maxLength: 3 }),
        arbAuditGraphIRI,
        arbSourceDocURI,
        (changes, auditGraphIRI, sourceDocURI) => {
          const triples = auditService.generateChangeEventTriples(changes, auditGraphIRI, sourceDocURI);

          for (const line of triples) {
            const predMatch = line.match(/^<[^>]+>\s+<([^>]+)>/);
            if (!predMatch) continue;
            const predicate = predMatch[1];

            // Every predicate should be either rdf:type or a PF namespace predicate
            const isRdfType = predicate === RDF_TYPE;
            const isPFNamespace = predicate.startsWith(PF);
            expect(isRdfType || isPFNamespace).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce correct rdf:type value for ChangeEvent (min 100 runs)', () => {
    fc.assert(
      fc.property(
        arbChangeEvent,
        arbAuditGraphIRI,
        arbSourceDocURI,
        (change, auditGraphIRI, sourceDocURI) => {
          const triples = auditService.generateChangeEventTriples([change], auditGraphIRI, sourceDocURI);

          // Find the rdf:type triple
          const typeTriple = triples.find(t => t.includes(`<${RDF_TYPE}>`));
          expect(typeTriple).toBeDefined();
          expect(typeTriple).toContain(`<${PF}ChangeEvent>`);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 6: ChangeEvent URI uniqueness
 * **Validates: Requirements 3.2**
 *
 * For any set of ChangeEvents generated from a single diff operation,
 * all assigned ChangeEvent URIs should be unique.
 */
describe('Property 6: ChangeEvent URI uniqueness', () => {
  const PF = 'http://purplefabric.ai/ontology#';

  // Generators
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);
  const arbPropertyURI = arbId.map(id => `http://example.org/ontology#${id}`);
  const arbValue = fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/);
  const arbChangeType = fc.constantFrom('INSERT', 'UPDATE', 'DELETE');
  const arbAuditGraphIRI = fc.constant('http://purplefabric.ai/graphs/tenant/t1/workspace/w1/audit');
  const arbSourceDocURI = arbId.map(id => `doc://${id}`);

  /**
   * Generate a valid ChangeEvent object with appropriate previousValue/newValue
   * based on changeType.
   */
  const arbChangeEvent = fc.record({
    entityURI: arbEntityURI,
    property: arbPropertyURI,
    previousValue: arbValue,
    newValue: arbValue,
    changeType: arbChangeType,
  }).map(evt => {
    if (evt.changeType === 'INSERT') {
      return { ...evt, previousValue: '' };
    }
    if (evt.changeType === 'DELETE') {
      return { ...evt, newValue: '' };
    }
    return evt;
  });

  /**
   * Helper: extract unique event URIs (subjects) from generated triples.
   * Event URIs follow the pattern: {auditGraphIRI}/event/{uuid}
   */
  function extractEventURIs(triples, auditGraphIRI) {
    const uris = new Set();
    for (const line of triples) {
      const match = line.match(/^<([^>]+)>/);
      if (match && match[1].startsWith(`${auditGraphIRI}/event/`)) {
        uris.add(match[1]);
      }
    }
    return uris;
  }

  it('should assign a unique URI to each ChangeEvent (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbChangeEvent, { minLength: 1, maxLength: 20 }),
        arbAuditGraphIRI,
        arbSourceDocURI,
        (changes, auditGraphIRI, sourceDocURI) => {
          const triples = auditService.generateChangeEventTriples(changes, auditGraphIRI, sourceDocURI);

          const eventURIs = extractEventURIs(triples, auditGraphIRI);

          // Number of unique event URIs should equal the number of input changes
          expect(eventURIs.size).toBe(changes.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce no duplicate URIs even with identical change inputs (min 100 runs)', () => {
    fc.assert(
      fc.property(
        arbChangeEvent,
        fc.integer({ min: 2, max: 10 }),
        arbAuditGraphIRI,
        arbSourceDocURI,
        (change, count, auditGraphIRI, sourceDocURI) => {
          // Create an array of identical changes
          const changes = Array.from({ length: count }, () => ({ ...change }));

          const triples = auditService.generateChangeEventTriples(changes, auditGraphIRI, sourceDocURI);

          const eventURIs = extractEventURIs(triples, auditGraphIRI);

          // Even with identical change objects, each should get a unique URI
          expect(eventURIs.size).toBe(count);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return empty array and zero URIs for empty changes', () => {
    const triples = auditService.generateChangeEventTriples(
      [],
      'http://purplefabric.ai/graphs/tenant/t1/workspace/w1/audit',
      'doc://test'
    );
    expect(triples).toEqual([]);
  });
});


/**
 * Property 7: ChangeEvent Turtle round-trip validity
 * **Validates: Requirements 3.4**
 *
 * For any ChangeEvent object, the generated Turtle triple strings should be
 * parseable back into structured triples that preserve the original ChangeEvent
 * field values (entity, property, previousValue, newValue, changeType, changedAt,
 * sourceDocument).
 */
describe('Property 7: ChangeEvent Turtle round-trip validity', () => {
  const PF = 'http://purplefabric.ai/ontology#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  // Generators — alphanumeric only to avoid Turtle escaping edge cases
  const arbId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/);
  const arbEntityURI = arbId.map(id => `http://example.org/entity/${id}`);
  const arbPropertyURI = arbId.map(id => `http://example.org/ontology#${id}`);
  const arbValue = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/);
  const arbChangeType = fc.constantFrom('INSERT', 'UPDATE', 'DELETE');
  const arbAuditGraphIRI = fc.constant('http://purplefabric.ai/graphs/tenant/t1/workspace/w1/audit');
  const arbSourceDocURI = arbId.map(id => `http://example.org/doc/${id}`);

  /**
   * Generate a valid ChangeEvent with previousValue/newValue aligned to changeType.
   */
  const arbChangeEvent = fc.record({
    entityURI: arbEntityURI,
    property: arbPropertyURI,
    previousValue: arbValue,
    newValue: arbValue,
    changeType: arbChangeType,
  }).map(evt => {
    if (evt.changeType === 'INSERT') return { ...evt, previousValue: '' };
    if (evt.changeType === 'DELETE') return { ...evt, newValue: '' };
    return evt;
  });

  it('should round-trip ChangeEvent fields through Turtle generation and parsing (min 100 runs)', () => {
    fc.assert(
      fc.property(
        arbChangeEvent,
        arbAuditGraphIRI,
        arbSourceDocURI,
        (change, auditGraphIRI, sourceDocURI) => {
          // Step 1: Generate Turtle triples from the ChangeEvent
          const triples = auditService.generateChangeEventTriples([change], auditGraphIRI, sourceDocURI);
          expect(triples.length).toBeGreaterThan(0);

          // Step 2: Parse each triple back into structured form
          const parsed = triples.map(line => auditService.parseTriple(line)).filter(Boolean);
          expect(parsed.length).toBe(triples.length);

          // Build a predicate → parsed triple map for easy lookup
          const byPredicate = new Map();
          for (const p of parsed) {
            byPredicate.set(p.predicate, p);
          }

          // Step 3: Verify pf:entity round-trips to the original entityURI
          const entityTriple = byPredicate.get(`${PF}entity`);
          expect(entityTriple).toBeDefined();
          expect(entityTriple.objectType).toBe('uri');
          expect(entityTriple.objectValue).toBe(change.entityURI);

          // Step 4: Verify pf:property round-trips to the original property
          const propertyTriple = byPredicate.get(`${PF}property`);
          expect(propertyTriple).toBeDefined();
          expect(propertyTriple.objectType).toBe('uri');
          expect(propertyTriple.objectValue).toBe(change.property);

          // Step 5: Verify pf:changeType round-trips
          const changeTypeTriple = byPredicate.get(`${PF}changeType`);
          expect(changeTypeTriple).toBeDefined();
          expect(changeTypeTriple.objectValue).toBe(change.changeType);

          // Step 6: Verify pf:previousValue for UPDATE and DELETE
          if (change.changeType === 'UPDATE' || change.changeType === 'DELETE') {
            const prevTriple = byPredicate.get(`${PF}previousValue`);
            expect(prevTriple).toBeDefined();
            expect(prevTriple.objectValue).toBe(change.previousValue);
          }

          // Step 7: Verify pf:newValue for INSERT and UPDATE
          if (change.changeType === 'INSERT' || change.changeType === 'UPDATE') {
            const newTriple = byPredicate.get(`${PF}newValue`);
            expect(newTriple).toBeDefined();
            expect(newTriple.objectValue).toBe(change.newValue);
          }

          // Step 8: Verify pf:sourceDocument round-trips
          const sourceDocTriple = byPredicate.get(`${PF}sourceDocument`);
          expect(sourceDocTriple).toBeDefined();
          expect(sourceDocTriple.objectType).toBe('uri');
          expect(sourceDocTriple.objectValue).toBe(sourceDocURI);

          // Step 9: Verify pf:changedAt is a valid ISO 8601 timestamp
          const changedAtTriple = byPredicate.get(`${PF}changedAt`);
          expect(changedAtTriple).toBeDefined();
          const parsedDate = new Date(changedAtTriple.objectValue);
          expect(parsedDate.toISOString()).toBe(changedAtTriple.objectValue);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 8: Audit triple batching preserves all events
 * **Validates: Requirements 8.3**
 *
 * For any set of ChangeEvent triples and any batch size, splitting into batches
 * and concatenating should produce the same set of triples as the original
 * (no triples lost or duplicated).
 */
describe('Property 8: Audit triple batching preserves all events', () => {
  const { BATCH_SIZE } = require('../auditService');

  /**
   * Replicate the batching logic used in writeAuditTriples:
   *   for (let i = 0; i < arr.length; i += batchSize) {
   *     batches.push(arr.slice(i, i + batchSize));
   *   }
   */
  function splitIntoBatches(arr, batchSize) {
    const batches = [];
    for (let i = 0; i < arr.length; i += batchSize) {
      batches.push(arr.slice(i, i + batchSize));
    }
    return batches;
  }

  // Generator for a triple-like string
  const arbTriple = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/).map(
    id => `<http://example.org/audit/event/${id}> <http://purplefabric.ai/ontology#changeType> "UPDATE" .`
  );

  it('should preserve all triples after batching and concatenation (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbTriple, { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (triples, batchSize) => {
          const batches = splitIntoBatches(triples, batchSize);
          const concatenated = batches.flat();

          // Same elements, same order, same count
          expect(concatenated).toEqual(triples);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should ensure each batch has at most batchSize elements (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbTriple, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (triples, batchSize) => {
          const batches = splitIntoBatches(triples, batchSize);

          for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(batchSize);
            expect(batch.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should ensure total elements across all batches equals original length (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbTriple, { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (triples, batchSize) => {
          const batches = splitIntoBatches(triples, batchSize);
          const totalElements = batches.reduce((sum, b) => sum + b.length, 0);

          expect(totalElements).toBe(triples.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce correct number of batches (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(arbTriple, { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (triples, batchSize) => {
          const batches = splitIntoBatches(triples, batchSize);
          const expectedBatchCount = triples.length === 0 ? 0 : Math.ceil(triples.length / batchSize);

          expect(batches.length).toBe(expectedBatchCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should work with the actual BATCH_SIZE constant from auditService (min 100 runs)', () => {
    expect(BATCH_SIZE).toBe(10000);

    fc.assert(
      fc.property(
        fc.array(arbTriple, { minLength: 0, maxLength: 200 }),
        (triples) => {
          const batches = splitIntoBatches(triples, BATCH_SIZE);
          const concatenated = batches.flat();

          expect(concatenated).toEqual(triples);

          for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(BATCH_SIZE);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
