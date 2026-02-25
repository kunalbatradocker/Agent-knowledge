/**
 * Manual cleanup script to clear workspace ontologies
 */

const graphDBStore = require('../server/services/graphDBStore');

async function clearWorkspaceOntologies() {
  try {
    console.log('🧹 Clearing all workspace ontologies...');
    
    // Get all workspace ontologies
    const ontologies = await graphDBStore.listOntologies('default', 'default', 'workspace');
    console.log(`Found ${ontologies.length} workspace ontologies`);
    
    // Clear each workspace ontology
    for (const ont of ontologies) {
      const clearUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(ont.graphIRI)}`;
      
      const response = await fetch(clearUrl, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
      });

      if (response.ok) {
        console.log(`✅ Cleared: ${ont.ontologyId}`);
      } else {
        console.log(`❌ Failed to clear: ${ont.ontologyId}`);
      }
    }
    
    console.log('✅ Workspace cleanup completed');
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
}

// Run cleanup
clearWorkspaceOntologies().then(() => process.exit(0));
