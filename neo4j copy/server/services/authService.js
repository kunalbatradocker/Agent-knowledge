/**
 * Auth Service - User management in Redis
 * Keys: user:{email} = JSON { email, name, passwordHash, role, createdAt }
 * Index: user_emails (SET of all emails)
 * 
 * Security features:
 * - Password complexity validation
 * - Account lockout after failed attempts
 * - Refresh token rotation
 * - Secure JWT secret enforcement
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { client } = require('../config/redis');

// --- JWT Config ---
const DEFAULT_SECRET = 'kg-platform-secret-change-me';
let JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

// Warn loudly and generate a random secret if the default is still in use
if (JWT_SECRET === DEFAULT_SECRET || JWT_SECRET === 'change-this-to-a-random-string') {
  JWT_SECRET = crypto.randomBytes(48).toString('base64url');
  console.warn('⚠️  JWT_SECRET is not set or uses the insecure default.');
  console.warn('   A random secret was generated for this session.');
  console.warn('   Set JWT_SECRET in your .env for persistent sessions across restarts.');
}

const JWT_EXPIRY = process.env.JWT_EXPIRY || '15m';           // short-lived access token
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
const MASTER_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@admin.com';
const MASTER_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- Account lockout config ---
const MAX_FAILED_ATTEMPTS = parseInt(process.env.MAX_FAILED_ATTEMPTS, 10) || 5;
const LOCKOUT_DURATION_SECONDS = parseInt(process.env.LOCKOUT_DURATION_SECONDS, 10) || 900; // 15 min

// --- Rate limiting config ---
const LOGIN_RATE_LIMIT_WINDOW = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW, 10) || 900; // 15 min
const LOGIN_RATE_LIMIT_MAX = parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 15;        // per IP

// --- Redis key helpers ---
function userKey(email) { return `user:${email.toLowerCase()}`; }
function failedAttemptsKey(email) { return `auth:failed:${email.toLowerCase()}`; }
function lockoutKey(email) { return `auth:lockout:${email.toLowerCase()}`; }
function refreshTokenKey(token) { return `auth:refresh:${token}`; }
function userRefreshSetKey(email) { return `auth:refreshset:${email.toLowerCase()}`; }
function rateLimitKey(ip) { return `auth:ratelimit:${ip}`; }

// --- Password complexity ---
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_RULES = [
  { regex: /[a-z]/, message: 'at least one lowercase letter' },
  { regex: /[A-Z]/, message: 'at least one uppercase letter' },
  { regex: /[0-9]/, message: 'at least one number' },
  { regex: /[^a-zA-Z0-9]/, message: 'at least one special character' },
];

function validatePasswordComplexity(password) {
  const errors = [];
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  for (const rule of PASSWORD_RULES) {
    if (!rule.regex.test(password)) errors.push(rule.message);
  }
  return errors;
}

// --- Rate limiting ---
async function checkRateLimit(ip) {
  const key = rateLimitKey(ip);
  const current = await client.incr(key);
  if (current === 1) {
    await client.expire(key, LOGIN_RATE_LIMIT_WINDOW);
  }
  return { allowed: current <= LOGIN_RATE_LIMIT_MAX, remaining: Math.max(0, LOGIN_RATE_LIMIT_MAX - current), retryAfter: LOGIN_RATE_LIMIT_WINDOW };
}

// --- Account lockout ---
async function checkAccountLockout(email) {
  const locked = await client.get(lockoutKey(email.toLowerCase()));
  if (locked) {
    const ttl = await client.ttl(lockoutKey(email.toLowerCase()));
    return { locked: true, remainingSeconds: ttl > 0 ? ttl : LOCKOUT_DURATION_SECONDS };
  }
  return { locked: false };
}

async function recordFailedAttempt(email) {
  email = email.toLowerCase();
  const key = failedAttemptsKey(email);
  const attempts = await client.incr(key);
  if (attempts === 1) {
    await client.expire(key, LOCKOUT_DURATION_SECONDS);
  }
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await client.set(lockoutKey(email), '1', { EX: LOCKOUT_DURATION_SECONDS });
    await client.del(key);
    return { lockedOut: true, remainingSeconds: LOCKOUT_DURATION_SECONDS };
  }
  return { lockedOut: false, attemptsRemaining: MAX_FAILED_ATTEMPTS - attempts };
}

async function clearFailedAttempts(email) {
  await client.del(failedAttemptsKey(email.toLowerCase()));
}

// --- Refresh tokens ---
async function generateRefreshToken(email) {
  email = email.toLowerCase();
  const token = crypto.randomBytes(48).toString('base64url');
  const expirySeconds = parseExpiry(REFRESH_TOKEN_EXPIRY);
  // Store refresh token → email mapping
  await client.set(refreshTokenKey(token), email, { EX: expirySeconds });
  // Track all refresh tokens for this user (for logout-all)
  await client.sAdd(userRefreshSetKey(email), token);
  await client.expire(userRefreshSetKey(email), expirySeconds);
  return token;
}

async function rotateRefreshToken(oldToken) {
  const key = refreshTokenKey(oldToken);
  const email = await client.get(key);
  if (!email) return null; // expired or invalid

  // Revoke old token
  await client.del(key);
  await client.sRem(userRefreshSetKey(email), oldToken);

  // Check user still exists
  const userData = await client.get(userKey(email));
  if (!userData) return null;
  const user = JSON.parse(userData);

  // Parse workspaces for token
  let workspaces = [];
  if (typeof user.workspaces === 'string') {
    try { workspaces = JSON.parse(user.workspaces); } catch { workspaces = []; }
  } else if (Array.isArray(user.workspaces)) {
    workspaces = user.workspaces;
  }

  // Issue new pair
  const accessToken = jwt.sign(
    { email: user.email, role: user.role, name: user.name, workspaces },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  const newRefreshToken = await generateRefreshToken(email);

  return {
    token: accessToken,
    refreshToken: newRefreshToken,
    user: { email: user.email, name: user.name, role: user.role, workspaces }
  };
}

async function revokeAllRefreshTokens(email) {
  email = email.toLowerCase();
  const tokens = await client.sMembers(userRefreshSetKey(email));
  for (const t of tokens) {
    await client.del(refreshTokenKey(t));
  }
  await client.del(userRefreshSetKey(email));
}

function parseExpiry(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 86400; // default 1 day
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return 86400;
  }
}

// --- Core CRUD ---
async function createUser(email, password, name, role = 'viewer', skipPasswordValidation = false, workspaces = []) {
  email = email.toLowerCase();
  if (!skipPasswordValidation) {
    const pwErrors = validatePasswordComplexity(password);
    if (pwErrors.length > 0) {
      throw new Error(`Password must contain: ${pwErrors.join(', ')}`);
    }
  }
  const exists = await client.exists(userKey(email));
  if (exists) throw new Error('User already exists');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { email, name, passwordHash, role, workspaces: JSON.stringify(workspaces), createdAt: new Date().toISOString() };
  await client.set(userKey(email), JSON.stringify(user));
  await client.sAdd('user_emails', email);
  const { passwordHash: _, ...safe } = user;
  safe.workspaces = workspaces;
  return safe;
}

async function authenticate(email, password, ip) {
  email = email.toLowerCase();

  // Rate limit by IP
  if (ip) {
    const rl = await checkRateLimit(ip);
    if (!rl.allowed) {
      const err = new Error('Too many login attempts. Please try again later.');
      err.statusCode = 429;
      err.retryAfter = rl.retryAfter;
      throw err;
    }
  }

  // Account lockout check
  const lockout = await checkAccountLockout(email);
  if (lockout.locked) {
    const err = new Error(`Account locked. Try again in ${Math.ceil(lockout.remainingSeconds / 60)} minutes.`);
    err.statusCode = 423;
    throw err;
  }

  const data = await client.get(userKey(email));
  if (!data) {
    await recordFailedAttempt(email);
    return null;
  }
  const user = JSON.parse(data);
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const result = await recordFailedAttempt(email);
    if (result.lockedOut) {
      const err = new Error(`Account locked after ${MAX_FAILED_ATTEMPTS} failed attempts. Try again in ${Math.ceil(LOCKOUT_DURATION_SECONDS / 60)} minutes.`);
      err.statusCode = 423;
      throw err;
    }
    return null;
  }

  // Success — clear failed attempts
  await clearFailedAttempts(email);

  // Parse workspaces for token
  let workspaces = [];
  if (typeof user.workspaces === 'string') {
    try { workspaces = JSON.parse(user.workspaces); } catch { workspaces = []; }
  } else if (Array.isArray(user.workspaces)) {
    workspaces = user.workspaces;
  }

  const token = jwt.sign(
    { email: user.email, role: user.role, name: user.name, workspaces },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  const refreshToken = await generateRefreshToken(email);

  return {
    token,
    refreshToken,
    user: { email: user.email, name: user.name, role: user.role, workspaces }
  };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function getUser(email) {
  const data = await client.get(userKey(email.toLowerCase()));
  if (!data) return null;
  const { passwordHash, ...safe } = JSON.parse(data);
  // Parse workspaces from JSON string if stored as string
  if (typeof safe.workspaces === 'string') {
    try { safe.workspaces = JSON.parse(safe.workspaces); } catch { safe.workspaces = []; }
  }
  if (!safe.workspaces) safe.workspaces = [];
  return safe;
}

async function listUsers() {
  const emails = await client.sMembers('user_emails');
  const users = [];
  for (const email of emails) {
    const u = await getUser(email);
    if (u) users.push(u);
  }
  return users;
}

async function updateUser(email, updates) {
  email = email.toLowerCase();
  const data = await client.get(userKey(email));
  if (!data) throw new Error('User not found');
  const user = JSON.parse(data);
  if (updates.name) user.name = updates.name;
  if (updates.role) user.role = updates.role;
  if (updates.workspaces !== undefined) user.workspaces = JSON.stringify(updates.workspaces);
  if (updates.password) {
    const pwErrors = validatePasswordComplexity(updates.password);
    if (pwErrors.length > 0) {
      throw new Error(`Password must contain: ${pwErrors.join(', ')}`);
    }
    user.passwordHash = await bcrypt.hash(updates.password, 10);
  }
  await client.set(userKey(email), JSON.stringify(user));
  const { passwordHash, ...safe } = user;
  if (typeof safe.workspaces === 'string') {
    try { safe.workspaces = JSON.parse(safe.workspaces); } catch { safe.workspaces = []; }
  }
  return safe;
}

async function deleteUser(email) {
  email = email.toLowerCase();
  if (email === MASTER_ADMIN_EMAIL.toLowerCase()) throw new Error('Cannot delete master admin');
  await revokeAllRefreshTokens(email);
  await client.del(userKey(email));
  await client.sRem('user_emails', email);
}

async function initializeMasterAdmin() {
  const exists = await client.exists(userKey(MASTER_ADMIN_EMAIL));
  if (exists) {
    console.log(`   ✅ Master admin exists: ${MASTER_ADMIN_EMAIL}`);
    return false;
  }
  // Skip password validation for master admin (configured via env)
  await createUser(MASTER_ADMIN_EMAIL, MASTER_ADMIN_PASSWORD, 'Admin', 'admin', true);
  console.log(`   ✅ Master admin created: ${MASTER_ADMIN_EMAIL}`);
  return true;
}

module.exports = {
  createUser, authenticate, verifyToken, getUser, listUsers, updateUser, deleteUser,
  initializeMasterAdmin, rotateRefreshToken, revokeAllRefreshTokens,
  validatePasswordComplexity, checkRateLimit
};
