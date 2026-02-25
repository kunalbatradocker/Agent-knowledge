/**
 * Tenant Context Middleware
 * Extracts and validates tenant/workspace context from requests
 * Enforces multi-tenant isolation for API operations
 */

const tenantService = require('../services/tenantService');

/**
 * Extract tenant context from request
 * Looks in: headers, query params, body
 */
function extractTenantContext(req) {
  return {
    tenant_id: req.headers['x-tenant-id'] || 
               req.query.tenant_id || 
               req.body?.tenant_id || 
               null,
    workspace_id: req.headers['x-workspace-id'] || 
                  req.query.workspace_id || 
                  req.body?.workspace_id || 
                  null
  };
}

/**
 * Middleware: Require tenant context
 * Use for endpoints that MUST have tenant/workspace specified
 */
function requireTenantContext(req, res, next) {
  const context = extractTenantContext(req);
  
  if (!context.tenant_id) {
    return res.status(400).json({
      error: 'Tenant context required',
      message: 'Please provide tenant_id via X-Tenant-Id header, query param, or request body'
    });
  }
  
  if (!context.workspace_id) {
    return res.status(400).json({
      error: 'Workspace context required',
      message: 'Please provide workspace_id via X-Workspace-Id header, query param, or request body'
    });
  }
  
  // Attach to request for downstream use
  req.tenantContext = context;
  next();
}

/**
 * Middleware: Optional tenant context
 * Extracts context if provided, but doesn't require it
 * Use for endpoints that can work with or without tenant scoping
 */
function optionalTenantContext(req, _res, next) {
  const context = extractTenantContext(req);
  req.tenantContext = context;
  next();
}

/**
 * Middleware: Validate workspace belongs to tenant
 * Use after requireTenantContext for additional validation
 */
async function validateWorkspaceAccess(req, res, next) {
  const { tenant_id, workspace_id } = req.tenantContext || {};
  
  if (!tenant_id || !workspace_id) {
    return next(); // Skip validation if context not set
  }
  
  try {
    const isValid = await tenantService.validateWorkspaceAccess(tenant_id, workspace_id);
    
    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Workspace does not belong to the specified tenant'
      });
    }
    
    next();
  } catch (error) {
    console.error('Workspace validation error:', error);
    res.status(500).json({ success: false, error: 'Failed to validate workspace access' });
  }
}

/**
 * Middleware: Use default tenant/workspace if not specified
 * Useful for backward compatibility during migration
 */
async function useDefaultTenantIfMissing(req, _res, next) {
  const context = extractTenantContext(req);
  
  if (!context.tenant_id || !context.workspace_id) {
    try {
      const { tenant, workspace } = await tenantService.getOrCreateDefaultTenantWorkspace();
      
      req.tenantContext = {
        tenant_id: context.tenant_id || tenant.tenant_id,
        workspace_id: context.workspace_id || workspace.workspace_id,
        isDefault: !context.tenant_id || !context.workspace_id
      };
      
      // Log when using defaults (for debugging during migration)
      if (req.tenantContext.isDefault) {
        console.log(`   ℹ️  Using default tenant/workspace for request: ${req.method} ${req.path}`);
      }
    } catch (error) {
      console.error('Error getting default tenant/workspace:', error);
      // Continue without context - let individual endpoints handle it
      req.tenantContext = context;
    }
  } else {
    req.tenantContext = context;
  }
  
  next();
}

/**
 * Helper: Build Cypher WHERE clause for tenant/workspace filtering
 * @param {Object} context - Tenant context from request
 * @param {string} nodeAlias - The alias used for the node in the query (e.g., 'd' for Document)
 * @returns {Object} { whereClause: string, params: object }
 */
function buildTenantFilter(context, nodeAlias = 'n') {
  const conditions = [];
  const params = {};
  
  if (context?.tenant_id) {
    conditions.push(`${nodeAlias}.tenant_id = $tenant_id`);
    params.tenant_id = context.tenant_id;
  }
  
  if (context?.workspace_id) {
    conditions.push(`${nodeAlias}.workspace_id = $workspace_id`);
    params.workspace_id = context.workspace_id;
  }
  
  return {
    whereClause: conditions.length > 0 ? conditions.join(' AND ') : '',
    params
  };
}

/**
 * Helper: Build Cypher MATCH clause for workspace-scoped queries
 * Uses relationship-based filtering (preferred for new queries)
 * @param {Object} context - Tenant context from request
 * @returns {Object} { matchClause: string, params: object }
 */
function buildWorkspaceScopeMatch(context) {
  if (!context?.workspace_id) {
    return { matchClause: '', params: {} };
  }
  
  return {
    matchClause: `
      MATCH (w:Workspace {workspace_id: $workspace_id})
      MATCH (t:Tenant)-[:OWNS]->(w)
    `,
    params: {
      workspace_id: context.workspace_id
    }
  };
}

module.exports = {
  extractTenantContext,
  requireTenantContext,
  optionalTenantContext,
  validateWorkspaceAccess,
  useDefaultTenantIfMissing,
  buildTenantFilter,
  buildWorkspaceScopeMatch
};
