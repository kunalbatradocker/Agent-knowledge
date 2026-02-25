/**
 * Data Profile Service — deterministic column profiling (no LLM needed)
 * 
 * Analyzes CSV/Excel columns to produce a data profile with:
 * - Data type detection (date, numeric, boolean, text, category, id, fk)
 * - Cardinality and null rates
 * - Value distribution
 * - FK candidate detection
 * - Suggested XSD types
 * 
 * This replaces the LLM-based type detection in the schema analysis step,
 * making it faster, cheaper, and deterministic.
 */

const logger = require('../utils/logger');

class DataProfileService {
  
  /**
   * Profile all columns in a dataset.
   * @param {string[]} headers - Column names
   * @param {Object[]} rows - Data rows
   * @param {Object} options - { sheets?: SheetInfo[] }
   * @returns {DataProfile}
   */
  profileColumns(headers, rows, options = {}) {
    const { sheets } = options;
    const profiles = {};
    const startTime = Date.now();
    
    for (const header of headers) {
      if (header === '__sheet') continue;
      profiles[header] = this._profileColumn(header, rows, sheets);
    }
    
    // Detect FK relationships between columns
    const fkCandidates = this._detectForeignKeys(profiles, headers, rows, sheets);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`📊 Data profiling complete: ${Object.keys(profiles).length} columns in ${duration}s`);
    
    return {
      columns: profiles,
      fkCandidates,
      rowCount: rows.length,
      sheetCount: sheets?.length || 1,
      profiledAt: new Date().toISOString(),
    };
  }
  
  /**
   * Profile a single column.
   */
  _profileColumn(header, rows, sheets) {
    const values = rows.map(r => r[header]).filter(v => v !== null && v !== undefined && v !== '');
    const totalRows = rows.length;
    const nonNullCount = values.length;
    const nullRate = totalRows > 0 ? (totalRows - nonNullCount) / totalRows : 1;
    
    // Unique values
    const uniqueValues = new Set(values.map(v => String(v).trim().toLowerCase()));
    const cardinality = uniqueValues.size;
    const cardinalityRatio = nonNullCount > 0 ? cardinality / nonNullCount : 0;
    
    // Detect data type
    const typeInfo = this._detectType(header, values, cardinality, cardinalityRatio, totalRows);
    
    // Sample values (up to 5 unique)
    const sampleValues = [...new Set(values.slice(0, 50).map(v => String(v)))].slice(0, 5);
    
    // Sheet distribution (which sheets have this column)
    let sheetPresence = null;
    if (sheets && sheets.length > 1) {
      sheetPresence = {};
      for (const sheet of sheets) {
        const sheetRows = rows.filter(r => r.__sheet === sheet.name);
        const sheetValues = sheetRows.filter(r => r[header] !== null && r[header] !== undefined && r[header] !== '');
        if (sheetValues.length > 0) {
          sheetPresence[sheet.name] = sheetValues.length;
        }
      }
    }
    
    return {
      header,
      type: typeInfo.type,
      xsdType: typeInfo.xsdType,
      isId: typeInfo.isId,
      isFkCandidate: typeInfo.isFkCandidate,
      isCategory: typeInfo.isCategory,
      nullRate: Math.round(nullRate * 1000) / 1000,
      cardinality,
      cardinalityRatio: Math.round(cardinalityRatio * 1000) / 1000,
      nonNullCount,
      sampleValues,
      sheetPresence,
      stats: typeInfo.stats || {},
    };
  }
  
  /**
   * Detect the data type of a column based on its values and header name.
   */
  _detectType(header, values, cardinality, cardinalityRatio, totalRows) {
    const headerLower = header.toLowerCase().replace(/[_\s-]/g, '');
    const sampleSize = Math.min(values.length, 100);
    const sample = values.slice(0, sampleSize);
    
    // 1. Check if it's an ID column (by name pattern)
    const isIdByName = /^(id|_id|pk|key|uuid|guid)$/i.test(header) ||
      /(_id|_pk|_key|_uuid)$/i.test(header) ||
      /^(id_|pk_|key_)/i.test(header);
    
    if (isIdByName && cardinalityRatio > 0.9) {
      return { type: 'id', xsdType: 'xsd:string', isId: true, isFkCandidate: false, isCategory: false };
    }
    
    // 2. Check for boolean
    const boolValues = new Set(['true', 'false', 'yes', 'no', '0', '1', 'y', 'n', 't', 'f']);
    const boolCount = sample.filter(v => boolValues.has(String(v).trim().toLowerCase())).length;
    if (boolCount / sampleSize > 0.9 && cardinality <= 4) {
      return { type: 'boolean', xsdType: 'xsd:boolean', isId: false, isFkCandidate: false, isCategory: false };
    }
    
    // 3. Check for date/datetime
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}$/,                    // YYYY-MM-DD
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,         // ISO datetime
      /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,            // MM/DD/YYYY
      /^\d{1,2}-\d{1,2}-\d{2,4}$/,              // DD-MM-YYYY
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i, // Month name
    ];
    const dateByName = /date|time|timestamp|created|updated|modified|born|died|started|ended|expires/i.test(headerLower);
    const dateCount = sample.filter(v => {
      const s = String(v).trim();
      return datePatterns.some(p => p.test(s)) || (!isNaN(Date.parse(s)) && s.length > 6);
    }).length;
    
    if ((dateCount / sampleSize > 0.7) || (dateByName && dateCount / sampleSize > 0.3)) {
      const hasTime = sample.some(v => /T\d{2}:\d{2}|:\d{2}:\d{2}/.test(String(v)));
      return { 
        type: 'date', 
        xsdType: hasTime ? 'xsd:dateTime' : 'xsd:date', 
        isId: false, isFkCandidate: false, isCategory: false 
      };
    }
    
    // 4. Check for numeric
    const numCount = sample.filter(v => {
      const s = String(v).trim().replace(/[$€£¥,]/g, '');
      return !isNaN(s) && s !== '' && !/^\d{4}-\d{2}/.test(s);
    }).length;
    
    if (numCount / sampleSize > 0.8) {
      const hasDecimal = sample.some(v => String(v).includes('.'));
      const isCurrency = /amount|price|cost|fee|salary|balance|total|revenue|payment/i.test(headerLower) ||
        sample.some(v => /[$€£¥]/.test(String(v)));
      return { 
        type: 'numeric', 
        xsdType: hasDecimal || isCurrency ? 'xsd:decimal' : 'xsd:integer',
        isId: false, isFkCandidate: false, isCategory: false,
        stats: { hasDecimal, isCurrency }
      };
    }
    
    // 5. Check for category (low cardinality text)
    if (cardinality <= 20 && cardinality < totalRows * 0.1 && values.length > 10) {
      return { 
        type: 'category', 
        xsdType: 'xsd:string', 
        isId: false, isFkCandidate: false, isCategory: true,
        stats: { distinctValues: cardinality }
      };
    }
    
    // 6. Check for FK candidate (by name pattern + moderate cardinality)
    const isFkByName = /(_id|_ref|_code|_num|_number|_key)$/i.test(header) ||
      /^(fk_|ref_)/i.test(header) ||
      /(customer|account|branch|product|employee|order|user|company|department|category|type)(_?id|_?ref|_?code|_?num|_?number)?$/i.test(headerLower);
    
    if (isFkByName && cardinalityRatio < 0.9) {
      return { type: 'fk', xsdType: 'xsd:string', isId: false, isFkCandidate: true, isCategory: false };
    }
    
    // 7. High cardinality with ID-like name but not caught above
    if (cardinalityRatio > 0.95 && values.length > 10) {
      return { type: 'id', xsdType: 'xsd:string', isId: true, isFkCandidate: false, isCategory: false };
    }
    
    // 8. Default: text
    const avgLen = values.length > 0 ? values.reduce((sum, v) => sum + String(v).length, 0) / values.length : 0;
    return { 
      type: 'text', 
      xsdType: 'xsd:string', 
      isId: false, isFkCandidate: false, isCategory: false,
      stats: { avgLength: Math.round(avgLen) }
    };
  }
  
  /**
   * Detect foreign key relationships between columns across sheets.
   * Returns pairs of (sourceCol, targetCol, sheetFrom, sheetTo, matchRate).
   */
  _detectForeignKeys(profiles, headers, rows, sheets) {
    const candidates = [];
    
    if (!sheets || sheets.length < 2) {
      // Single sheet: look for columns that reference other columns' values
      return candidates;
    }
    
    // Build value sets per column per sheet
    const sheetColumnValues = {}; // { sheetName: { colName: Set<values> } }
    for (const sheet of sheets) {
      sheetColumnValues[sheet.name] = {};
      const sheetRows = rows.filter(r => r.__sheet === sheet.name);
      for (const header of headers) {
        if (header === '__sheet') continue;
        const vals = new Set(
          sheetRows.map(r => r[header]).filter(v => v !== null && v !== undefined && v !== '').map(v => String(v).trim())
        );
        if (vals.size > 0) {
          sheetColumnValues[sheet.name][header] = vals;
        }
      }
    }
    
    // For each pair of sheets, find columns with overlapping values
    for (let i = 0; i < sheets.length; i++) {
      for (let j = 0; j < sheets.length; j++) {
        if (i === j) continue;
        const fromSheet = sheets[i].name;
        const toSheet = sheets[j].name;
        
        for (const [fromCol, fromVals] of Object.entries(sheetColumnValues[fromSheet] || {})) {
          const fromProfile = profiles[fromCol];
          if (!fromProfile || fromProfile.type === 'date' || fromProfile.type === 'boolean') continue;
          
          for (const [toCol, toVals] of Object.entries(sheetColumnValues[toSheet] || {})) {
            const toProfile = profiles[toCol];
            if (!toProfile) continue;
            
            // Check if toCol is an ID/PK in its sheet
            if (!toProfile.isId && toProfile.cardinalityRatio < 0.8) continue;
            
            // Calculate overlap
            let matchCount = 0;
            for (const v of fromVals) {
              if (toVals.has(v)) matchCount++;
            }
            const matchRate = fromVals.size > 0 ? matchCount / fromVals.size : 0;
            
            if (matchRate > 0.3 && matchCount > 1) {
              candidates.push({
                fromSheet,
                fromColumn: fromCol,
                toSheet,
                toColumn: toCol,
                matchRate: Math.round(matchRate * 1000) / 1000,
                matchCount,
                fromCardinality: fromVals.size,
                toCardinality: toVals.size,
              });
            }
          }
        }
      }
    }
    
    // Sort by match rate descending, deduplicate
    candidates.sort((a, b) => b.matchRate - a.matchRate);
    
    // Keep best candidate per (fromSheet, fromColumn) pair
    const seen = new Set();
    const deduped = candidates.filter(c => {
      const key = `${c.fromSheet}:${c.fromColumn}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    return deduped;
  }
  
  /**
   * Generate a suggested XSD type for a column based on its profile.
   */
  suggestXsdType(profile) {
    return profile.xsdType || 'xsd:string';
  }
  
  /**
   * Generate a suggested property name from a column header.
   */
  suggestPropertyName(header) {
    // Convert to camelCase
    return header
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toLowerCase());
  }
  
  /**
   * Generate a suggested class name from a sheet name or header.
   */
  suggestClassName(name) {
    return name
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toUpperCase());
  }
}

module.exports = new DataProfileService();
