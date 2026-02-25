/**
 * Activity Logger Middleware
 *
 * Automatically logs every authenticated API request to the audit trail.
 * Runs as a response-finish hook so it captures the final status code.
 *
 * Categorizes requests into human-readable action labels based on
 * HTTP method + URL path.
 */

const activityAuditService = require('../services/activityAuditService');

// Route-to-action mapping (checked in order, first match wins)
const ACTION_MAP = [
  // Auth
  { pattern: /^\/api\/auth\/login$/, method: 'POST', action: 'auth.login' },
  { pattern: /^\/api\/auth\/logout$/, method: 'POST', action: 'auth.logout' },
  { pattern: /^\/api\/auth\/refresh$/, method: 'POST', action: 'auth.refresh' },
  { pattern: /^\/api\/auth\/register$/, method: 'POST', action: 'auth.register' },
  { pattern: /^\/api\/auth\/users/, method: 'POST', action: 'user.create' },
  { pattern: /^\/api\/auth\/users/, method: 'PUT', action: 'user.update' },
  { pattern: /^\/api\/auth\/users/, method: 'DELETE', action: 'user.delete' },
  { pattern: /^\/api\/auth\/llm-token$/, method: 'POST', action: 'token.set' },
  { pattern: /^\/api\/auth\/llm-token$/, method: 'DELETE', action: 'token.delete' },

  // Chat
  { pattern: /^\/api\/chat\/message/, method: 'POST', action: 'chat.message' },
  { pattern: /^\/api\/chat/, method: 'DELETE', action: 'chat.delete' },

  // Documents / uploads
  { pattern: /^\/api\/ontology\/.*\/upload/, method: 'POST', action: 'document.upload' },
  { pattern: /^\/api\/ontology\/.*\/documents/, method: 'DELETE', action: 'document.delete' },

  // Extraction
  { pattern: /^\/api\/extraction/, method: 'POST', action: 'extraction.run' },
  { pattern: /^\/api\/ontology\/.*\/extract/, method: 'POST', action: 'extraction.run' },

  // Ontology management
  { pattern: /^\/api\/ontology-versions/, method: 'POST', action: 'ontology.create' },
  { pattern: /^\/api\/ontology-versions/, method: 'PUT', action: 'ontology.update' },
  { pattern: /^\/api\/ontology-versions/, method: 'DELETE', action: 'ontology.delete' },
  { pattern: /^\/api\/owl/, method: 'POST', action: 'owl.update' },
  { pattern: /^\/api\/owl/, method: 'PUT', action: 'owl.update' },

  // Graph
  { pattern: /^\/api\/graph/, method: 'POST', action: 'graph.query' },
  { pattern: /^\/api\/graph/, method: 'DELETE', action: 'graph.delete' },
  { pattern: /^\/api\/sparql/, method: 'POST', action: 'sparql.query' },

  // Admin
  { pattern: /^\/api\/admin\/clear/, method: 'POST', action: 'admin.clear' },
  { pattern: /^\/api\/admin\/clear/, method: 'DELETE', action: 'admin.clear' },
  { pattern: /^\/api\/admin\/workspace\/.*\/purge/, method: 'DELETE', action: 'admin.workspace.purge' },
  { pattern: /^\/api\/admin\/tenant\/.*\/purge/, method: 'DELETE', action: 'admin.tenant.purge' },
  { pattern: /^\/api\/admin/, method: 'POST', action: 'admin.action' },
  { pattern: /^\/api\/admin/, method: 'DELETE', action: 'admin.delete' },

  // Tenants / workspaces
  { pattern: /^\/api\/tenants\/.*\/workspaces/, method: 'POST', action: 'workspace.create' },
  { pattern: /^\/api\/tenants\/.*\/workspaces/, method: 'DELETE', action: 'workspace.delete' },
  { pattern: /^\/api\/tenants/, method: 'POST', action: 'tenant.create' },
  { pattern: /^\/api\/tenants/, method: 'DELETE', action: 'tenant.delete' },

  // Folders
  { pattern: /^\/api\/folders/, method: 'POST', action: 'folder.create' },
  { pattern: /^\/api\/folders/, method: 'PUT', action: 'folder.update' },
  { pattern: /^\/api\/folders/, method: 'DELETE', action: 'folder.delete' },

  // Settings
  { pattern: /^\/api\/settings/, method: 'POST', action: 'settings.update' },
  { pattern: /^\/api\/settings/, method: 'PUT', action: 'settings.update' },

  // Enterprise
  { pattern: /^\/api\/enterprise\/entity-resolution\/merge/, method: 'POST', action: 'entity.merge' },
  { pattern: /^\/api\/enterprise\/connectors/, method: 'POST', action: 'connector.create' },
  { pattern: /^\/api\/enterprise\/connectors/, method: 'DELETE', action: 'connector.delete' },

  // Identity resolution
  { pattern: /^\/api\/identity/, method: 'POST', action: 'identity.resolve' },

  // Review queue
  { pattern: /^\/api\/review-queue\/.*\/approve/, method: 'POST', action: 'review.approve' },
  { pattern: /^\/api\/review-queue\/.*\/reject/, method: 'POST', action: 'review.reject' },
  { pattern: /^\/api\/review-queue/, method: 'POST', action: 'review.action' },

  // Ontology packs
  { pattern: /^\/api\/ontology-packs/, method: 'POST', action: 'ontology-pack.install' },
  { pattern: /^\/api\/ontology-packs/, method: 'DELETE', action: 'ontology-pack.delete' },
];

/**
 * Classify a request into a human-readable action string.
 */
function classifyAction(method, path) {
  for (const rule of ACTION_MAP) {
    if (rule.method === method && rule.pattern.test(path)) {
      return rule.action;
    }
  }
  // Fallback: method.path-segment
  const segments = path.replace(/^\/api\//, '').split('/');
  const base = segments[0] || 'unknown';
  return `${method.toLowerCase()}.${base}`;
}

/**
 * Determine if a request should be logged.
 * Skip noisy read-only endpoints to keep the log useful.
 */
function shouldLog(method, path) {
  // Always skip noisy/internal endpoints regardless of method
  if (path === '/api/health') return false;
  if (path.includes('/rbac/audit')) return false;
  if (path.includes('/api/auth/refresh')) return false;

  // Log state-changing requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;

  // Skip most GETs to reduce noise — only log GETs to sensitive areas
  if (method === 'GET') {
    if (path.includes('/admin') || path.includes('/settings') || path.includes('/users')) return true;
    return false;
  }

  return true;
}

/**
 * Express middleware — attach to response 'finish' event.
 */
function activityLogger(req, res, next) {
  // Capture start time
  const startTime = Date.now();

  res.on('finish', () => {
    try {
      const method = req.method;
      const path = req.originalUrl?.split('?')[0] || req.path;

      if (!shouldLog(method, path)) return;

      const statusCode = res.statusCode;
      const success = statusCode >= 200 && statusCode < 400;
      const userId = req.user?.email || req.user?.id || req.headers?.['x-user-id'] || 'anonymous';

      // For login, extract email from body
      let effectiveUserId = userId;
      if (path === '/api/auth/login' && req.body?.email) {
        effectiveUserId = req.body.email;
      }

      const action = classifyAction(method, path);
      const workspaceId = req.tenantContext?.workspace_id
        || req.query?.workspaceId || req.query?.workspace_id || '';

      activityAuditService.logActivity({
        userId: effectiveUserId,
        action,
        resource: `${method} ${path}`,
        method,
        statusCode,
        success,
        ip: req.ip || req.connection?.remoteAddress || '',
        workspaceId,
        details: !success ? `HTTP ${statusCode}` : '',
      });
    } catch {
      // Never break the response
    }
  });

  next();
}

module.exports = { activityLogger };
