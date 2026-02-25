/**
 * API Rate Limiter Middleware
 * Uses Redis sliding window for distributed rate limiting.
 * Separate limits for general API calls vs auth endpoints.
 */

const { client, connectRedis } = require('../config/redis');

/**
 * Create a rate limiter middleware.
 * @param {object} opts
 * @param {number} opts.windowMs  - Time window in milliseconds (default: 60000 = 1 min)
 * @param {number} opts.max       - Max requests per window (default: 200)
 * @param {string} opts.prefix    - Redis key prefix (default: 'rl:api')
 * @param {string} opts.message   - Error message on limit exceeded
 */
function createRateLimiter({ windowMs = 60000, max = 200, prefix = 'rl:api', message = 'Too many requests, please try again later' } = {}) {
  return async (req, res, next) => {
    try {
      await connectRedis();
      // Key by IP + user ID (if authenticated)
      const userId = req.user?.id || req.ip;
      const key = `${prefix}:${userId}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Use Redis sorted set: score = timestamp, member = unique request ID
      await client.zRemRangeByScore(key, '-inf', windowStart);
      const count = await client.zCard(key);

      if (count >= max) {
        res.set('Retry-After', Math.ceil(windowMs / 1000));
        return res.status(429).json({ error: message });
      }

      await client.zAdd(key, { score: now, value: `${now}:${Math.random().toString(36).slice(2, 8)}` });
      await client.expire(key, Math.ceil(windowMs / 1000) + 1);

      // Set rate limit headers
      res.set('X-RateLimit-Limit', max);
      res.set('X-RateLimit-Remaining', Math.max(0, max - count - 1));

      next();
    } catch (err) {
      // If Redis is down, allow the request (fail open)
      console.warn('Rate limiter error (allowing request):', err.message);
      next();
    }
  };
}

// Pre-configured limiters
const apiLimiter = createRateLimiter({ windowMs: 60000, max: 200, prefix: 'rl:api' });
const uploadLimiter = createRateLimiter({ windowMs: 60000, max: 20, prefix: 'rl:upload', message: 'Upload rate limit exceeded' });
const queryLimiter = createRateLimiter({ windowMs: 60000, max: 60, prefix: 'rl:query', message: 'Query rate limit exceeded' });

module.exports = { createRateLimiter, apiLimiter, uploadLimiter, queryLimiter };
