/**
 * Sheet Data Routes
 * Spreadsheet-style CRUD over GraphDB entity data with audit via auditService
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const graphDBStore = require('../../services/graphDBStore');
const neo4jService = require('../../services/neo4jService');
const redisService = require('../../services/redisService');
const auditService = require('../../services/auditService');
const graphDBTripleService = require('../../services/graphDBTripleService');
const logger = require('../../utils/logger');
const { optionalTenantContext } = require('../../middleware/tenantContext');
const { requireMember } = require('../../middleware/auth');

const PF = 'http://purplefabric.ai/ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function escapeRdfValue(val) {
  if (val === null || val === undefined) return '""';
  const s = String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${s}"`;
}

function extractLocal(iri) {
  if (!iri) return iri;
  return iri.split('#').pop().split('/').pop();
}

// Write audit change events to GraphDB audit graph
async function writeAuditChanges(tenantId, workspaceId, changes, sourceDocumentURI) {
  try {
    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);
    const triples = auditService.generateChangeEventTriples(changes, auditGraphIRI, sourceDocumentURI);
    if (triples.length > 0) {
      await auditService.writeAuditTriples(tenantId, workspaceId, triples);
    }
  } catch (e) {
    logger.warn(`[SheetData] Audit write failed (non-fatal): ${e.message}`);
  }
}

// --- GET /sheet-data/:docId ---
router.get('/:docId', optionalTenantContext, async (req, res) => {
  try {
    const { docId } = req.params;
    const tenantId = req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default';
    const { type, limit = 100, offset = 0, search = '', columnFilters } = req.query;

    const docJson = await redisService.get(`doc:${docId}`);
    if (!docJson) return res.status(404).json({ success: false, error: 'Document not found' });
    const doc = JSON.parse(docJson);
    const docUri = doc.uri;

    // Discover entity types
    const typesQuery = `
      SELECT DISTINCT ?type (COUNT(DISTINCT ?s) AS ?count) WHERE {
        ?s <${PF}sourceDocument> <${docUri}> .
        ?s a ?type .
        FILTER(?type != <http://www.w3.org/2002/07/owl#NamedIndividual>)
      } GROUP BY ?type ORDER BY DESC(?count)
    `;
    const typesResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, typesQuery, 'data');
    const entityTypes = (typesResult?.results?.bindings || []).map(b => ({
      uri: b.type?.value,
      label: extractLocal(b.type?.value),
      count: parseInt(b.count?.value || 0)
    }));

    const selectedType = type || entityTypes[0]?.uri;
    if (!selectedType) {
      return res.json({ success: true, entityTypes, columns: [], rows: [], total: 0 });
    }

    // Get properties
    const propsQuery = `
      SELECT DISTINCT ?p WHERE {
        ?s <${PF}sourceDocument> <${docUri}> .
        ?s a <${selectedType}> .
        ?s ?p ?o .
        FILTER(?p != <${RDF_TYPE}>) FILTER(?p != <${PF}sourceDocument>)
      }
    `;
    const propsResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, propsQuery, 'data');
    const columns = (propsResult?.results?.bindings || []).map(b => ({
      uri: b.p?.value, label: extractLocal(b.p?.value)
    }));

    // Search/filter
    let searchFilter = '';
    if (search) {
      const escaped = search.replace(/"/g, '\\"');
      searchFilter = `?s ?_anyP ?_anyV . FILTER(ISLITERAL(?_anyV) && CONTAINS(LCASE(STR(?_anyV)), LCASE("${escaped}")))`;
    }
    let colFilterClauses = '';
    if (columnFilters) {
      try {
        const cf = JSON.parse(columnFilters);
        for (const [propUri, filterText] of Object.entries(cf)) {
          if (filterText) {
            const esc = filterText.replace(/"/g, '\\"');
            const varName = propUri.split('#').pop().split('/').pop();
            colFilterClauses += `\n?s <${propUri}> ?_cf_${varName} . FILTER(CONTAINS(LCASE(STR(?_cf_${varName})), LCASE("${esc}")))`;
          }
        }
      } catch (e) { /* ignore */ }
    }
    const filterBlock = searchFilter + colFilterClauses;

    // Count
    const countQuery = `SELECT (COUNT(DISTINCT ?s) AS ?total) WHERE {
      ?s <${PF}sourceDocument> <${docUri}> . ?s a <${selectedType}> . ${filterBlock}
    }`;
    const countResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, countQuery, 'data');
    const total = parseInt(countResult?.results?.bindings?.[0]?.total?.value || 0);

    // Rows
    const dataQuery = `SELECT ?s ?p ?o WHERE {
      { SELECT DISTINCT ?s WHERE {
          ?s <${PF}sourceDocument> <${docUri}> . ?s a <${selectedType}> . ${filterBlock}
        } ORDER BY ?s LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      }
      ?s ?p ?o . FILTER(?p != <${RDF_TYPE}>)
    } ORDER BY ?s`;
    const dataResult = await graphDBStore.executeSPARQL(tenantId, workspaceId, dataQuery, 'data');

    const rowMap = new Map();
    for (const b of dataResult?.results?.bindings || []) {
      const subj = b.s?.value, prop = b.p?.value, val = b.o?.value, valType = b.o?.type;
      if (!rowMap.has(subj)) rowMap.set(subj, { _uri: subj });
      const propLabel = extractLocal(prop);
      rowMap.get(subj)[propLabel] = val;
      if (valType === 'uri' && prop !== `${PF}sourceDocument`) {
        rowMap.get(subj)[`_ref_${propLabel}`] = true;
      }
    }

    res.json({
      success: true, entityTypes,
      selectedType: { uri: selectedType, label: extractLocal(selectedType) },
      columns, rows: Array.from(rowMap.values()), total,
      offset: parseInt(offset), limit: parseInt(limit)
    });
  } catch (error) {
    logger.error('Sheet data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- PUT /sheet-data/:docId/cell ---
router.put('/:docId/cell', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default';
    const { entityUri, propertyUri, oldValue, newValue } = req.body;

    if (!entityUri || !propertyUri) {
      return res.status(400).json({ success: false, error: 'entityUri and propertyUri required' });
    }

    const dataGraph = graphDBStore.getDataGraphIRI(tenantId, workspaceId);

    // SPARQL DELETE/INSERT
    const updateQuery = oldValue !== undefined && oldValue !== null
      ? `DELETE DATA { GRAPH <${dataGraph}> { <${entityUri}> <${propertyUri}> ${escapeRdfValue(oldValue)} } };
         INSERT DATA { GRAPH <${dataGraph}> { <${entityUri}> <${propertyUri}> ${escapeRdfValue(newValue)} } }`
      : `INSERT DATA { GRAPH <${dataGraph}> { <${entityUri}> <${propertyUri}> ${escapeRdfValue(newValue)} } }`;

    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
    const response = await graphDBStore._fetchWithPool(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: updateQuery
    });
    if (!response.ok) throw new Error(`SPARQL update failed: ${response.status}`);

    // Sync to Neo4j
    const propLocal = extractLocal(propertyUri);
    const session = neo4jService.getSession();
    try {
      await session.run(`MATCH (n {uri: $uri}) SET n.\`${propLocal}\` = $val`, { uri: entityUri, val: newValue });
    } finally { await session.close(); }

    // Get doc URI for audit sourceDocument
    const docJson = await redisService.get(`doc:${req.params.docId}`);
    const docUri = docJson ? JSON.parse(docJson).uri : entityUri;

    // Audit → GraphDB audit graph
    await writeAuditChanges(tenantId, workspaceId, [{
      entityURI: entityUri,
      property: propertyUri,
      previousValue: oldValue || '',
      newValue: newValue || '',
      changeType: oldValue !== undefined && oldValue !== null ? 'UPDATE' : 'INSERT'
    }], docUri);

    res.json({ success: true });
  } catch (error) {
    logger.error('Cell update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- POST /sheet-data/:docId/row ---
router.post('/:docId/row', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const { docId } = req.params;
    const tenantId = req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default';
    const { typeUri, properties = {} } = req.body;

    if (!typeUri) return res.status(400).json({ success: false, error: 'typeUri required' });

    const docJson = await redisService.get(`doc:${docId}`);
    if (!docJson) return res.status(404).json({ success: false, error: 'Document not found' });
    const doc = JSON.parse(docJson);

    const entityId = uuidv4();
    const entityUri = `${doc.uri}/entity/${entityId}`;
    const dataGraph = graphDBStore.getDataGraphIRI(tenantId, workspaceId);

    const triples = [
      `<${entityUri}> a <${typeUri}> .`,
      `<${entityUri}> <${PF}sourceDocument> <${doc.uri}> .`
    ];
    for (const [propUri, value] of Object.entries(properties)) {
      if (value !== '' && value !== null && value !== undefined) {
        triples.push(`<${entityUri}> <${propUri}> ${escapeRdfValue(value)} .`);
      }
    }

    const insertQuery = `INSERT DATA { GRAPH <${dataGraph}> { ${triples.join('\n')} } }`;
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
    const response = await graphDBStore._fetchWithPool(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: insertQuery
    });
    if (!response.ok) throw new Error(`Insert failed: ${response.status}`);

    // Sync to Neo4j
    const typeLabel = extractLocal(typeUri).replace(/[^a-zA-Z0-9_]/g, '_') || 'Entity';
    const neoProps = { uri: entityUri, workspace_id: workspaceId, source_document: doc.uri };
    for (const [propUri, value] of Object.entries(properties)) {
      neoProps[extractLocal(propUri)] = value;
    }
    const session = neo4jService.getSession();
    try {
      const propKeys = Object.keys(neoProps).map(k => `n.\`${k}\` = $props.\`${k}\``).join(', ');
      await session.run(`CREATE (n:\`${typeLabel}\` {uri: $uri}) SET ${propKeys}`, { uri: entityUri, props: neoProps });
    } finally { await session.close(); }

    // Audit → GraphDB audit graph (INSERT for each property)
    const changes = Object.entries(properties)
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([propUri, value]) => ({
        entityURI: entityUri, property: propUri,
        previousValue: '', newValue: String(value), changeType: 'INSERT'
      }));
    if (changes.length > 0) {
      await writeAuditChanges(tenantId, workspaceId, changes, doc.uri);
    }

    res.json({ success: true, entityUri });
  } catch (error) {
    logger.error('Add row error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- DELETE /sheet-data/:docId/row ---
router.delete('/:docId/row', requireMember, optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default';
    const { entityUri } = req.body;

    if (!entityUri) return res.status(400).json({ success: false, error: 'entityUri required' });

    const dataGraph = graphDBStore.getDataGraphIRI(tenantId, workspaceId);

    // Snapshot before delete for audit
    const snapshotQuery = `SELECT ?p ?o WHERE { GRAPH <${dataGraph}> { <${entityUri}> ?p ?o } }`;
    const snapResp = await graphDBStore._fetchWithPool(
      `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}`,
      { method: 'POST', headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'application/sparql-results+json' }, body: snapshotQuery }
    );
    const snapshotBindings = snapResp.ok ? (await snapResp.json())?.results?.bindings || [] : [];

    // Delete from GraphDB
    const deleteQuery = `DELETE WHERE { GRAPH <${dataGraph}> { <${entityUri}> ?p ?o } }`;
    const response = await graphDBStore._fetchWithPool(
      `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`,
      { method: 'POST', headers: { 'Content-Type': 'application/sparql-update' }, body: deleteQuery }
    );
    if (!response.ok) throw new Error(`Delete failed: ${response.status}`);

    // Delete from Neo4j
    const session = neo4jService.getSession();
    try {
      await session.run('MATCH (n {uri: $uri}) DETACH DELETE n', { uri: entityUri });
    } finally { await session.close(); }

    // Audit → GraphDB audit graph (DELETE for each property)
    let docUri = entityUri;
    const changes = [];
    for (const b of snapshotBindings) {
      const prop = b.p?.value;
      const val = b.o?.value;
      if (prop === `${PF}sourceDocument`) { docUri = val; continue; }
      if (prop === RDF_TYPE) continue;
      changes.push({
        entityURI: entityUri, property: prop,
        previousValue: val || '', newValue: '', changeType: 'DELETE'
      });
    }
    if (changes.length > 0) {
      await writeAuditChanges(tenantId, workspaceId, changes, docUri);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete row error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- GET /sheet-data/:docId/audit ---
// Get audit history from GraphDB audit graph, filtered by document
router.get('/:docId/audit', optionalTenantContext, async (req, res) => {
  try {
    const tenantId = req.tenantContext?.tenant_id || req.headers['x-tenant-id'] || 'default';
    const workspaceId = req.tenantContext?.workspace_id || req.headers['x-workspace-id'] || 'default';
    const { docId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    // Get doc URI
    const docJson = await redisService.get(`doc:${docId}`);
    if (!docJson) return res.status(404).json({ success: false, entries: [], total: 0 });
    const doc = JSON.parse(docJson);

    const auditGraphIRI = graphDBStore.getAuditGraphIRI(tenantId, workspaceId);

    // Count
    const countQuery = `PREFIX pf: <${PF}>
SELECT (COUNT(?event) AS ?total) WHERE {
  GRAPH <${auditGraphIRI}> {
    ?event a pf:ChangeEvent .
    ?event pf:sourceDocument <${doc.uri}> .
  }
}`;

    // Data — also fetch entity label and type for display
    const dataQuery = `PREFIX pf: <${PF}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?event ?entity ?property ?previousValue ?newValue ?changeType ?changedAt ?entityType ?entityName WHERE {
  GRAPH <${auditGraphIRI}> {
    ?event a pf:ChangeEvent .
    ?event pf:sourceDocument <${doc.uri}> .
    ?event pf:entity ?entity .
    ?event pf:property ?property .
    ?event pf:changeType ?changeType .
    ?event pf:changedAt ?changedAt .
    OPTIONAL { ?event pf:previousValue ?previousValue }
    OPTIONAL { ?event pf:newValue ?newValue }
  }
  OPTIONAL {
    GRAPH ?dg {
      ?entity a ?entityType .
      FILTER(?entityType != <http://www.w3.org/2002/07/owl#NamedIndividual>)
    }
  }
  OPTIONAL {
    GRAPH ?dg2 {
      { ?entity rdfs:label ?entityName }
      UNION
      { ?entity pf:label ?entityName }
    }
  }
} ORDER BY DESC(?changedAt) LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

    const [countResult, dataResult] = await Promise.all([
      auditService._executeSPARQLDirect(countQuery),
      auditService._executeSPARQLDirect(dataQuery)
    ]);

    const total = parseInt(countResult?.results?.bindings?.[0]?.total?.value || 0);
    const entries = (dataResult?.results?.bindings || []).map(b => {
      const entityUri = b.entity.value;
      // Derive entity label: prefer rdfs:label/pf:label, then extract from URI
      const entityLabel = b.entityName?.value || extractLocal(entityUri);
      const entityType = b.entityType?.value ? extractLocal(b.entityType.value) : null;
      return {
        id: b.event.value,
        action: (b.changeType.value || '').toLowerCase() === 'update' ? 'update_cell'
          : (b.changeType.value || '').toLowerCase() === 'insert' ? 'add_row'
          : 'delete_row',
        timestamp: b.changedAt.value,
        entityUri,
        entityLabel,
        entityType,
        property: extractLocal(b.property.value),
        propertyUri: b.property.value,
        oldValue: b.previousValue?.value || '',
        newValue: b.newValue?.value || '',
        changeType: b.changeType.value
      };
    });

    res.json({ success: true, entries, total });
  } catch (error) {
    logger.error('Audit fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
