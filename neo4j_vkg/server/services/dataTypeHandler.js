/**
 * Data Type Handler - Manages all supported data formats
 */

const logger = require('../utils/logger');

class DataTypeHandler {
  constructor() {
    this.handlers = new Map();
    this.registerDefaultHandlers();
  }

  /**
   * Register default handlers for common data types
   */
  registerDefaultHandlers() {
    // Document handlers
    this.registerHandler('pdf', require('./handlers/pdfHandler'));
    this.registerHandler('text', require('./handlers/textHandler'));

    // Structured data handlers
    this.registerHandler('csv', require('./handlers/csvHandler'));
    this.registerHandler('json', require('./handlers/jsonHandler'));
    this.registerHandler('xml', require('./handlers/xmlHandler'));
    this.registerHandler('excel', require('./handlers/excelHandler'));
  }

  /**
   * Register a custom handler
   */
  registerHandler(type, handler) {
    if (!handler.extract || typeof handler.extract !== 'function') {
      throw new Error(`Handler for type '${type}' must have an extract method`);
    }
    this.handlers.set(type, handler);
    logger.info(`📝 Registered handler for type: ${type}`);
  }

  /**
   * Get handler for data type
   */
  getHandler(type) {
    return this.handlers.get(type);
  }

  /**
   * Check if type is supported
   */
  isSupported(type) {
    return this.handlers.has(type);
  }

  /**
   * Get all supported types
   */
  getSupportedTypes() {
    return Array.from(this.handlers.keys());
  }

  /**
   * Process data with appropriate handler
   */
  async processData(type, source, options = {}) {
    const handler = this.getHandler(type);
    if (!handler) {
      throw new Error(`No handler registered for type: ${type}`);
    }

    try {
      logger.info(`🔄 Processing ${type} data`);
      const result = await handler.extract(source, options);
      
      return {
        type,
        ...result,
        processedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error(`Failed to process ${type} data:`, error);
      throw error;
    }
  }

  /**
   * Batch process multiple data sources
   */
  async processBatch(sources, options = {}) {
    const results = [];
    
    for (const source of sources) {
      try {
        const result = await this.processData(source.type, source.data, {
          ...options,
          ...source.options
        });
        results.push({ success: true, source: source.id, result });
      } catch (error) {
        logger.error(`Batch processing failed for ${source.id}:`, error);
        results.push({ 
          success: false, 
          source: source.id, 
          error: error.message 
        });
      }
    }

    return results;
  }

  /**
   * Auto-detect data type from content
   */
  detectType(content, filename = null) {
    // File extension detection
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const extMap = {
        'pdf': 'pdf',
        'txt': 'text',
        'md': 'text',
        'doc': 'doc',
        'docx': 'docx',
        'csv': 'csv',
        'json': 'json',
        'xml': 'xml',
        'xlsx': 'excel',
        'xls': 'excel',
        'ttl': 'turtle',
        'rdf': 'rdf',
        'owl': 'owl',
        'jpg': 'image',
        'jpeg': 'image',
        'png': 'image',
        'gif': 'image',
        'mp3': 'audio',
        'wav': 'audio',
        'mp4': 'video',
        'avi': 'video'
      };
      
      if (extMap[ext] && this.isSupported(extMap[ext])) {
        return extMap[ext];
      }
    }

    // Content-based detection
    if (typeof content === 'string') {
      const sample = content.substring(0, 1000);
      
      if (sample.includes('%PDF-')) return 'pdf';
      if (sample.includes('<?xml')) return 'xml';
      if (sample.startsWith('{') || sample.startsWith('[')) return 'json';
      if (sample.includes('@prefix') || sample.includes('@base')) return 'turtle';
      
      // CSV detection
      const lines = sample.split('\n').slice(0, 5);
      if (lines.length > 1 && lines.every(line => line.includes(','))) {
        return 'csv';
      }
      
      return 'text';
    }

    // Binary content detection would go here
    return 'unknown';
  }

  /**
   * Validate data before processing
   */
  async validateData(type, source, options = {}) {
    const handler = this.getHandler(type);
    if (!handler) {
      return { valid: false, error: `Unsupported type: ${type}` };
    }

    if (handler.validate) {
      try {
        const validation = await handler.validate(source, options);
        return { valid: true, ...validation };
      } catch (error) {
        return { valid: false, error: error.message };
      }
    }

    return { valid: true };
  }

  /**
   * Get schema/structure for data type
   */
  async getSchema(type, source, options = {}) {
    const handler = this.getHandler(type);
    if (!handler || !handler.getSchema) {
      return null;
    }

    try {
      return await handler.getSchema(source, options);
    } catch (error) {
      logger.error(`Failed to get schema for ${type}:`, error);
      return null;
    }
  }

  /**
   * Transform data to standard format
   */
  async transform(type, source, targetFormat, options = {}) {
    const handler = this.getHandler(type);
    if (!handler || !handler.transform) {
      throw new Error(`Transform not supported for type: ${type}`);
    }

    try {
      return await handler.transform(source, targetFormat, options);
    } catch (error) {
      logger.error(`Failed to transform ${type} to ${targetFormat}:`, error);
      throw error;
    }
  }
}

module.exports = new DataTypeHandler();
