/**
 * Auth Middleware - JWT verification, RBAC, workspace access, CSRF protection
 *
 * Role hierarchy: viewer < member < manager < admin
 * Each role inherits all permissions from lower roles.
 * See server/config/roles.js for the full permission map.
 */
const authService = require('../services/authService');
const { hasPermission, PERMISSIONS } = require('../config/roles');

// --- Core auth ---

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = authService.verifyToken(header.slice(7));
    // Inject user ID into headers for downstream audit services
    req.headers['x-user-id'] = req.user.email || req.user.id || 'unknown';
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Role / permission checks ---

/**
 * Require a specific permission.
 * Usage: router.post('/foo', requirePermission(PERMISSIONS.DOCUMENTS_WRITE), handler)
 */
function requirePermission(permission) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!hasPermission(req.user.role, permission)) {
        return res.status(403).json({ error: `Insufficient permissions (requires ${permission})` });
      }
      next();
    });
  };
}

/**
 * Shortcut: require admin role.
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

/**
 * Shortcut: require manager or above.
 */
function requireManager(req, res, next) {
  requireAuth(req, res, () => {
    if (!hasPermission(req.user.role, PERMISSIONS.ONTOLOGY_MANAGE)) {
      return res.status(403).json({ error: 'Manager access required' });
    }
    next();
  });
}

/**
 * Shortcut: require member or above (can write content).
 */
function requireMember(req, res, next) {
  requireAuth(req, res, () => {
    if (!hasPermission(req.user.role, PERMISSIONS.DOCUMENTS_WRITE)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    next();
  });
}

// --- Workspace access ---

/**
 * Workspace access middleware.
 * Admins have access to all workspaces.
 * Other users must have the workspace in their workspaces array.
 * Empty workspaces array = access to all (backward compat).
 */
function requireWorkspaceAccess(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'admin') return next();

    const workspaceId = req.tenantContext?.workspace_id
      || req.query.workspaceId || req.query.workspace_id
      || req.body?.workspaceId || req.body?.workspace_id;

    if (!workspaceId) return next();

    const userWorkspaces = req.user.workspaces || [];
    if (userWorkspaces.length === 0) return next();

    if (!userWorkspaces.includes(workspaceId)) {
      return res.status(403).json({ error: 'You do not have access to this workspace' });
    }
    next();
  });
}

// --- CSRF ---

function csrfProtection(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) return next();

  const xrw = req.headers['x-requested-with'];
  if (!xrw) {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireManager,
  requireMember,
  requirePermission,
  requireWorkspaceAccess,
  csrfProtection,
  PERMISSIONS,
};
