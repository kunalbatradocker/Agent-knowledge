#!/usr/bin/env node
require('dotenv').config();

async function testBedrock() {
  const region = process.env.AWS_REGION || 'us-east-1';
  const modelId = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;

  console.log(`Testing Bedrock with region: ${region}, model: ${modelId}`);
  console.log(`Using: ${apiKey ? 'API Key (Bearer token)' : 'SDK (SigV4)'}\n`);

  if (apiKey) {
    // Use Bedrock API key with Converse API
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse`;
    const body = {
      messages: [{ role: 'user', content: [{ text: 'Say hello in one sentence.' }] }]
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });

      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      const result = await response.json();
      console.log('✅ Bedrock working! Response:', result.output.message.content[0].text);
    } catch (err) {
      console.error('❌ Bedrock error:', err.message);
    }
  } else {
    // Fall back to SDK
    const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region });

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in one sentence.' }] }]
    };

    try {
      const response = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        body: JSON.stringify(body)
      }));

      const result = JSON.parse(new TextDecoder().decode(response.body));
      console.log('✅ Bedrock working! Response:', result.content[0].text);
    } catch (err) {
      console.error('❌ Bedrock error:', err.message);
    }
  }
}

testBedrock();
