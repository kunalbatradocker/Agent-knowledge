/**
 * Activity Audit Service
 *
 * Redis-backed activity logger with 7-day retention.
 * Uses a sorted set (score = timestamp) for efficient range queries and cleanup.
 *
 * Redis key: audit:activity (sorted set)
 * Each member: JSON string of activity entry
 * Score: Unix timestamp (ms)
 */

const { client: redis } = require('../config/redis');

const AUDIT_KEY = 'audit:activity';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class ActivityAuditService {
  /**
   * Log an activity entry.
   * @param {Object} entry
   * @param {string} entry.userId - User email or ID
   * @param {string} entry.action - e.g. 'auth.login', 'document.upload'
   * @param {string} [entry.resource] - e.g. '/api/chat/message'
   * @param {string} [entry.method] - HTTP method
   * @param {number} [entry.statusCode] - HTTP response status
   * @param {boolean} [entry.success] - true if 2xx/3xx
   * @param {string} [entry.ip] - Client IP
   * @param {string} [entry.workspaceId] - Workspace context
   * @param {string} [entry.details] - Extra info
   * @param {Object} [entry.requestBody] - Sanitized request body
   * @param {Object} [entry.responseBody] - Sanitized response body
   * @param {number} [entry.durationMs] - Request duration in ms
   */
  async logActivity(entry) {
    try {
      if (!redis.isOpen) return;

      const now = Date.now();
      const record = {
        timestamp: new Date(now).toISOString(),
        userId: entry.userId || 'anonymous',
        action: entry.action || 'unknown',
        resource: entry.resource || '',
        method: entry.method || '',
        statusCode: entry.statusCode || 0,
        success: entry.success !== undefined ? entry.success : true,
        ip: entry.ip || '',
        workspaceId: entry.workspaceId || '',
        details: entry.details || '',
        requestBody: entry.requestBody || null,
        responseBody: entry.responseBody || null,
        durationMs: entry.durationMs || 0,
      };

      // Add to sorted set with timestamp as score
      // Append a random suffix to avoid duplicate member collisions
      const member = JSON.stringify(record) + '::' + now + ':' + Math.random().toString(36).slice(2, 8);
      await redis.zAdd(AUDIT_KEY, { score: now, value: member });

      // Periodic cleanup: ~1% of writes trigger cleanup
      if (Math.random() < 0.01) {
        this.cleanup().catch(() => {});
      }
    } catch (err) {
      // Never let audit logging break the request
      console.warn('Audit log write failed:', err.message);
    }
  }

  /**
   * Get activity log entries.
   * @param {number} [limit=50] - Max entries to return
   * @param {number} [offset=0] - Offset for pagination
   * @returns {Array} Activity entries (newest first)
   */
  async getActivityLog(limit = 50, offset = 0) {
    try {
      if (!redis.isOpen) return [];

      // Get entries in reverse order (newest first)
      const entries = await redis.zRange(AUDIT_KEY, '+inf', '-inf', {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset, count: limit },
      });

      return entries.map(raw => {
        try {
          // Strip the random suffix we appended
          const jsonStr = raw.replace(/::[\d]+:[a-z0-9]+$/, '');
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (err) {
      console.warn('Audit log read failed:', err.message);
      return [];
    }
  }

  /**
   * Remove entries older than 7 days.
   */
  async cleanup() {
    try {
      if (!redis.isOpen) return 0;
      const cutoff = Date.now() - RETENTION_MS;
      const removed = await redis.zRemRangeByScore(AUDIT_KEY, '-inf', cutoff);
      if (removed > 0) {
        console.log(`🧹 Audit cleanup: removed ${removed} entries older than 7 days`);
      }
      return removed;
    } catch (err) {
      console.warn('Audit cleanup failed:', err.message);
      return 0;
    }
  }
}

module.exports = new ActivityAuditService();
