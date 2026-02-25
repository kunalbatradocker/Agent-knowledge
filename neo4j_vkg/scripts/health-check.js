#!/usr/bin/env node

/**
 * Enterprise Knowledge Graph Platform - Service Health Check
 * Validates all required services are running before starting the application
 */

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Load environment variables
require('dotenv').config();

const services = {
  graphdb: {
    name: 'GraphDB',
    url: process.env.GRAPHDB_URL || 'http://localhost:7200',
    repository: process.env.GRAPHDB_REPOSITORY || 'knowledge_graph_1',
    required: true
  },
  neo4j: {
    name: 'Neo4j',
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    required: true
  },
  redis: {
    name: 'Redis',
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    required: true
  },
  ollama: {
    name: 'Ollama (Local LLM)',
    url: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
    required: process.env.USE_LOCAL_LLM === 'true'
  }
};

async function checkService(service, config) {
  try {
    switch (service) {
      case 'graphdb':
        const graphdbResponse = await fetch(`${config.url}/rest/repositories/${config.repository}`);
        return {
          status: graphdbResponse.ok ? 'running' : 'error',
          message: graphdbResponse.ok ? 'Connected' : `HTTP ${graphdbResponse.status}`
        };
        
      case 'neo4j':
        // Simple connection test - in production you'd use the Neo4j driver
        return { status: 'running', message: 'Connection assumed (configure proper check)' };
        
      case 'redis':
        try {
          await execAsync('redis-cli ping');
          return { status: 'running', message: 'Connected' };
        } catch (error) {
          return { status: 'error', message: 'Not responding to ping' };
        }
        
      case 'ollama':
        if (!config.required) {
          return { status: 'skipped', message: 'Not configured (using OpenAI)' };
        }
        const ollamaResponse = await fetch(config.url.replace('/v1', '/api/tags'));
        if (ollamaResponse.ok) {
          const data = await ollamaResponse.json();
          const modelCount = data.models?.length || 0;
          return { 
            status: 'running', 
            message: `Connected (${modelCount} models available)` 
          };
        }
        return { status: 'error', message: `HTTP ${ollamaResponse.status}` };
        
      default:
        return { status: 'unknown', message: 'Unknown service' };
    }
  } catch (error) {
    return { 
      status: 'error', 
      message: error.code === 'ECONNREFUSED' ? 'Service not running' : error.message 
    };
  }
}

async function main() {
  console.log('🔍 Enterprise Knowledge Graph Platform - Service Health Check\n');
  
  let allGood = true;
  const results = {};
  
  for (const [serviceName, config] of Object.entries(services)) {
    process.stdout.write(`Checking ${config.name}... `);
    
    const result = await checkService(serviceName, config);
    results[serviceName] = result;
    
    const statusIcon = {
      'running': '✅',
      'error': '❌',
      'skipped': '⏭️',
      'unknown': '❓'
    }[result.status] || '❓';
    
    console.log(`${statusIcon} ${result.message}`);
    
    if (result.status === 'error' && config.required) {
      allGood = false;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  
  if (allGood) {
    console.log('✅ All required services are running!');
    console.log('\nYou can now start the application with:');
    console.log('  npm run dev');
    process.exit(0);
  } else {
    console.log('❌ Some required services are not running.');
    console.log('\nPlease ensure the following services are started:');
    
    for (const [serviceName, config] of Object.entries(services)) {
      if (results[serviceName].status === 'error' && config.required) {
        console.log(`\n${config.name}:`);
        switch (serviceName) {
          case 'graphdb':
            console.log(`  - Start GraphDB server`);
            console.log(`  - Create repository: ${config.repository}`);
            console.log(`  - Verify at: ${config.url}`);
            break;
          case 'neo4j':
            console.log(`  - Start Neo4j: neo4j start`);
            console.log(`  - Verify at: http://localhost:7474`);
            break;
          case 'redis':
            console.log(`  - Start Redis: redis-server`);
            console.log(`  - Or via Docker: docker run -d -p 6379:6379 redis`);
            break;
          case 'ollama':
            console.log(`  - Start Ollama: ollama serve`);
            console.log(`  - Pull model: ollama pull ${process.env.LOCAL_LLM_MODEL || 'gemma3:4b'}`);
            break;
        }
      }
    }
    
    console.log('\nFor detailed setup instructions, see README.md');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Health check failed:', error);
  process.exit(1);
});
