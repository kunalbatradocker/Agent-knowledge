/**
 * Token Encryption Utility
 * AES-256-GCM encryption for per-user Bedrock tokens stored in Redis.
 * Derives the encryption key from JWT_SECRET using PBKDF2.
 */
const crypto = require('crypto');
const { client: redisClient } = require('../config/redis');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM recommended IV length
const TAG_LENGTH = 16;      // Auth tag length
const SALT = 'pf-bedrock-token-enc'; // Static salt (key is already high-entropy)

let _encKey = null;

function getEncryptionKey() {
  if (_encKey) return _encKey;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set — cannot encrypt tokens');
  _encKey = crypto.pbkdf2Sync(secret, SALT, 100000, 32, 'sha256');
  return _encKey;
}

function redisKey(userId) {
  return `bedrock_token:${userId}`;
}

/**
 * Encrypt a plaintext token.
 * Returns a base64 string: iv + authTag + ciphertext
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted token.
 */
function decrypt(encoded) {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Store an encrypted token in Redis with TTL.
 */
async function storeToken(userId, token, ttlSeconds) {
  const encrypted = encrypt(token);
  await redisClient.setEx(redisKey(userId), ttlSeconds, encrypted);
}

/**
 * Retrieve and decrypt a token from Redis. Returns null if not found.
 */
async function getToken(userId) {
  const encrypted = await redisClient.get(redisKey(userId));
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch (e) {
    // If decryption fails (e.g. key changed), delete the stale entry
    await redisClient.del(redisKey(userId));
    return null;
  }
}

/**
 * Delete a user's token from Redis.
 */
async function deleteToken(userId) {
  await redisClient.del(redisKey(userId));
}

module.exports = { encrypt, decrypt, storeToken, getToken, deleteToken };
