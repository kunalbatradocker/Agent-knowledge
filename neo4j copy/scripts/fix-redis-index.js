/**
 * Fix Redis vector index — patches missing created_at on existing chunks,
 * drops and recreates the RediSearch index so all chunks get indexed.
 * 
 * Run: node scripts/fix-redis-index.js
 */
const { createClient } = require('redis');

(async () => {
  const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await client.connect();

  const INDEX_NAME = 'chunk_vector_idx';
  const CHUNK_PREFIX = 'chunk:';

  // Step 1: Patch missing created_at on all chunk keys
  let patched = 0;
  let total = 0;
  let cursor = '0';
  do {
    const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${CHUNK_PREFIX}*`, 'COUNT', '200']);
    cursor = result[0];
    for (const key of result[1]) {
      const keyType = await client.type(key);
      if (keyType !== 'ReJSON-RL' && keyType !== 'json') continue;
      total++;
      try {
        const ca = await client.json.get(key, { path: '$.created_at' });
        if (!ca || !ca[0]) {
          await client.json.set(key, '$.created_at', Date.now());
          patched++;
        }
      } catch (e) {
        console.warn(`  ⚠️ Could not patch ${key}: ${e.message}`);
      }
    }
  } while (cursor !== '0');
  console.log(`Scanned ${total} chunks, patched ${patched} missing created_at`);

  // Step 2: Drop existing index
  try {
    await client.ft.dropIndex(INDEX_NAME);
    console.log(`Dropped index ${INDEX_NAME}`);
  } catch (e) {
    console.log(`Index drop: ${e.message}`);
  }

  // Step 3: Recreate index
  const dim = parseInt(process.env.EMBEDDING_DIMENSION) || 1024;
  await client.ft.create(INDEX_NAME, {
    '$.embedding': {
      type: 'VECTOR', ALGORITHM: 'HNSW', TYPE: 'FLOAT32',
      DIM: dim, DISTANCE_METRIC: 'COSINE', AS: 'embedding'
    },
    '$.text': { type: 'TEXT', AS: 'text' },
    '$.documentId': { type: 'TAG', AS: 'documentId' },
    '$.documentName': { type: 'TEXT', AS: 'documentName' },
    '$.tenant_id': { type: 'TAG', AS: 'tenant_id' },
    '$.workspace_id': { type: 'TAG', AS: 'workspace_id' },
    '$.doc_type': { type: 'TAG', AS: 'doc_type' },
    '$.context_type': { type: 'TAG', AS: 'context_type' },
    '$.access_label': { type: 'TAG', AS: 'access_label' },
    '$.chunkIndex': { type: 'NUMERIC', AS: 'chunkIndex' },
    '$.startPage': { type: 'NUMERIC', AS: 'startPage' },
    '$.created_at': { type: 'NUMERIC', AS: 'created_at' }
  }, { ON: 'JSON', PREFIX: CHUNK_PREFIX });
  console.log(`Created index ${INDEX_NAME} (dim=${dim})`);

  // Step 4: Wait a moment for indexing, then check
  await new Promise(r => setTimeout(r, 2000));
  const info = await client.ft.info(INDEX_NAME);
  console.log(`\nIndex status:`);
  console.log(`  numDocs: ${info.numDocs}`);
  console.log(`  indexing: ${info.indexing}`);
  console.log(`  percentIndexed: ${info.percentIndexed}`);
  console.log(`  hashIndexingFailures: ${info.hashIndexingFailures}`);

  if (info.hashIndexingFailures > 0) {
    console.log(`\n⚠️ Still have indexing failures. Checking a sample chunk...`);
    let sampleKey = null;
    cursor = '0';
    const scanResult = await client.sendCommand(['SCAN', '0', 'MATCH', `${CHUNK_PREFIX}*`, 'COUNT', '1']);
    if (scanResult[1].length > 0) {
      sampleKey = scanResult[1][0];
      const data = await client.json.get(sampleKey);
      console.log(`  Sample key: ${sampleKey}`);
      console.log(`  Fields: ${Object.keys(data).join(', ')}`);
      console.log(`  embedding type: ${typeof data.embedding}, isArray: ${Array.isArray(data.embedding)}, length: ${data.embedding?.length}`);
      console.log(`  created_at: ${data.created_at}`);
      console.log(`  chunkIndex: ${data.chunkIndex} (type: ${typeof data.chunkIndex})`);
      console.log(`  startPage: ${data.startPage} (type: ${typeof data.startPage})`);
    }
  } else {
    console.log(`\n✅ All chunks indexed successfully!`);
  }

  await client.quit();
})().catch(e => { console.error(e); process.exit(1); });
