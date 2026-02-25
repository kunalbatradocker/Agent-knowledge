#!/usr/bin/env node
/**
 * Debug: show registered Trino catalogs and their metadata from Redis
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const redisService = require('../server/services/redisService');

async function main() {
  // Check what keys exist for trino catalogs
  const keys = await redisService.keys('vkg:catalogs:*');
  console.log('Redis keys matching vkg:catalogs:*:', keys);

  for (const key of keys) {
    const raw = await redisService.hGetAll(key);
    console.log(`\n=== ${key} ===`);
    for (const [name, val] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(val);
        console.log(`  ${name}:`, JSON.stringify(parsed, null, 4));
      } catch {
        console.log(`  ${name}: ${val}`);
      }
    }
  }

  // Also check vkg mapping cache
  const mappingKeys = await redisService.keys('vkg:mappings:*');
  console.log('\n\nRedis keys matching vkg:mappings:*:', mappingKeys);
  for (const key of mappingKeys) {
    const val = await redisService.get(key);
    if (val) {
      try {
        const parsed = JSON.parse(val);
        console.log(`\n=== ${key} ===`);
        console.log('  classes:', Object.keys(parsed.classes || {}));
        console.log('  properties:', Object.keys(parsed.properties || {}));
        console.log('  relationships:', Object.keys(parsed.relationships || {}));
        // Show first class detail
        const firstClass = Object.entries(parsed.classes || {})[0];
        if (firstClass) console.log('  sample class:', firstClass[0], firstClass[1]);
        const firstProp = Object.entries(parsed.properties || {})[0];
        if (firstProp) console.log('  sample prop:', firstProp[0], firstProp[1]);
      } catch {
        console.log(`  ${key}: (parse error)`);
      }
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
