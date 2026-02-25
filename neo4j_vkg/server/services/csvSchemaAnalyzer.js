/**
 * CSV Schema Analyzer Service
 * Analyzes CSV columns and suggests ontology mappings
 */

class CSVSchemaAnalyzer {
  
  /**
   * Analyze CSV headers and suggest schema
   */
  analyze(headers, sampleRows = []) {
    const columns = headers.map(header => {
      const samples = sampleRows.slice(0, 10).map(r => r[header]).filter(Boolean);
      return {
        column: header,
        ...this.analyzeColumn(header, samples)
      };
    });

    const relationships = this.suggestRelationships(columns);
    
    return { columns, relationships };
  }

  /**
   * Analyze a single column
   */
  analyzeColumn(header, samples) {
    const h = header.toLowerCase();
    const uniqueCount = new Set(samples).size;
    const fillRate = samples.length > 0 ? (samples.filter(Boolean).length / samples.length) * 100 : 0;
    
    // Detect column type
    const isId = /\bid\b|_id$|^id$|^respid$/i.test(header);
    const isDate = /date|time|created|updated|received|sent/i.test(header);
    const isNumeric = samples.length > 0 && samples.every(v => !isNaN(Number(v)));
    const isBoolean = samples.every(v => /^(yes|no|true|false|y|n|1|0)$/i.test(String(v)));
    const isLongText = samples.some(v => String(v).length > 200);
    const isLowCardinality = uniqueCount < 20 && samples.length > 5 && !isNumeric;
    const isCategorical = !isNumeric && uniqueCount < 50 && uniqueCount > 1;
    
    // Determine if should be node or property
    let suggestedType = 'property';
    let includeAsNode = false;
    let confidence = 0.7;
    let reasoning = '';

    if (isId) {
      suggestedType = 'id';
      reasoning = 'Identified as ID column';
      confidence = 0.95;
    } else if (isDate) {
      suggestedType = 'date';
      reasoning = 'Date/time column';
      confidence = 0.9;
    } else if (isNumeric) {
      suggestedType = 'numeric';
      reasoning = 'Numeric values';
      confidence = 0.85;
    } else if (isBoolean) {
      suggestedType = 'boolean';
      reasoning = 'Boolean-like values';
      confidence = 0.9;
    } else if (isLongText) {
      suggestedType = 'text';
      reasoning = 'Long text content';
      confidence = 0.85;
    } else if (isCategorical) {
      // Categorical columns are good candidates for linked entities
      suggestedType = 'category';
      includeAsNode = true;
      reasoning = `Categorical (${uniqueCount} unique values)`;
      confidence = 0.8;
    } else if (isLowCardinality) {
      suggestedType = 'node';
      includeAsNode = true;
      reasoning = `Low cardinality (${uniqueCount} unique values)`;
      confidence = 0.8;
    }

    return {
      suggestedLabel: this.toClassName(header),
      suggestedType,
      includeAsNode,
      includeAsProperty: !includeAsNode,
      confidence,
      reasoning,
      stats: {
        uniqueCount,
        fillRate: Math.round(fillRate),
        isNumeric,
        isDate,
        isBoolean,
        isLongText
      },
      sampleValues: samples.slice(0, 5)
    };
  }

  /**
   * Suggest relationships between node columns
   */
  suggestRelationships(columns) {
    const nodeColumns = columns.filter(c => c.includeAsNode);
    const relationships = [];

    // Find primary entity (usually the one with ID)
    const idCol = columns.find(c => c.suggestedType === 'id');
    const primaryEntity = idCol ? this.toClassName(idCol.column.replace(/[_\s]?id$/i, '')) : 'Record';

    nodeColumns.forEach(col => {
      relationships.push({
        from: primaryEntity,
        to: col.suggestedLabel,
        predicate: `HAS_${col.suggestedLabel.toUpperCase()}`,
        fromColumn: idCol?.column || 'record',
        toColumn: col.column,
        confidence: 0.75
      });
    });

    return relationships;
  }

  /**
   * Get predefined mappings for known datasets
   */
  getPredefinedMapping(datasetType) {
    const mappings = {
      'consumer-complaints': {
        primaryClass: 'Complaint',
        columnMappings: {
          'Complaint ID': { type: 'id', property: 'complaintId' },
          'Date received': { type: 'date', property: 'dateReceived' },
          'Date sent to company': { type: 'date', property: 'dateSentToCompany' },
          'Product': { type: 'node', linkedClass: 'Product', relationship: 'aboutProduct' },
          'Sub-product': { type: 'property', property: 'subProduct' },
          'Issue': { type: 'node', linkedClass: 'Issue', relationship: 'hasIssue' },
          'Sub-issue': { type: 'property', property: 'subIssue' },
          'Company': { type: 'node', linkedClass: 'Company', relationship: 'againstCompany' },
          'State': { type: 'node', linkedClass: 'State', relationship: 'inState' },
          'ZIP code': { type: 'property', property: 'zipCode' },
          'Consumer complaint narrative': { type: 'text', property: 'narrative' },
          'Company public response': { type: 'property', property: 'companyPublicResponse' },
          'Company response to consumer': { type: 'property', property: 'companyResponse' },
          'Timely response?': { type: 'boolean', property: 'timelyResponse' },
          'Consumer disputed?': { type: 'boolean', property: 'consumerDisputed' },
          'Submitted via': { type: 'property', property: 'submittedVia' },
          'Tags': { type: 'property', property: 'tags' },
          'Consumer consent provided?': { type: 'property', property: 'consentProvided' }
        }
      },
      'transactions': {
        primaryClass: 'Transaction',
        columnMappings: {
          'Transaction ID': { type: 'id', property: 'transactionId' },
          'Transaction_ID': { type: 'id', property: 'transactionId' },
          'Amount': { type: 'numeric', property: 'amount' },
          'Transaction Amount': { type: 'numeric', property: 'amount' },
          'Sender Account ID': { type: 'node', linkedClass: 'Account', relationship: 'fromAccount' },
          'Receiver Account ID': { type: 'node', linkedClass: 'Account', relationship: 'toAccount' },
          'Fraud_Flag': { type: 'boolean', property: 'isFraud' },
          'Transaction Type': { type: 'property', property: 'transactionType' },
          'Timestamp': { type: 'date', property: 'timestamp' }
        }
      }
    };
    return mappings[datasetType] || null;
  }

  /**
   * Detect dataset type from headers
   */
  detectDatasetType(headers) {
    const h = headers.map(x => x.toLowerCase());
    
    if (h.includes('complaint id') || h.includes('consumer complaint narrative')) {
      return 'consumer-complaints';
    }
    if (h.some(x => x.includes('transaction')) && h.some(x => x.includes('account'))) {
      return 'transactions';
    }
    return null;
  }

  /**
   * Convert header to class name
   */
  toClassName(header) {
    return header
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\s+/g, '')
      .replace(/Id$/, '')
      .replace(/\?$/, '');
  }
}

module.exports = new CSVSchemaAnalyzer();
