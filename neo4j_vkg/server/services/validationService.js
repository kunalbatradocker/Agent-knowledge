/**
 * Validation Service
 * Centralized validation logic for entities, ontologies, and other data structures
 */

const { ValidationError } = require('../middleware/errorHandler');

/**
 * Validate required fields exist and are non-empty
 * @param {Object} data - Data object to validate
 * @param {string[]} requiredFields - Array of required field names
 * @throws {ValidationError} If any required field is missing
 */
function validateRequired(data, requiredFields) {
  const missing = requiredFields.filter(field => {
    const value = data[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields: ${missing.join(', ')}`,
      { missingFields: missing }
    );
  }
}

/**
 * Validate tenant context
 * @param {Object} context - Tenant context object
 * @param {Object} options - Validation options
 * @param {boolean} options.requireTenant - Whether tenant_id is required
 * @param {boolean} options.requireWorkspace - Whether workspace_id is required
 * @throws {ValidationError} If required context is missing
 */
function validateTenantContext(context, options = {}) {
  const { requireTenant = true, requireWorkspace = true } = options;

  if (requireTenant && !context?.tenant_id) {
    throw new ValidationError('Tenant context required', {
      message: 'Please provide tenant_id via X-Tenant-Id header, query param, or request body'
    });
  }

  if (requireWorkspace && !context?.workspace_id) {
    throw new ValidationError('Workspace context required', {
      message: 'Please provide workspace_id via X-Workspace-Id header, query param, or request body'
    });
  }
}

/**
 * Validate entity data
 * @param {Object} entity - Entity data to validate
 * @throws {ValidationError} If entity data is invalid
 */
function validateEntity(entity) {
  validateRequired(entity, ['label', 'type']);

  if (typeof entity.label !== 'string' || entity.label.trim().length === 0) {
    throw new ValidationError('Entity label must be a non-empty string');
  }

  if (typeof entity.type !== 'string' || entity.type.trim().length === 0) {
    throw new ValidationError('Entity type must be a non-empty string');
  }

  if (entity.confidence !== undefined) {
    const conf = parseFloat(entity.confidence);
    if (isNaN(conf) || conf < 0 || conf > 1) {
      throw new ValidationError('Entity confidence must be a number between 0 and 1');
    }
  }
}

/**
 * Validate relationship data
 * @param {Object} relationship - Relationship data to validate
 * @throws {ValidationError} If relationship data is invalid
 */
function validateRelationship(relationship) {
  validateRequired(relationship, ['sourceId', 'targetId', 'predicate']);

  if (relationship.sourceId === relationship.targetId) {
    throw new ValidationError('Relationship source and target cannot be the same entity');
  }
}

/**
 * Validate ontology class definition
 * @param {Object} classDef - Class definition to validate
 * @throws {ValidationError} If class definition is invalid
 */
function validateOntologyClass(classDef) {
  validateRequired(classDef, ['name']);

  if (!/^[A-Z][a-zA-Z0-9_]*$/.test(classDef.name)) {
    throw new ValidationError(
      'Class name must start with uppercase letter and contain only alphanumeric characters and underscores'
    );
  }

  if (classDef.attributes && !Array.isArray(classDef.attributes)) {
    throw new ValidationError('Class attributes must be an array');
  }
}

/**
 * Validate ontology relationship definition
 * @param {Object} relDef - Relationship definition to validate
 * @throws {ValidationError} If relationship definition is invalid
 */
function validateOntologyRelationship(relDef) {
  validateRequired(relDef, ['type', 'from_class', 'to_class']);

  if (!/^[A-Z_]+$/.test(relDef.type)) {
    throw new ValidationError(
      'Relationship type must be uppercase with underscores only (e.g., WORKS_FOR)'
    );
  }
}

/**
 * Validate pagination parameters
 * @param {Object} params - Pagination parameters
 * @param {Object} limits - Limit configuration
 * @returns {Object} Validated and normalized pagination params
 */
function validatePagination(params, limits = {}) {
  const { maxLimit = 100, defaultLimit = 50 } = limits;

  let limit = parseInt(params.limit, 10);
  if (isNaN(limit) || limit < 1) {
    limit = defaultLimit;
  } else if (limit > maxLimit) {
    limit = maxLimit;
  }

  let offset = parseInt(params.offset, 10);
  if (isNaN(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset, cursor: params.cursor || null };
}

/**
 * Validate UUID format
 * @param {string} id - ID to validate
 * @param {string} fieldName - Name of the field for error message
 * @throws {ValidationError} If ID is not a valid UUID
 */
function validateUUID(id, fieldName = 'id') {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  
  if (!id || !uuidRegex.test(id)) {
    throw new ValidationError(`Invalid ${fieldName}: must be a valid UUID`);
  }
}

/**
 * Validate file upload
 * @param {Object} file - Multer file object
 * @param {Object} options - Validation options
 * @throws {ValidationError} If file is invalid
 */
function validateFileUpload(file, options = {}) {
  const { 
    required = true, 
    allowedExtensions = ['.pdf', '.docx', '.doc', '.txt', '.html', '.md'],
    maxSize = 50 * 1024 * 1024 // 50MB
  } = options;

  if (!file) {
    if (required) {
      throw new ValidationError('No file uploaded');
    }
    return;
  }

  const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!allowedExtensions.includes(ext)) {
    throw new ValidationError(
      `Invalid file type. Allowed types: ${allowedExtensions.join(', ')}`
    );
  }

  if (file.size > maxSize) {
    throw new ValidationError(
      `File too large. Maximum size: ${Math.round(maxSize / 1024 / 1024)}MB`
    );
  }
}

/**
 * Sanitize string for use as Neo4j label
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized label
 */
function sanitizeLabel(str) {
  if (!str) return 'Concept';
  // Convert "Payment Method" to "PaymentMethod"
  return str.split(/\s+/).map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join('');
}

/**
 * Sanitize user input to prevent XSS
 * @param {string} input - User input to sanitize
 * @returns {string} Sanitized input
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

module.exports = {
  validateRequired,
  validateTenantContext,
  validateEntity,
  validateRelationship,
  validateOntologyClass,
  validateOntologyRelationship,
  validatePagination,
  validateUUID,
  validateFileUpload,
  sanitizeLabel,
  sanitizeInput
};
