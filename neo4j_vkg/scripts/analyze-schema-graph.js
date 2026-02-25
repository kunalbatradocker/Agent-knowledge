/**
 * Analyze what's actually in the schema graph
 */

require('dotenv').config();
const graphDBStore = require('../server/services/graphDBStore');

const TENANT_ID = 'default';
const WORKSPACE_ID = 'default';

async function analyze() {
  console.log('🔍 Analyzing Schema Graph Contents\n');

  try {
    const schemaGraphIRI = graphDBStore.getSchemaGraphIRI(TENANT_ID, WORKSPACE_ID);
    console.log('Schema Graph IRI:', schemaGraphIRI);
    console.log('');

    // 1. Count total triples
    console.log('1️⃣  Total Triples:');
    const totalCount = await graphDBStore.countTriplesInGraph(schemaGraphIRI);
    console.log('   ', totalCount, 'triples\n');

    // 2. Find all ontologies
    console.log('2️⃣  Finding Ontologies:');
    const ontologyQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      
      SELECT ?ontology ?label ?comment ?version
      FROM <${schemaGraphIRI}>
      WHERE {
        ?ontology a owl:Ontology .
        OPTIONAL { ?ontology rdfs:label ?label }
        OPTIONAL { ?ontology rdfs:comment ?comment }
        OPTIONAL { ?ontology owl:versionInfo ?version }
      }
    `;

    const ontologies = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, ontologyQuery, 'schema');
    console.log('   Found', ontologies.results.bindings.length, 'ontologies:');
    
    for (const ont of ontologies.results.bindings) {
      console.log('   -', ont.label?.value || ont.ontology.value);
      console.log('     IRI:', ont.ontology.value);
      console.log('     Version:', ont.version?.value || 'N/A');
      if (ont.comment?.value) {
        console.log('     Comment:', ont.comment.value.substring(0, 80) + '...');
      }
      console.log('');
    }

    // 3. Count classes per ontology
    console.log('3️⃣  Classes by Ontology:');
    const classQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      
      SELECT ?class ?label
      FROM <${schemaGraphIRI}>
      WHERE {
        ?class a owl:Class .
        OPTIONAL { ?class rdfs:label ?label }
      }
    `;

    const classes = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, classQuery, 'schema');
    console.log('   Total classes:', classes.results.bindings.length);
    
    // Group by namespace
    const namespaces = {};
    for (const cls of classes.results.bindings) {
      const iri = cls.class.value;
      const namespace = iri.substring(0, iri.lastIndexOf('#') + 1) || iri.substring(0, iri.lastIndexOf('/') + 1);
      namespaces[namespace] = (namespaces[namespace] || 0) + 1;
    }
    
    console.log('   Classes by namespace:');
    for (const [ns, count] of Object.entries(namespaces).sort((a, b) => b[1] - a[1])) {
      console.log('     ', count, 'classes in', ns);
    }
    console.log('');

    // 4. Count properties
    console.log('4️⃣  Properties:');
    const propQuery = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      
      SELECT (COUNT(?prop) as ?count)
      FROM <${schemaGraphIRI}>
      WHERE {
        { ?prop a owl:ObjectProperty }
        UNION
        { ?prop a owl:DatatypeProperty }
      }
    `;

    const props = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, propQuery, 'schema');
    console.log('   Total properties:', props.results.bindings[0]?.count?.value || 0);
    console.log('');

    // 5. Check for non-ontology triples
    console.log('5️⃣  Checking for Non-Ontology Data:');
    const typeQuery = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      
      SELECT ?type (COUNT(?s) as ?count)
      FROM <${schemaGraphIRI}>
      WHERE {
        ?s rdf:type ?type .
      }
      GROUP BY ?type
      ORDER BY DESC(?count)
      LIMIT 20
    `;

    const types = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, typeQuery, 'schema');
    console.log('   Top types in schema graph:');
    for (const type of types.results.bindings) {
      const typeIRI = type.type.value;
      const count = type.count.value;
      const shortType = typeIRI.split(/[#/]/).pop();
      console.log('     ', count, 'x', shortType, `(${typeIRI})`);
    }
    console.log('');

    // 6. Sample some triples
    console.log('6️⃣  Sample Triples:');
    const sampleQuery = `
      SELECT ?s ?p ?o
      FROM <${schemaGraphIRI}>
      WHERE {
        ?s ?p ?o .
      }
      LIMIT 10
    `;

    const samples = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, sampleQuery, 'schema');
    console.log('   First 10 triples:');
    for (const triple of samples.results.bindings) {
      const s = triple.s.value.split(/[#/]/).pop();
      const p = triple.p.value.split(/[#/]/).pop();
      const o = triple.o.value.split(/[#/]/).pop() || triple.o.value.substring(0, 50);
      console.log('     ', s, '->', p, '->', o);
    }
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════════════');
    console.log('ANALYSIS SUMMARY');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Total Triples:', totalCount);
    console.log('Ontologies Found:', ontologies.results.bindings.length);
    console.log('Total Classes:', classes.results.bindings.length);
    console.log('Namespaces:', Object.keys(namespaces).length);
    console.log('');
    
    if (totalCount > 1000 && ontologies.results.bindings.length === 1) {
      console.log('⚠️  WARNING: Very large schema for single ontology!');
      console.log('   This might indicate mixed data or multiple ontologies.');
    }
    
    if (Object.keys(namespaces).length > 5) {
      console.log('⚠️  WARNING: Many different namespaces detected!');
      console.log('   Multiple ontologies may be mixed together.');
    }
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Analysis failed:', error);
    console.error(error.stack);
  }
}

analyze().then(() => {
  console.log('Analysis complete');
  process.exit(0);
}).catch(error => {
  console.error('Analysis error:', error);
  process.exit(1);
});
