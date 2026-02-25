/**
 * CSV Parser Service
 */

const fs = require('fs').promises;
const logger = require('../utils/logger');

class CSVParser {
  /**
   * Parse CSV file to JSON array
   */
  async parse(filePath, options = {}) {
    const {
      delimiter = ',',
      quote = '"',
      escape = '"',
      skipEmptyLines = true,
      maxRows = 100000
    } = options;

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      
      if (lines.length === 0) {
        return [];
      }

      // Parse header
      const headers = this.parseLine(lines[0], delimiter, quote, escape);
      const data = [];

      // Parse data rows
      for (let i = 1; i < Math.min(lines.length, maxRows + 1); i++) {
        const line = lines[i].trim();
        
        if (skipEmptyLines && !line) {
          continue;
        }

        const values = this.parseLine(line, delimiter, quote, escape);
        
        if (values.length > 0) {
          const row = {};
          headers.forEach((header, index) => {
            row[header] = values[index] || '';
          });
          data.push(row);
        }
      }

      logger.info(`📊 Parsed CSV: ${data.length} rows, ${headers.length} columns`);
      return { headers, rows: data, columnAnalysis: this.analyzeColumns(headers, data) };

    } catch (error) {
      logger.error('CSV parsing failed:', error);
      throw error;
    }
  }

  /**
   * Analyze columns for type detection
   */
  analyzeColumns(headers, rows) {
    const columns = {};
    headers.forEach(header => {
      const values = rows.map(r => r[header]).filter(v => v != null && v !== '');
      const numericCount = values.filter(v => !isNaN(Number(v))).length;
      const isNumeric = values.length > 0 && numericCount / values.length > 0.8;
      const isId = /id$/i.test(header) || header.toLowerCase() === 'id';
      const isDate = /date|time|created|updated/i.test(header);
      columns[header] = { isNumeric, isId, isDate, uniqueCount: new Set(values).size };
    });
    return { columns };
  }

  /**
   * Parse a single CSV line
   */
  parseLine(line, delimiter, quote, escape) {
    const values = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === quote) {
        if (inQuotes && nextChar === quote) {
          // Escaped quote
          current += quote;
          i += 2;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
        }
      } else if (char === delimiter && !inQuotes) {
        // Field separator
        values.push(current.trim());
        current = '';
        i++;
      } else {
        // Regular character
        current += char;
        i++;
      }
    }

    // Add final field
    values.push(current.trim());
    
    return values;
  }

  /**
   * Convert CSV data to graph format
   */
  toGraph(data, options = {}) {
    const {
      idColumn = null,
      labelColumn = null,
      relationshipColumns = []
    } = options;

    const nodes = [];
    const relationships = [];

    data.forEach((row, index) => {
      const nodeId = row[idColumn] || `row_${index}`;
      const label = row[labelColumn] || 'Record';

      // Create node
      const node = {
        id: nodeId,
        label: label,
        properties: { ...row }
      };
      nodes.push(node);

      // Create relationships if specified
      relationshipColumns.forEach(relCol => {
        const targetId = row[relCol];
        if (targetId && targetId !== nodeId) {
          relationships.push({
            source: nodeId,
            target: targetId,
            type: relCol,
            properties: {}
          });
        }
      });
    });

    return { nodes, relationships };
  }

  /**
   * Detect CSV structure and suggest mappings
   */
  analyzeStructure(data) {
    if (data.length === 0) {
      return { columns: [], suggestions: {} };
    }

    const columns = Object.keys(data[0]);
    const suggestions = {};

    // Analyze each column
    columns.forEach(col => {
      const values = data.map(row => row[col]).filter(v => v && v.trim());
      const uniqueValues = new Set(values);
      
      suggestions[col] = {
        type: this.detectColumnType(values),
        uniqueCount: uniqueValues.size,
        nullCount: data.length - values.length,
        sampleValues: Array.from(uniqueValues).slice(0, 5)
      };
    });

    // Suggest ID and label columns
    const idColumn = this.suggestIdColumn(columns, suggestions);
    const labelColumn = this.suggestLabelColumn(columns, suggestions);

    return {
      columns,
      suggestions,
      recommended: {
        idColumn,
        labelColumn,
        relationshipColumns: this.suggestRelationshipColumns(columns, suggestions)
      }
    };
  }

  /**
   * Detect column data type
   */
  detectColumnType(values) {
    if (values.length === 0) return 'empty';

    const sample = values.slice(0, 100);
    
    // Check for numbers
    const numberCount = sample.filter(v => !isNaN(v) && !isNaN(parseFloat(v))).length;
    if (numberCount / sample.length > 0.8) {
      return 'number';
    }

    // Check for dates
    const dateCount = sample.filter(v => !isNaN(Date.parse(v))).length;
    if (dateCount / sample.length > 0.8) {
      return 'date';
    }

    // Check for emails
    const emailCount = sample.filter(v => /\S+@\S+\.\S+/.test(v)).length;
    if (emailCount / sample.length > 0.8) {
      return 'email';
    }

    // Check for URLs
    const urlCount = sample.filter(v => /^https?:\/\//.test(v)).length;
    if (urlCount / sample.length > 0.8) {
      return 'url';
    }

    return 'text';
  }

  /**
   * Suggest ID column
   */
  suggestIdColumn(columns, suggestions) {
    // Look for columns with 'id' in name
    const idCandidates = columns.filter(col => 
      /id|key|identifier/i.test(col)
    );

    if (idCandidates.length > 0) {
      return idCandidates[0];
    }

    // Look for columns with unique values
    const uniqueCandidates = columns.filter(col => 
      suggestions[col].uniqueCount === suggestions[col].uniqueCount + suggestions[col].nullCount
    );

    return uniqueCandidates[0] || columns[0];
  }

  /**
   * Suggest label column
   */
  suggestLabelColumn(columns, suggestions) {
    // Look for columns with 'name', 'title', 'label' in name
    const labelCandidates = columns.filter(col => 
      /name|title|label|description/i.test(col)
    );

    if (labelCandidates.length > 0) {
      return labelCandidates[0];
    }

    // Look for text columns with reasonable uniqueness
    const textCandidates = columns.filter(col => 
      suggestions[col].type === 'text' && 
      suggestions[col].uniqueCount > 1
    );

    return textCandidates[0] || columns[1] || columns[0];
  }

  /**
   * Suggest relationship columns
   */
  suggestRelationshipColumns(columns, suggestions) {
    return columns.filter(col => 
      /ref|link|parent|child|related|connect/i.test(col) ||
      (suggestions[col].type === 'text' && suggestions[col].uniqueCount < suggestions[col].uniqueCount * 0.5)
    );
  }
}

module.exports = new CSVParser();
