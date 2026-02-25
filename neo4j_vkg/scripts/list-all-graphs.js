#!/usr/bin/env node

/**
 * List All Graphs in GraphDB
 * Shows all named graphs with their triple counts
 */

const graphDBStore = require('../server/services/graphDBStore');

async function listAllGraphs() {
  console.log('📊 Listing all graphs in GraphDB...\n');

  try {
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}`;
    
    // Query to list all named graphs
    const query = `
      SELECT ?g (COUNT(*) as ?count)
      WHERE {
        GRAPH ?g {
          ?s ?p ?o .
        }
      }
      GROUP BY ?g
      ORDER BY DESC(?count)
    `;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        'Accept': 'application/sparql-results+json'
      },
      body: query
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const results = await response.json();
    
    console.log(`Found ${results.results.bindings.length} named graphs:\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Graph IRI                                                          | Triples');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    let totalTriples = 0;
    const graphsByType = {
      global: [],
      tenant: [],
      workspace: [],
      other: []
    };
    
    for (const binding of results.results.bindings) {
      const graphIRI = binding.g.value;
      const count = parseInt(binding.count.value);
      totalTriples += count;
      
      // Categorize graph
      let type = 'other';
      if (graphIRI.includes('/global/ontology/')) {
        type = 'global';
      } else if (graphIRI.match(/\/tenant\/[^/]+\/ontology\//)) {
        type = 'tenant';
      } else if (graphIRI.match(/\/tenant\/[^/]+\/workspace\/[^/]+\/data/)) {
        type = 'workspace-data';
      } else if (graphIRI.includes('/schema')) {
        type = 'workspace';
      }
      
      graphsByType[type] = graphsByType[type] || [];
      graphsByType[type].push({ graphIRI, count });
      
      // Truncate long IRIs for display
      const displayIRI = graphIRI.length > 66 ? 
        graphIRI.substring(0, 63) + '...' : 
        graphIRI.padEnd(66);
      
      console.log(`${displayIRI} | ${count.toString().padStart(7)}`);
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total: ${results.results.bindings.length} graphs, ${totalTriples} triples\n`);
    
    // Summary by type
    console.log('📊 Summary by Type:\n');
    
    if (graphsByType.global && graphsByType.global.length > 0) {
      console.log(`🌍 Global Ontologies: ${graphsByType.global.length}`);
      for (const g of graphsByType.global) {
        const name = g.graphIRI.split('/').pop();
        console.log(`   - ${name}: ${g.count} triples`);
      }
      console.log('');
    }
    
    if (graphsByType.tenant && graphsByType.tenant.length > 0) {
      console.log(`🏢 Tenant Ontologies: ${graphsByType.tenant.length}`);
      for (const g of graphsByType.tenant) {
        console.log(`   - ${g.graphIRI}: ${g.count} triples`);
      }
      console.log('');
    }
    
    if (graphsByType.workspace && graphsByType.workspace.length > 0) {
      console.log(`📦 Workspace Ontologies (OLD): ${graphsByType.workspace.length}`);
      for (const g of graphsByType.workspace) {
        console.log(`   - ${g.graphIRI}: ${g.count} triples`);
      }
      console.log('');
    }
    
    if (graphsByType['workspace-data'] && graphsByType['workspace-data'].length > 0) {
      console.log(`📊 Workspace Data: ${graphsByType['workspace-data'].length}`);
      for (const g of graphsByType['workspace-data']) {
        console.log(`   - ${g.graphIRI}: ${g.count} triples`);
      }
      console.log('');
    }
    
    if (graphsByType.other && graphsByType.other.length > 0) {
      console.log(`❓ Other Graphs: ${graphsByType.other.length}`);
      for (const g of graphsByType.other) {
        console.log(`   - ${g.graphIRI}: ${g.count} triples`);
      }
      console.log('');
    }
    
    // Recommendations
    console.log('💡 Recommendations:\n');
    
    if (graphsByType.workspace && graphsByType.workspace.length > 0) {
      console.log('⚠️  Old workspace ontologies detected!');
      console.log('   These are no longer needed with global ontologies.');
      console.log('   Run: node scripts/cleanup-workspace-ontologies.js');
      console.log('');
    }
    
    if (graphsByType.global && graphsByType.global.length > 0) {
      console.log('✅ Global ontologies are active');
      console.log('   These are shared across all tenants/workspaces');
      console.log('');
    }

  } catch (error) {
    console.error('❌ Failed to list graphs:', error);
    process.exit(1);
  }
}

listAllGraphs();
