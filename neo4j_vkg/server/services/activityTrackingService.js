/**
 * Activity Tracking Service
 * User interaction logging for personalization and relevance scoring
 * Enterprise-grade activity tracking comparable to Glean
 */

const { client, connectRedis } = require('../config/redis');
const neo4jService = require('./neo4jService');
const { v4: uuidv4 } = require('uuid');

class ActivityTrackingService {
  constructor() {
    this.ACTIVITY_PREFIX = 'activity:';
    this.USER_ACTIVITY_PREFIX = 'user_activity:';
    this.ENTITY_ACTIVITY_PREFIX = 'entity_activity:';
    this.POPULARITY_PREFIX = 'popularity:';
    
    this.activityTypes = {
      VIEW: 'view',
      SEARCH: 'search',
      CLICK: 'click',
      QUERY: 'query',
      EXPORT: 'export',
      EDIT: 'edit',
      CREATE: 'create',
      DELETE: 'delete',
      SHARE: 'share',
      BOOKMARK: 'bookmark'
    };

    this.decayFactor = 0.95; // Daily decay for popularity
    this.maxHistoryDays = 90;
  }

  /**
   * Record a user activity
   */
  async recordActivity(activity) {
    await connectRedis();
    
    const activityId = uuidv4();
    const timestamp = Date.now();
    
    const activityKey = `${this.ACTIVITY_PREFIX}${activityId}`;
    const userId = activity.userId || 'anonymous';
    const entityUri = activity.entityUri || '';
    const entityType = activity.entityType || '';
    const query = activity.query || '';
    const sessionId = activity.sessionId || '';
    const date = new Date(timestamp).toISOString().split('T')[0];
    
    // Store activity record using individual hSet calls
    await client.hSet(activityKey, 'activityId', activityId);
    await client.hSet(activityKey, 'userId', userId);
    await client.hSet(activityKey, 'type', activity.type || '');
    await client.hSet(activityKey, 'entityUri', entityUri);
    await client.hSet(activityKey, 'entityType', entityType);
    await client.hSet(activityKey, 'query', query);
    await client.hSet(activityKey, 'sessionId', sessionId);
    await client.hSet(activityKey, 'metadata', JSON.stringify(activity.metadata || {}));
    await client.hSet(activityKey, 'timestamp', String(timestamp));
    await client.hSet(activityKey, 'date', date);
    
    await client.expire(activityKey, this.maxHistoryDays * 24 * 60 * 60);

    // Add to user's activity list
    if (userId !== 'anonymous') {
      await client.lPush(`${this.USER_ACTIVITY_PREFIX}${userId}`, activityId);
      await client.lTrim(`${this.USER_ACTIVITY_PREFIX}${userId}`, 0, 999);
    }

    // Update entity popularity
    if (entityUri) {
      await this.updateEntityPopularity(entityUri, activity.type);
      await client.lPush(`${this.ENTITY_ACTIVITY_PREFIX}${entityUri}`, activityId);
      await client.lTrim(`${this.ENTITY_ACTIVITY_PREFIX}${entityUri}`, 0, 499);
    }

    // Update search/query analytics
    if (query) {
      await this.recordQueryAnalytics(query, userId);
    }

    return { activityId, timestamp };
  }

  /**
   * Update entity popularity score
   */
  async updateEntityPopularity(entityUri, activityType) {
    await connectRedis();
    
    // Different activity types have different weights
    const weights = {
      view: 1,
      click: 2,
      search: 1.5,
      query: 1.5,
      export: 3,
      edit: 4,
      share: 5,
      bookmark: 4
    };

    const weight = weights[activityType] || 1;
    const today = new Date().toISOString().split('T')[0];
    
    // Increment daily score
    await client.hIncrByFloat(`${this.POPULARITY_PREFIX}daily:${today}`, entityUri, weight);
    
    // Increment total score (with decay applied periodically)
    await client.hIncrByFloat(`${this.POPULARITY_PREFIX}total`, entityUri, weight);
  }

  /**
   * Record query analytics
   */
  async recordQueryAnalytics(query, userId) {
    await connectRedis();
    
    const normalizedQuery = query.toLowerCase().trim();
    const today = new Date().toISOString().split('T')[0];
    
    // Track query frequency
    await client.hIncrBy('query_frequency', normalizedQuery, 1);
    await client.hIncrBy(`query_frequency:${today}`, normalizedQuery, 1);
    
    // Track user's query history
    if (userId && userId !== 'anonymous') {
      await client.lPush(`user_queries:${userId}`, JSON.stringify({
        query: normalizedQuery,
        timestamp: Date.now()
      }));
      await client.lTrim(`user_queries:${userId}`, 0, 99);
    }
  }

  /**
   * Get user's recent activity
   */
  async getUserActivity(userId, limit = 50) {
    await connectRedis();
    
    const activityIds = await client.lRange(`${this.USER_ACTIVITY_PREFIX}${userId}`, 0, limit - 1);
    
    const activities = [];
    for (const id of activityIds) {
      const data = await client.hGetAll(`${this.ACTIVITY_PREFIX}${id}`);
      if (data && Object.keys(data).length > 0) {
        activities.push({
          ...data,
          metadata: JSON.parse(data.metadata || '{}'),
          timestamp: parseInt(data.timestamp, 10)
        });
      }
    }

    return activities;
  }

  /**
   * Get entity activity history
   */
  async getEntityActivity(entityUri, limit = 50) {
    await connectRedis();
    
    const activityIds = await client.lRange(`${this.ENTITY_ACTIVITY_PREFIX}${entityUri}`, 0, limit - 1);
    
    const activities = [];
    for (const id of activityIds) {
      const data = await client.hGetAll(`${this.ACTIVITY_PREFIX}${id}`);
      if (data && Object.keys(data).length > 0) {
        activities.push({
          ...data,
          metadata: JSON.parse(data.metadata || '{}'),
          timestamp: parseInt(data.timestamp, 10)
        });
      }
    }

    return activities;
  }

  /**
   * Get popularity scores for entities
   */
  async getPopularityScores(entityUris) {
    await connectRedis();
    
    const scores = {};
    for (const uri of entityUris) {
      const score = await client.hGet(`${this.POPULARITY_PREFIX}total`, uri);
      scores[uri] = parseFloat(score) || 0;
    }

    return scores;
  }

  /**
   * Get top popular entities
   */
  async getTopPopularEntities(limit = 20) {
    await connectRedis();
    
    const allScores = await client.hGetAll(`${this.POPULARITY_PREFIX}total`);
    
    const sorted = Object.entries(allScores)
      .map(([uri, score]) => ({ uri, score: parseFloat(score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sorted;
  }

  /**
   * Calculate personalized relevance boost for a user
   */
  async getPersonalizedBoosts(userId, entityUris) {
    await connectRedis();
    
    const boosts = {};
    const userActivity = await this.getUserActivity(userId, 100);
    
    // Count interactions per entity
    const interactionCounts = {};
    for (const activity of userActivity) {
      if (activity.entityUri) {
        interactionCounts[activity.entityUri] = (interactionCounts[activity.entityUri] || 0) + 1;
      }
    }

    // Calculate boost based on past interactions
    for (const uri of entityUris) {
      const interactions = interactionCounts[uri] || 0;
      // Logarithmic boost to prevent over-personalization
      boosts[uri] = interactions > 0 ? Math.log2(interactions + 1) * 0.1 : 0;
    }

    return boosts;
  }

  /**
   * Get user's frequently accessed entity types
   */
  async getUserPreferredTypes(userId) {
    const userActivity = await this.getUserActivity(userId, 200);
    
    const typeCounts = {};
    for (const activity of userActivity) {
      if (activity.entityType) {
        typeCounts[activity.entityType] = (typeCounts[activity.entityType] || 0) + 1;
      }
    }

    return Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  }

  /**
   * Get trending queries
   */
  async getTrendingQueries(limit = 10) {
    await connectRedis();
    
    const today = new Date().toISOString().split('T')[0];
    const todayQueries = await client.hGetAll(`query_frequency:${today}`);
    
    return Object.entries(todayQueries)
      .map(([query, count]) => ({ query, count: parseInt(count, 10) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Apply time decay to popularity scores (run daily)
   */
  async applyPopularityDecay() {
    await connectRedis();
    
    const allScores = await client.hGetAll(`${this.POPULARITY_PREFIX}total`);
    
    for (const [uri, score] of Object.entries(allScores)) {
      const decayedScore = parseFloat(score) * this.decayFactor;
      if (decayedScore < 0.01) {
        await client.hDel(`${this.POPULARITY_PREFIX}total`, uri);
      } else {
        await client.hSet(`${this.POPULARITY_PREFIX}total`, uri, decayedScore.toString());
      }
    }

    return { processed: Object.keys(allScores).length };
  }

  /**
   * Get activity analytics summary
   */
  async getAnalyticsSummary(days = 7) {
    await connectRedis();
    
    const summary = {
      totalActivities: 0,
      activitiesByType: {},
      activitiesByDay: {},
      topEntities: [],
      topQueries: []
    };

    // Get activities by day
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const dayScores = await client.hGetAll(`${this.POPULARITY_PREFIX}daily:${dateStr}`);
      const dayTotal = Object.values(dayScores).reduce((sum, s) => sum + parseFloat(s), 0);
      summary.activitiesByDay[dateStr] = dayTotal;
      summary.totalActivities += dayTotal;
    }

    // Get top entities
    summary.topEntities = await this.getTopPopularEntities(10);
    
    // Get top queries
    summary.topQueries = await this.getTrendingQueries(10);

    return summary;
  }
}

module.exports = new ActivityTrackingService();
