/**
 * PDF Handler - Extract text and metadata from PDF files
 */

const pdfParser = require('../pdfParser');
const logger = require('../../utils/logger');

class PDFHandler {
  /**
   * Extract content from PDF
   */
  async extract(filePath, options = {}) {
    try {
      const result = await pdfParser.extractText(filePath);
      
      return {
        text: result.text,
        pages: result.pages,
        metadata: {
          ...result.metadata,
          pageCount: result.pages?.length || 0,
          extractedAt: new Date().toISOString()
        },
        structured: {
          type: 'document',
          format: 'pdf',
          sections: this.extractSections(result.text),
          entities: this.extractBasicEntities(result.text)
        }
      };
    } catch (error) {
      logger.error('PDF extraction failed:', error);
      throw error;
    }
  }

  /**
   * Validate PDF file
   */
  async validate(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const buffer = await fs.readFile(filePath);
      
      // Check PDF signature
      if (!buffer.toString('ascii', 0, 4).includes('%PDF')) {
        return { valid: false, error: 'Invalid PDF file' };
      }

      return { 
        valid: true, 
        size: buffer.length,
        version: this.extractPDFVersion(buffer)
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get PDF schema/structure
   */
  async getSchema(filePath, options = {}) {
    try {
      const result = await pdfParser.extractText(filePath);
      
      return {
        type: 'document',
        format: 'pdf',
        structure: {
          pages: result.pages?.length || 0,
          hasText: !!result.text,
          textLength: result.text?.length || 0,
          sections: this.identifySections(result.text)
        }
      };
    } catch (error) {
      logger.error('PDF schema extraction failed:', error);
      return null;
    }
  }

  /**
   * Transform PDF to other formats
   */
  async transform(filePath, targetFormat, options = {}) {
    const result = await this.extract(filePath, options);
    
    switch (targetFormat) {
      case 'text':
        return result.text;
      case 'json':
        return JSON.stringify(result, null, 2);
      case 'markdown':
        return this.toMarkdown(result);
      default:
        throw new Error(`Unsupported target format: ${targetFormat}`);
    }
  }

  /**
   * Extract basic sections from text
   */
  extractSections(text) {
    if (!text) return [];
    
    const sections = [];
    const lines = text.split('\n');
    let currentSection = null;
    
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      
      // Detect headers (simple heuristic)
      if (trimmed.length > 0 && trimmed.length < 100 && 
          (trimmed.match(/^[A-Z\s]+$/) || trimmed.endsWith(':'))) {
        
        if (currentSection) {
          sections.push(currentSection);
        }
        
        currentSection = {
          title: trimmed,
          startLine: index,
          content: []
        };
      } else if (currentSection && trimmed.length > 0) {
        currentSection.content.push(trimmed);
      }
    });
    
    if (currentSection) {
      sections.push(currentSection);
    }
    
    return sections;
  }

  /**
   * Extract basic entities
   */
  extractBasicEntities(text) {
    if (!text) return [];
    
    const entities = [];
    
    // Email addresses
    const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g);
    if (emails) {
      emails.forEach(email => {
        entities.push({ type: 'email', value: email });
      });
    }
    
    // Phone numbers
    const phones = text.match(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g);
    if (phones) {
      phones.forEach(phone => {
        entities.push({ type: 'phone', value: phone });
      });
    }
    
    // Dates
    const dates = text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g);
    if (dates) {
      dates.forEach(date => {
        entities.push({ type: 'date', value: date });
      });
    }
    
    return entities;
  }

  /**
   * Extract PDF version from buffer
   */
  extractPDFVersion(buffer) {
    const header = buffer.toString('ascii', 0, 20);
    const match = header.match(/%PDF-(\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Identify document sections
   */
  identifySections(text) {
    if (!text) return [];
    
    const sections = [];
    const commonSections = [
      'summary', 'abstract', 'introduction', 'background',
      'methodology', 'results', 'conclusion', 'references',
      'experience', 'education', 'skills', 'contact'
    ];
    
    commonSections.forEach(section => {
      const regex = new RegExp(`\\b${section}\\b`, 'i');
      if (regex.test(text)) {
        sections.push(section);
      }
    });
    
    return sections;
  }

  /**
   * Convert to Markdown format
   */
  toMarkdown(result) {
    let markdown = `# Document\n\n`;
    
    if (result.metadata) {
      markdown += `**Pages:** ${result.metadata.pageCount || 'Unknown'}\n\n`;
    }
    
    if (result.structured?.sections) {
      result.structured.sections.forEach(section => {
        markdown += `## ${section.title}\n\n`;
        markdown += section.content.join('\n\n') + '\n\n';
      });
    } else {
      markdown += result.text;
    }
    
    return markdown;
  }
}

module.exports = new PDFHandler();
