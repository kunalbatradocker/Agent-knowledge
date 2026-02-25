/**
 * Role-Based Access Control (RBAC) Configuration
 *
 * Roles (highest to lowest):
 *   admin   – Full access to everything
 *   manager – Manage ontologies, clear data, organize workspace structure
 *   member  – Upload docs, run extractions, contribute content
 *   viewer  – Read-only access to dashboards, queries, chat
 *
 * Each permission is a string like 'documents:write' or 'admin:users'.
 * Middleware checks if the user's role includes the required permission.
 */

const PERMISSIONS = {
  // Read / query (viewer+)
  DASHBOARD_VIEW:     'dashboard:view',
  QUERY_EXECUTE:      'query:execute',
  CHAT_USE:           'chat:use',
  DOCUMENTS_READ:     'documents:read',
  ENTITIES_READ:      'entities:read',
  ONTOLOGY_READ:      'ontology:read',
  GRAPH_READ:         'graph:read',
  STATS_VIEW:         'stats:view',

  // Write / contribute (member+)
  DOCUMENTS_WRITE:    'documents:write',
  DOCUMENTS_DELETE:    'documents:delete',
  EXTRACTION_RUN:     'extraction:run',
  CHAT_DELETE:        'chat:delete',
  DATASOURCE_MANAGE:  'datasource:manage',

  // Manage (manager+)
  ONTOLOGY_MANAGE:    'ontology:manage',
  DATA_CLEAR:         'data:clear',
  FOLDERS_MANAGE:     'folders:manage',
  IDENTITY_MANAGE:    'identity:manage',
  SYNC_TRIGGER:       'sync:trigger',
  SCHEMA_MANAGE:      'schema:manage',

  // VKG / Federated (manager+ for catalog management, viewer+ for querying)
  VKG_QUERY:          'vkg:query',
  VKG_CATALOG_MANAGE: 'vkg:catalog:manage',
  VKG_ONTOLOGY_GEN:   'vkg:ontology:generate',
  VKG_SCHEMA_DRIFT:   'vkg:schema:drift',

  // Admin only
  ADMIN_USERS:        'admin:users',
  ADMIN_SETTINGS:     'admin:settings',
  ADMIN_LLM:          'admin:llm',
  WORKSPACE_CREATE:   'workspace:create',
  WORKSPACE_DELETE:    'workspace:delete',
  TENANT_MANAGE:      'tenant:manage',
  PURGE:              'purge',
};

const ROLE_PERMISSIONS = {
  viewer: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.QUERY_EXECUTE,
    PERMISSIONS.CHAT_USE,
    PERMISSIONS.DOCUMENTS_READ,
    PERMISSIONS.ENTITIES_READ,
    PERMISSIONS.ONTOLOGY_READ,
    PERMISSIONS.GRAPH_READ,
    PERMISSIONS.STATS_VIEW,
    PERMISSIONS.VKG_QUERY,
  ],

  member: [
    // inherits viewer
    PERMISSIONS.DOCUMENTS_WRITE,
    PERMISSIONS.DOCUMENTS_DELETE,
    PERMISSIONS.EXTRACTION_RUN,
    PERMISSIONS.CHAT_DELETE,
    PERMISSIONS.DATASOURCE_MANAGE,
  ],

  manager: [
    // inherits member
    PERMISSIONS.ONTOLOGY_MANAGE,
    PERMISSIONS.DATA_CLEAR,
    PERMISSIONS.FOLDERS_MANAGE,
    PERMISSIONS.IDENTITY_MANAGE,
    PERMISSIONS.SYNC_TRIGGER,
    PERMISSIONS.SCHEMA_MANAGE,
    PERMISSIONS.VKG_CATALOG_MANAGE,
    PERMISSIONS.VKG_ONTOLOGY_GEN,
    PERMISSIONS.VKG_SCHEMA_DRIFT,
  ],

  admin: [
    // inherits manager
    PERMISSIONS.ADMIN_USERS,
    PERMISSIONS.ADMIN_SETTINGS,
    PERMISSIONS.ADMIN_LLM,
    PERMISSIONS.WORKSPACE_CREATE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.TENANT_MANAGE,
    PERMISSIONS.PURGE,
  ],
};

// Build cumulative permissions (each role inherits from lower roles)
const ROLE_HIERARCHY = ['viewer', 'member', 'manager', 'admin'];

function getPermissionsForRole(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  if (idx === -1) return ROLE_PERMISSIONS.viewer || []; // unknown role defaults to viewer
  const perms = new Set();
  for (let i = 0; i <= idx; i++) {
    const r = ROLE_HIERARCHY[i];
    (ROLE_PERMISSIONS[r] || []).forEach(p => perms.add(p));
  }
  return [...perms];
}

function hasPermission(role, permission) {
  return getPermissionsForRole(role).includes(permission);
}

module.exports = { PERMISSIONS, ROLE_HIERARCHY, ROLE_PERMISSIONS, getPermissionsForRole, hasPermission };
