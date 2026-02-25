/**
 * Clear only data graphs from GraphDB (preserve all ontologies)
 */

const graphDBStore = require('../server/services/graphDBStore');

async function clearDataOnly() {
  try {
    console.log('🧹 Clearing data graphs from GraphDB (preserving all ontologies)...');
    
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
      
      // Preserve ALL ontology graphs (global and workspace)
      if (graphIRI.includes('/ontology/')) {
        console.log(`✅ Preserved ontology: ${graphIRI}`);
        preservedGraphs++;
        continue;
      }
      
      // Clear only data, version, and other non-ontology graphs
      if (graphIRI.includes('/data') || 
          graphIRI.includes('/versions') || 
          graphIRI.includes('/schema') ||
          !graphIRI.includes('/ontology/')) {
        
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
    }

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Preserved ontologies: ${preservedGraphs}`);
    console.log(`   🗑️ Cleared data graphs: ${clearedGraphs}`);
    console.log(`\n🎉 Data cleanup completed!`);
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

// Run cleanup
clearDataOnly().then(() => process.exit(0));
