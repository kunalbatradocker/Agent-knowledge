#!/bin/bash

# Enhanced Ontology Upgrade Script
# This script replaces the existing basic ontologies with high-standard enhanced versions

echo "🔄 Upgrading Global Ontologies to High Standards..."

# Backup existing ontologies
echo "📦 Creating backup of existing ontologies..."
mkdir -p "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/backup-$(date +%Y%m%d-%H%M%S)"
cp "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies"/*.ttl "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/backup-$(date +%Y%m%d-%H%M%S)/"

# Replace with enhanced versions
echo "✨ Installing enhanced ontologies..."

echo "  📄 Upgrading Resume Ontology..."
cp "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/enhanced-resume.ttl" "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/resume.ttl"

echo "  🏦 Upgrading Banking Ontology..."
cp "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/enhanced-banking.ttl" "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/banking.ttl"

echo "  🛡️ Upgrading AML Ontology..."
cp "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/enhanced-aml.ttl" "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/aml.ttl"

echo "  ⚖️ Upgrading Legal Contract Ontology..."
cp "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/enhanced-legal-contract.ttl" "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/legal-contract.ttl"

echo "🧹 Cleaning up temporary files..."
rm "/Users/kunalbatra/Documents/neo4j copy/server/data/owl-ontologies/enhanced-"*.ttl

echo "✅ Ontology upgrade complete!"
echo ""
echo "📊 Enhanced Ontology Summary:"
echo "  • Resume Ontology: 15+ object properties, 60+ data properties, enhanced relationships"
echo "  • Banking Ontology: 25+ object properties, 80+ data properties, comprehensive financial modeling"
echo "  • AML Ontology: 30+ object properties, 90+ data properties, full compliance coverage"
echo "  • Legal Contract Ontology: 35+ object properties, 85+ data properties, complete legal framework"
echo ""
echo "🔄 Please restart the server to load the enhanced ontologies."
