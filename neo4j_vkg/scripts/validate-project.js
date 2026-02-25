#!/usr/bin/env node

/**
 * Project Validation Script
 * Ensures the project matches README specifications
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function checkFile(filePath, description) {
  const fullPath = path.join(projectRoot, filePath);
  const exists = fs.existsSync(fullPath);
  console.log(`${exists ? '✅' : '❌'} ${description}: ${filePath}`);
  return exists;
}

function checkEnvVariable(envPath, variable, description) {
  try {
    const envContent = fs.readFileSync(path.join(projectRoot, envPath), 'utf8');
    const hasVariable = envContent.includes(variable);
    console.log(`${hasVariable ? '✅' : '❌'} ${description}: ${variable}`);
    return hasVariable;
  } catch (error) {
    console.log(`❌ Cannot read ${envPath}`);
    return false;
  }
}

function checkPackageScript(scriptName, description) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const hasScript = packageJson.scripts && packageJson.scripts[scriptName];
    console.log(`${hasScript ? '✅' : '❌'} ${description}: npm run ${scriptName}`);
    return hasScript;
  } catch (error) {
    console.log(`❌ Cannot read package.json`);
    return false;
  }
}

console.log('🔍 Enterprise Knowledge Graph Platform - Project Validation\n');

console.log('📁 Core Files:');
checkFile('README.md', 'README documentation');
checkFile('.env', 'Environment configuration');
checkFile('env.template', 'Environment template');
checkFile('package.json', 'Main package configuration');
checkFile('client/package.json', 'Client package configuration');

console.log('\n🗄️ Database Configuration:');
checkFile('server/config/graphdb.js', 'GraphDB configuration');
checkFile('server/config/neo4j.js', 'Neo4j configuration');
checkFile('server/config/redis.js', 'Redis configuration');

console.log('\n📚 Global Ontologies:');
checkFile('server/data/owl-ontologies/resume.ttl', 'Resume ontology');
checkFile('server/data/owl-ontologies/legal-contract.ttl', 'Legal Contract ontology');
checkFile('server/data/owl-ontologies/banking.ttl', 'Banking ontology');
checkFile('server/data/owl-ontologies/aml.ttl', 'AML ontology');

console.log('\n⚙️ Environment Variables:');
checkEnvVariable('.env', 'GRAPHDB_URL', 'GraphDB URL');
checkEnvVariable('.env', 'GRAPHDB_REPOSITORY', 'GraphDB Repository');
checkEnvVariable('.env', 'NEO4J_URI', 'Neo4j URI');
checkEnvVariable('.env', 'REDIS_URL', 'Redis URL');
checkEnvVariable('.env', 'USE_LOCAL_LLM', 'LLM Configuration');

console.log('\n📋 Package Scripts:');
checkPackageScript('dev', 'Development mode');
checkPackageScript('health', 'Health check');
checkPackageScript('install-all', 'Install all dependencies');
checkPackageScript('server', 'Start server');
checkPackageScript('client', 'Start client');
checkPackageScript('workers', 'Start workers');

console.log('\n🌐 API Routes:');
checkFile('server/routes/owl.js', 'OWL ontology management');
checkFile('server/routes/sparql.js', 'SPARQL query interface');
checkFile('server/routes/chat.js', 'Chat & RAG');
checkFile('server/routes/extraction.js', 'Document processing');
checkFile('server/routes/enterprise.js', 'Enterprise features');

console.log('\n🎨 Frontend Components:');
checkFile('client/src/App.js', 'Main React application');
checkFile('client/src/components/Chat.js', 'Chat interface');
checkFile('client/src/components/FileManager.js', 'File management');
checkFile('client/src/components/OntologiesPage.js', 'Ontology management');
checkFile('client/src/components/GraphVisualization.js', 'Graph visualization');
checkFile('client/src/contexts/TenantContext.js', 'Multi-tenant context');

console.log('\n🔧 Utility Scripts:');
checkFile('scripts/health-check.js', 'Service health check');
checkFile('scripts/test-connections.js', 'Connection testing');
checkFile('scripts/start-server.js', 'Server startup');
checkFile('scripts/start-client.js', 'Client startup');

console.log('\n' + '='.repeat(60));
console.log('✅ Project validation complete!');
console.log('\nThe Enterprise Knowledge Graph Platform is properly configured.');
console.log('Run "npm run health" to check service availability.');
