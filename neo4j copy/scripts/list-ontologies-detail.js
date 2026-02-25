/**
 * List all ontologies with detailed breakdown
 */

require('dotenv').config();
const graphDBStore = require('../server/services/graphDBStore');
const owlOntologyService = require('../server/services/owlOntologyService');

const TENANT_ID = 'default';
const WORKSPACE_ID = 'default';

async function listOntologies() {
  console.log('📚 Listing All Ontologies in GraphDB\n');

  try {
    // Get all ontologies
    const ontologies = await owlOntologyService.listOntologies(TENANT_ID, WORKSPACE_ID);
    
    console.log(`Found ${ontologies.length} ontologies:\n`);
    console.log('═══════════════════════════════════════════════════════\n');

    for (let i = 0; i < ontologies.length; i++) {
      const ont = ontologies[i];
      
      console.log(`${i + 1}. ${ont.label || 'Unnamed Ontology'}`);
      console.log('   IRI:', ont.iri);
      console.log('   Version:', ont.versionInfo || 'N/A');
      
      if (ont.comment) {
        const shortComment = ont.comment.length > 100 
          ? ont.comment.substring(0, 100) + '...'
          : ont.comment;
        console.log('   Description:', shortComment);
      }

      // Count classes for this ontology
      const namespace = ont.iri.replace('Ontology', '').replace(/[^#]*#/, '');
      const baseIRI = ont.iri.substring(0, ont.iri.lastIndexOf('#') + 1);
      
      const classQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        
        SELECT (COUNT(?class) as ?count)
        WHERE {
          ?class a owl:Class .
          FILTER(STRSTARTS(STR(?class), "${baseIRI}"))
        }
      `;

      try {
        const result = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, classQuery, 'schema');
        const classCount = result.results.bindings[0]?.count?.value || 0;
        console.log('   Classes:', classCount);
      } catch (e) {
        console.log('   Classes: Unable to count');
      }

      // Count properties for this ontology
      const propQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        
        SELECT (COUNT(?prop) as ?count)
        WHERE {
          {
            ?prop a owl:ObjectProperty .
            FILTER(STRSTARTS(STR(?prop), "${baseIRI}"))
          }
          UNION
          {
            ?prop a owl:DatatypeProperty .
            FILTER(STRSTARTS(STR(?prop), "${baseIRI}"))
          }
        }
      `;

      try {
        const result = await graphDBStore.executeSPARQL(TENANT_ID, WORKSPACE_ID, propQuery, 'schema');
        const propCount = result.results.bindings[0]?.count?.value || 0;
        console.log('   Properties:', propCount);
      } catch (e) {
        console.log('   Properties: Unable to count');
      }

      console.log('');
    }

    console.log('═══════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Total Ontologies:', ontologies.length);
    console.log('Storage: Single schema graph (multi-ontology)');
    console.log('Schema Graph IRI:', graphDBStore.getSchemaGraphIRI(TENANT_ID, WORKSPACE_ID));
    console.log('');
    console.log('💡 All ontologies are stored together in one schema graph.');
    console.log('   This allows cross-ontology reasoning and integration.');
    console.log('   The TTL viewer shows the combined schema (all ontologies).');
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Failed to list ontologies:', error);
    console.error(error.stack);
  }
}

listOntologies().then(() => {
  console.log('✅ Complete');
  process.exit(0);
}).catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
