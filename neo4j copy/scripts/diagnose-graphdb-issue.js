/**
 * Diagnose GraphDB Connection and Export Issues
 */

require('dotenv').config();
const graphDBStore = require('../server/services/graphDBStore');
const owlOntologyService = require('../server/services/owlOntologyService');

const TENANT_ID = 'default';
const WORKSPACE_ID = 'default';

async function diagnose() {
  console.log('🔍 Diagnosing GraphDB Issue\n');

  try {
    // 1. Check connection
    console.log('1️⃣  Checking GraphDB connection...');
    const connection = await graphDBStore.checkConnection();
    console.log('   Connected:', connection.connected);
    console.log('   Repository exists:', connection.repositoryExists);
    console.log('   Repository:', graphDBStore.repository);
    console.log('   URL:', graphDBStore.baseUrl);
    
    if (!connection.connected) {
      console.error('\n❌ GraphDB is not connected!');
      console.error('   Make sure GraphDB is running at:', graphDBStore.baseUrl);
      return;
    }
    
    if (!connection.repositoryExists) {
      console.error('\n❌ Repository does not exist!');
      console.error('   Available repositories:', connection.availableRepositories.join(', '));
      console.error('   Create repository in GraphDB Workbench or update GRAPHDB_REPOSITORY env var');
      return;
    }
    
    console.log('   ✅ Connection OK\n');

    // 2. Check graph IRIs
    console.log('2️⃣  Graph IRIs:');
    const schemaGraphIRI = graphDBStore.getSchemaGraphIRI(TENANT_ID, WORKSPACE_ID);
    const dataGraphIRI = graphDBStore.getDataGraphIRI(TENANT_ID, WORKSPACE_ID);
    console.log('   Schema:', schemaGraphIRI);
    console.log('   Data:', dataGraphIRI);
    console.log('');

    // 3. Count triples
    console.log('3️⃣  Counting triples...');
    const schemaCount = await graphDBStore.countTriplesInGraph(schemaGraphIRI);
    const dataCount = await graphDBStore.countTriplesInGraph(dataGraphIRI);
    console.log('   Schema graph:', schemaCount, 'triples');
    console.log('   Data graph:', dataCount, 'triples');
    console.log('');

    // 4. Try export
    console.log('4️⃣  Testing export...');
    try {
      const turtle = await owlOntologyService.exportSchemaOnly(TENANT_ID, WORKSPACE_ID);
      console.log('   ✅ Export successful');
      console.log('   Length:', turtle.length, 'characters');
      console.log('   Lines:', turtle.split('\n').length);
      console.log('   First 200 chars:', turtle.substring(0, 200));
      console.log('');
    } catch (exportError) {
      console.error('   ❌ Export failed:', exportError.message);
      console.error('   Stack:', exportError.stack);
      console.log('');
    }

    // 5. Check if initialization needed
    console.log('5️⃣  Checking if initialization needed...');
    const hasSchema = await graphDBStore.hasSchema(TENANT_ID, WORKSPACE_ID);
    console.log('   Has schema:', hasSchema);
    
    if (!hasSchema) {
      console.log('\n💡 Schema is empty. Run initialization:');
      console.log('   node scripts/test-graphdb-separation.js');
      console.log('   OR');
      console.log('   curl -X POST http://localhost:5002/api/owl/initialize \\');
      console.log('     -H "Content-Type: application/json" \\');
      console.log('     -d \'{"tenantId":"default","workspaceId":"default"}\'');
    }
    console.log('');

    // 6. Test direct GraphDB API
    console.log('6️⃣  Testing direct GraphDB API...');
    const testUrl = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements?context=${encodeURIComponent(schemaGraphIRI)}`;
    console.log('   URL:', testUrl);
    
    try {
      const response = await fetch(testUrl, {
        headers: { 'Accept': 'application/x-turtle' }
      });
      console.log('   Status:', response.status, response.statusText);
      
      if (response.ok) {
        const text = await response.text();
        console.log('   Response length:', text.length);
        console.log('   ✅ Direct API call successful');
      } else {
        const errorText = await response.text();
        console.log('   ❌ Error:', errorText);
      }
    } catch (apiError) {
      console.error('   ❌ API call failed:', apiError.message);
    }
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════');
    console.log('GraphDB Connected:', connection.connected ? '✅' : '❌');
    console.log('Repository Exists:', connection.repositoryExists ? '✅' : '❌');
    console.log('Schema Triples:', schemaCount);
    console.log('Data Triples:', dataCount);
    console.log('Has Schema:', hasSchema ? '✅' : '❌');
    
    if (!hasSchema) {
      console.log('\n⚠️  ACTION REQUIRED: Initialize ontologies');
    } else {
      console.log('\n✅ System appears to be working');
    }
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Diagnostic failed:', error);
    console.error('Stack:', error.stack);
  }
}

diagnose().then(() => {
  console.log('Diagnostic complete');
  process.exit(0);
}).catch(error => {
  console.error('Diagnostic error:', error);
  process.exit(1);
});
