/**
 * Ontology Pack Service
 * Simplified service that delegates to OWL ontology service
 */

const owlOntologyService = require('./owlOntologyService');

class OntologyPackService {
  /**
   * Initialize the service
   */
  async initialize() {
    // No initialization needed - OWL service handles everything
    return { success: true };
  }

  /**
   * Get all ontologies for a tenant/workspace
   */
  async getAllOntologies(options = {}) {
    const { tenantId, workspaceId } = options;
    return await owlOntologyService.listOntologies(tenantId, workspaceId);
  }

  /**
   * Get a specific ontology
   */
  async getOntology(ontologyId, options = {}) {
    const { tenantId, workspaceId } = options;
    return await owlOntologyService.getOntology(tenantId, workspaceId, ontologyId);
  }

  /**
   * Save an ontology
   */
  async saveOntology(ontologyData, options = {}) {
    const { tenantId, workspaceId } = options;
    // Convert to OWL format and save
    return await owlOntologyService.importOntology(tenantId, workspaceId, ontologyData);
  }

  /**
   * Delete an ontology
   */
  async deleteOntology(ontologyId, options = {}) {
    const { tenantId, workspaceId } = options;
    return await owlOntologyService.deleteOntology(tenantId, workspaceId, ontologyId);
  }

  /**
   * Get available industries/domains
   */
  async getAvailableIndustries(options = {}) {
    // Return standard domains
    return ['resume', 'legal-contract', 'banking', 'aml', 'general'];
  }
}

module.exports = new OntologyPackService();
