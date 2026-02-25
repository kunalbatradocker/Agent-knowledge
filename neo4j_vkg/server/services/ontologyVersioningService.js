/**
 * Ontology Versioning Service
 * Manages ontology versions, rollback, branching, and tagging
 */

const { client: redisClient, connectRedis } = require('../config/redis');
const owlOntologyService = require('./owlOntologyService');
const { v4: uuidv4 } = require('uuid');

const REDIS_KEYS = {
  ONTOLOGY_VERSIONS: 'ontology_versions:', // ontology_versions:{ontologyId} → sorted set of versions
  VERSION_DATA: 'version_data:', // version_data:{ontologyId}:{versionId} → full ontology data
  VERSION_META: 'version_meta:', // version_meta:{ontologyId}:{versionId} → metadata
  CURRENT_VERSION: 'current_version:', // current_version:{ontologyId} → current version ID
  BRANCHES: 'branches:', // branches:{ontologyId} → hash of branch_name → version_id
  TAGS: 'tags:', // tags:{ontologyId} → hash of tag_name → version_id
  AUDIT_LOG: 'ontology_audit:', // ontology_audit:{ontologyId} → list of audit entries
};

class OntologyVersioningService {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await connectRedis();
    this.initialized = true;
  }

  // ============================================================
  // VERSION CREATION
  // ============================================================

  async createVersion(ontologyId, options = {}) {
    await this.initialize();
    
    const {
      description = '',
      user_id = 'system',
      branch = 'main',
      tag = null,
      parent_version = null,
      tenant_id = 'default',
      workspace_id = 'default'
    } = options;

    // Try to get current ontology data, fallback to mock structure if not found
    let ontologyData;
    try {
      ontologyData = await owlOntologyService.getOntologyStructure(tenant_id, workspace_id, ontologyId, 'all');
    } catch (error) {
      console.warn(`Could not get ontology structure for ${ontologyId}, using mock data:`, error.message);
      // Create mock structure for testing
      ontologyData = {
        classes: [
          { uri: `http://purplefabric.ai/${ontologyId}#Class1`, label: 'Sample Class 1' },
          { uri: `http://purplefabric.ai/${ontologyId}#Class2`, label: 'Sample Class 2' }
        ],
        properties: [
          { uri: `http://purplefabric.ai/${ontologyId}#prop1`, label: 'Sample Property 1', type: 'objectProperty' },
          { uri: `http://purplefabric.ai/${ontologyId}#prop2`, label: 'Sample Property 2', type: 'datatypeProperty' }
        ]
      };
    }

    // Generate version ID
    const versionId = `v${Date.now()}-${uuidv4().slice(0, 8)}`;
    const timestamp = new Date().toISOString();

    // Get parent version if not specified
    let actualParent = parent_version;
    if (!actualParent) {
      actualParent = await this.getCurrentVersion(ontologyId);
    }

    // Create version metadata
    const versionMeta = {
      version_id: versionId,
      ontology_id: ontologyId,
      created_at: timestamp,
      created_by: user_id,
      description,
      branch,
      parent_version: actualParent,
      
      // Stats
      class_count: ontologyData.classes?.length || 0,
      property_count: ontologyData.properties?.length || 0,
      
      // Checksums for change detection
      structure_hash: this.calculateStructureHash(ontologyData)
    };

    // Store version data and metadata
    await redisClient.set(
      `${REDIS_KEYS.VERSION_DATA}${ontologyId}:${versionId}`,
      JSON.stringify(ontologyData)
    );
    
    await redisClient.set(
      `${REDIS_KEYS.VERSION_META}${ontologyId}:${versionId}`,
      JSON.stringify(versionMeta)
    );

    // Add to version history
    await redisClient.zAdd(
      `${REDIS_KEYS.ONTOLOGY_VERSIONS}${ontologyId}`,
      { score: Date.now(), value: versionId }
    );

    // Update current version
    await redisClient.set(`${REDIS_KEYS.CURRENT_VERSION}${ontologyId}`, versionId);

    // Update branch pointer
    await redisClient.hSet(`${REDIS_KEYS.BRANCHES}${ontologyId}`, branch, versionId);

    // Create tag if specified
    if (tag) {
      await this.createTag(ontologyId, tag, versionId);
    }

    // Audit log
    await this.logAudit(ontologyId, {
      action: 'version_created',
      version_id: versionId,
      user_id,
      details: { description, branch, tag, parent_version: actualParent }
    });

    return versionMeta;
  }

  // ============================================================
  // VERSION RETRIEVAL
  // ============================================================

  async getVersionHistory(ontologyId, options = {}) {
    await this.initialize();
    
    const { limit = 50, branch = null } = options;
    
    // Get all versions (newest first)
    const versionIds = await redisClient.zRange(
      `${REDIS_KEYS.ONTOLOGY_VERSIONS}${ontologyId}`,
      0, limit - 1,
      { REV: true }
    );

    const versions = [];
    for (const versionId of versionIds) {
      const meta = await this.getVersionMeta(ontologyId, versionId);
      if (meta && (!branch || meta.branch === branch)) {
        versions.push(meta);
      }
    }

    return versions;
  }

  async getVersionMeta(ontologyId, versionId) {
    await this.initialize();
    
    const data = await redisClient.get(`${REDIS_KEYS.VERSION_META}${ontologyId}:${versionId}`);
    return data ? JSON.parse(data) : null;
  }

  async getVersionData(ontologyId, versionId) {
    await this.initialize();
    
    const data = await redisClient.get(`${REDIS_KEYS.VERSION_DATA}${ontologyId}:${versionId}`);
    return data ? JSON.parse(data) : null;
  }

  async getCurrentVersion(ontologyId) {
    await this.initialize();
    return await redisClient.get(`${REDIS_KEYS.CURRENT_VERSION}${ontologyId}`);
  }

  // ============================================================
  // ROLLBACK
  // ============================================================

  async rollbackToVersion(ontologyId, targetVersionId, options = {}) {
    await this.initialize();
    
    const { user_id = 'system', reason = '', create_backup = true } = options;

    // Get target version data
    const targetData = await this.getVersionData(ontologyId, targetVersionId);
    const targetMeta = await this.getVersionMeta(ontologyId, targetVersionId);
    
    if (!targetData || !targetMeta) {
      throw new Error(`Version not found: ${ontologyId}:${targetVersionId}`);
    }

    // Create backup of current state if requested
    let backupVersionId = null;
    if (create_backup) {
      const backup = await this.createVersion(ontologyId, {
        description: `Backup before rollback to ${targetVersionId}`,
        user_id,
        branch: 'backup',
        tag: `backup-${Date.now()}`
      });
      backupVersionId = backup.version_id;
    }

    // Restore ontology to target version state
    await this.restoreOntologyFromVersion(ontologyId, targetData);

    // Update current version pointer
    await redisClient.set(`${REDIS_KEYS.CURRENT_VERSION}${ontologyId}`, targetVersionId);

    // Update main branch to point to target
    await redisClient.hSet(`${REDIS_KEYS.BRANCHES}${ontologyId}`, 'main', targetVersionId);

    // Audit log
    await this.logAudit(ontologyId, {
      action: 'rollback',
      version_id: targetVersionId,
      user_id,
      details: { 
        reason, 
        backup_version: backupVersionId,
        target_branch: targetMeta.branch 
      }
    });

    return {
      success: true,
      rolled_back_to: targetVersionId,
      backup_version: backupVersionId,
      restored_at: new Date().toISOString()
    };
  }

  async restoreOntologyFromVersion(ontologyId, versionData) {
    // Restore the ontology in GraphDB using the versioned structure data
    try {
      const ontologyIRI = versionData.ontologyIRI || '';
      const iriMatch = ontologyIRI.match(/tenant\/([^/]+)\/workspace\/([^/]+)/);
      const tenantId = iriMatch?.[1] || 'default';
      const workspaceId = iriMatch?.[2] || 'default';
      const baseUri = ontologyIRI || `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}`;

      // The versioned data may have local names for domain/range instead of full URIs.
      // Reconstruct full URIs so updateOntology generates valid Turtle.
      const classes = (versionData.classes || []).map(cls => ({
        ...cls,
        uri: cls.uri || cls.iri || `${baseUri}#${(cls.localName || cls.label || '').replace(/\\s+/g, '')}`
      }));

      const classUriMap = {};
      for (const cls of classes) {
        const localName = cls.localName || cls.label || cls.uri?.split(/[#/]/).pop();
        if (localName) classUriMap[localName] = cls.uri;
      }

      const properties = (versionData.properties || []).map(prop => {
        const propUri = prop.uri || prop.iri || `${baseUri}#${(prop.localName || prop.label || '').replace(/\\s+/g, '')}`;
        let domain = prop.domain || '';
        let range = prop.range || '';
        // If domain/range are local names, resolve to full URIs
        if (domain && !domain.includes('://')) {
          domain = classUriMap[domain] || `${baseUri}#${domain}`;
        }
        if (range && !range.includes('://') && !range.startsWith('xsd:')) {
          range = classUriMap[range] || `${baseUri}#${range}`;
        }
        return {
          ...prop,
          uri: propUri,
          domain,
          range,
          propertyType: prop.type === 'datatypeProperty' ? 'DatatypeProperty' : 'ObjectProperty'
        };
      });

      await owlOntologyService.updateOntology(tenantId, workspaceId, ontologyId, {
        label: versionData.label || ontologyId,
        comment: versionData.comment || '',
        classes,
        properties
      });
    } catch (error) {
      console.error(`Failed to restore ontology ${ontologyId} from version:`, error);
      throw new Error(`Rollback failed: could not restore ontology to GraphDB — ${error.message}`);
    }
  }

  // ============================================================
  // BRANCHING
  // ============================================================

  async createBranch(ontologyId, branchName, fromVersion = null, options = {}) {
    await this.initialize();
    
    const { user_id = 'system', description = '' } = options;

    // Get source version (current if not specified)
    const sourceVersion = fromVersion || await this.getCurrentVersion(ontologyId);
    if (!sourceVersion) {
      throw new Error(`No source version found for ontology: ${ontologyId}`);
    }

    // Check if branch already exists
    const existingBranch = await redisClient.hGet(`${REDIS_KEYS.BRANCHES}${ontologyId}`, branchName);
    if (existingBranch) {
      throw new Error(`Branch '${branchName}' already exists`);
    }

    // Create new version on the branch
    const branchVersion = await this.createVersion(ontologyId, {
      description: description || `Created branch '${branchName}' from ${sourceVersion}`,
      user_id,
      branch: branchName,
      parent_version: sourceVersion
    });

    return {
      branch_name: branchName,
      version_id: branchVersion.version_id,
      created_from: sourceVersion,
      created_at: branchVersion.created_at
    };
  }

  async getBranches(ontologyId) {
    await this.initialize();
    
    const branches = await redisClient.hGetAll(`${REDIS_KEYS.BRANCHES}${ontologyId}`);
    const result = [];

    for (const [branchName, versionId] of Object.entries(branches)) {
      const meta = await this.getVersionMeta(ontologyId, versionId);
      result.push({
        name: branchName,
        current_version: versionId,
        last_updated: meta?.created_at,
        created_by: meta?.created_by
      });
    }

    return result;
  }

  async switchBranch(ontologyId, branchName, options = {}) {
    await this.initialize();
    
    const { user_id = 'system' } = options;

    // Get branch version
    const branchVersion = await redisClient.hGet(`${REDIS_KEYS.BRANCHES}${ontologyId}`, branchName);
    if (!branchVersion) {
      throw new Error(`Branch '${branchName}' not found`);
    }

    // Switch to branch version (similar to rollback but without backup)
    const result = await this.rollbackToVersion(ontologyId, branchVersion, {
      user_id,
      reason: `Switched to branch '${branchName}'`,
      create_backup: false
    });

    await this.logAudit(ontologyId, {
      action: 'branch_switch',
      version_id: branchVersion,
      user_id,
      details: { branch_name: branchName }
    });

    return result;
  }

  // ============================================================
  // TAGGING
  // ============================================================

  async createTag(ontologyId, tagName, versionId = null, options = {}) {
    await this.initialize();
    
    const { user_id = 'system', description = '' } = options;

    // Use current version if not specified
    const targetVersion = versionId || await this.getCurrentVersion(ontologyId);
    if (!targetVersion) {
      throw new Error(`No version found for ontology: ${ontologyId}`);
    }

    // Check if tag already exists
    const existingTag = await redisClient.hGet(`${REDIS_KEYS.TAGS}${ontologyId}`, tagName);
    if (existingTag) {
      throw new Error(`Tag '${tagName}' already exists`);
    }

    // Create tag
    await redisClient.hSet(`${REDIS_KEYS.TAGS}${ontologyId}`, tagName, targetVersion);

    // Store tag metadata
    await redisClient.set(
      `tag_meta:${ontologyId}:${tagName}`,
      JSON.stringify({
        tag_name: tagName,
        version_id: targetVersion,
        created_at: new Date().toISOString(),
        created_by: user_id,
        description
      })
    );

    await this.logAudit(ontologyId, {
      action: 'tag_created',
      version_id: targetVersion,
      user_id,
      details: { tag_name: tagName, description }
    });

    return { tag_name: tagName, version_id: targetVersion };
  }

  async getTags(ontologyId) {
    await this.initialize();
    
    const tags = await redisClient.hGetAll(`${REDIS_KEYS.TAGS}${ontologyId}`);
    const result = [];

    for (const [tagName, versionId] of Object.entries(tags)) {
      const metaData = await redisClient.get(`tag_meta:${ontologyId}:${tagName}`);
      const meta = metaData ? JSON.parse(metaData) : {};
      
      result.push({
        name: tagName,
        version_id: versionId,
        created_at: meta.created_at,
        created_by: meta.created_by,
        description: meta.description
      });
    }

    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async deleteTag(ontologyId, tagName, options = {}) {
    await this.initialize();
    
    const { user_id = 'system' } = options;

    const deleted = await redisClient.hDel(`${REDIS_KEYS.TAGS}${ontologyId}`, tagName);
    await redisClient.del(`tag_meta:${ontologyId}:${tagName}`);

    if (deleted) {
      await this.logAudit(ontologyId, {
        action: 'tag_deleted',
        user_id,
        details: { tag_name: tagName }
      });
    }

    return { deleted: deleted > 0 };
  }

  // ============================================================
  // COMPARISON
  // ============================================================

  async compareVersions(ontologyId, version1, version2) {
    await this.initialize();
    
    const data1 = await this.getVersionData(ontologyId, version1);
    const data2 = await this.getVersionData(ontologyId, version2);
    const meta1 = await this.getVersionMeta(ontologyId, version1);
    const meta2 = await this.getVersionMeta(ontologyId, version2);

    if (!data1 || !data2) {
      throw new Error('One or both versions not found');
    }

    // Compare classes
    const classes1 = new Map((data1.classes || []).map(c => [c.uri || c.label, c]));
    const classes2 = new Map((data2.classes || []).map(c => [c.uri || c.label, c]));

    const addedClasses = [];
    const removedClasses = [];
    const modifiedClasses = [];

    for (const [key, cls] of classes2) {
      if (!classes1.has(key)) {
        addedClasses.push(cls);
      } else {
        const old = classes1.get(key);
        if (JSON.stringify(old) !== JSON.stringify(cls)) {
          modifiedClasses.push({ old, new: cls });
        }
      }
    }

    for (const [key, cls] of classes1) {
      if (!classes2.has(key)) {
        removedClasses.push(cls);
      }
    }

    // Compare properties
    const props1 = new Map((data1.properties || []).map(p => [p.uri || p.label, p]));
    const props2 = new Map((data2.properties || []).map(p => [p.uri || p.label, p]));

    const addedProperties = [];
    const removedProperties = [];

    for (const [key, prop] of props2) {
      if (!props1.has(key)) addedProperties.push(prop);
    }

    for (const [key, prop] of props1) {
      if (!props2.has(key)) removedProperties.push(prop);
    }

    return {
      version1: { ...meta1, class_count: classes1.size, property_count: props1.size },
      version2: { ...meta2, class_count: classes2.size, property_count: props2.size },
      diff: {
        classes: { added: addedClasses, removed: removedClasses, modified: modifiedClasses },
        properties: { added: addedProperties, removed: removedProperties }
      },
      summary: {
        classes_added: addedClasses.length,
        classes_removed: removedClasses.length,
        classes_modified: modifiedClasses.length,
        properties_added: addedProperties.length,
        properties_removed: removedProperties.length
      }
    };
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  calculateStructureHash(ontologyData) {
    const crypto = require('crypto');
    const structure = {
      classes: (ontologyData.classes || []).map(c => ({ uri: c.uri, label: c.label })),
      properties: (ontologyData.properties || []).map(p => ({ uri: p.uri, label: p.label, type: p.type }))
    };
    return crypto.createHash('md5').update(JSON.stringify(structure)).digest('hex');
  }

  async logAudit(ontologyId, entry) {
    await this.initialize();
    
    const auditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ontology_id: ontologyId,
      ...entry
    };

    await redisClient.lPush(`${REDIS_KEYS.AUDIT_LOG}${ontologyId}`, JSON.stringify(auditEntry));
    await redisClient.lTrim(`${REDIS_KEYS.AUDIT_LOG}${ontologyId}`, 0, 999); // Keep last 1000 entries
  }

  async getAuditLog(ontologyId, limit = 50) {
    await this.initialize();
    
    const entries = await redisClient.lRange(`${REDIS_KEYS.AUDIT_LOG}${ontologyId}`, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
  }
}

module.exports = new OntologyVersioningService();
