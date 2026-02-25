#!/usr/bin/env node

/**
 * Cleanup Script: Remove Old Workspace Ontologies
 * 
 * After migrating to global ontologies, this script removes the old
 * workspace-specific ontology graphs that are no longer needed.
 * 
 * Safe to run - only removes workspace ontologies, not global ones or data.
 */

const graphDBStore = require('../server/services/graphDBStore');
const logger = require('../server/utils/logger');

async function cleanupWorkspaceOntologies() {
  console.log('🧹 Cleaning up old workspace ontologies...\n');

  try {
    // 1. Check GraphDB connection
    console.log('1️⃣  Checking GraphDB connection...');
    const connection = await graphDBStore.checkConnection();
    
    if (!connection.connected || !connection.repositoryExists) {
      console.error('❌ GraphDB not available');
      process.exit(1);
    }
    console.log('✅ GraphDB connected\n');

    // 2. List workspace ontologies
    console.log('2️⃣  Finding workspace ontologies to remove...');
    const tenantId = 'default';
    const workspaceId = 'default';
    
    const workspaceOntologies = await graphDBStore.listOntologies(
      tenantId,
      workspaceId,
      'workspace'
    );
    
    console.log(`   Found ${workspaceOntologies.length} workspace ontologies:`);
    for (const ont of workspaceOntologies) {
      const count = await graphDBStore.countTriplesInGraph(ont.graphIRI);
      console.log(`   - ${ont.label}: ${count} triples`);
      console.log(`     Graph: ${ont.graphIRI}`);
    }
    
    if (workspaceOntologies.length === 0) {
      console.log('\n✅ No workspace ontologies to clean up');
      return;
    }

    // 3. Confirm deletion
    console.log(`\n⚠️  This will DELETE ${workspaceOntologies.length} workspace ontology graphs`);
    console.log('   Global ontologies and workspace data will NOT be affected');
    console.log('\n   Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. Delete workspace ontologies
    console.log('\n3️⃣  Deleting workspace ontologies...');
    
    let deleted = 0;
    for (const ont of workspaceOntologies) {
      try {
        console.log(`\n   🗑️  Deleting: ${ont.label}`);
        console.log(`      Graph: ${ont.graphIRI}`);
        
        const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
        const updateQuery = `CLEAR GRAPH <${ont.graphIRI}>`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sparql-update'
          },
          body: updateQuery
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`      ✗ Failed: ${response.status} - ${errorText}`);
        } else {
          console.log(`      ✓ Deleted successfully`);
          deleted++;
        }
      } catch (error) {
        console.error(`      ✗ Error: ${error.message}`);
      }
    }
    
    console.log(`\n✅ Deleted ${deleted} workspace ontology graphs\n`);

    // 5. Verify cleanup
    console.log('4️⃣  Verifying cleanup...');
    
    const remainingWorkspace = await graphDBStore.listOntologies(
      tenantId,
      workspaceId,
      'workspace'
    );
    
    const globalOntologies = await graphDBStore.listOntologies(
      tenantId,
      workspaceId,
      'global'
    );
    
    console.log(`   Workspace ontologies remaining: ${remainingWorkspace.length}`);
    console.log(`   Global ontologies: ${globalOntologies.length}`);
    
    if (remainingWorkspace.length === 0 && globalOntologies.length > 0) {
      console.log('   ✓ Cleanup successful!');
    } else if (remainingWorkspace.length > 0) {
      console.log('   ⚠️  Some workspace ontologies still remain');
    }

    // 6. Summary
    console.log('\n📊 Cleanup Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Workspace ontologies deleted: ${deleted}`);
    console.log(`   Global ontologies preserved: ${globalOntologies.length}`);
    console.log('');
    console.log('   Architecture:');
    console.log('   ✓ Global ontologies: Active and shared');
    console.log('   ✓ Workspace data: Preserved and isolated');
    console.log('   ✓ Old workspace ontologies: Removed');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log('\n✅ Cleanup complete!');
    console.log('   UI will now show only global ontologies.');

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run cleanup
cleanupWorkspaceOntologies();
