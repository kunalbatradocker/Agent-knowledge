/**
 * Load Consumer Complaints ontology as global
 */
const fs = require('fs');
const path = require('path');

async function loadConsumerComplaintsOntology() {
  const owlOntologyService = require('../services/owlOntologyService');
  
  const ttlPath = path.join(__dirname, '../ontologies/consumer-complaints.ttl');
  const ttlContent = fs.readFileSync(ttlPath, 'utf-8');
  
  console.log('Loading Consumer Complaints ontology...');
  
  try {
    const result = await owlOntologyService.importOntology(
      null, // tenantId (null for global)
      null, // workspaceId (null for global)
      'consumer-complaints',
      ttlContent,
      'turtle',
      { scope: 'global', label: 'Consumer Complaints' }
    );
    
    console.log('✅ Consumer Complaints ontology loaded:', result);
  } catch (error) {
    console.error('❌ Failed to load ontology:', error.message);
  }
}

// Run if called directly
if (require.main === module) {
  loadConsumerComplaintsOntology().then(() => process.exit(0));
}

module.exports = loadConsumerComplaintsOntology;
