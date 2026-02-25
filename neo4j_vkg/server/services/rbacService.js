/**
 * RBAC Service (DEPRECATED)
 *
 * This service previously maintained its own role/permission system in Redis.
 * It has been replaced by the code-defined system in server/config/roles.js
 * and server/middleware/auth.js.
 *
 * This file is kept as a thin compatibility layer so the enterprise API
 * endpoints (/api/enterprise/rbac/*) don't crash. All role management
 * should go through the new system.
 *
 * Role hierarchy (new system): viewer < member < manager < admin
 * Permissions are defined in server/config/roles.js (24 permissions).
 */

const { ROLE_HIERARCHY, ROLE_PERMISSIONS, getPermissionsForRole, hasPermission } = require('../config/roles');

class RBACService {
  constructor() {
    // Map new roles to display info
    this.roles = {
      viewer:  { id: 'viewer',  name: 'Viewer',  description: 'Read-only access to dashboards, queries, chat' },
      member:  { id: 'member',  name: 'Member',  description: 'Upload docs, run extractions, contribute content' },
      manager: { id: 'manager', name: 'Manager', description: 'Manage ontologies, clear data, organize workspace' },
      admin:   { id: 'admin',   name: 'Admin',   description: 'Full access to everything' },
    };
  }

  /**
   * Initialize — no-op, roles are defined in code now
   */
  async initialize() {
    return { initialized: true, rolesCreated: 0, roles: ROLE_HIERARCHY };
  }

  /**
   * Get all roles (returns the new role definitions)
   */
  async getAllRoles() {
    return ROLE_HIERARCHY.map(r => ({
      ...this.roles[r],
      permissions: getPermissionsForRole(r),
      isSystem: true,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
  }

  /**
   * Get a role by ID
   */
  async getRole(roleId) {
    if (!this.roles[roleId]) return null;
    return {
      ...this.roles[roleId],
      permissions: getPermissionsForRole(roleId),
      entityTypeRestrictions: [],
      isSystem: true,
    };
  }

  /**
   * Create a role — blocked, roles are code-defined
   */
  async createRole(_roleId, _roleData) {
    throw new Error('Custom role creation is disabled. Roles are defined in server/config/roles.js. Use viewer, member, manager, or admin.');
  }

  /**
   * Update a role — blocked
   */
  async updateRole(_roleId, _updates) {
    throw new Error('Role modification is disabled. Roles are defined in server/config/roles.js.');
  }

  /**
   * Delete a role — blocked
   */
  async deleteRole(_roleId) {
    throw new Error('Role deletion is disabled. Roles are defined in server/config/roles.js.');
  }

  /**
   * Assign role to user — delegates to authService
   */
  async assignRole(userId, roleId) {
    if (!ROLE_HIERARCHY.includes(roleId)) {
      throw new Error(`Invalid role: ${roleId}. Valid roles: ${ROLE_HIERARCHY.join(', ')}`);
    }
    // Update user role via authService
    const authService = require('./authService');
    await authService.updateUser(userId, { role: roleId });
    return { userId, roleId, assigned: true };
  }

  /**
   * Remove role from user — sets back to viewer
   */
  async removeRole(userId, _roleId) {
    const authService = require('./authService');
    await authService.updateUser(userId, { role: 'viewer' });
    return { userId, roleId: 'viewer', removed: true };
  }

  /**
   * Get user's permissions based on their role in authService
   */
  async getUserPermissions(userId) {
    const authService = require('./authService');
    const user = await authService.getUser(userId);
    const role = user?.role || 'viewer';
    return {
      permissions: getPermissionsForRole(role),
      entityTypeRestrictions: [],
      roles: [role],
    };
  }

  /**
   * Check if user has a specific permission
   */
  async hasPermission(userId, permission) {
    const authService = require('./authService');
    const user = await authService.getUser(userId);
    const role = user?.role || 'viewer';
    return hasPermission(role, permission);
  }

  /**
   * Entity ACL — no-op stubs (entity-level ACLs removed)
   */
  async setEntityACL(_entityUri, _acl) {
    return { message: 'Entity-level ACLs are deprecated. Use role-based permissions instead.' };
  }

  async getEntityACL(_entityUri) {
    return null;
  }

  /**
   * Audit log — delegates to activityAuditService
   */
  async getPermissionAuditLog(limit = 50) {
    const activityAuditService = require('./activityAuditService');
    return activityAuditService.getActivityLog(limit);
  }
}

module.exports = new RBACService();
