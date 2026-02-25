/**
 * Clear all data from GraphDB except ontologies
 */

const graphDBStore = require('../server/services/graphDBStore');

async function clearDataKeepOntologies() {
  try {
    console.log('🧹 Clearing all data from GraphDB (preserving ontologies)...');
    
    // Get all graphs
    const listQuery = `
      SELECT DISTINCT ?g
      WHERE {
        GRAPH ?g { ?s ?p ?o }
      }
    `;

    const response = await fetch(`${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        'Accept': 'application/sparql-results+json'
      },
      body: listQuery
    });

    if (!response.ok) {
      throw new Error(`Failed to list graphs: ${response.statusText}`);
    }

    const results = await response.json();
    let clearedGraphs = 0;
    let preservedGraphs = 0;

    // Clear each graph except ontology graphs
    for (const binding of results.results.bindings) {
      const graphIRI = binding.g.value;
      
      // Preserve ontology graphs (global, tenant, workspace ontologies)
      if (graphIRI.includes('/ontology/') || 
          graphIRI.includes('/global/ontology/')) {
        console.log(`✅ Preserved ontology: ${graphIRI}`);
        preservedGraphs++;
        continue;
      }
      
      // Clear data graphs
      const clearUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(graphIRI)}`;
      
      const clearResponse = await fetch(clearUrl, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
      });

      if (clearResponse.ok) {
        console.log(`🗑️ Cleared data graph: ${graphIRI}`);
        clearedGraphs++;
      } else {
        console.log(`❌ Failed to clear: ${graphIRI}`);
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Preserved ontologies: ${preservedGraphs}`);
    console.log(`   🗑️ Cleared data graphs: ${clearedGraphs}`);
    console.log(`\n🎉 GraphDB cleanup completed!`);
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

// Run cleanup
clearDataKeepOntologies().then(() => process.exit(0));
