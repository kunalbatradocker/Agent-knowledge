/**
 * Chunk Classification Service
 * LLM-only classification of document chunks by context type
 */

const llmService = require('./llmService');
const logger = require('../utils/logger');

class ChunkClassificationService {
  /**
   * Classify a chunk's context type using LLM
   */
  async classifyChunk(chunkText, options = {}) {
    if (options.context_type) {
      return options.context_type;
    }

    const systemPrompt = `You are a document analyst. Classify text chunks by their semantic role.

Return ONLY one of these types:
- definition: Explains what something is or means
- policy_rule: States requirements, rules, or regulations
- example: Illustrates a concept with a specific case
- procedure_step: Describes steps in a process
- summary: Condenses or concludes information
- reference: Citations, links, or pointers to other content
- faq: Question and answer format
- warning: Alerts, cautions, or important notices
- general_content: Standard informational content

Output only the type name, nothing else.`;

    try {
      const result = await llmService.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunkText.substring(0, 500) }
      ], { maxTokens: 20, temperature: 0.1 });

      const cleaned = result.trim().toLowerCase();
      const validTypes = ['definition', 'policy_rule', 'example', 'procedure_step', 'summary', 'reference', 'faq', 'warning', 'general_content'];
      
      return validTypes.includes(cleaned) ? cleaned : 'general_content';
    } catch (error) {
      logger.error('Chunk classification failed:', error.message);
      return 'general_content';
    }
  }

  /**
   * Classify multiple chunks in batch
   */
  async classifyChunks(chunks) {
    const results = [];
    for (const chunk of chunks) {
      const contextType = await this.classifyChunk(chunk.text || chunk);
      results.push({ ...chunk, context_type: contextType });
    }
    return results;
  }

  /**
   * Extract section info using LLM
   */
  extractSectionInfo(chunkText, metadata = {}) {
    if (metadata.section_title || metadata.heading_path) {
      return {
        section_title: metadata.section_title || null,
        heading_path: metadata.heading_path || null
      };
    }
    return { section_title: null, heading_path: null };
  }
}

module.exports = new ChunkClassificationService();
