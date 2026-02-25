/**
 * Ontology Initialization Service
 * Loads global ontologies from OWL files into GraphDB on startup
 * Replaces legacy YAML-based initialization
 */

const owlOntologyService = require('./owlOntologyService');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

class OntologyInitializationService {
  /**
   * Initialize global ontologies - reads from GraphDB only
   */
  async initializeOnStartup() {
    try {
      logger.info('📚 Initializing ontologies from GraphDB...');
      
      let globalOntologies = await owlOntologyService.listOntologies(null, null, 'global');
      
      if (globalOntologies.length === 0) {
        logger.info('📂 No global ontologies found — seeding from .ttl files...');
        const ontologyDir = path.join(__dirname, '../data/owl-ontologies');
        try {
          await owlOntologyService.initializeFromFiles('default', 'default', ontologyDir, 'global');
          globalOntologies = await owlOntologyService.listOntologies(null, null, 'global');
        } catch (seedErr) {
          logger.error('Failed to seed ontologies from files:', seedErr.message);
        }
      }
      
      if (globalOntologies.length > 0) {
        logger.info(`📚 Ontology initialization complete: ${globalOntologies.length} loaded`);
      } else {
        logger.warn('⚠️  No global ontologies available');
      }
      
      return { success: true, loaded: globalOntologies.length };
    } catch (error) {
      logger.error('Failed to initialize ontologies:', error);
      throw error;
    }
  }
  
  /**
   * Reload ontologies from files (for development/testing)
   */
  async reloadFromFiles(tenantId = null, workspaceId = null) {
    return this.initializeOnStartup();
  }
}

module.exports = new OntologyInitializationService();
