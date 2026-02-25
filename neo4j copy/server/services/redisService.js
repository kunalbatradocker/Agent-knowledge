/**
 * Redis Service - Simple wrapper for staging data
 */
const { client } = require('../config/redis');

// In-memory fallback when Redis unavailable
const memoryStore = new Map();

async function set(key, value, ttlSeconds = 86400) {
  try {
    if (client.isOpen) {
      if (ttlSeconds === 0) {
        // No expiry — persist forever
        await client.set(key, value);
      } else {
        await client.setEx(key, ttlSeconds, value);
      }
    } else {
      memoryStore.set(key, { value, expires: ttlSeconds === 0 ? Infinity : Date.now() + ttlSeconds * 1000 });
    }
  } catch (e) {
    memoryStore.set(key, { value, expires: ttlSeconds === 0 ? Infinity : Date.now() + ttlSeconds * 1000 });
  }
}

async function get(key) {
  try {
    if (client.isOpen) {
      return await client.get(key);
    }
  } catch (e) {}
  
  const item = memoryStore.get(key);
  if (item && item.expires > Date.now()) {
    return item.value;
  }
  memoryStore.delete(key);
  return null;
}

async function del(key) {
  try {
    if (client.isOpen) {
      await client.del(key);
    }
  } catch (e) {}
  memoryStore.delete(key);
}

async function keys(pattern) {
  try {
    if (client.isOpen) {
      // Use SCAN instead of KEYS to avoid blocking Redis
      const results = [];
      let cursor = '0';
      do {
        const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
        cursor = reply[0];
        results.push(...reply[1]);
      } while (cursor !== '0');
      return results;
    }
  } catch (e) {}
  // Fallback to memory store
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return Array.from(memoryStore.keys()).filter(k => regex.test(k));
}

async function sAdd(key, value) {
  try {
    if (client.isOpen) {
      return await client.sAdd(key, value);
    }
  } catch (e) {}
  // Fallback
  if (!memoryStore.has(key)) memoryStore.set(key, { value: new Set(), expires: Infinity });
  memoryStore.get(key).value.add(value);
}

async function sRem(key, value) {
  try {
    if (client.isOpen) {
      return await client.sRem(key, value);
    }
  } catch (e) {}
  // Fallback
  const item = memoryStore.get(key);
  if (item && item.value instanceof Set) item.value.delete(value);
}

async function sMembers(key) {
  try {
    if (client.isOpen) {
      return await client.sMembers(key);
    }
  } catch (e) {}
  // Fallback
  const item = memoryStore.get(key);
  return item ? Array.from(item.value) : [];
}

// Alias for compatibility
const setEx = set;

// List operations for audit log
async function lPush(key, value) {
  try {
    if (client.isOpen) return await client.lPush(key, value);
  } catch (e) {}
  const item = memoryStore.get(key);
  if (item && Array.isArray(item.value)) { item.value.unshift(value); }
  else { memoryStore.set(key, { value: [value] }); }
}

async function lRange(key, start, stop) {
  try {
    if (client.isOpen) return await client.lRange(key, start, stop);
  } catch (e) {}
  const item = memoryStore.get(key);
  if (!item || !Array.isArray(item.value)) return [];
  return stop === -1 ? item.value.slice(start) : item.value.slice(start, stop + 1);
}

async function lTrim(key, start, stop) {
  try {
    if (client.isOpen) return await client.lTrim(key, start, stop);
  } catch (e) {}
  const item = memoryStore.get(key);
  if (item && Array.isArray(item.value)) { item.value = item.value.slice(start, stop + 1); }
}

// Hash operations
async function hSet(key, field, value) {
  try {
    if (client.isOpen) return await client.hSet(key, field, value);
  } catch (e) {}
  if (!memoryStore.has(key)) memoryStore.set(key, { value: {} });
  memoryStore.get(key).value[field] = value;
}

async function hGet(key, field) {
  try {
    if (client.isOpen) return await client.hGet(key, field);
  } catch (e) {}
  const item = memoryStore.get(key);
  return item ? item.value[field] || null : null;
}

async function hGetAll(key) {
  try {
    if (client.isOpen) return await client.hGetAll(key);
  } catch (e) {}
  const item = memoryStore.get(key);
  return item ? item.value : null;
}

async function hDel(key, field) {
  try {
    if (client.isOpen) return await client.hDel(key, field);
  } catch (e) {}
  const item = memoryStore.get(key);
  if (item && item.value) delete item.value[field];
}

module.exports = { set, setEx, get, del, keys, sAdd, sRem, sMembers, lPush, lRange, lTrim, hSet, hGet, hGetAll, hDel };
