const { createClient } = require('redis');

(async () => {
  const client = createClient({ url: 'redis://localhost:6379' });
  await client.connect();
  
  // Check index
  try {
    const info = await client.ft.info('chunk_vector_idx');
    console.log('Index:', info.indexName, 'numDocs:', info.numDocs, 'indexing:', info.indexing);
  } catch(e) { console.log('Index error:', e.message); }
  
  // Count chunk keys
  let chunkCount = 0;
  let sampleChunkKeys = [];
  let cursor = '0';
  do {
    const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'chunk:*', 'COUNT', '200']);
    cursor = result[0];
    chunkCount += result[1].length;
    if (sampleChunkKeys.length < 3) sampleChunkKeys.push(...result[1].slice(0, 3));
  } while (cursor !== '0');
  console.log('Total chunk: keys:', chunkCount, 'samples:', sampleChunkKeys.slice(0, 3));
  
  // Count doc keys (excluding :chunks sets)
  let docKeys = [];
  cursor = '0';
  do {
    const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'doc:*', 'COUNT', '200']);
    cursor = result[0];
    docKeys.push(...result[1]);
  } while (cursor !== '0');
  const metaKeys = docKeys.filter(k => !k.includes(':chunks'));
  const chunkSetKeys = docKeys.filter(k => k.includes(':chunks'));
  console.log('doc: metadata keys:', metaKeys.length, 'doc:chunks sets:', chunkSetKeys.length);
  
  // Check workspace docs
  const allWsKeys = [];
  cursor = '0';
  do {
    const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'workspace:*:docs', 'COUNT', '200']);
    cursor = result[0];
    allWsKeys.push(...result[1]);
  } while (cursor !== '0');
  console.log('Workspace doc sets:', allWsKeys);
  
  for (const wsKey of allWsKeys) {
    const wsDocs = await client.sMembers(wsKey);
    console.log(`  ${wsKey}: ${wsDocs.length} docs`, wsDocs.slice(0, 3));
    
    // Check first doc's chunks
    if (wsDocs.length > 0) {
      const firstDoc = wsDocs[0];
      const chunkSetKey = 'doc:' + firstDoc + ':chunks';
      const exists = await client.exists(chunkSetKey);
      if (exists) {
        const chunks = await client.sMembers(chunkSetKey);
        console.log(`    doc:${firstDoc}:chunks = ${chunks.length} chunks`);
        
        // Check first chunk
        if (chunks.length > 0) {
          const key = 'chunk:' + chunks[0];
          const type = await client.type(key);
          console.log(`    chunk key type: ${type}`);
          if (type === 'ReJSON-RL' || type === 'json') {
            const emb = await client.json.get(key, { path: '$.embedding' });
            const hasEmb = emb && emb[0] && emb[0].length > 0;
            console.log(`    has embedding: ${hasEmb}, dim: ${hasEmb ? emb[0].length : 0}`);
            const wsId = await client.json.get(key, { path: '$.workspace_id' });
            console.log(`    workspace_id: ${wsId}`);
            const docId = await client.json.get(key, { path: '$.documentId' });
            console.log(`    documentId: ${docId}`);
          }
        }
      } else {
        console.log(`    doc:${firstDoc}:chunks set DOES NOT EXIST`);
      }
    }
  }
  
  // Check staged docs
  let stagedCount = 0;
  cursor = '0';
  do {
    const result = await client.sendCommand(['SCAN', cursor, 'MATCH', 'staged:*', 'COUNT', '200']);
    cursor = result[0];
    stagedCount += result[1].length;
  } while (cursor !== '0');
  console.log('Staged docs:', stagedCount);
  
  await client.quit();
})().catch(e => console.error(e));
