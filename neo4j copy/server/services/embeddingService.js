const OpenAI = require('openai');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config();

// Lazy-loaded to avoid circular dependency with llmService
let _llmRequestContext = null;
function getLLMRequestContext() {
  if (!_llmRequestContext) {
    _llmRequestContext = require('./llmService').llmRequestContext;
  }
  return _llmRequestContext;
}

class EmbeddingService {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'ollama';
    this.useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    this.embeddingDimension = parseInt(process.env.EMBEDDING_DIMENSION) || 1024;
    this.client = null;
    this.bedrockClient = null;
    this.bedrockRegion = process.env.AWS_REGION || 'us-east-1';

    if (this.provider === 'bedrock') {
      this.bedrockClient = new BedrockRuntimeClient({ region: this.bedrockRegion });
      this.embeddingModel = process.env.BEDROCK_EMBEDDING_MODEL || 'amazon.titan-embed-text-v2:0';
      this.embeddingDimension = parseInt(process.env.EMBEDDING_DIMENSION) || 1024;
      console.log(`Embedding service using Bedrock: ${this.embeddingModel}`);
    } else if (this.useLocalLLM) {
      const localLLMBaseURL = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1';
      this.client = new OpenAI({ baseURL: localLLMBaseURL, apiKey: process.env.OPENAI_API_KEY || 'ollama' });
      this.embeddingModel = process.env.LOCAL_EMBEDDING_MODEL || 'nomic-embed-text';
      console.log(`Embedding service using local LLM at: ${localLLMBaseURL}`);
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      this.client = apiKey && apiKey !== 'ollama' ? new OpenAI({ apiKey }) : null;
      this.embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    }
  }

  /**
   * Generate embedding for a single text with retry logic and timeout
   */
  async generateEmbedding(text, retries = 3) {
    if (!this.client && !this.bedrockClient) {
      throw new Error('Embedding service not configured. Check your LLM settings.');
    }

    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.slice(0, maxLength) : text;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (this.bedrockClient) {
          return await this._bedrockEmbed(truncatedText);
        }

        const response = await Promise.race([
          this.client.embeddings.create({ model: this.embeddingModel, input: truncatedText }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Embedding request timeout')), 30000))
        ]);
        return response.data[0].embedding;
      } catch (error) {
        const isRetryable = error.message.includes('EOF') || 
                           error.message.includes('ECONNRESET') ||
                           error.message.includes('timeout') ||
                           error.status === 500;

        if (isRetryable && attempt < retries) {
          console.warn(`⚠️ Embedding attempt ${attempt}/${retries} failed, retrying in ${attempt * 2}s...`);
          await new Promise(resolve => setTimeout(resolve, attempt * 2000));
          continue;
        }

        console.error(`❌ Error generating embedding (attempt ${attempt}/${retries}):`, error.message);
        
        // Provide helpful error message
        if (error.message.includes('EOF') || error.message.includes('ECONNRESET')) {
          throw new Error(`Ollama connection lost. Make sure Ollama is running and the model "${this.embeddingModel}" is available. Run: ollama pull ${this.embeddingModel}`);
        }
        
        throw new Error(`Failed to generate embedding: ${error.message}`);
      }
    }
  }

  /**
   * Generate embeddings for multiple texts (parallel batch)
   */
  async generateEmbeddings(texts) {
    if (!this.client && !this.bedrockClient) {
      throw new Error('Embedding service not configured. Check your LLM settings.');
    }

    const parallelism = parseInt(process.env.EMBEDDING_PARALLELISM) || 10;

    // Bedrock and local LLMs: process in parallel batches
    if (this.bedrockClient || this.useLocalLLM) {
      const embeddings = [];
      console.log(`   🚀 Generating ${texts.length} embeddings (parallelism: ${parallelism})...`);
      
      for (let i = 0; i < texts.length; i += parallelism) {
        const batch = texts.slice(i, i + parallelism);
        const batchResults = await Promise.all(batch.map(text => this.generateEmbedding(text)));
        embeddings.push(...batchResults);
        
        if (texts.length > parallelism) {
          console.log(`   ✓ Embedded ${Math.min(i + parallelism, texts.length)}/${texts.length}`);
        }
      }
      return embeddings;
    }

    // OpenAI supports batch embedding natively
    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: texts
    });
    return response.data.map(d => d.embedding);
  }

  /**
   * Generate embedding via Bedrock Titan.
   * Uses per-user bearer token (from AsyncLocalStorage) if available,
   * falling back to the AWS SDK credential chain.
   */
  async _bedrockEmbed(text) {
    // Check for per-user bearer token from request context
    const llmCtx = getLLMRequestContext();
    const requestCtx = llmCtx ? llmCtx.getStore() : null;
    const rawToken = requestCtx?.bedrockToken || process.env.AWS_BEARER_TOKEN_BEDROCK;

    if (!rawToken) {
      throw new Error('No Bedrock bearer token available for embeddings. Click the 🔑 LLM Token button to add your token.');
    }

    // Ensure the token has the required "bedrock-api-key-" prefix
    const bearerToken = rawToken.startsWith('bedrock-api-key-') ? rawToken : `bedrock-api-key-${rawToken}`;

    // Extract the signing region from the token — API call MUST use the same region
    let effectiveRegion = this.bedrockRegion;
    try {
      const b64 = rawToken.replace(/^bedrock-api-key-/, '');
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const regionMatch = decoded.match(/X-Amz-Credential=[^%]+%2F\d+%2F([^%]+)%2F/);
      if (regionMatch) effectiveRegion = regionMatch[1];
    } catch { /* use default region */ }

    const url = `https://bedrock-runtime.${effectiveRegion}.amazonaws.com/model/${encodeURIComponent(this.embeddingModel)}/invoke`;
    const body = JSON.stringify({
      inputText: text,
      dimensions: this.embeddingDimension,
      normalize: true
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${bearerToken}`
      },
      body
    });

    if (!response.ok) {
      const respBody = await response.text();
      if (response.status === 403) {
        throw new Error('Bedrock embedding auth failed (403). Your bearer token has likely expired. Click the 🔑 LLM Token button to update it.');
      }
      throw new Error(`Bedrock embedding API error ${response.status}: ${respBody}`);
    }

    const result = await response.json();
    return result.embedding;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (normA * normB);
  }

  /**
   * Find most similar embeddings from a list
   */
  findMostSimilar(queryEmbedding, embeddings, topK = 5) {
    const similarities = embeddings.map((emb, index) => ({
      index,
      similarity: this.cosineSimilarity(queryEmbedding, emb.embedding),
      ...emb
    }));

    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Get embedding model name
   */
  getModelName() {
    return this.embeddingModel;
  }

  /**
   * Get embedding model info
   */
  getModelInfo() {
    return {
      model: this.embeddingModel,
      dimension: this.embeddingDimension,
      isLocal: this.useLocalLLM,
      baseURL: this.useLocalLLM ? (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1') : 'https://api.openai.com'
    };
  }
}

module.exports = new EmbeddingService();

