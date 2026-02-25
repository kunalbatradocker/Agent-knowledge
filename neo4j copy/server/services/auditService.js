/**
 * Audit Service
 * Handles diff computation, ChangeEvent generation, and audit graph operations.
 */

const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const graphDBTripleService = require('./graphDBTripleService');
const graphDBStore = require('./graphDBStore');

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const PF = 'http://purplefabric.ai/ontology#';

const BATCH_SIZE = 10000;

/**
 * Predicates excluded from diff to avoid noise from system-managed fields.
 */
const SKIP_PREDICATES = new Set([
  `${RDF}type`,
  `${PF}sourceDocument`,
  `${PF}rowIndex`,
  `${PF}lastUpdatedBy`,
  `${PF}updatedAt`,
  `${RDFS}label`,
]);

class AuditService {

  /**
   * Parse a single Turtle triple line into a structured object.
   * Handles URI objects, typed literals, and plain literals.
   * Returns null for prefix lines, blank lines, and malformed lines.
   *
   * @param {string} turtleLine - A Turtle triple string
   * @returns {{ subject: string, predicate: string, object: string, objectValue: string, objectType: string } | null}
   */
  parseTriple(turtleLine) {
    if (!turtleLine || typeof turtleLine !== 'string') return null;

    const line = turtleLine.trim();
    if (line === '' || line.startsWith('@prefix') || line.startsWith('#')) return null;

    // Match: <subject> <predicate> <object> .   (URI object)
    const uriMatch = line.match(/^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.?\s*$/);
    if (uriMatch) {
      return {
        subject: uriMatch[1],
        predicate: uriMatch[2],
        object: `<${uriMatch[3]}>`,
        objectValue: uriMatch[3],
        objectType: 'uri',
      };
    }

    // Match: <subject> <predicate> "value"^^<type> .   (typed literal)
    const typedLiteralMatch = line.match(/^<([^>]+)>\s+<([^>]+)>\s+"((?:[^"\\]|\\.)*)"\^\^<([^>]+)>\s*\.?\s*$/);
    if (typedLiteralMatch) {
      return {
        subject: typedLiteralMatch[1],
        predicate: typedLiteralMatch[2],
        object: `"${typedLiteralMatch[3]}"^^<${typedLiteralMatch[4]}>`,
        objectValue: typedLiteralMatch[3].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        objectType: 'literal',
      };
    }

    // Match: <subject> <predicate> "value" .   (plain literal)
    const plainLiteralMatch = line.match(/^<([^>]+)>\s+<([^>]+)>\s+"((?:[^"\\]|\\.)*)"\s*\.?\s*$/);
    if (plainLiteralMatch) {
      return {
        subject: plainLiteralMatch[1],
        predicate: plainLiteralMatch[2],
        object: `"${plainLiteralMatch[3]}"`,
        objectValue: plainLiteralMatch[3].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        objectType: 'literal',
      };
    }

    // Malformed or unsupported line
    logger.warn(`[AuditService] Skipping unparseable triple line: ${line}`);
    return null;
  }

  /**
   * Extract unique entity subject URIs from an array of Turtle triple strings.
   * Excludes Document URIs (subjects with rdf:type pf:Document) and
   * OWL declarations (subjects with rdf:type owl:Class, owl:ObjectProperty, owl:DatatypeProperty).
   *
   * @param {string[]} triples - Array of Turtle triple strings
   * @returns {string[]} - Unique entity subject URIs
   */
  extractEntityURIs(triples) {
    if (!triples || !Array.isArray(triples)) return [];

    const allSubjects = new Set();
    const excludedSubjects = new Set();

    const excludedTypes = new Set([
      `${PF}Document`,
      `${OWL}Class`,
      `${OWL}ObjectProperty`,
      `${OWL}DatatypeProperty`,
    ]);

    for (const line of triples) {
      const parsed = this.parseTriple(line);
      if (!parsed) continue;

      allSubjects.add(parsed.subject);

      // Check if this triple declares the subject as an excluded type
      if (parsed.predicate === `${RDF}type` && parsed.objectType === 'uri') {
        if (excludedTypes.has(parsed.objectValue)) {
          excludedSubjects.add(parsed.subject);
        }
      }
    }

    // Return subjects that are not excluded
    return [...allSubjects].filter(uri => !excludedSubjects.has(uri));
  }

  /**
   * Extract a human-readable value from a raw Turtle object string.
   * Handles URI objects like `<http://...>`, typed literals like `"val"^^<type>`,
   * and plain literals like `"val"`.
   *
   * @param {string} rawObject - Raw Turtle object string
   * @returns {string} - Extracted value
   */
  _extractObjectValue(rawObject) {
    if (!rawObject || typeof rawObject !== 'string') return '';

    // URI object: <http://example.org/thing>
    const uriMatch = rawObject.match(/^<([^>]+)>$/);
    if (uriMatch) return uriMatch[1];

    // Typed literal: "value"^^<type>
    const typedMatch = rawObject.match(/^"((?:[^"\\]|\\.)*)"\^\^<[^>]+>$/);
    if (typedMatch) return typedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // Plain literal: "value"
    const plainMatch = rawObject.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (plainMatch) return plainMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    return rawObject;
  }

  /**
   * Compute diff between existing and new triples grouped by entity.
   * Classifies changes as INSERT, UPDATE, or DELETE per (entity, predicate) pair.
   * Skips predicates in SKIP_PREDICATES.
   *
   * @param {Map<string, Array<{predicate: string, object: string, objectType: string}>>} existingByEntity
   * @param {Map<string, Array<{predicate: string, object: string, objectValue: string, objectType: string}>>} newTriplesByEntity
   * @param {string} [sourceDocumentURI] - If provided, only delete entities that belong to this source document
   * @returns {{ changes: Array<{entityURI: string, property: string, previousValue: string, newValue: string, changeType: string}>, entityURIsToDelete: string[] }}
   */
  computeDiff(existingByEntity, newTriplesByEntity, sourceDocumentURI) {
    const changes = [];
    const entityURIsToDelete = [];

    // Collect all entity URIs from both maps
    const allEntityURIs = new Set([
      ...(existingByEntity ? existingByEntity.keys() : []),
      ...(newTriplesByEntity ? newTriplesByEntity.keys() : []),
    ]);

    for (const entityURI of allEntityURIs) {
      const oldTriples = (existingByEntity && existingByEntity.get(entityURI)) || [];
      const newTriples = (newTriplesByEntity && newTriplesByEntity.get(entityURI)) || [];

      // Only delete-before-insert if entity belongs to the same source document
      if (oldTriples.length > 0) {
        const existingSource = oldTriples.find(t => t.predicate === `${PF}sourceDocument`);
        const existingSourceURI = existingSource ? existingSource.object.replace(/^<|>$/g, '') : null;
        if (!sourceDocumentURI || existingSourceURI === sourceDocumentURI) {
          entityURIsToDelete.push(entityURI);
        }
      }

      // Build predicate → object maps, skipping metadata predicates
      const oldByPredicate = new Map();
      for (const t of oldTriples) {
        if (!SKIP_PREDICATES.has(t.predicate)) {
          oldByPredicate.set(t.predicate, t);
        }
      }

      const newByPredicate = new Map();
      for (const t of newTriples) {
        if (!SKIP_PREDICATES.has(t.predicate)) {
          newByPredicate.set(t.predicate, t);
        }
      }

      // Check new predicates against old
      for (const [predicate, newEntry] of newByPredicate) {
        const oldEntry = oldByPredicate.get(predicate);
        const newValue = newEntry.objectValue != null ? newEntry.objectValue : this._extractObjectValue(newEntry.object);

        if (!oldEntry) {
          // INSERT: predicate exists in new but not in old
          changes.push({
            entityURI,
            property: predicate,
            previousValue: '',
            newValue,
            changeType: 'INSERT',
          });
        } else if (oldEntry.object !== newEntry.object) {
          // UPDATE: same predicate, different object
          const previousValue = oldEntry.objectValue != null ? oldEntry.objectValue : this._extractObjectValue(oldEntry.object);
          changes.push({
            entityURI,
            property: predicate,
            previousValue,
            newValue,
            changeType: 'UPDATE',
          });
        }
        // If objects are identical, no change — skip
      }

      // Check for DELETEs: predicates in old but not in new
      for (const [predicate, oldEntry] of oldByPredicate) {
        if (!newByPredicate.has(predicate)) {
          const previousValue = oldEntry.objectValue != null ? oldEntry.objectValue : this._extractObjectValue(oldEntry.object);
          changes.push({
            entityURI,
            property: predicate,
            previousValue,
            newValue: '',
            changeType: 'DELETE',
          });
        }
      }
    }

    return { changes, entityURIsToDelete };
  }

  /**
   * Generate ChangeEvent RDF triples from diff results.
   * Each ChangeEvent gets a unique URI and produces individual Turtle triple strings.
   *
   * @param {Array<{entityURI: string, property: string, previousValue: string, newValue: string, changeType: string}>} changes
   * @param {string} auditGraphIRI - The audit graph IRI
   * @param {string} sourceDocumentURI - URI of the document that triggered the change
   * @returns {string[]} - Array of Turtle triple strings (one triple per string, ending with ` .`)
   */
  generateChangeEventTriples(changes, auditGraphIRI, sourceDocumentURI) {
    if (!changes || !Array.isArray(changes) || changes.length === 0) return [];

    const triples = [];
    const timestamp = new Date().toISOString();

    for (const change of changes) {
      const eventURI = `${auditGraphIRI}/event/${uuidv4()}`;
      const escapedChangeType = graphDBTripleService.escapeTurtleLiteral(change.changeType);
      const escapedTimestamp = graphDBTripleService.escapeTurtleLiteral(timestamp);

      // rdf:type
      triples.push(`<${eventURI}> <${RDF}type> <${PF}ChangeEvent> .`);
      // pf:entity
      triples.push(`<${eventURI}> <${PF}entity> <${change.entityURI}> .`);
      // pf:property
      triples.push(`<${eventURI}> <${PF}property> <${change.property}> .`);

      // pf:previousValue — for UPDATE and DELETE only
      if (change.changeType === 'UPDATE' || change.changeType === 'DELETE') {
        const escapedPrev = graphDBTripleService.escapeTurtleLiteral(change.previousValue);
        triples.push(`<${eventURI}> <${PF}previousValue> "${escapedPrev}"^^<${XSD}string> .`);
      }

      // pf:newValue — for INSERT and UPDATE only
      if (change.changeType === 'INSERT' || change.changeType === 'UPDATE') {
        const escapedNew = graphDBTripleService.escapeTurtleLiteral(change.newValue);
        triples.push(`<${eventURI}> <${PF}newValue> "${escapedNew}"^^<${XSD}string> .`);
      }

      // pf:changeType
      triples.push(`<${eventURI}> <${PF}changeType> "${escapedChangeType}"^^<${XSD}string> .`);
      // pf:changedAt
      triples.push(`<${eventURI}> <${PF}changedAt> "${escapedTimestamp}"^^<${XSD}dateTime> .`);
      // pf:sourceDocument
      triples.push(`<${eventURI}> <${PF}sourceDocument> <${sourceDocumentURI}> .`);
    }

    return triples;
  }

  /**
   * Query existing triples for a set of entity URIs from the data graph.
   * Batches entity URIs in groups of 100 to avoid SPARQL query size limits.
   *
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {string[]} entityURIs - URIs of entities to query
   * @returns {Promise<Map<string, Array<{predicate: string, object: string, objectType: string}>>>}
   */
  async getExistingTriples(tenantId, workspaceId, entityURIs) {
    if (!entityURIs || entityURIs.length === 0) {
      logger.info('[AuditService] No entity URIs provided, returning empty map.');
      return new Map();
    }

    const ENTITY_BATCH_SIZE = 100;
    const result = new Map();

    logger.info(`[AuditService] Querying existing triples for ${entityURIs.length} entities`);

    for (let i = 0; i < entityURIs.length; i += ENTITY_BATCH_SIZE) {
      const batch = entityURIs.slice(i, i + ENTITY_BATCH_SIZE);
      const valuesClause = batch.map(uri => `<${uri}>`).join(' ');

      const query = `SELECT ?s ?p ?o WHERE {
  VALUES ?s { ${valuesClause} }
  ?s ?p ?o .
}`;

      const response = await graphDBStore.executeSPARQL(tenantId, workspaceId, query, 'data');
      const bindings = response?.results?.bindings || [];

      for (const binding of bindings) {
        const subject = binding.s.value;
        const predicate = binding.p.value;

        let object;
        let objectType;

        if (binding.o.type === 'uri') {
          objectType = 'uri';
          object = `<${binding.o.value}>`;
        } else {
          // literal (typed or plain)
          objectType = 'literal';
          if (binding.o.datatype) {
            object = `"${binding.o.value}"^^<${binding.o.datatype}>`;
          } else {
            object = `"${binding.o.value}"`;
          }
        }

        if (!result.has(subject)) {
          result.set(subject, []);
        }
        result.get(subject).push({ predicate, object, objectType });
      }
    }

    logger.info(`[AuditService] Retrieved existing triples for ${result.size} entities (${[...result.values()].reduce((sum, arr) => sum + arr.length, 0)} total triples)`);

    return result;
  }

  /**
   * Group parsed triples by their subject URI.
   *
   * @param {string[]} triples - Array of Turtle triple strings
   * @returns {Map<string, Array<{ predicate: string, object: string, objectValue: string, objectType: string }>>}
   */
  groupTriplesByEntity(triples) {
    const grouped = new Map();

    if (!triples || !Array.isArray(triples)) return grouped;

    for (const line of triples) {
      const parsed = this.parseTriple(line);
      if (!parsed) continue;

      if (!grouped.has(parsed.subject)) {
        grouped.set(parsed.subject, []);
      }

      grouped.get(parsed.subject).push({
        predicate: parsed.predicate,
        object: parsed.object,
        objectValue: parsed.objectValue,
        objectType: parsed.objectType,
      });
    }

    return grouped;
  }

  /**
   * Write ChangeEvent triples to the audit graph in GraphDB.
   * Uses graphDBStore._fetchWithPool for HTTP POST with concurrency control.
   * Batches triples with BATCH_SIZE to avoid exceeding request size limits.
   *
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {string[]} auditTriples - Array of Turtle triple strings
   */
  async writeAuditTriples(tenantId, workspaceId, auditTriples) {
    if (!auditTriples || auditTriples.length === 0) {
      logger.info('[AuditService] No audit triples to write, skipping.');
      return;
    }

    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(auditGraphIRI)}`;

    const prefixes = [
      `@prefix rdf: <${RDF}> .`,
      `@prefix rdfs: <${RDFS}> .`,
      `@prefix xsd: <${XSD}> .`,
      `@prefix pf: <${PF}> .`,
      ''
    ].join('\n');

    const totalBatches = Math.ceil(auditTriples.length / BATCH_SIZE);

    for (let i = 0; i < auditTriples.length; i += BATCH_SIZE) {
      const batch = auditTriples.slice(i, i + BATCH_SIZE);
      const turtle = prefixes + '\n' + batch.join('\n');
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      const response = await graphDBStore._fetchWithPool(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Audit graph write failed at batch ${batchNum}/${totalBatches}: ${response.status} - ${error}`);
      }

      logger.info(`[AuditService] Wrote audit batch ${batchNum}/${totalBatches} (${batch.length} triples) to ${auditGraphIRI}`);
    }

    logger.info(`[AuditService] Wrote ${auditTriples.length} total audit triples to ${auditGraphIRI}`);
  }

  /**
   * Full pre-commit audit flow: extract entity URIs → query existing triples →
   * compute diff → generate ChangeEvent triples → write to audit graph.
   *
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {string[]} newTriples - Array of Turtle triple strings being committed
   * @param {string} sourceDocumentURI - URI of the document triggering the commit
   * @returns {Promise<{ changeCount: number, entityURIsToDelete: string[] }>}
   */
  async preCommitAudit(tenantId, workspaceId, newTriples, sourceDocumentURI) {
    if (!sourceDocumentURI) {
      logger.warn('[AuditService] preCommitAudit called without sourceDocumentURI, skipping audit.');
      return { changeCount: 0, entityURIsToDelete: [] };
    }

    logger.info(`[AuditService] Starting pre-commit audit for workspace ${workspaceId}, source: ${sourceDocumentURI}`);

    // 1. Extract entity URIs from new triples
    const entityURIs = this.extractEntityURIs(newTriples);
    logger.info(`[AuditService] Extracted ${entityURIs.length} entity URIs from ${newTriples.length} new triples`);

    if (entityURIs.length === 0) {
      logger.info('[AuditService] No entity URIs found in new triples, skipping audit.');
      return { changeCount: 0, entityURIsToDelete: [] };
    }

    // 2. Query existing triples for those entities
    const existingByEntity = await this.getExistingTriples(tenantId, workspaceId, entityURIs);

    // Skip audit on first commit — no existing data means nothing to diff against
    if (existingByEntity.size === 0) {
      logger.info(`[AuditService] First commit (no existing triples), skipping audit for ${entityURIs.length} entities`);
      return { changeCount: 0, entityURIsToDelete: [] };
    }

    // 3. Group new triples by entity
    const newTriplesByEntity = this.groupTriplesByEntity(newTriples);

    // 4. Compute diff
    const { changes, entityURIsToDelete } = this.computeDiff(existingByEntity, newTriplesByEntity, sourceDocumentURI);
    logger.info(`[AuditService] Diff computed: ${changes.length} changes, ${entityURIsToDelete.length} entities to delete`);

    // 5. Generate and write ChangeEvent triples
    if (changes.length > 0) {
      const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
      const auditTriples = this.generateChangeEventTriples(changes, auditGraphIRI, sourceDocumentURI);
      logger.info(`[AuditService] Generated ${auditTriples.length} audit triples for ${changes.length} changes`);

      // 6. Write audit triples to GraphDB
      await this.writeAuditTriples(tenantId, workspaceId, auditTriples);
    } else {
      logger.info('[AuditService] No changes detected, skipping audit write.');
    }

    logger.info(`[AuditService] Pre-commit audit complete: ${changes.length} changes recorded`);
    return { changeCount: changes.length, entityURIsToDelete };
  }

  /**
   * Execute a SPARQL query directly against the GraphDB repository endpoint.
   * Uses explicit GRAPH clauses instead of relying on executeSPARQL's FROM clause injection.
   *
   * @param {string} query - SPARQL query string
   * @returns {Promise<Object>} - Parsed SPARQL JSON results
   * @private
   */
  async _executeSPARQLDirect(query) {
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}`;
    const response = await graphDBStore._fetchWithPool(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        'Accept': 'application/sparql-results+json'
      },
      body: query
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SPARQL query failed: ${response.status} - ${error}`);
    }
    return response.json();
  }

  /**
   * Query change history for a specific entity from the audit graph.
   * Returns all ChangeEvents where pf:entity matches the given entityURI,
   * ordered by changedAt DESC.
   *
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {string} entityURI
   * @returns {Promise<Array<{uri: string, entityURI: string, property: string, previousValue: string, newValue: string, changeType: string, changedAt: string, sourceDocument: string}>>}
   */
  async getEntityChangeHistory(tenantId, workspaceId, entityURI) {
    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);

    const query = `
PREFIX pf: <${PF}>
SELECT ?event ?property ?previousValue ?newValue ?changeType ?changedAt ?sourceDocument WHERE {
  GRAPH <${auditGraphIRI}> {
    ?event a pf:ChangeEvent .
    ?event pf:entity <${entityURI}> .
    ?event pf:property ?property .
    ?event pf:changeType ?changeType .
    ?event pf:changedAt ?changedAt .
    ?event pf:sourceDocument ?sourceDocument .
    OPTIONAL { ?event pf:previousValue ?previousValue }
    OPTIONAL { ?event pf:newValue ?newValue }
  }
}
ORDER BY DESC(?changedAt)
`;

    logger.info(`[AuditService] Querying change history for entity: ${entityURI}`);
    const result = await this._executeSPARQLDirect(query);
    const bindings = result?.results?.bindings || [];

    return bindings.map(b => ({
      uri: b.event.value,
      entityURI,
      property: b.property.value,
      previousValue: b.previousValue ? b.previousValue.value : '',
      newValue: b.newValue ? b.newValue.value : '',
      changeType: b.changeType.value,
      changedAt: b.changedAt.value,
      sourceDocument: b.sourceDocument.value,
    }));
  }

  /**
   * Query recent changes across the workspace with pagination and optional filters.
   *
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {{ limit?: number, offset?: number, changeType?: string, dateFrom?: string, dateTo?: string }} options
   * @returns {Promise<{ changes: Array<{uri: string, entityURI: string, property: string, previousValue: string, newValue: string, changeType: string, changedAt: string, sourceDocument: string}>, total: number }>}
   */
  async getWorkspaceAuditLog(tenantId, workspaceId, options = {}) {
    const { limit = 50, offset = 0, changeType, dateFrom, dateTo } = options;
    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);

    // Build optional FILTER clauses
    const filters = [];
    if (changeType) {
      filters.push(`FILTER(?changeType = "${graphDBTripleService.escapeTurtleLiteral(changeType)}")`);
    }
    if (dateFrom) {
      filters.push(`FILTER(?changedAt >= "${dateFrom}"^^<${XSD}dateTime>)`);
    }
    if (dateTo) {
      filters.push(`FILTER(?changedAt <= "${dateTo}"^^<${XSD}dateTime>)`);
    }
    const filterClause = filters.length > 0 ? '\n    ' + filters.join('\n    ') : '';

    // Count query for total
    const countQuery = `
PREFIX pf: <${PF}>
SELECT (COUNT(?event) AS ?total) WHERE {
  GRAPH <${auditGraphIRI}> {
    ?event a pf:ChangeEvent .
    ?event pf:changeType ?changeType .
    ?event pf:changedAt ?changedAt .${filterClause}
  }
}
`;

    // Data query with pagination
    const dataQuery = `
PREFIX pf: <${PF}>
SELECT ?event ?entity ?property ?previousValue ?newValue ?changeType ?changedAt ?sourceDocument WHERE {
  GRAPH <${auditGraphIRI}> {
    ?event a pf:ChangeEvent .
    ?event pf:entity ?entity .
    ?event pf:property ?property .
    ?event pf:changeType ?changeType .
    ?event pf:changedAt ?changedAt .
    ?event pf:sourceDocument ?sourceDocument .
    OPTIONAL { ?event pf:previousValue ?previousValue }
    OPTIONAL { ?event pf:newValue ?newValue }${filterClause}
  }
}
ORDER BY DESC(?changedAt)
LIMIT ${parseInt(limit, 10)}
OFFSET ${parseInt(offset, 10)}
`;

    logger.info(`[AuditService] Querying workspace audit log (limit=${limit}, offset=${offset}, changeType=${changeType || 'all'}, dateFrom=${dateFrom || 'none'}, dateTo=${dateTo || 'none'})`);

    const [countResult, dataResult] = await Promise.all([
      this._executeSPARQLDirect(countQuery),
      this._executeSPARQLDirect(dataQuery),
    ]);

    const total = parseInt(countResult?.results?.bindings?.[0]?.total?.value || '0', 10);
    const bindings = dataResult?.results?.bindings || [];

    const changes = bindings.map(b => ({
      uri: b.event.value,
      entityURI: b.entity.value,
      property: b.property.value,
      previousValue: b.previousValue ? b.previousValue.value : '',
      newValue: b.newValue ? b.newValue.value : '',
      changeType: b.changeType.value,
      changedAt: b.changedAt.value,
      sourceDocument: b.sourceDocument.value,
    }));

    return { changes, total };
  }
}

module.exports = new AuditService();
module.exports.SKIP_PREDICATES = SKIP_PREDICATES;
module.exports.BATCH_SIZE = BATCH_SIZE;
module.exports.PF = PF;
module.exports.RDF = RDF;
module.exports.RDFS = RDFS;
module.exports.OWL = OWL;
module.exports.XSD = XSD;
