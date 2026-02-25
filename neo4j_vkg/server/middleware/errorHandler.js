/**
 * Unified Error Handling Middleware
 * Provides consistent error responses across all API endpoints
 */

// Custom error classes for different error types
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

/**
 * Async handler wrapper to catch errors in async route handlers
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped handler with error catching
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Format error response consistently
 * @param {Error} err - Error object
 * @param {boolean} includeStack - Whether to include stack trace
 * @returns {Object} Formatted error response
 */
function formatErrorResponse(err, includeStack = false) {
  const response = {
    success: false,
    error: err.message || 'An unexpected error occurred',
    code: err.code || 'INTERNAL_ERROR'
  };

  if (err.details) {
    response.details = err.details;
  }

  if (includeStack && err.stack) {
    response.stack = err.stack;
  }

  return response;
}

/**
 * Main error handling middleware
 * Place at the end of middleware chain
 */
function errorHandler(err, req, res, _next) {
  // Log error
  console.error(`[${req.method} ${req.path}] Error:`, err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // Determine status code
  let statusCode = err.statusCode || 500;

  // Handle specific error types
  if (err.code === 'ServiceUnavailable' || err.message?.includes('connect')) {
    statusCode = 503;
    err.message = 'Database unavailable. Please ensure services are running.';
    err.code = 'SERVICE_UNAVAILABLE';
  }

  // Handle Neo4j specific errors
  if (err.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
    statusCode = 409;
    err.code = 'CONFLICT';
  }

  const response = formatErrorResponse(
    err,
    process.env.NODE_ENV === 'development'
  );

  res.status(statusCode).json(response);
}

/**
 * 404 handler for unmatched routes
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
    code: 'NOT_FOUND'
  });
}

module.exports = {
  // Error classes
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  // Middleware
  asyncHandler,
  errorHandler,
  notFoundHandler,
  formatErrorResponse
};
