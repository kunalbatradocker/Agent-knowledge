/**
 * Universal Data Processor - Handles all data types with enhanced extraction
 */

const enhancedExtractionService = require('./enhancedExtractionService');
const dataTypeHandler = require('./dataTypeHandler');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

class UniversalDataProcessor {
  constructor() {
    this.supportedTypes = dataTypeHandler.getSupportedTypes();
  }

  /**
   * Process any file type with enhanced extraction
   */
  async processFile(filePath, options = {}) {
    const {
      ontologyId,
      tenantId = 'default',
      workspaceId = 'default',
      extractionApproaches = ['ner', 'llm', 'patterns'],
      userFeedback = null
    } = options;

    try {
      logger.info(`🔄 Processing file: ${path.basename(filePath)}`);

      // Detect file type
      const fileType = await this.detectFileType(filePath);
      logger.info(`📄 Detected type: ${fileType}`);

      // Extract content using appropriate handler
      const content = await dataTypeHandler.processData(fileType, filePath, options);

      // Apply enhanced extraction if ontology provided
      let extraction = null;
      if (ontologyId && content.text) {
        extraction = await enhancedExtractionService.extract(content.text, ontologyId, {
          approaches: extractionApproaches,
          tenantId,
          workspaceId,
          userFeedback
        });
      }

      return {
        fileType,
        content,
        extraction,
        metadata: {
          fileName: path.basename(filePath),
          fileSize: (await fs.stat(filePath)).size,
          processedAt: new Date().toISOString(),
          ontologyId,
          handler: fileType
        }
      };

    } catch (error) {
      logger.error(`Failed to process file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Detect file type using data type handler
   */
  async detectFileType(filePath) {
    try {
      const content = await fs.readFile(filePath);
      const filename = path.basename(filePath);
      
      return dataTypeHandler.detectType(content.toString('utf8', 0, 1000), filename);
    } catch (error) {
      logger.warn('File type detection failed, defaulting to text:', error.message);
      return 'text';
    }
  }

  /**
   * Process multiple files in batch
   */
  async processBatch(filePaths, options = {}) {
    const results = [];
    
    for (const filePath of filePaths) {
      try {
        const result = await this.processFile(filePath, options);
        results.push({ success: true, filePath, result });
      } catch (error) {
        logger.error(`Batch processing failed for ${filePath}:`, error);
        results.push({ success: false, filePath, error: error.message });
      }
    }

    return results;
  }

  /**
   * Get supported file types
   */
  getSupportedTypes() {
    return dataTypeHandler.getSupportedTypes();
  }

  /**
   * Check if file type is supported
   */
  isSupported(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);
    
    try {
      const detectedType = dataTypeHandler.detectType('', filename);
      return dataTypeHandler.isSupported(detectedType);
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate file before processing
   */
  async validateFile(filePath, options = {}) {
    try {
      const fileType = await this.detectFileType(filePath);
      return await dataTypeHandler.validateData(fileType, filePath, options);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get file schema/structure
   */
  async getFileSchema(filePath, options = {}) {
    try {
      const fileType = await this.detectFileType(filePath);
      return await dataTypeHandler.getSchema(fileType, filePath, options);
    } catch (error) {
      logger.error('Schema extraction failed:', error);
      return null;
    }
  }

  /**
   * Transform file to different format
   */
  async transformFile(filePath, targetFormat, options = {}) {
    try {
      const fileType = await this.detectFileType(filePath);
      return await dataTypeHandler.transform(fileType, filePath, targetFormat, options);
    } catch (error) {
      logger.error('File transformation failed:', error);
      throw error;
    }
  }

  /**
   * Process data from memory (not file)
   */
  async processData(data, dataType, options = {}) {
    const {
      ontologyId,
      tenantId = 'default',
      workspaceId = 'default',
      extractionApproaches = ['ner', 'llm', 'patterns'],
      userFeedback = null
    } = options;

    try {
      logger.info(`🔄 Processing ${dataType} data from memory`);

      // Process with appropriate handler
      const content = await dataTypeHandler.processData(dataType, data, options);

      // Apply enhanced extraction if ontology provided
      let extraction = null;
      if (ontologyId && content.text) {
        extraction = await enhancedExtractionService.extract(content.text, ontologyId, {
          approaches: extractionApproaches,
          tenantId,
          workspaceId,
          userFeedback
        });
      }

      return {
        dataType,
        content,
        extraction,
        metadata: {
          processedAt: new Date().toISOString(),
          ontologyId,
          handler: dataType,
          source: 'memory'
        }
      };

    } catch (error) {
      logger.error(`Failed to process ${dataType} data:`, error);
      throw error;
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      supportedTypes: this.getSupportedTypes().length,
      handlers: dataTypeHandler.getSupportedTypes(),
      extractionApproaches: ['ner', 'llm', 'patterns', 'hybrid']
    };
  }
}

module.exports = new UniversalDataProcessor();
