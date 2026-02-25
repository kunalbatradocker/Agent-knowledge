/**
 * Auth Routes - Login, refresh, user management
 * Security: rate limiting, account lockout, password complexity, refresh token rotation
 */
const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Public: login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const result = await authService.authenticate(email, password, ip);
    if (!result) return res.status(401).json({ error: 'Invalid credentials' });

    res.json(result);
  } catch (error) {
    if (error.statusCode === 429) {
      res.set('Retry-After', String(error.retryAfter || 900));
      return res.status(429).json({ error: error.message });
    }
    if (error.statusCode === 423) {
      return res.status(423).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Public: refresh token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const result = await authService.rotateRefreshToken(refreshToken);
    if (!result) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public: logout (revoke refresh token)
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    // Best-effort revoke — always return success
    if (refreshToken) {
      const { client } = require('../config/redis');
      const key = `auth:refresh:${refreshToken}`;
      const email = await client.get(key);
      if (email) {
        await client.del(key);
        await client.sRem(`auth:refreshset:${email}`, refreshToken);
      }
    }
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await authService.getUser(req.user.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Include resolved permissions so frontend can show/hide UI elements
    const { getPermissionsForRole } = require('../config/roles');
    user.permissions = getPermissionsForRole(user.role);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change own password
router.put('/me/password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const errors = authService.validatePasswordComplexity(password);
    if (errors.length > 0) {
      return res.status(400).json({ error: `Password must contain: ${errors.join(', ')}` });
    }
    const user = await authService.updateUser(req.user.email, { password });
    // Revoke all refresh tokens so user must re-login with new password
    await authService.revokeAllRefreshTokens(req.user.email);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: list users
router.get('/users', requireAdmin, async (_req, res) => {
  try {
    res.json(await authService.listUsers());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: create user
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, name, role, workspaces } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await authService.createUser(email, password, name || email.split('@')[0], role, false, workspaces || []);
    res.status(201).json(user);
  } catch (error) {
    if (error.message.includes('already exists')) return res.status(409).json({ error: error.message });
    if (error.message.includes('Password must')) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Admin: update user
router.put('/users/:email', requireAdmin, async (req, res) => {
  try {
    const { name, role, password, workspaces } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (role !== undefined) updates.role = role;
    if (password) updates.password = password;
    if (workspaces !== undefined) updates.workspaces = workspaces;
    const user = await authService.updateUser(req.params.email, updates);
    res.json(user);
  } catch (error) {
    if (error.message.includes('not found')) return res.status(404).json({ error: error.message });
    if (error.message.includes('Password must')) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete user
router.delete('/users/:email', requireAdmin, async (req, res) => {
  try {
    await authService.deleteUser(req.params.email);
    res.json({ success: true });
  } catch (error) {
    res.status(error.message.includes('master admin') ? 403 : 500).json({ error: error.message });
  }
});

// ============================================================
// Per-User LLM Token Management (accessible to all authenticated users)
// ============================================================

/**
 * GET /api/auth/llm-token/status
 * Get LLM token status for the current user (+ server token info)
 */
router.get('/llm-token/status', requireAuth, async (req, res) => {
  try {
    const llmService = require('../services/llmService');
    const tokenStore = require('../utils/tokenEncryption');
    const serverToken = llmService.bedrockApiKey;
    const serverInfo = llmService.constructor.parseTokenExpiry(serverToken);

    const userId = req.user.email || req.user.id || 'default';
    let userInfo = null;
    try {
      const userToken = await tokenStore.getToken(userId);
      if (userToken) {
        userInfo = llmService.constructor.parseTokenExpiry(userToken);
        userInfo.hasToken = true;
      }
    } catch (e) { /* Redis unavailable */ }

    res.json({
      provider: llmService.provider,
      model: llmService.model,
      server: {
        hasToken: !!serverToken,
        expired: serverInfo.expired,
        remainingSeconds: serverInfo.remainingSeconds
      },
      user: userInfo || { hasToken: false }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/llm-token
 * Save a per-user Bedrock bearer token (encrypted at rest in Redis)
 */
router.post('/llm-token', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const llmService = require('../services/llmService');
    const tokenStore = require('../utils/tokenEncryption');
    const info = llmService.constructor.parseTokenExpiry(token);

    const userId = req.user.email || req.user.id || 'default';
    const ttl = info.remainingSeconds && info.remainingSeconds > 0 ? info.remainingSeconds : 43200;
    await tokenStore.storeToken(userId, token, ttl);
    console.log(`🔑 [Auth] Stored Bedrock token for userId="${userId}" (email=${req.user.email}, id=${req.user.id}) TTL=${ttl}s`);

    // Always update the in-memory server token so it's immediately available
    // (covers the case where AsyncLocalStorage context is lost)
    llmService.setBedrockToken(token);

    res.json({
      success: true,
      tokenInfo: info,
      message: info.expired
        ? 'Token stored but appears expired'
        : `Token stored, expires in ${Math.floor((info.remainingSeconds || 0) / 3600)}h ${Math.floor(((info.remainingSeconds || 0) % 3600) / 60)}m`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/auth/llm-token
 * Remove the current user's Bedrock token
 */
router.delete('/llm-token', requireAuth, async (req, res) => {
  try {
    const userId = req.user.email || req.user.id || 'default';
    const tokenStore = require('../utils/tokenEncryption');
    await tokenStore.deleteToken(userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
