/**
 * Commit Helper
 * Re-exports processCommitInBackground from documents.js
 * Used by the BullMQ commit worker to avoid circular dependency issues.
 */

const { processCommitInBackground } = require('./documents');

module.exports = { processCommitInBackground };
