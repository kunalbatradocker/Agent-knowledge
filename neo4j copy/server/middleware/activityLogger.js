/**
 * Activity Logger Middleware
 *
 * Automatically logs every authenticated API request to the audit trail.
 * Captures request body (input) and response body (output) for each action.
 * Runs as a response-finish hook so it captures the final status code.
 */

const activityAuditService = require('../services/activityAuditService');

// Route-to-action mapping (checked in order, first match wins)
const ACTION_MAP = [
  // Auth
  { pattern: /^\/api\/auth\/login$/, method: 'POST', action: 'auth.login' },
  { pattern: /^\/api\/auth\/logout$/, method: 'POST', action: 'auth.logout' },
  { pattern: /^\/api\/auth\/register$/, method: 'POST', action: 'auth.register' },
  { pattern: /^\/api\/auth\/users/, method: 'POST', action: 'user.create' },
  { pattern: /^\/api\/auth\/users/, method: 'PUT', action: 'user.update' },
  { pattern: /^\/api\/auth\/users/, method: 'DELETE', action: 'user.delete' },
  { pattern: /^\/api\/auth\/llm-token$/, method: 'POST', action: 'token.set' },
  { pattern: /^\/api\/auth\/llm-token$/, method: 'DELETE', action: 'token.delete' },
  { pattern: /^\/api\/auth\/me\/password$/, method: 'PUT', action: 'auth.password.change' },
  // Chat
  { pattern: /^\/api\/chat\/message/, method: 'POST', action: 'chat.message' },
  { pattern: /^\/api\/chat\/conversation/, method: 'DELETE', action: 'chat.delete' },
  { pattern: /^\/api\/chat\/conversations/, method: 'DELETE', action: 'chat.clear' },
  { pattern: /^\/api\/chat\/search/, method: 'POST', action: 'chat.search' },
  // Documents / uploads
  { pattern: /^\/api\/ontology\/.*\/upload/, method: 'POST', action: 'document.upload' },
  { pattern: /^\/api\/ontology\/.*\/documents/, method: 'DELETE', action: 'document.delete' },
  { pattern: /^\/api\/ontology\/.*\/fm-upload/, method: 'POST', action: 'document.upload' },
  // Extraction
  { pattern: /^\/api\/extraction\/enhanced/, method: 'POST', action: 'extraction.enhanced' },
  { pattern: /^\/api\/extraction\/text/, method: 'POST', action: 'extraction.text' },
  { pattern: /^\/api\/extraction/, method: 'POST', action: 'extraction.run' },
  { pattern: /^\/api\/ontology\/.*\/extract/, method: 'POST', action: 'extraction.run' },
  // Ontology management
  { pattern: /^\/api\/ontology-versions/, method: 'POST', action: 'ontology.version' },
  { pattern: /^\/api\/ontology-versions/, method: 'PUT', action: 'ontology.update' },
  { pattern: /^\/api\/ontology-versions/, method: 'DELETE', action: 'ontology.delete' },
  { pattern: /^\/api\/ontology-packs/, method: 'POST', action: 'ontology-pack.action' },
  { pattern: /^\/api\/ontology-packs/, method: 'DELETE', action: 'ontology-pack.delete' },
  { pattern: /^\/api\/owl\/import/, method: 'POST', action: 'owl.import' },
  { pattern: /^\/api\/owl\/create/, method: 'POST', action: 'owl.create' },
  { pattern: /^\/api\/owl/, method: 'POST', action: 'owl.action' },
  { pattern: /^\/api\/owl/, method: 'PUT', action: 'owl.update' },
  { pattern: /^\/api\/owl/, method: 'DELETE', action: 'owl.delete' },
  // Graph
  { pattern: /^\/api\/graph\/nl-to-cypher/, method: 'POST', action: 'graph.nl-query' },
  { pattern: /^\/api\/graph\/cypher/, method: 'POST', action: 'graph.cypher' },
  { pattern: /^\/api\/graph\/clear/, method: 'DELETE', action: 'graph.clear' },
  { pattern: /^\/api\/graph\/cleanup/, method: 'POST', action: 'graph.cleanup' },
  { pattern: /^\/api\/graph/, method: 'POST', action: 'graph.action' },
  { pattern: /^\/api\/sparql\/query/, method: 'POST', action: 'sparql.query' },
  // Admin
  { pattern: /^\/api\/admin\/workspace\/.*\/purge/, method: 'DELETE', action: 'admin.workspace.purge' },
  { pattern: /^\/api\/admin\/tenant\/.*\/purge/, method: 'DELETE', action: 'admin.tenant.purge' },
  { pattern: /^\/api\/admin\/redis\/cleanup/, method: 'POST', action: 'admin.redis.cleanup' },
  { pattern: /^\/api\/admin\/neo4j\/cleanup/, method: 'POST', action: 'admin.neo4j.cleanup' },
  { pattern: /^\/api\/admin\/graphdb\/cleanup/, method: 'POST', action: 'admin.graphdb.cleanup' },
  { pattern: /^\/api\/admin\/graphdb\/delete/, method: 'POST', action: 'admin.graphdb.delete' },
  { pattern: /^\/api\/admin\/neo4j\/delete/, method: 'POST', action: 'admin.neo4j.delete' },
  { pattern: /^\/api\/admin\/llm\/token/, method: 'POST', action: 'admin.llm.token' },
  { pattern: /^\/api\/admin/, method: 'POST', action: 'admin.action' },
  { pattern: /^\/api\/admin/, method: 'DELETE', action: 'admin.delete' },
  // Tenants / workspaces
  { pattern: /^\/api\/tenants\/.*\/workspaces/, method: 'POST', action: 'workspace.create' },
  { pattern: /^\/api\/tenants\/.*\/workspaces/, method: 'PUT', action: 'workspace.update' },
  { pattern: /^\/api\/tenants\/.*\/workspaces/, method: 'DELETE', action: 'workspace.delete' },
  { pattern: /^\/api\/tenants/, method: 'POST', action: 'tenant.create' },
  { pattern: /^\/api\/tenants/, method: 'PUT', action: 'tenant.update' },
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
  { pattern: /^\/api\/enterprise\/entity-resolution\/auto-resolve/, method: 'POST', action: 'entity.auto-resolve' },
  { pattern: /^\/api\/enterprise\/connectors/, method: 'POST', action: 'connector.create' },
  { pattern: /^\/api\/enterprise\/connectors/, method: 'DELETE', action: 'connector.delete' },
  { pattern: /^\/api\/enterprise\/migration/, method: 'POST', action: 'migration.run' },
  // Identity
  { pattern: /^\/api\/identity\/merge/, method: 'POST', action: 'identity.merge' },
  { pattern: /^\/api\/identity\/split/, method: 'POST', action: 'identity.split' },
  { pattern: /^\/api\/identity/, method: 'POST', action: 'identity.action' },
  // Review queue
  { pattern: /^\/api\/review-queue\/.*\/approve/, method: 'POST', action: 'review.approve' },
  { pattern: /^\/api\/review-queue\/.*\/reject/, method: 'POST', action: 'review.reject' },
  { pattern: /^\/api\/review-queue\/bulk/, method: 'POST', action: 'review.bulk' },
  { pattern: /^\/api\/review-queue/, method: 'POST', action: 'review.action' },
  { pattern: /^\/api\/review-queue/, method: 'DELETE', action: 'review.delete' },
  // Sync
  { pattern: /^\/api\/sync\/trigger/, method: 'POST', action: 'sync.trigger' },
  // Versioning
  { pattern: /^\/api\/versioning\/.*\/rollback/, method: 'POST', action: 'versioning.rollback' },
  // JDBC
  { pattern: /^\/api\/jdbc\/.*\/import/, method: 'POST', action: 'jdbc.import' },
  { pattern: /^\/api\/jdbc\/connect/, method: 'POST', action: 'jdbc.connect' },
  { pattern: /^\/api\/jdbc/, method: 'DELETE', action: 'jdbc.disconnect' },
  // Metrics
  { pattern: /^\/api\/metrics\/reset/, method: 'POST', action: 'metrics.reset' },
];

// Sensitive fields to redact from request/response bodies
const SENSITIVE_FIELDS = ['password', 'token', 'refreshToken', 'secret', 'apiKey', 'bearer', 'authorization'];

/**
 * Sanitize an object by redacting sensitive fields and truncating large values.
 */
function sanitizeBody(body, maxSize = 4096) {
  if (!body || typeof body !== 'object') return body;
  try {
    const sanitized = {};
    for (const [key, value] of Object.entries(body)) {
      const lk = key.toLowerCase();
      if (SENSITIVE_FIELDS.some(f => lk.includes(f))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.slice(0, 500) + `... [truncated, ${value.length} chars]`;
      } else if (Array.isArray(value) && value.length > 20) {
        sanitized[key] = value.slice(0, 20).concat(`... [${value.length} items total]`);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeBody(value, maxSize);
      } else {
        sanitized[key] = value;
      }
    }
    const str = JSON.stringify(sanitized);
    if (str.length > maxSize) {
      return { _truncated: true, _size: str.length, _preview: str.slice(0, maxSize) };
    }
    return sanitized;
  } catch {
    return { _error: 'Could not serialize body' };
  }
}

function classifyAction(method, path) {
  for (const rule of ACTION_MAP) {
    if (rule.method === method && rule.pattern.test(path)) {
      return rule.action;
    }
  }
  const segments = path.replace(/^\/api\//, '').split('/');
  const base = segments[0] || 'unknown';
  return `${method.toLowerCase()}.${base}`;
}

function shouldLog(method, path) {
  if (path === '/api/health') return false;
  if (path.includes('/rbac/audit')) return false;
  if (path.includes('/api/auth/refresh')) return false;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;
  if (method === 'GET') {
    if (path.includes('/admin') || path.includes('/settings') || path.includes('/users')) return true;
    return false;
  }
  return true;
}

/**
 * Express middleware — intercepts response body and logs on finish.
 */
function activityLogger(req, res, next) {
  const startTime = Date.now();

  // Intercept res.json to capture response body
  const originalJson = res.json.bind(res);
  let capturedResponseBody = null;
  res.json = function (body) {
    capturedResponseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    try {
      const method = req.method;
      const path = req.originalUrl?.split('?')[0] || req.path;
      if (!shouldLog(method, path)) return;

      const statusCode = res.statusCode;
      const success = statusCode >= 200 && statusCode < 400;
      const userId = req.user?.email || req.user?.id || req.headers?.['x-user-id'] || 'anonymous';

      let effectiveUserId = userId;
      if (path === '/api/auth/login' && req.body?.email) {
        effectiveUserId = req.body.email;
      }

      const action = classifyAction(method, path);
      const workspaceId = req.tenantContext?.workspace_id
        || req.query?.workspaceId || req.query?.workspace_id || '';

      // Capture sanitized request body
      let requestBody = null;
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        requestBody = sanitizeBody(req.body);
      }

      // Capture sanitized response body
      let responseBody = null;
      if (capturedResponseBody && typeof capturedResponseBody === 'object') {
        responseBody = sanitizeBody(capturedResponseBody);
      }

      const durationMs = Date.now() - startTime;

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
        requestBody,
        responseBody,
        durationMs,
      });
    } catch {
      // Never break the response
    }
  });

  next();
}

module.exports = { activityLogger };
