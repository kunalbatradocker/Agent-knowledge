#!/usr/bin/env node
/**
 * Quick test: verify Bedrock bearer token handling.
 * Tests the exact same logic as the fixed llmService._callBedrock.
 * Usage: node scripts/test-bedrock-token.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const rawToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
if (!rawToken) {
  console.error('❌ AWS_BEARER_TOKEN_BEDROCK not set in .env');
  process.exit(1);
}

// Same logic as llmService
const bearerToken = rawToken.startsWith('bedrock-api-key-') ? rawToken : `bedrock-api-key-${rawToken}`;

// Parse token details
const b64 = rawToken.replace(/^bedrock-api-key-/, '');
const decoded = Buffer.from(b64, 'base64').toString('utf-8');
const dateMatch = decoded.match(/X-Amz-Date=(\d{8}T\d{6}Z)/);
const expiresMatch = decoded.match(/X-Amz-Expires=(\d+)/);
const regionMatch = decoded.match(/X-Amz-Credential=[^%]+%2F\d+%2F([^%]+)%2F/);

const tokenRegion = regionMatch ? regionMatch[1] : null;
const envRegion = process.env.AWS_REGION || 'us-west-2';
const effectiveRegion = tokenRegion || envRegion;

console.log('=== Token Analysis ===');
console.log(`Has prefix: ${rawToken.startsWith('bedrock-api-key-')}`);
console.log(`Bearer token length: ${bearerToken.length}`);
console.log(`ENV region: ${envRegion}`);
console.log(`Token signing region: ${tokenRegion}`);
console.log(`Effective region (auto-detected): ${effectiveRegion}`);

if (dateMatch && expiresMatch) {
  const issuedAt = new Date(dateMatch[1].replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
  const expiresInSec = parseInt(expiresMatch[1]);
  const expiresAt = new Date(issuedAt.getTime() + expiresInSec * 1000);
  const remaining = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  console.log(`Issued: ${issuedAt.toISOString()}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`Remaining: ${remaining}s (${remaining > 0 ? '✅ VALID' : '❌ EXPIRED'})`);
}

const model = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
const url = `https://bedrock-runtime.${effectiveRegion}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

console.log(`\n=== Bedrock API Test ===`);
console.log(`URL: ${url}`);

async function testCall() {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: 'Say hello in one word.' }] }],
        inferenceConfig: { maxTokens: 10, temperature: 0.1 }
      })
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Response: ${data.output?.message?.content?.[0]?.text}`);
    } else {
      const body = await response.text();
      console.log(`❌ Error: ${body.substring(0, 500)}`);
    }
  } catch (e) {
    console.error(`❌ Fetch error: ${e.message}`);
  }
}

testCall();
