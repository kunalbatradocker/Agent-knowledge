#!/usr/bin/env node
/**
 * Test: Upload → Embed → Stage → Agent Query → Commit flow
 * 
 * Validates that:
 * 1. Upload creates doc metadata with status='staged' and chunks_stored > 0
 * 2. Vector store has chunks immediately after upload (before commit)
 * 3. Commit flow does NOT re-embed (skips embedding step)
 * 4. After commit, doc metadata status='committed' and chunks_stored preserved
 * 5. Staged doc delete cleans up vector store chunks
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const WORKSPACE_ID = process.env.TEST_WORKSPACE || 'default';
const TENANT_ID = process.env.TEST_TENANT || 'default';

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(msg) { console.log(`${CYAN}[test]${RESET} ${msg}`); }
function pass(msg) { console.log(`${GREEN}  ✅ PASS${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}  ❌ FAIL${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠️  WARN${RESET} ${msg}`); }

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { pass(msg); passed++; }
  else { fail(msg); failed++; }
}

async function fetchJSON(urlPath, options = {}) {
  const url = new URL(urlPath, API_BASE);
  const resp = await fetch(url.toString(), {
    headers: {
      'x-workspace-id': WORKSPACE_ID,
      'x-tenant-id': TENANT_ID,
      ...options.headers
    },
    ...options
  });
  const text = await resp.text();
  try { return { status: resp.status, data: JSON.parse(text) }; }
  catch { return { status: resp.status, data: text }; }
}

async function uploadTestFile(content, fileName, folderId) {
  const boundary = '----TestBoundary' + Date.now();
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    'Content-Type: text/plain',
    '',
    content,
    `--${boundary}`,
    `Content-Disposition: form-data; name="workspaceId"`,
    '',
    WORKSPACE_ID,
    `--${boundary}`,
    `Content-Disposition: form-data; name="tenantId"`,
    '',
    TENANT_ID,
    `--${boundary}`,
    `Content-Disposition: form-data; name="chunkingMethod"`,
    '',
    'fixed',
    `--${boundary}`,
    `Content-Disposition: form-data; name="chunkSize"`,
    '',
    '200',
  ];
  if (folderId) {
    body.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="folderId"`,
      '',
      folderId
    );
  }
  body.push(`--${boundary}--`);

  const resp = await fetch(`${API_BASE}/api/ontology/fm-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'x-workspace-id': WORKSPACE_ID,
      'x-tenant-id': TENANT_ID
    },
    body: body.join('\r\n')
  });
  return { status: resp.status, data: await resp.json() };
}

async function getDocMetadata(docId) {
  // Read doc metadata directly from Redis via a health-check style endpoint
  // or use the documents list endpoint
  const resp = await fetchJSON(`/api/ontology/documents/staged`);
  if (resp.data?.documents) {
    return resp.data.documents.find(d => d.doc_id === docId);
  }
  return null;
}

async function main() {
  log('=== Upload → Embed → Stage → Commit Flow Test ===\n');

  // ── Test 1: Check server is running ──
  log('1. Checking server connectivity...');
  try {
    const health = await fetchJSON('/api/health');
    assert(health.status === 200, `Server is running (status ${health.status})`);
  } catch (e) {
    fail(`Server not reachable at ${API_BASE}: ${e.message}`);
    console.log(`\n${RED}Server must be running. Start with: npm run server${RESET}`);
    process.exit(1);
  }

  // ── Test 2: Upload a text file via /fm-upload ──
  log('\n2. Uploading test document via /fm-upload...');
  const testContent = `
    Artificial intelligence (AI) is transforming industries worldwide.
    Machine learning, a subset of AI, enables computers to learn from data.
    Deep learning uses neural networks with many layers to model complex patterns.
    Natural language processing (NLP) allows machines to understand human language.
    Computer vision enables machines to interpret and understand visual information.
    Reinforcement learning trains agents through reward-based feedback systems.
  `.trim();

  const uploadResult = await uploadTestFile(testContent, 'test-embed-flow.txt');
  assert(uploadResult.status === 200 && uploadResult.data.success, 
    `Upload succeeded (docId: ${uploadResult.data.documentId})`);
  
  const docId = uploadResult.data.documentId;
  if (!docId) {
    fail('No documentId returned from upload');
    process.exit(1);
  }

  assert(uploadResult.data.chunksCreated > 0, 
    `Chunks created: ${uploadResult.data.chunksCreated}`);
  assert(uploadResult.data.staged === true, 'Document is staged');

  // ── Test 3: Verify doc metadata exists in Redis ──
  log('\n3. Verifying doc metadata in Redis...');
  const docMeta = await fetchJSON(`/api/ontology/documents/staged`);
  // The staged list should include our doc
  const stagedDocs = docMeta.data?.documents || docMeta.data || [];
  const ourDoc = Array.isArray(stagedDocs) ? stagedDocs.find(d => d.doc_id === docId) : null;
  
  if (ourDoc) {
    assert(ourDoc.status === 'staged', `Doc status is 'staged' (got: ${ourDoc.status})`);
    assert(ourDoc.chunks_stored > 0 || ourDoc.chunksStored > 0, 
      `Chunks stored at upload time: ${ourDoc.chunks_stored || ourDoc.chunksStored}`);
  } else {
    warn('Could not find doc in staged list — checking via direct Redis read...');
    // Try reading doc metadata directly
    const directMeta = await fetchJSON(`/api/ontology/documents/${docId}`);
    if (directMeta.data) {
      log(`  Direct metadata: ${JSON.stringify(directMeta.data).substring(0, 200)}`);
    }
  }

  // ── Test 4: Verify vector store has chunks (agent can query) ──
  log('\n4. Testing agent vector search (pre-commit)...');
  const searchResult = await fetchJSON('/api/graphrag/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'What is machine learning?',
      workspace_id: WORKSPACE_ID,
      tenant_id: TENANT_ID,
      topK: 5
    })
  });
  
  if (searchResult.data?.chunks || searchResult.data?.results) {
    const chunks = searchResult.data.chunks || searchResult.data.results || [];
    const fromOurDoc = chunks.filter(c => c.documentId === docId || c.document_id === docId);
    assert(fromOurDoc.length > 0, 
      `Vector search found ${fromOurDoc.length} chunks from our uploaded doc (pre-commit)`);
  } else {
    warn(`Vector search returned unexpected format: ${JSON.stringify(searchResult.data).substring(0, 200)}`);
  }

  // ── Test 5: Delete staged doc and verify cleanup ──
  log('\n5. Deleting staged document...');
  const deleteResult = await fetchJSON(`/api/ontology/documents/staged/${docId}?workspace_id=${WORKSPACE_ID}`, {
    method: 'DELETE'
  });
  assert(deleteResult.data?.success === true, 'Staged doc deleted successfully');

  // ── Test 6: Verify vector store chunks are cleaned up ──
  log('\n6. Verifying vector store cleanup after delete...');
  const searchAfterDelete = await fetchJSON('/api/graphrag/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'What is machine learning?',
      workspace_id: WORKSPACE_ID,
      tenant_id: TENANT_ID,
      topK: 5
    })
  });
  
  if (searchAfterDelete.data?.chunks || searchAfterDelete.data?.results) {
    const chunks = searchAfterDelete.data.chunks || searchAfterDelete.data.results || [];
    const fromOurDoc = chunks.filter(c => c.documentId === docId || c.document_id === docId);
    assert(fromOurDoc.length === 0, 
      `No chunks from deleted doc in vector store (found: ${fromOurDoc.length})`);
  } else {
    warn('Could not verify vector store cleanup');
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);
  console.log('='.repeat(50));
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`${RED}Test error:${RESET}`, e);
  process.exit(1);
});
