/**
 * usePermissions Hook
 * Role-aware permission checking for UI rendering.
 * Mirrors the server-side RBAC hierarchy: viewer < member < manager < admin
 */

import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

const ROLE_HIERARCHY = ['viewer', 'member', 'manager', 'admin'];

const ROLE_PERMISSIONS = {
  viewer: [
    'dashboard:view', 'query:execute', 'chat:use',
    'documents:read', 'entities:read', 'ontology:read',
    'graph:read', 'stats:view',
  ],
  member: [
    'documents:write', 'documents:delete', 'extraction:run',
    'chat:delete', 'datasource:manage',
  ],
  manager: [
    'ontology:manage', 'data:clear', 'folders:manage',
    'identity:manage', 'sync:trigger', 'schema:manage',
  ],
  admin: [
    'admin:users', 'admin:settings', 'admin:llm',
    'workspace:create', 'workspace:delete', 'tenant:manage', 'purge',
  ],
};

function getPermissionsForRole(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  if (idx === -1) return ROLE_PERMISSIONS.viewer;
  const perms = new Set();
  for (let i = 0; i <= idx; i++) {
    (ROLE_PERMISSIONS[ROLE_HIERARCHY[i]] || []).forEach(p => perms.add(p));
  }
  return [...perms];
}

export function usePermissions() {
  const { user } = useAuth();
  const role = user?.role || 'viewer';

  const permissions = useMemo(() => getPermissionsForRole(role), [role]);

  const can = (permission) => permissions.includes(permission);
  const isAtLeast = (minRole) => {
    const userIdx = ROLE_HIERARCHY.indexOf(role);
    const minIdx = ROLE_HIERARCHY.indexOf(minRole);
    return userIdx >= minIdx;
  };

  return {
    role,
    permissions,
    can,
    isAtLeast,
    isAdmin: role === 'admin',
    isManager: isAtLeast('manager'),
    isMember: isAtLeast('member'),
    isViewer: true,
    // Convenience checks for common UI patterns
    canUpload: isAtLeast('member'),
    canDelete: isAtLeast('member'),
    canManageOntology: isAtLeast('manager'),
    canClearData: isAtLeast('manager'),
    canManageFolders: isAtLeast('manager'),
    canManageUsers: role === 'admin',
    canPurge: role === 'admin',
  };
}

export default usePermissions;
