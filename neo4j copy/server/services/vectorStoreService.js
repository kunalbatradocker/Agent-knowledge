const { client, connectRedis, checkConnection } = require('../config/redis');
const embeddingService = require('./embeddingService');
const { v4: uuidv4 } = require('uuid');

class VectorStoreService {
  constructor() {
    this.chunkPrefix = 'chunk:';
    this.documentPrefix = 'doc:';
    this.indexName = 'chunk_vector_idx';
    this.indexReady = false;
    this._indexPromise = null;
  }

  // ── Index management ──────────────────────────────────────────────

  /**
   * Convert a JS number array to a FLOAT32 binary Buffer for RediSearch
   */
  _float32Buffer(arr) {
    const buf = Buffer.alloc(arr.length * 4);
    for (let i = 0; i < arr.length; i++) {
      buf.writeFloatLE(arr[i], i * 4);
    }
    return buf;
  }

  /**
   * Ensure the RediSearch HNSW index exists. Called once on first operation.
   * If the index already exists it's a no-op.
   */
  async ensureIndex(dim) {
    if (this.indexReady) return;
    if (this._indexPromise) return this._indexPromise;

    this._indexPromise = (async () => {
      try {
        await connectRedis();
        // Check if index already exists
        const info = await client.ft.info(this.indexName);
        this.indexReady = true;
        console.log(`✅ RediSearch index "${this.indexName}" already exists (${info.numDocs ?? 0} docs indexed)`);
      } catch (err) {
        // Index doesn't exist — create it
        const dimension = dim || parseInt(process.env.EMBEDDING_DIMENSION) || 1024;
        console.log(`🔧 Creating RediSearch HNSW index (dim=${dimension})...`);
        try {
          await client.ft.create(this.indexName, {
            // Indexed fields
            '$.embedding': {
              type: 'VECTOR',
              ALGORITHM: 'HNSW',
              TYPE: 'FLOAT32',
              DIM: dimension,
              DISTANCE_METRIC: 'COSINE',
              AS: 'embedding'
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
          }, {
            ON: 'JSON',
            PREFIX: this.chunkPrefix
          });
          console.log(`✅ RediSearch index "${this.indexName}" created`);
          this.indexReady = true;
        } catch (createErr) {
          // Another process may have created it concurrently
          if (createErr.message?.includes('Index already exists')) {
            this.indexReady = true;
          } else {
            console.error('❌ Failed to create RediSearch index:', createErr.message);
            throw createErr;
          }
        }
      }
      this._indexPromise = null;
    })();

    return this._indexPromise;
  }

  // ── Migration ─────────────────────────────────────────────────────

  /**
   * Migrate old-format data (separate vec: and chunk: HASH keys) to new
   * JSON-based format that RediSearch can index.
   * Safe to call multiple times — skips already-migrated chunks.
   */
  async migrateOldData() {
    await connectRedis();

    let migratedCount = 0;

    // Pass 1: Migrate old vec: + chunk: HASH pairs to new JSON format
    const oldVecPrefix = 'vec:';
    let cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${oldVecPrefix}*`, 'COUNT', '200']);
      cursor = result[0];
      const keys = result[1];

      for (const vecKey of keys) {
        try {
          const chunkId = vecKey.slice(oldVecPrefix.length);
          const newKey = `${this.chunkPrefix}${chunkId}`;

          // Check if already migrated (new key is JSON type)
          const keyType = await client.type(newKey);
          if (keyType === 'ReJSON-RL' || keyType === 'json') {
            await client.del(vecKey);
            continue;
          }

          const vecData = await client.hGetAll(vecKey);
          const oldChunkKey = `chunk:${chunkId}`;
          const chunkData = await client.hGetAll(oldChunkKey);

          if (!vecData.embedding || !chunkData.id) continue;

          const embeddingArr = JSON.parse(vecData.embedding);
          await this.ensureIndex(embeddingArr.length);

          // For JSON-based indexes, vectors are stored as number arrays
          await client.json.set(newKey, '$', {
            id: chunkId,
            documentId: chunkData.documentId || '',
            documentName: chunkData.documentName || '',
            chunkIndex: parseInt(chunkData.chunkIndex) || 0,
            text: chunkData.text || '',
            startChar: parseInt(chunkData.startChar) || 0,
            endChar: parseInt(chunkData.endChar) || 0,
            startPage: parseInt(chunkData.startPage) || 0,
            endPage: parseInt(chunkData.endPage) || 0,
            context_type: chunkData.context_type || '',
            section_title: chunkData.section_title || '',
            heading_path: chunkData.heading_path || '',
            token_count: parseInt(chunkData.token_count) || 0,
            char_count: parseInt(chunkData.char_count) || 0,
            tenant_id: chunkData.tenant_id || '',
            workspace_id: chunkData.workspace_id || '',
            doc_type: chunkData.doc_type || '',
            access_label: chunkData.access_label || '',
            language: chunkData.language || 'en',
            embedding_model: vecData.embedding_model || 'unknown',
            created_at: Date.now(),
            metadata: chunkData.metadata ? JSON.parse(chunkData.metadata) : {},
            embedding: embeddingArr
          });

          await client.del(vecKey);
          if (keyType === 'hash') await client.del(oldChunkKey);

          migratedCount++;
          if (migratedCount % 50 === 0) {
            console.log(`   🔄 Migrated ${migratedCount} chunks to RediSearch format...`);
          }
        } catch (e) {
          console.warn(`   ⚠️ Failed to migrate ${vecKey}: ${e.message}`);
        }
      }
    } while (cursor !== '0');

    // Pass 2: Fix any JSON chunk: keys that have malformed embeddings
    // (e.g., stored as Buffer object {type:"Buffer",data:[...]} instead of number array)
    let fixedCount = 0;
    cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${this.chunkPrefix}*`, 'COUNT', '200']);
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        try {
          const keyType = await client.type(key);
          if (keyType !== 'ReJSON-RL' && keyType !== 'json') continue;

          // Check if embedding is a proper array or a malformed Buffer object
          const emb = await client.json.get(key, { path: '$.embedding' });
          if (!emb || !emb[0]) continue;

          const embVal = emb[0];
          // If it's an object with type:"Buffer" and data array, fix it
          if (embVal && typeof embVal === 'object' && embVal.type === 'Buffer' && Array.isArray(embVal.data)) {
            // Convert Buffer data back to float array
            const buf = Buffer.from(embVal.data);
            const floatArr = [];
            for (let i = 0; i < buf.length; i += 4) {
              floatArr.push(buf.readFloatLE(i));
            }
            await client.json.set(key, '$.embedding', floatArr);
            fixedCount++;
          } else if (!Array.isArray(embVal)) {
            // Some other malformed format — skip
            console.warn(`   ⚠️ Unexpected embedding format in ${key}: ${typeof embVal}`);
          }
        } catch (e) {
          // Skip keys that can't be read
        }
      }
    } while (cursor !== '0');

    const total = migratedCount + fixedCount;

    // Pass 3: Patch chunks missing created_at (causes RediSearch indexing failures)
    let patchedCount = 0;
    cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${this.chunkPrefix}*`, 'COUNT', '200']);
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        try {
          const keyType = await client.type(key);
          if (keyType !== 'ReJSON-RL' && keyType !== 'json') continue;

          const ca = await client.json.get(key, { path: '$.created_at' });
          if (!ca || !ca[0]) {
            await client.json.set(key, '$.created_at', Date.now());
            patchedCount++;
          }
        } catch (e) {
          // Skip keys that can't be patched
        }
      }
    } while (cursor !== '0');

    const needsReindex = fixedCount > 0 || patchedCount > 0;
    if (needsReindex) {
      console.log(`   🔄 Re-creating index after fixing ${fixedCount} embeddings, ${patchedCount} missing created_at...`);
      try {
        await client.ft.dropIndex(this.indexName);
        this.indexReady = false;
        await this.ensureIndex();
      } catch (e) {
        console.warn(`   ⚠️ Could not recreate index: ${e.message}`);
      }
    }
    if (total > 0 || patchedCount > 0) {
      console.log(`✅ Migration complete: ${migratedCount} migrated, ${fixedCount} embeddings fixed, ${patchedCount} created_at patched`);
    }
    return total + patchedCount;
  }

  // ── Store operations ──────────────────────────────────────────────

  /**
   * Store a chunk with its embedding in Redis as a JSON document
   * indexed by RediSearch.
   */
  async storeChunk(chunk, embedding) {
    try {
      await connectRedis();
      await this.ensureIndex(embedding.length);

      const chunkId = chunk.id || chunk.chunk_id || `chunk_${Date.now()}`;
      const chunkKey = `${this.chunkPrefix}${chunkId}`;

      const chunkIndex = chunk.chunkIndex ?? chunk.order ?? 0;
      const startChar = chunk.startChar ?? 0;
      const endChar = chunk.endChar ?? (chunk.text?.length || 0);

      const embeddingModel = chunk.embedding_model || embeddingService.getModelName() || 'unknown';

      // Single JSON document — RediSearch indexes it automatically
      // For JSON-based indexes, vectors are stored as number arrays (not binary blobs)
      await client.json.set(chunkKey, '$', {
        id: chunkId,
        documentId: chunk.documentId || '',
        documentName: chunk.documentName || '',
        chunkIndex: chunkIndex,
        text: chunk.text || '',
        startChar: startChar,
        endChar: endChar,
        startPage: chunk.start_page || chunk.metadata?.startPage || 0,
        endPage: chunk.end_page || chunk.metadata?.endPage || 0,
        context_type: chunk.context_type || '',
        section_title: chunk.section_title || '',
        heading_path: chunk.heading_path || '',
        token_count: chunk.token_count || Math.ceil((chunk.text || '').length / 4),
        char_count: chunk.char_count || (chunk.text || '').length,
        tenant_id: chunk.tenant_id || '',
        workspace_id: chunk.workspace_id || '',
        doc_type: chunk.doc_type || '',
        access_label: chunk.access_label || '',
        language: chunk.language || 'en',
        embedding_model: embeddingModel,
        created_at: Date.now(),
        metadata: chunk.metadata || {},
        embedding: Array.from(embedding)
      });

      // Maintain document → chunk set (used by getDocumentChunks / deleteDocument)
      if (chunk.documentId) {
        await client.sAdd(`${this.documentPrefix}${chunk.documentId}:chunks`, chunkId);
      }

      return { success: true, chunkId };
    } catch (error) {
      console.error('Error storing chunk:', error);
      throw new Error(`Failed to store chunk: ${error.message}`);
    }
  }

  /**
   * Store multiple chunks with embeddings
   */
  async storeChunks(chunks, embeddings) {
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await this.storeChunk(chunks[i], embeddings[i]);
      results.push(result);
    }
    return results;
  }

  /**
   * Add chunks with automatic embedding generation
   */
  async addChunks(chunks) {
    try {
      await connectRedis();

      const results = [];
      let successCount = 0;
      let errorCount = 0;
      console.log(`   📊 Processing ${chunks.length} chunks for embedding...`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const normalizedChunk = {
            id: chunk.id || chunk.chunk_id || `chunk_${chunk.docId}_${chunk.chunkIndex || i}`,
            chunk_id: chunk.id || chunk.chunk_id || `chunk_${chunk.docId}_${chunk.chunkIndex || i}`,
            documentId: chunk.docId || chunk.documentId || '',
            documentName: chunk.documentName || '',
            chunkIndex: chunk.chunkIndex ?? i,
            text: chunk.text || '',
            startChar: chunk.startChar ?? 0,
            endChar: chunk.endChar ?? (chunk.text?.length || 0),
            start_page: chunk.startPage || chunk.start_page || 0,
            end_page: chunk.endPage || chunk.end_page || 0,
            context_type: chunk.context_type || '',
            section_title: chunk.section_title || '',
            heading_path: chunk.heading_path || '',
            tenant_id: chunk.tenant_id || '',
            workspace_id: chunk.workspace_id || '',
            doc_type: chunk.doc_type || '',
            language: chunk.language || 'en',
            metadata: chunk.metadata || {}
          };

          const embedding = await embeddingService.generateEmbedding(normalizedChunk.text);
          const result = await this.storeChunk(normalizedChunk, embedding);
          results.push(result);
          successCount++;

          if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
            console.log(`   ✅ Embedded and stored ${i + 1}/${chunks.length} chunks (${errorCount} errors)`);
          }
        } catch (chunkError) {
          errorCount++;
          console.error(`   ❌ Error processing chunk ${i}: ${chunkError.message}`);
        }
      }

      console.log(`   📊 Embedding complete: ${successCount} success, ${errorCount} errors`);
      return { success: true, chunksStored: successCount, errors: errorCount };
    } catch (error) {
      console.error('Error adding chunks:', error);
      throw new Error(`Failed to add chunks: ${error.message}`);
    }
  }

  /**
   * Process and store a document (chunk + embed + store)
   */
  async processAndStoreDocument(documentId, documentName, chunksOrText, chunkingService = null) {
    try {
      let chunks;
      let totalChunks;
      let totalCharacters;

      if (typeof chunksOrText === 'object' && chunksOrText.chunks) {
        chunks = chunksOrText.chunks;
        totalChunks = chunksOrText.totalChunks || chunks.length;
        totalCharacters = chunksOrText.totalCharacters || 0;
        console.log(`Using ${totalChunks} pre-chunked segments for document: ${documentName}`);
      } else if (typeof chunksOrText === 'string' && chunkingService) {
        const chunkedDoc = chunkingService.chunkDocument(chunksOrText, {
          id: documentId,
          name: documentName
        });
        chunks = chunkedDoc.chunks;
        totalChunks = chunkedDoc.totalChunks;
        totalCharacters = chunkedDoc.totalCharacters;
        console.log(`Processing ${totalChunks} chunks for document: ${documentName}`);
      } else {
        throw new Error('Invalid input: provide either chunked document object or text with chunkingService');
      }

      const chunkTexts = chunks.map(c => c.text);
      console.log('Generating embeddings...');

      const embeddings = [];
      for (let i = 0; i < chunkTexts.length; i++) {
        console.log(`  Embedding chunk ${i + 1}/${chunkTexts.length}`);
        const embedding = await embeddingService.generateEmbedding(chunkTexts[i]);
        embeddings.push(embedding);
      }

      console.log('Storing chunks in Redis...');
      await this.storeChunks(chunks, embeddings);

      await this.storeDocumentMetadata(documentId, {
        name: documentName,
        totalChunks: totalChunks,
        totalCharacters: totalCharacters,
        processedAt: new Date().toISOString()
      });

      return {
        success: true,
        documentId,
        documentName,
        totalChunks,
        totalCharacters
      };
    } catch (error) {
      console.error('Error processing document:', error);
      throw error;
    }
  }

  /**
   * Store document metadata
   */
  async storeDocumentMetadata(documentId, metadata) {
    await connectRedis();
    const docKey = `${this.documentPrefix}${documentId}`;
    await client.hSet(docKey, {
      id: documentId,
      ...metadata,
      metadata: JSON.stringify(metadata)
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  /**
   * Semantic search using RediSearch KNN on HNSW index.
   * O(log n) instead of O(n) brute-force.
   *
   * @param {string} query - Search query text
   * @param {number} topK - Number of results
   * @param {Object} filters - Optional: { tenant_id, workspace_id, doc_type, context_type }
   */
  async semanticSearch(query, topK = 5, filters = {}) {
    try {
      await connectRedis();

      const queryEmbedding = await embeddingService.generateEmbedding(query);
      await this.ensureIndex(queryEmbedding.length);

      const queryBlob = this._float32Buffer(queryEmbedding);

      // Build pre-filter from TAG fields
      const filterParts = [];
      if (filters.tenant_id) filterParts.push(`@tenant_id:{${this._escapeTag(filters.tenant_id)}}`);
      if (filters.workspace_id) filterParts.push(`@workspace_id:{${this._escapeTag(filters.workspace_id)}}`);
      if (filters.doc_type) filterParts.push(`@doc_type:{${this._escapeTag(filters.doc_type)}}`);
      if (filters.context_type) filterParts.push(`@context_type:{${this._escapeTag(filters.context_type)}}`);
      if (filters.access_label) filterParts.push(`@access_label:{${this._escapeTag(filters.access_label)}}`);
      // Filter by specific document IDs (used for folder-scoped agent queries)
      if (filters.documentIds && filters.documentIds.length > 0) {
        const escaped = filters.documentIds.map(id => this._escapeTag(id));
        filterParts.push(`@documentId:{${escaped.join('|')}}`);
      }

      const preFilter = filterParts.length > 0 ? filterParts.join(' ') : '*';

      // KNN query — RediSearch returns results sorted by distance (ascending)
      const knnQuery = `(${preFilter})=>[KNN ${topK} @embedding $BLOB AS score]`;

      const results = await client.ft.search(this.indexName, knnQuery, {
        PARAMS: { BLOB: queryBlob },
        SORTBY: 'score',
        LIMIT: { from: 0, size: topK },
        DIALECT: 2
      });

      console.log(`   🔍 RediSearch returned ${results?.total ?? 0} results`);

      if (!results || results.total === 0) {
        return [];
      }

      const MIN_SIMILARITY = 0.15;

      const mapped = results.documents
        .map(doc => {
          const d = doc.value;
          // RediSearch COSINE distance = 1 - similarity
          const rawScore = parseFloat(d.score ?? d.__score ?? '1');
          const similarity = 1 - rawScore;

          return {
            chunkId: d.id || doc.id.replace(this.chunkPrefix, ''),
            similarity,
            text: d.text || '',
            documentId: d.documentId || '',
            documentName: d.documentName || '',
            chunkIndex: parseInt(d.chunkIndex) || 0,
            startPage: parseInt(d.startPage) || null,
            endPage: parseInt(d.endPage) || null,
            embedding_model: d.embedding_model || 'unknown',
            metadata: typeof d.metadata === 'string' ? JSON.parse(d.metadata) : (d.metadata || {})
          };
        })
        .filter(r => r.similarity >= MIN_SIMILARITY);

      if (mapped.length === 0 && results.documents.length > 0) {
        // Log top scores when everything is filtered out
        const topScores = results.documents.slice(0, 3).map(doc => {
          const raw = parseFloat(doc.value.score ?? '1');
          return (1 - raw).toFixed(4);
        });
        console.log(`   ⚠️ All ${results.documents.length} results below similarity threshold ${MIN_SIMILARITY} (top scores: ${topScores.join(', ')})`);
      }

      return mapped;
    } catch (error) {
      console.error('Error in semantic search:', error);
      // Fallback: if index not ready yet, return empty rather than crash
      if (error.message?.includes('no such index') || error.message?.includes('Index not found')) {
        console.warn('⚠️ RediSearch index not found — returning empty results. Run migration or store data first.');
        return [];
      }
      throw new Error(`Semantic search failed: ${error.message}`);
    }
  }

  /**
   * Escape special characters for RediSearch TAG queries
   */
  _escapeTag(value) {
    return value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~/ ]/g, '\\$&');
  }

  // ── Document / chunk retrieval ────────────────────────────────────

  /**
   * Get all chunks for a document
   */
  async getDocumentChunks(documentId) {
    await connectRedis();

    const chunkIds = await client.sMembers(`${this.documentPrefix}${documentId}:chunks`);
    const chunks = [];

    for (const chunkId of chunkIds) {
      try {
        const key = `${this.chunkPrefix}${chunkId}`;
        const keyType = await client.type(key);

        let chunkData;
        if (keyType === 'ReJSON-RL' || keyType === 'json') {
          // New JSON format
          const raw = await client.json.get(key, { path: ['$.id', '$.documentId', '$.documentName', '$.chunkIndex', '$.text', '$.startChar', '$.endChar', '$.startPage', '$.endPage', '$.context_type', '$.section_title', '$.heading_path', '$.token_count', '$.char_count', '$.tenant_id', '$.workspace_id', '$.doc_type', '$.language', '$.metadata'] });
          if (!raw || !raw['$.id'] || raw['$.id'].length === 0) continue;
          chunkData = {
            id: raw['$.id'][0],
            documentId: raw['$.documentId'][0],
            documentName: raw['$.documentName'][0],
            chunkIndex: raw['$.chunkIndex'][0],
            text: raw['$.text'][0],
            startChar: raw['$.startChar'][0],
            endChar: raw['$.endChar'][0],
            startPage: raw['$.startPage'][0],
            endPage: raw['$.endPage'][0],
            context_type: raw['$.context_type'][0],
            section_title: raw['$.section_title'][0],
            heading_path: raw['$.heading_path'][0],
            token_count: raw['$.token_count'][0],
            char_count: raw['$.char_count'][0],
            tenant_id: raw['$.tenant_id'][0],
            workspace_id: raw['$.workspace_id'][0],
            doc_type: raw['$.doc_type'][0],
            language: raw['$.language'][0],
            metadata: raw['$.metadata'][0]
          };
        } else if (keyType === 'hash') {
          // Legacy HASH format (pre-migration)
          const raw = await client.hGetAll(key);
          if (!raw.id) continue;
          chunkData = {
            ...raw,
            chunkIndex: parseInt(raw.chunkIndex) || 0,
            metadata: raw.metadata ? JSON.parse(raw.metadata) : {}
          };
        } else {
          continue;
        }

        chunks.push(chunkData);
      } catch (e) {
        console.warn(`⚠️ Error reading chunk ${chunkId}: ${e.message}`);
      }
    }

    return chunks.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
  }
  /**
   * Get a single chunk by ID from Redis
   */
  async getChunkById(chunkId) {
    await connectRedis();
    const key = `${this.chunkPrefix}${chunkId}`;
    const keyType = await client.type(key);

    if (keyType === 'ReJSON-RL' || keyType === 'json') {
      const raw = await client.json.get(key, { path: ['$.id', '$.documentId', '$.documentName', '$.chunkIndex', '$.text', '$.startChar', '$.endChar', '$.startPage', '$.endPage', '$.context_type', '$.section_title', '$.heading_path', '$.tenant_id', '$.workspace_id', '$.doc_type'] });
      if (!raw || !raw['$.id'] || raw['$.id'].length === 0) return null;
      return {
        id: raw['$.id'][0],
        documentId: raw['$.documentId'][0],
        documentName: raw['$.documentName'][0],
        chunkIndex: raw['$.chunkIndex'][0],
        text: raw['$.text'][0],
        startChar: raw['$.startChar'][0],
        endChar: raw['$.endChar'][0],
        startPage: raw['$.startPage'][0],
        endPage: raw['$.endPage'][0],
        context_type: raw['$.context_type'][0],
        section_title: raw['$.section_title'][0],
        heading_path: raw['$.heading_path'][0],
        tenant_id: raw['$.tenant_id'][0],
        workspace_id: raw['$.workspace_id'][0],
        doc_type: raw['$.doc_type'][0]
      };
    } else if (keyType === 'hash') {
      const raw = await client.hGetAll(key);
      if (!raw.id) return null;
      return { ...raw, chunkIndex: parseInt(raw.chunkIndex) || 0 };
    }
    return null;
  }

  /**
   * Get all stored documents
   */
  async getDocuments() {
    await connectRedis();

    // doc: keys are still HASH (metadata only, not indexed by RediSearch)
    let cursor = '0';
    const documents = [];

    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${this.documentPrefix}*`, 'COUNT', '200']);
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        if (key.includes(':chunks')) continue;
        try {
          const docData = await client.hGetAll(key);
          if (docData.id) {
            documents.push({
              id: docData.id,
              name: docData.name,
              totalChunks: parseInt(docData.totalChunks) || 0,
              processedAt: docData.processedAt
            });
          }
        } catch (e) { /* skip */ }
      }
    } while (cursor !== '0');

    return documents;
  }

  /**
   * Delete a document and all its chunks
   */
  async deleteDocument(documentId) {
    await connectRedis();

    const chunkIds = await client.sMembers(`${this.documentPrefix}${documentId}:chunks`);

    for (const chunkId of chunkIds) {
      // Delete new JSON key (also removes from index automatically)
      await client.del(`${this.chunkPrefix}${chunkId}`);
      // Clean up any leftover old vec: key
      await client.del(`vec:${chunkId}`);
    }

    await client.del(`${this.documentPrefix}${documentId}`);
    await client.del(`${this.documentPrefix}${documentId}:chunks`);

    return { success: true, deletedChunks: chunkIds.length };
  }

  // ── Stats / admin ─────────────────────────────────────────────────

  /**
   * Get vector store statistics
   */
  async getStats() {
    await connectRedis();

    try {
      const indexInfo = await client.ft.info(this.indexName);
      const numDocs = indexInfo.numDocs ?? 0;

      // Count document metadata keys via SCAN
      let docCount = 0;
      let cursor = '0';
      do {
        const result = await client.sendCommand(['SCAN', cursor, 'MATCH', `${this.documentPrefix}*`, 'COUNT', '200']);
        cursor = result[0];
        docCount += result[1].filter(k => !k.includes(':chunks')).length;
      } while (cursor !== '0');

      return {
        totalVectors: numDocs,
        totalChunks: numDocs,
        totalDocuments: docCount,
        indexStatus: 'active'
      };
    } catch (e) {
      // Index doesn't exist yet
      return { totalVectors: 0, totalChunks: 0, totalDocuments: 0, indexStatus: 'not_created' };
    }
  }

  /**
   * Check Redis connection
   */
  async checkConnection() {
    return await checkConnection();
  }

  /**
   * Clear all vector store data and drop the index
   */
  async clearAll() {
    try {
      const isConnected = await this.checkConnection();
      if (!isConnected || !isConnected.connected) {
        console.log('Redis not connected, skipping vector store clear');
        return { cleared: false, reason: 'not connected' };
      }

      await connectRedis();

      // Drop the RediSearch index (also deletes indexed JSON docs if DD flag)
      try {
        await client.ft.dropIndex(this.indexName, { DD: true });
        console.log(`🗑️ Dropped RediSearch index "${this.indexName}" with documents`);
      } catch (e) {
        // Index may not exist
      }
      this.indexReady = false;

      // Clean up any remaining chunk: keys, doc: keys, and old vec: keys
      let totalDeleted = 0;
      for (const pattern of [`${this.chunkPrefix}*`, `${this.documentPrefix}*`, 'vec:*']) {
        let cursor = '0';
        do {
          const result = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
          cursor = result[0];
          const keys = result[1];
          if (keys.length > 0) {
            await client.del(keys);
            totalDeleted += keys.length;
          }
        } while (cursor !== '0');
      }

      console.log(`🗑️ Cleared ${totalDeleted} remaining keys from Redis vector store`);
      return { cleared: true, keysDeleted: totalDeleted };
    } catch (error) {
      console.error('Error clearing vector store:', error);
      return { cleared: false, error: error.message };
    }
  }
}

module.exports = new VectorStoreService();
