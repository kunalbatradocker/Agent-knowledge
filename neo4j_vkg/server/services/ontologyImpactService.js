/**
 * Ontology Impact Analysis Service
 * Analyzes the impact of ontology changes on existing graph data
 * 
 * Before publishing a new ontology version, shows:
 * - Which nodes would be orphaned (class removed)
 * - Which nodes would need type changes
 * - Which relationships would be affected
 */

const neo4jService = require('./neo4jService');
const ontologyPackService = require('./ontologyPackService');

class OntologyImpactService {
  /**
   * Analyze impact of publishing a new ontology version
   * @param {string} newVersionId - Version to analyze
   * @param {string} workspaceId - Workspace to check for affected data
   */
  async analyzeImpact(newVersionId, workspaceId) {
    const newVersion = await ontologyPackService.getVersion(newVersionId);
    if (!newVersion) {
      throw new Error(`Version not found: ${newVersionId}`);
    }

    const currentVersion = await ontologyPackService.getActiveVersion(newVersion.pack_id);

    // If no active version, this is first publish - no impact
    if (!currentVersion) {
      return {
        impact: 'none',
        message: 'No active version to compare - first publish',
        safe_to_publish: true,
        affected_nodes: [],
        affected_relationships: [],
        summary: {
          total_affected_nodes: 0,
          total_affected_relationships: 0
        }
      };
    }

    // Get compatibility report
    const compatibility = await ontologyPackService.checkCompatibility(currentVersion, newVersion);

    // Analyze affected nodes for each breaking change
    const affectedNodes = [];
    const affectedRelationships = [];

    for (const change of compatibility.breaking) {
      switch (change.type) {
        case 'class_removed':
          const classNodes = await this.findNodesByClass(change.class, workspaceId);
          if (classNodes.length > 0) {
            affectedNodes.push({
              change_type: 'CLASS_REMOVED',
              class_name: change.class,
              affected_count: classNodes.length,
              sample_nodes: classNodes.slice(0, 10),
              action_required: 'MIGRATE_OR_DELETE',
              severity: 'HIGH',
              message: `${classNodes.length} nodes of type "${change.class}" will be orphaned`
            });
          }
          break;

        case 'required_attribute_removed':
          const attrNodes = await this.findNodesByClass(change.class, workspaceId);
          if (attrNodes.length > 0) {
            affectedNodes.push({
              change_type: 'REQUIRED_ATTRIBUTE_REMOVED',
              class_name: change.class,
              attribute_name: change.attribute,
              affected_count: attrNodes.length,
              sample_nodes: attrNodes.slice(0, 10),
              action_required: 'UPDATE_SCHEMA',
              severity: 'MEDIUM',
              message: `${attrNodes.length} nodes may have orphaned attribute "${change.attribute}"`
            });
          }
          break;

        case 'attribute_type_changed':
          const typeNodes = await this.findNodesWithAttribute(change.class, change.attribute, workspaceId);
          if (typeNodes.length > 0) {
            affectedNodes.push({
              change_type: 'ATTRIBUTE_TYPE_CHANGED',
              class_name: change.class,
              attribute_name: change.attribute,
              old_type: change.old_type,
              new_type: change.new_type,
              affected_count: typeNodes.length,
              sample_nodes: typeNodes.slice(0, 10),
              action_required: 'MIGRATE_DATA',
              severity: 'HIGH',
              message: `${typeNodes.length} nodes need attribute type migration`
            });
          }
          break;

        case 'relationship_removed':
          const rels = await this.findRelationshipsByType(change.relationship, workspaceId);
          if (rels.length > 0) {
            affectedRelationships.push({
              change_type: 'RELATIONSHIP_REMOVED',
              relationship_type: change.relationship,
              affected_count: rels.length,
              sample_relationships: rels.slice(0, 10),
              action_required: 'DELETE_OR_MIGRATE',
              severity: 'HIGH',
              message: `${rels.length} relationships of type "${change.relationship}" will be orphaned`
            });
          }
          break;
      }
    }

    const totalAffectedNodes = affectedNodes.reduce((sum, a) => sum + a.affected_count, 0);
    const totalAffectedRels = affectedRelationships.reduce((sum, a) => sum + a.affected_count, 0);
    const hasHighSeverity = [...affectedNodes, ...affectedRelationships].some(a => a.severity === 'HIGH');

    return {
      compatibility,
      affected_nodes: affectedNodes,
      affected_relationships: affectedRelationships,
      summary: {
        total_affected_nodes: totalAffectedNodes,
        total_affected_relationships: totalAffectedRels,
        breaking_changes: compatibility.breaking.length,
        additions: compatibility.additions.length
      },
      safe_to_publish: totalAffectedNodes === 0 && totalAffectedRels === 0,
      requires_migration: hasHighSeverity,
      recommendation: this.getRecommendation(affectedNodes, affectedRelationships)
    };
  }

  /**
   * Find all nodes of a given class in workspace
   */
  async findNodesByClass(className, workspaceId) {
    const session = neo4jService.getSession();
    try {
      // Sanitize class name
      const sanitizedClass = className.replace(/[^a-zA-Z0-9_]/g, '');
      if (!sanitizedClass) return [];

      const query = `
        MATCH (n:\`${sanitizedClass}\`)
        WHERE n.workspace_id = $workspaceId OR $workspaceId IS NULL
        RETURN 
          n.concept_id as id,
          coalesce(n.label, n.displayName, n.name) as label,
          n.created_at as created_at
        LIMIT 100
      `;

      const result = await session.run(query, { workspaceId: workspaceId || null });
      return result.records.map(r => ({
        id: r.get('id'),
        label: r.get('label'),
        created_at: r.get('created_at')
      }));
    } catch (error) {
      console.error(`Error finding nodes by class ${className}:`, error.message);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Find nodes with a specific attribute
   */
  async findNodesWithAttribute(className, attributeName, workspaceId) {
    const session = neo4jService.getSession();
    try {
      const sanitizedClass = className.replace(/[^a-zA-Z0-9_]/g, '');
      const sanitizedAttr = attributeName.replace(/[^a-zA-Z0-9_]/g, '');
      if (!sanitizedClass || !sanitizedAttr) return [];

      const query = `
        MATCH (n:\`${sanitizedClass}\`)
        WHERE (n.workspace_id = $workspaceId OR $workspaceId IS NULL)
          AND n.\`${sanitizedAttr}\` IS NOT NULL
        RETURN 
          n.concept_id as id,
          coalesce(n.label, n.displayName, n.name) as label,
          n.\`${sanitizedAttr}\` as attribute_value
        LIMIT 100
      `;

      const result = await session.run(query, { workspaceId: workspaceId || null });
      return result.records.map(r => ({
        id: r.get('id'),
        label: r.get('label'),
        attribute_value: r.get('attribute_value')
      }));
    } catch (error) {
      console.error(`Error finding nodes with attribute:`, error.message);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Find relationships by type
   */
  async findRelationshipsByType(relType, workspaceId) {
    const session = neo4jService.getSession();
    try {
      const sanitizedType = relType.replace(/[^a-zA-Z0-9_]/g, '');
      if (!sanitizedType) return [];

      const query = `
        MATCH (a)-[r:\`${sanitizedType}\`]->(b)
        WHERE (a.workspace_id = $workspaceId OR $workspaceId IS NULL)
        RETURN 
          coalesce(a.label, a.displayName, a.name) as source_label,
          coalesce(b.label, b.displayName, b.name) as target_label,
          type(r) as rel_type
        LIMIT 100
      `;

      const result = await session.run(query, { workspaceId: workspaceId || null });
      return result.records.map(r => ({
        source: r.get('source_label'),
        target: r.get('target_label'),
        type: r.get('rel_type')
      }));
    } catch (error) {
      console.error(`Error finding relationships:`, error.message);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Generate migration plan for breaking changes
   */
  async generateMigrationPlan(newVersionId, workspaceId) {
    const impact = await this.analyzeImpact(newVersionId, workspaceId);

    if (impact.safe_to_publish) {
      return {
        required: false,
        message: 'No migration required - safe to publish'
      };
    }

    const steps = [];

    for (const affected of impact.affected_nodes) {
      switch (affected.change_type) {
        case 'CLASS_REMOVED':
          steps.push({
            step: steps.length + 1,
            action: 'MIGRATE_OR_DELETE_NODES',
            description: `Handle ${affected.affected_count} nodes of type "${affected.class_name}"`,
            options: [
              { action: 'delete', description: 'Delete all nodes of this type' },
              { action: 'migrate', description: 'Migrate to a different type', requires_target_type: true }
            ],
            affected_count: affected.affected_count,
            cypher_delete: `MATCH (n:\`${affected.class_name}\`) WHERE n.workspace_id = '${workspaceId}' DETACH DELETE n`,
            cypher_migrate: `MATCH (n:\`${affected.class_name}\`) WHERE n.workspace_id = '${workspaceId}' REMOVE n:\`${affected.class_name}\` SET n:\`{TARGET_TYPE}\``
          });
          break;

        case 'ATTRIBUTE_TYPE_CHANGED':
          steps.push({
            step: steps.length + 1,
            action: 'MIGRATE_ATTRIBUTE_TYPE',
            description: `Convert "${affected.attribute_name}" from ${affected.old_type} to ${affected.new_type}`,
            affected_count: affected.affected_count,
            cypher: `MATCH (n:\`${affected.class_name}\`) WHERE n.workspace_id = '${workspaceId}' SET n.\`${affected.attribute_name}\` = {CONVERSION_FUNCTION}(n.\`${affected.attribute_name}\`)`
          });
          break;
      }
    }

    for (const affected of impact.affected_relationships) {
      if (affected.change_type === 'RELATIONSHIP_REMOVED') {
        steps.push({
          step: steps.length + 1,
          action: 'DELETE_RELATIONSHIPS',
          description: `Delete ${affected.affected_count} relationships of type "${affected.relationship_type}"`,
          affected_count: affected.affected_count,
          cypher: `MATCH ()-[r:\`${affected.relationship_type}\`]->() WHERE startNode(r).workspace_id = '${workspaceId}' DELETE r`
        });
      }
    }

    return {
      required: true,
      steps,
      total_steps: steps.length,
      estimated_affected: impact.summary.total_affected_nodes + impact.summary.total_affected_relationships,
      warning: 'Review each step carefully before executing. Consider backing up data first.'
    };
  }

  /**
   * Execute a migration step
   */
  async executeMigrationStep(step, options = {}) {
    const session = neo4jService.getSession();
    try {
      let cypher = step.cypher || step.cypher_delete;
      
      // Replace placeholders
      if (options.targetType) {
        cypher = cypher.replace('{TARGET_TYPE}', options.targetType);
      }
      if (options.conversionFunction) {
        cypher = cypher.replace('{CONVERSION_FUNCTION}', options.conversionFunction);
      }

      const result = await session.run(cypher);
      
      return {
        success: true,
        step: step.step,
        action: step.action,
        records_affected: result.summary.counters.updates().nodesDeleted || 
                         result.summary.counters.updates().relationshipsDeleted ||
                         result.summary.counters.updates().propertiesSet || 0
      };
    } catch (error) {
      return {
        success: false,
        step: step.step,
        error: error.message
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get recommendation based on impact analysis
   */
  getRecommendation(affectedNodes, affectedRelationships) {
    const totalAffected = 
      affectedNodes.reduce((sum, a) => sum + a.affected_count, 0) +
      affectedRelationships.reduce((sum, a) => sum + a.affected_count, 0);

    if (totalAffected === 0) {
      return 'Safe to publish. No existing data will be affected.';
    }

    const hasHighSeverity = [...affectedNodes, ...affectedRelationships].some(a => a.severity === 'HIGH');

    if (hasHighSeverity) {
      return 'Migration required before publishing. Review the migration plan and execute steps carefully.';
    }

    return 'Minor impact detected. Review affected items before publishing.';
  }
}

module.exports = new OntologyImpactService();
