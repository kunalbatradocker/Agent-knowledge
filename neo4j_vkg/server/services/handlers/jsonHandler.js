/**
 * JSON Handler - Process JSON files with structure analysis
 */

const logger = require('../../utils/logger');

class JSONHandler {
  /**
   * Extract content from JSON
   */
  async extract(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content);
      
      const analysis = this.analyzeStructure(data);
      const text = this.jsonToText(data);
      const graph = this.toGraph(data, options);
      
      return {
        text: text,
        structured: {
          type: 'json',
          format: 'json',
          data: data,
          analysis: analysis,
          graph: graph
        },
        metadata: {
          size: content.length,
          depth: this.calculateDepth(data),
          keys: this.extractAllKeys(data),
          extractedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('JSON extraction failed:', error);
      throw error;
    }
  }

  /**
   * Validate JSON file
   */
  async validate(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const content = await fs.readFile(filePath, 'utf8');
      
      try {
        const data = JSON.parse(content);
        return { 
          valid: true,
          type: Array.isArray(data) ? 'array' : typeof data,
          size: content.length,
          preview: this.getPreview(data)
        };
      } catch (parseError) {
        return { 
          valid: false, 
          error: `Invalid JSON: ${parseError.message}` 
        };
      }
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get JSON schema
   */
  async getSchema(filePath, options = {}) {
    try {
      const result = await this.extract(filePath, options);
      
      return {
        type: 'json',
        format: 'json',
        structure: {
          rootType: Array.isArray(result.structured.data) ? 'array' : 'object',
          schema: this.generateSchema(result.structured.data),
          depth: result.metadata.depth,
          totalKeys: result.metadata.keys.length,
          uniqueKeys: [...new Set(result.metadata.keys)].length
        }
      };
    } catch (error) {
      logger.error('JSON schema extraction failed:', error);
      return null;
    }
  }

  /**
   * Transform JSON to other formats
   */
  async transform(filePath, targetFormat, options = {}) {
    const result = await this.extract(filePath, options);
    
    switch (targetFormat) {
      case 'text':
        return result.text;
      case 'csv':
        return this.toCSV(result.structured.data);
      case 'graph':
        return result.structured.graph;
      case 'xml':
        return this.toXML(result.structured.data);
      case 'yaml':
        return this.toYAML(result.structured.data);
      default:
        throw new Error(`Unsupported target format: ${targetFormat}`);
    }
  }

  /**
   * Convert JSON to readable text
   */
  jsonToText(obj, prefix = '', depth = 0) {
    if (depth > 10) return `${prefix}[Max depth reached]`;
    
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      return `${prefix}${obj}`;
    }
    
    if (obj === null || obj === undefined) {
      return `${prefix}null`;
    }
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return `${prefix}[]`;
      return obj.map((item, i) => 
        this.jsonToText(item, `${prefix}[${i}] `, depth + 1)
      ).join('\n');
    }
    
    if (typeof obj === 'object') {
      const entries = Object.entries(obj);
      if (entries.length === 0) return `${prefix}{}`;
      
      return entries.map(([key, value]) => 
        this.jsonToText(value, `${prefix}${key}: `, depth + 1)
      ).join('\n');
    }
    
    return `${prefix}${String(obj)}`;
  }

  /**
   * Analyze JSON structure
   */
  analyzeStructure(data) {
    const analysis = {
      type: Array.isArray(data) ? 'array' : typeof data,
      depth: this.calculateDepth(data),
      keys: this.extractAllKeys(data),
      patterns: this.detectPatterns(data),
      statistics: this.calculateStatistics(data)
    };
    
    return analysis;
  }

  /**
   * Calculate maximum depth
   */
  calculateDepth(obj, currentDepth = 0) {
    if (typeof obj !== 'object' || obj === null) {
      return currentDepth;
    }
    
    if (Array.isArray(obj)) {
      return Math.max(currentDepth, ...obj.map(item => 
        this.calculateDepth(item, currentDepth + 1)
      ));
    }
    
    const depths = Object.values(obj).map(value => 
      this.calculateDepth(value, currentDepth + 1)
    );
    
    return depths.length > 0 ? Math.max(currentDepth, ...depths) : currentDepth;
  }

  /**
   * Extract all keys from nested structure
   */
  extractAllKeys(obj, keys = []) {
    if (typeof obj !== 'object' || obj === null) {
      return keys;
    }
    
    if (Array.isArray(obj)) {
      obj.forEach(item => this.extractAllKeys(item, keys));
      return keys;
    }
    
    Object.entries(obj).forEach(([key, value]) => {
      keys.push(key);
      this.extractAllKeys(value, keys);
    });
    
    return keys;
  }

  /**
   * Detect common patterns in JSON
   */
  detectPatterns(data) {
    const patterns = [];
    
    if (Array.isArray(data) && data.length > 0) {
      // Check if array contains objects with similar structure
      const firstItem = data[0];
      if (typeof firstItem === 'object' && firstItem !== null) {
        const firstKeys = Object.keys(firstItem);
        const similarStructure = data.slice(1, 10).every(item => {
          if (typeof item !== 'object' || item === null) return false;
          const itemKeys = Object.keys(item);
          return firstKeys.length === itemKeys.length && 
                 firstKeys.every(key => itemKeys.includes(key));
        });
        
        if (similarStructure) {
          patterns.push({
            type: 'homogeneous_array',
            description: 'Array of objects with similar structure',
            confidence: 0.9
          });
        }
      }
    }
    
    // Detect ID patterns
    const allKeys = this.extractAllKeys(data);
    const idKeys = allKeys.filter(key => 
      key.toLowerCase().includes('id') || 
      key.toLowerCase() === 'key'
    );
    
    if (idKeys.length > 0) {
      patterns.push({
        type: 'identifier_fields',
        fields: [...new Set(idKeys)],
        confidence: 0.8
      });
    }
    
    return patterns;
  }

  /**
   * Calculate basic statistics
   */
  calculateStatistics(data) {
    const stats = {
      totalNodes: 0,
      leafNodes: 0,
      arrayCount: 0,
      objectCount: 0,
      primitiveCount: 0
    };
    
    this.traverseAndCount(data, stats);
    return stats;
  }

  /**
   * Traverse and count nodes
   */
  traverseAndCount(obj, stats) {
    stats.totalNodes++;
    
    if (typeof obj !== 'object' || obj === null) {
      stats.leafNodes++;
      stats.primitiveCount++;
      return;
    }
    
    if (Array.isArray(obj)) {
      stats.arrayCount++;
      obj.forEach(item => this.traverseAndCount(item, stats));
    } else {
      stats.objectCount++;
      Object.values(obj).forEach(value => this.traverseAndCount(value, stats));
    }
  }

  /**
   * Convert to graph representation
   */
  toGraph(data, options = {}) {
    const nodes = [];
    const edges = [];
    let nodeId = 0;
    
    const traverse = (obj, parentId = null, key = null) => {
      const currentId = nodeId++;
      
      if (typeof obj !== 'object' || obj === null) {
        nodes.push({
          id: currentId,
          label: key || 'value',
          type: typeof obj,
          value: obj
        });
      } else if (Array.isArray(obj)) {
        nodes.push({
          id: currentId,
          label: key || 'array',
          type: 'array',
          size: obj.length
        });
        
        obj.forEach((item, index) => {
          const childId = traverse(item, currentId, `[${index}]`);
          edges.push({
            source: currentId,
            target: childId,
            type: 'contains',
            index: index
          });
        });
      } else {
        nodes.push({
          id: currentId,
          label: key || 'object',
          type: 'object',
          keys: Object.keys(obj)
        });
        
        Object.entries(obj).forEach(([objKey, value]) => {
          const childId = traverse(value, currentId, objKey);
          edges.push({
            source: currentId,
            target: childId,
            type: 'property',
            key: objKey
          });
        });
      }
      
      if (parentId !== null) {
        // Edge already created by parent
      }
      
      return currentId;
    };
    
    traverse(data);
    
    return { nodes, edges };
  }

  /**
   * Generate JSON schema
   */
  generateSchema(data) {
    if (typeof data !== 'object' || data === null) {
      return { type: typeof data };
    }
    
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return { type: 'array', items: {} };
      }
      
      // Analyze first few items to determine schema
      const itemSchemas = data.slice(0, 5).map(item => this.generateSchema(item));
      return {
        type: 'array',
        items: itemSchemas[0] // Simplified - could merge schemas
      };
    }
    
    const properties = {};
    Object.entries(data).forEach(([key, value]) => {
      properties[key] = this.generateSchema(value);
    });
    
    return {
      type: 'object',
      properties: properties
    };
  }

  /**
   * Get preview of data
   */
  getPreview(data, maxItems = 3) {
    if (typeof data !== 'object' || data === null) {
      return data;
    }
    
    if (Array.isArray(data)) {
      return data.slice(0, maxItems);
    }
    
    const entries = Object.entries(data).slice(0, maxItems);
    return Object.fromEntries(entries);
  }

  /**
   * Convert to CSV (for array of objects)
   */
  toCSV(data) {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('CSV conversion requires array of objects');
    }
    
    const firstItem = data[0];
    if (typeof firstItem !== 'object' || firstItem === null) {
      throw new Error('CSV conversion requires objects in array');
    }
    
    const headers = Object.keys(firstItem);
    const csvRows = [headers.join(',')];
    
    data.forEach(item => {
      const row = headers.map(header => {
        const value = item[header];
        if (typeof value === 'string' && value.includes(',')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value || '';
      });
      csvRows.push(row.join(','));
    });
    
    return csvRows.join('\n');
  }

  /**
   * Convert to XML
   */
  toXML(data, rootElement = 'root') {
    const xmlEscape = (str) => {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
    
    const toXMLRecursive = (obj, elementName = 'item') => {
      if (typeof obj !== 'object' || obj === null) {
        return `<${elementName}>${xmlEscape(obj)}</${elementName}>`;
      }
      
      if (Array.isArray(obj)) {
        return obj.map(item => toXMLRecursive(item, elementName)).join('');
      }
      
      const content = Object.entries(obj)
        .map(([key, value]) => toXMLRecursive(value, key))
        .join('');
      
      return `<${elementName}>${content}</${elementName}>`;
    };
    
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXMLRecursive(data, rootElement)}`;
  }

  /**
   * Convert to YAML
   */
  toYAML(data, indent = 0) {
    const spaces = '  '.repeat(indent);
    
    if (typeof data !== 'object' || data === null) {
      return String(data);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => 
        `${spaces}- ${this.toYAML(item, indent + 1)}`
      ).join('\n');
    }
    
    return Object.entries(data)
      .map(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          return `${spaces}${key}:\n${this.toYAML(value, indent + 1)}`;
        }
        return `${spaces}${key}: ${this.toYAML(value, indent)}`;
      })
      .join('\n');
  }
}

module.exports = new JSONHandler();
