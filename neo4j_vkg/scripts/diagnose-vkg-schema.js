#!/usr/bin/env node
/**
 * Diagnose VKG schema: check what ontology graphs exist in GraphDB
 * and what the VKG query pipeline would see.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const GRAPHDB_URL = process.env.GRAPHDB_URL || 'http://localhost:7200';
const REPO = process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1';
const TENANT = 'default';
const WORKSPACE = 'default';

async function sparql(query) {
  const res = await fetch(`${GRAPHDB_URL}/repositories/${REPO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'application/sparql-results+json' },
    body: query
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`GraphDB: ${GRAPHDB_URL}/repositories/${REPO}`);
  console.log(`Tenant: ${TENANT}, Workspace: ${WORKSPACE}\n`);

  // 1. List ALL named graphs
  console.log('=== ALL NAMED GRAPHS ===');
  const allGraphs = await sparql('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
  for (const b of allGraphs.results.bindings) {
    console.log(`  ${b.g.value}`);
  }
  console.log(`Total: ${allGraphs.results.bindings.length} graphs\n`);

  // 2. List graphs that contain owl:Ontology
  console.log('=== GRAPHS WITH owl:Ontology ===');
  const ontGraphs = await sparql(`
    SELECT DISTINCT ?g WHERE {
      GRAPH ?g { ?ont a <http://www.w3.org/2002/07/owl#Ontology> }
    }
  `);
  for (const b of ontGraphs.results.bindings) {
    console.log(`  ${b.g.value}`);
  }
  console.log(`Total: ${ontGraphs.results.bindings.length} ontology graphs\n`);

  // 3. Check VKG-specific graphs
  console.log('=== VKG ONTOLOGY GRAPHS (workspace scope) ===');
  const vkgPrefix = `http://purplefabric.ai/graphs/tenant/${TENANT}/workspace/${WORKSPACE}/ontology`;
  const vkgGraphs = await sparql(`
    SELECT DISTINCT ?g WHERE {
      GRAPH ?g { ?ont a <http://www.w3.org/2002/07/owl#Ontology> }
      FILTER(STRSTARTS(STR(?g), "${vkgPrefix}"))
    }
  `);
  if (vkgGraphs.results.bindings.length === 0) {
    console.log('  ❌ NO VKG ontology graphs found!');
    console.log(`  Expected pattern: ${vkgPrefix}/<name>`);
    console.log('  → You need to Generate + Save an ontology from the Data Sources page first.\n');
  } else {
    for (const b of vkgGraphs.results.bindings) {
      const g = b.g.value;
      console.log(`  ✅ ${g}`);

      // Count classes and vkgmap annotations
      const counts = await sparql(`
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX vkgmap: <http://purplefabric.ai/vkg/mapping/>
        SELECT
          (COUNT(DISTINCT ?class) AS ?classes)
          (COUNT(DISTINCT ?dp) AS ?dataProps)
          (COUNT(DISTINCT ?op) AS ?objProps)
          (COUNT(DISTINCT ?mapped) AS ?mappedTriples)
        FROM <${g}>
        WHERE {
          { ?class a owl:Class }
          UNION { ?dp a owl:DatatypeProperty }
          UNION { ?op a owl:ObjectProperty }
          UNION { ?mapped ?mp ?mo . FILTER(STRSTARTS(STR(?mp), STR(vkgmap:))) }
        }
      `);
      const c = counts.results.bindings[0];
      console.log(`     Classes: ${c?.classes?.value || 0}, DataProps: ${c?.dataProps?.value || 0}, ObjProps: ${c?.objProps?.value || 0}, VKG mappings: ${c?.mappedTriples?.value || 0}`);
    }
    console.log();
  }

  // 4. Simulate what _getOntologySchema would return
  console.log('=== SIMULATING _getOntologySchema() ===');
  // This is what executeSPARQL does: it collects FROM clauses from listOntologies
  const allOntGraphs = await sparql(`
    SELECT DISTINCT ?g WHERE {
      GRAPH ?g { ?ont a <http://www.w3.org/2002/07/owl#Ontology> }
      FILTER(
        STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/global/ontology") ||
        STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${TENANT}/ontology") ||
        STRSTARTS(STR(?g), "http://purplefabric.ai/graphs/tenant/${TENANT}/workspace/${WORKSPACE}/ontology")
      )
    }
  `);
  const fromClauses = allOntGraphs.results.bindings.map(b => `FROM <${b.g.value}>`).join('\n');
  console.log(`  FROM clauses (${allOntGraphs.results.bindings.length}):`);
  for (const b of allOntGraphs.results.bindings) console.log(`    ${b.g.value}`);

  if (allOntGraphs.results.bindings.length > 0) {
    const classesQ = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?class ?label ?comment
      ${fromClauses}
      WHERE { ?class rdf:type owl:Class . OPTIONAL { ?class rdfs:label ?label } OPTIONAL { ?class rdfs:comment ?comment } }
    `;
    const classes = await sparql(classesQ);
    console.log(`\n  Classes found: ${classes.results.bindings.length}`);
    for (const b of classes.results.bindings.slice(0, 10)) {
      console.log(`    ${b.label?.value || b.class?.value}`);
    }
  } else {
    console.log('\n  ❌ No ontology graphs found → _getOntologySchema will return empty arrays');
  }

  // 5. Simulate getMappingAnnotations
  console.log('\n=== SIMULATING getMappingAnnotations() ===');
  if (allOntGraphs.results.bindings.length > 0) {
    const mappingsQ = `
      PREFIX vkgmap: <http://purplefabric.ai/vkg/mapping/>
      SELECT ?subject ?predicate ?object
      ${fromClauses}
      WHERE {
        ?subject ?predicate ?object .
        FILTER(STRSTARTS(STR(?predicate), "http://purplefabric.ai/vkg/mapping/"))
      }
    `;
    const mappings = await sparql(mappingsQ);
    console.log(`  VKG mapping triples: ${mappings.results.bindings.length}`);
    for (const b of mappings.results.bindings.slice(0, 10)) {
      const pred = b.predicate.value.replace('http://purplefabric.ai/vkg/mapping/', 'vkgmap:');
      console.log(`    ${b.subject.value.split('/').pop()} ${pred} ${b.object.value}`);
    }
  } else {
    console.log('  ❌ No ontology graphs → getMappingAnnotations will return empty');
  }
}

main().catch(e => console.error('Error:', e.message));
