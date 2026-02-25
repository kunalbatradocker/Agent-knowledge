#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const redis = require('../server/services/redisService');

async function main() {
  const keys = await redis.keys('vkg:mappings:*');
  for (const key of keys) {
    const val = await redis.get(key);
    if (!val) continue;
    const m = JSON.parse(val);
    console.log(`\n=== ${key} ===`);
    
    const catalogs = new Set();
    console.log('\nClasses → Tables:');
    for (const [cls, meta] of Object.entries(m.classes || {})) {
      const table = meta.sourceTable || '?';
      console.log(`  ${cls} → ${table}`);
      if (table !== '?') catalogs.add(table.split('.')[0]);
    }
    
    console.log('\nCatalogs referenced:', [...catalogs].join(', ') || 'none');
    console.log(`Total: ${Object.keys(m.classes || {}).length} classes, ${Object.keys(m.properties || {}).length} props, ${Object.keys(m.relationships || {}).length} rels`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
