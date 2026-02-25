# Development Guidelines & Constraints

This document defines the mandatory constraints, patterns, and instructions that **MUST** be followed when updating any part of this Enterprise Knowledge Graph Platform.

## 🚨 **CRITICAL: API Endpoint Validation**

### **Mandatory Testing After Any Changes**
After making ANY changes to the codebase, you MUST verify all API endpoints are working:

```bash
# 1. Start the server
npm run server

# 2. In another terminal, test all endpoints
npm run test:api
```

**All endpoints must return status < 400 for the system to be considered functional.**

### **Before Committing Code**
```bash
# Complete validation checklist
npm run validate    # Project structure
npm run health     # Service connections  
npm run test:api   # All API endpoints
```

## 🏗️ Architecture Constraints

### Multi-Tenant Architecture
- **MANDATORY**: All data operations MUST respect tenant/workspace isolation
- **MANDATORY**: Use `tenantContext` middleware for all tenant-aware endpoints
- **MANDATORY**: Follow the graph naming pattern:
  - Global ontologies: `http://example.org/graphs/global/ontology/{ontologyId}`
  - Workspace data: `http://example.org/graphs/tenant/{tenant}/workspace/{workspace}/data`
  - Tenant customizations: `http://example.org/graphs/tenant/{tenant}/ontology/{custom}`

### Database Layer Separation
- **GraphDB**: Primary semantic store for RDF/OWL ontologies and SPARQL queries
- **Neo4j**: Graph analytics, visualization, and relationship traversal
- **Redis**: Vector embeddings, caching, and session storage
- **NEVER**: Mix concerns between databases - each has a specific purpose

### Service Layer Architecture
- **MANDATORY**: All business logic MUST be in service classes under `server/services/`
- **MANDATORY**: Routes MUST only handle HTTP concerns (validation, response formatting)
- **MANDATORY**: Services MUST be stateless and dependency-injectable
- **MANDATORY**: Use dependency injection pattern for database connections

## 📁 File Structure Constraints

### Server Structure
```
server/
├── config/           # Database configs, constants only
├── routes/           # HTTP route handlers only
├── services/         # ALL business logic here
├── middleware/       # Request/response processing
├── models/           # Data models and schemas
├── workers/          # Background job processors
└── utils/            # Shared utilities
```

### Client Structure
```
client/src/
├── components/       # React components
├── contexts/         # React contexts (TenantContext)
├── hooks/            # Custom React hooks
└── App.js            # Main application
```

### Naming Conventions
- **Services**: `{domain}Service.js` (e.g., `ontologyService.js`)
- **Routes**: `{domain}.js` (e.g., `ontology.js`)
- **Components**: `PascalCase.js` (e.g., `OntologyManager.js`)
- **Constants**: `UPPER_SNAKE_CASE`
- **Variables**: `camelCase`

## 🔒 Security Constraints

### Tenant Isolation
- **MANDATORY**: Every API endpoint MUST validate tenant/workspace access
- **MANDATORY**: Use `requireTenantContext` middleware for protected endpoints
- **MANDATORY**: Never expose cross-tenant data without explicit ACL checks
- **MANDATORY**: Validate tenant ownership before any data operations

### Input Validation
- **MANDATORY**: Validate all inputs at route level before passing to services
- **MANDATORY**: Use proper HTTP status codes (see Error Handling section)
- **MANDATORY**: Sanitize file uploads and limit file sizes per `constants.js`
- **MANDATORY**: Validate SPARQL queries to prevent injection attacks

### Error Handling
- **MANDATORY**: Use custom error classes from `middleware/errorHandler.js`:
  - `ValidationError` (400) - Invalid input
  - `NotFoundError` (404) - Resource not found
  - `UnauthorizedError` (401) - Authentication required
  - `ForbiddenError` (403) - Access denied
  - `ConflictError` (409) - Resource conflict
  - `ServiceUnavailableError` (503) - External service down

## 🗄️ Database Interaction Patterns

### GraphDB Operations
- **MANDATORY**: Use `graphDBStore.js` for all RDF/SPARQL operations
- **MANDATORY**: Always specify named graphs for multi-tenant isolation
- **MANDATORY**: Use parameterized SPARQL queries to prevent injection
- **MANDATORY**: Handle GraphDB connection failures gracefully

```javascript
// ✅ CORRECT
const graphIRI = graphDBStore.getWorkspaceDataGraphIRI(tenantId, workspaceId);
const query = `
  INSERT DATA {
    GRAPH <${graphIRI}> {
      ?entity a ?type .
    }
  }
`;

// ❌ WRONG - No graph isolation
const query = `INSERT DATA { ?entity a ?type }`;
```

### Neo4j Operations
- **MANDATORY**: Use `neo4jService.js` for all graph analytics
- **MANDATORY**: Always include tenant/workspace labels on nodes
- **MANDATORY**: Use transactions for multi-step operations
- **MANDATORY**: Close sessions properly to prevent connection leaks

```javascript
// ✅ CORRECT
const session = driver.session();
try {
  await session.run(
    'CREATE (n:Entity:Tenant {tenantId: $tenantId, workspaceId: $workspaceId})',
    { tenantId, workspaceId }
  );
} finally {
  await session.close();
}
```

### Redis Operations
- **MANDATORY**: Use tenant-prefixed keys: `tenant:{tenantId}:workspace:{workspaceId}:{key}`
- **MANDATORY**: Set appropriate TTL for cached data
- **MANDATORY**: Handle Redis unavailability gracefully (degrade, don't fail)

## 🔄 API Design Patterns

### Request/Response Format
- **MANDATORY**: All API responses MUST follow this structure:
```javascript
// Success Response
{
  "success": true,
  "data": {...},
  "message": "Optional success message"
}

// Error Response
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "details": {...} // Optional additional details
}
```

### Pagination
- **MANDATORY**: Use constants from `config/constants.js` for pagination limits
- **MANDATORY**: Always provide pagination metadata:
```javascript
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

### Tenant Context Headers
- **MANDATORY**: Support tenant context via multiple methods:
  - Headers: `X-Tenant-Id`, `X-Workspace-Id`
  - Query params: `tenant_id`, `workspace_id`
  - Request body: `tenant_id`, `workspace_id`

## 🎯 Service Implementation Patterns

### Service Class Structure
```javascript
class ExampleService {
  constructor(dependencies = {}) {
    this.graphDBStore = dependencies.graphDBStore || require('./graphDBStore');
    this.neo4jService = dependencies.neo4jService || require('./neo4jService');
    // Dependency injection for testability
  }

  async methodName(tenantId, workspaceId, params) {
    // 1. Validate inputs
    if (!tenantId || !workspaceId) {
      throw new ValidationError('Tenant and workspace required');
    }

    // 2. Business logic
    try {
      // Implementation
    } catch (error) {
      logger.error('Service operation failed:', error);
      throw new ServiceUnavailableError('Operation failed');
    }
  }
}
```

### Logging Requirements
- **MANDATORY**: Use `utils/logger.js` for all logging
- **MANDATORY**: Log levels: `error`, `warn`, `info`, `debug`
- **MANDATORY**: Include tenant/workspace context in logs
- **MANDATORY**: Log service entry/exit points for debugging

```javascript
logger.info(`🔍 Starting entity extraction for tenant:${tenantId}, workspace:${workspaceId}`);
logger.error('❌ GraphDB connection failed:', error);
```

## 🧪 Testing Constraints

### Test File Organization
- **MANDATORY**: Place tests adjacent to source files with `.test.js` suffix
- **MANDATORY**: Use dependency injection for mocking external services
- **MANDATORY**: Test both success and error scenarios
- **MANDATORY**: Include tenant isolation tests for multi-tenant features

### Test Data
- **MANDATORY**: Use test-specific tenant/workspace IDs (e.g., `test-tenant`, `test-workspace`)
- **MANDATORY**: Clean up test data after each test
- **MANDATORY**: Never use production tenant/workspace IDs in tests

## 🚀 Deployment Constraints

### Environment Variables
- **MANDATORY**: All configuration MUST be via environment variables
- **MANDATORY**: Provide sensible defaults in code
- **MANDATORY**: Document all environment variables in `.env.template`
- **MANDATORY**: Never commit actual `.env` files

### Service Dependencies
- **MANDATORY**: Services MUST start in this order:
  1. GraphDB
  2. Neo4j  
  3. Redis
  4. Backend server
  5. Frontend client
  6. Background workers

### Health Checks
- **MANDATORY**: All services MUST implement health check endpoints
- **MANDATORY**: Health checks MUST verify database connectivity
- **MANDATORY**: Use circuit breaker pattern for external service calls

## 📦 Package Management

### Dependencies
- **MANDATORY**: Pin exact versions in `package-lock.json`
- **MANDATORY**: Audit dependencies regularly for security vulnerabilities
- **MANDATORY**: Document why each dependency is needed
- **MANDATORY**: Prefer established, well-maintained packages

### Scripts
- **MANDATORY**: Use npm scripts for all common operations:
  - `npm run dev` - Start all services
  - `npm run server` - Backend only
  - `npm run client` - Frontend only
  - `npm run workers` - Background workers only
  - `npm run test` - Run tests
  - `npm run migrate` - Database migrations

## 🔧 Development Workflow

### Code Changes
1. **MANDATORY**: Update this guidelines document if adding new patterns
2. **MANDATORY**: Follow existing code style and patterns
3. **MANDATORY**: Add appropriate logging and error handling
4. **MANDATORY**: Test tenant isolation for multi-tenant features
5. **MANDATORY**: Update API documentation if changing endpoints

### Database Schema Changes
1. **MANDATORY**: Create migration scripts in `scripts/` directory
2. **MANDATORY**: Test migrations on sample data
3. **MANDATORY**: Provide rollback procedures
4. **MANDATORY**: Document schema changes in relevant `.md` files

### Breaking Changes
- **MANDATORY**: Version API endpoints if making breaking changes
- **MANDATORY**: Maintain backward compatibility for at least one version
- **MANDATORY**: Update client code to handle new API versions
- **MANDATORY**: Document migration path for existing data

## 🚫 Prohibited Practices

### Never Do These
- ❌ **NEVER** bypass tenant isolation checks
- ❌ **NEVER** hardcode database connection strings
- ❌ **NEVER** expose internal error details to clients
- ❌ **NEVER** use synchronous file operations in request handlers
- ❌ **NEVER** store sensitive data in logs
- ❌ **NEVER** commit credentials or API keys
- ❌ **NEVER** modify global ontologies without proper versioning
- ❌ **NEVER** perform cross-tenant operations without ACL validation

### Code Smells to Avoid
- ❌ Large service methods (>100 lines)
- ❌ Deep nesting (>3 levels)
- ❌ Magic numbers (use constants)
- ❌ Callback hell (use async/await)
- ❌ Tight coupling between services
- ❌ Missing error handling
- ❌ Inconsistent naming conventions

## 📋 Checklist for New Features

Before implementing any new feature, ensure:

- [ ] Multi-tenant isolation is properly implemented
- [ ] Appropriate error handling and logging is added
- [ ] Input validation is implemented at route level
- [ ] Service layer follows dependency injection pattern
- [ ] Database operations use proper connection management
- [ ] API follows standard request/response format
- [ ] Tests cover both success and error scenarios
- [ ] Documentation is updated (README, API docs, this file)
- [ ] Environment variables are documented
- [ ] Migration scripts are provided if needed

## 🔄 Maintenance Guidelines

### Regular Tasks
- **Weekly**: Review and update dependencies
- **Monthly**: Audit security vulnerabilities
- **Quarterly**: Review and optimize database performance
- **Annually**: Review and update this guidelines document

### Monitoring
- **MANDATORY**: Monitor GraphDB, Neo4j, and Redis health
- **MANDATORY**: Track API response times and error rates
- **MANDATORY**: Monitor tenant data isolation integrity
- **MANDATORY**: Alert on service failures and connection issues

---

**Remember**: These guidelines exist to maintain code quality, security, and system reliability. When in doubt, follow existing patterns and ask for clarification rather than inventing new approaches.
