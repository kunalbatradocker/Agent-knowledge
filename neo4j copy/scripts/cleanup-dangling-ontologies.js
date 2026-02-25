/**
 * Cleanup dangling global ontologies
 * Removes ontologies that were incorrectly created in global scope
 */

const graphDBStore = require('../server/services/graphDBStore');

const DANGLING_ONTOLOGY_IDS = [
  'company',
  'product', 
  'issue',
  'state'
];

async function cleanup() {
  console.log('🧹 Cleaning up dangling global ontologies...\n');
  
  try {
    // List all global ontologies
    const ontologies = await graphDBStore.listOntologies(null, null, 'global');
    console.log(`Found ${ontologies.length} global ontologies\n`);
    
    for (const ont of ontologies) {
      const id = ont.ontologyId?.toLowerCase();
      const label = ont.label?.toLowerCase();
      
      // Check if this is a dangling ontology
      const isDangling = DANGLING_ONTOLOGY_IDS.some(d => 
        id === d || label === d || 
        ont.comment?.includes('Predefined mapping')
      );
      
      if (isDangling) {
        console.log(`🗑️  Removing: ${ont.label || ont.ontologyId} (${ont.graphIRI})`);
        
        try {
          await graphDBStore.clearGraph(ont.graphIRI);
          console.log(`   ✅ Deleted\n`);
        } catch (err) {
          console.log(`   ❌ Failed: ${err.message}\n`);
        }
      }
    }
    
    console.log('✅ Cleanup complete');
  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
  }
  
  process.exit(0);
}

cleanup();
