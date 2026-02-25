/**
 * CSV Handler - Process CSV files with graph conversion
 */

const csvParser = require('../csvParser');
const logger = require('../../utils/logger');

class CSVHandler {
  /**
   * Extract content from CSV
   */
  async extract(filePath, options = {}) {
    try {
      const data = await csvParser.parse(filePath, options);
      const analysis = csvParser.analyzeStructure(data);
      const graph = csvParser.toGraph(data, analysis.recommended);
      
      return {
        text: this.csvToText(data),
        structured: {
          type: 'tabular',
          format: 'csv',
          data: data,
          headers: analysis.columns,
          rowCount: data.length,
          columnCount: analysis.columns.length,
          analysis: analysis,
          graph: graph
        },
        metadata: {
          rowCount: data.length,
          columnCount: analysis.columns.length,
          extractedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('CSV extraction failed:', error);
      throw error;
    }
  }

  /**
   * Validate CSV file
   */
  async validate(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const content = await fs.readFile(filePath, 'utf8');
      
      // Basic CSV validation
      const lines = content.split('\n').filter(line => line.trim());
      if (lines.length < 2) {
        return { valid: false, error: 'CSV must have at least header and one data row' };
      }

      // Check for consistent column count
      const headerCols = lines[0].split(',').length;
      const inconsistentRows = lines.slice(1, 10).filter(line => 
        line.split(',').length !== headerCols
      );

      return { 
        valid: true, 
        warnings: inconsistentRows.length > 0 ? 
          [`${inconsistentRows.length} rows have inconsistent column count`] : [],
        preview: {
          totalRows: lines.length,
          columns: headerCols,
          sampleRows: lines.slice(0, 3)
        }
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get CSV schema
   */
  async getSchema(filePath, options = {}) {
    try {
      const data = await csvParser.parse(filePath, { ...options, maxRows: 100 });
      const analysis = csvParser.analyzeStructure(data);
      
      return {
        type: 'tabular',
        format: 'csv',
        structure: {
          columns: analysis.columns.map(col => ({
            name: col,
            type: analysis.suggestions[col]?.type || 'text',
            uniqueCount: analysis.suggestions[col]?.uniqueCount || 0,
            nullCount: analysis.suggestions[col]?.nullCount || 0,
            sampleValues: analysis.suggestions[col]?.sampleValues || []
          })),
          recommended: analysis.recommended,
          totalRows: data.length
        }
      };
    } catch (error) {
      logger.error('CSV schema extraction failed:', error);
      return null;
    }
  }

  /**
   * Transform CSV to other formats
   */
  async transform(filePath, targetFormat, options = {}) {
    const result = await this.extract(filePath, options);
    
    switch (targetFormat) {
      case 'json':
        return JSON.stringify(result.structured.data, null, 2);
      case 'text':
        return result.text;
      case 'graph':
        return result.structured.graph;
      case 'sql':
        return this.toSQL(result.structured.data, options.tableName || 'data');
      default:
        throw new Error(`Unsupported target format: ${targetFormat}`);
    }
  }

  /**
   * Convert CSV data to readable text
   */
  csvToText(data) {
    if (!data || data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    let text = `Dataset with ${data.length} records and ${headers.length} fields:\n\n`;
    
    // Add header description
    text += `Fields: ${headers.join(', ')}\n\n`;
    
    // Add sample records as text
    const sampleSize = Math.min(5, data.length);
    text += `Sample records:\n`;
    
    for (let i = 0; i < sampleSize; i++) {
      const record = data[i];
      text += `Record ${i + 1}:\n`;
      headers.forEach(header => {
        text += `  ${header}: ${record[header]}\n`;
      });
      text += '\n';
    }
    
    return text;
  }

  /**
   * Convert to SQL INSERT statements
   */
  toSQL(data, tableName) {
    if (!data || data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const columns = headers.join(', ');
    
    let sql = `-- Table: ${tableName}\n`;
    sql += `-- Columns: ${columns}\n\n`;
    
    data.forEach(row => {
      const values = headers.map(header => {
        const value = row[header];
        if (value === null || value === undefined || value === '') {
          return 'NULL';
        }
        if (typeof value === 'string') {
          return `'${value.replace(/'/g, "''")}'`;
        }
        return value;
      }).join(', ');
      
      sql += `INSERT INTO ${tableName} (${columns}) VALUES (${values});\n`;
    });
    
    return sql;
  }

  /**
   * Generate CREATE TABLE statement
   */
  generateCreateTable(schema, tableName) {
    const columns = schema.structure.columns.map(col => {
      let sqlType = 'TEXT';
      switch (col.type) {
        case 'number':
          sqlType = 'NUMERIC';
          break;
        case 'date':
          sqlType = 'DATE';
          break;
        case 'email':
        case 'url':
          sqlType = 'VARCHAR(255)';
          break;
      }
      return `  ${col.name} ${sqlType}`;
    }).join(',\n');
    
    return `CREATE TABLE ${tableName} (\n${columns}\n);`;
  }

  /**
   * Detect relationships in CSV data
   */
  detectRelationships(data, options = {}) {
    if (!data || data.length === 0) return [];
    
    const headers = Object.keys(data[0]);
    const relationships = [];
    
    // Look for foreign key patterns
    headers.forEach(header => {
      if (header.toLowerCase().includes('id') && header !== 'id') {
        const referencedTable = header.replace(/[_-]?id$/i, '');
        relationships.push({
          type: 'foreign_key',
          column: header,
          referencedTable: referencedTable,
          confidence: 0.7
        });
      }
    });
    
    // Look for hierarchical relationships
    const parentColumns = headers.filter(h => 
      h.toLowerCase().includes('parent') || 
      h.toLowerCase().includes('manager') ||
      h.toLowerCase().includes('supervisor')
    );
    
    parentColumns.forEach(col => {
      relationships.push({
        type: 'hierarchical',
        column: col,
        relationship: 'parent_child',
        confidence: 0.8
      });
    });
    
    return relationships;
  }
}

module.exports = new CSVHandler();
