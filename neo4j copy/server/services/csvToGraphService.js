/**
 * CSV to Graph Service
 * Converts CSV data directly to a knowledge graph where:
 * - Each column becomes a node type/class
 * - Each unique value in a column becomes a node
 * - Rows define relationships between values across columns
 * 
 * Supports ontology-aware mode where columns are mapped to ontology classes
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class CsvToGraphService {
  constructor() {
    // Column types that should be treated as properties, not nodes
    this.propertyPatterns = [
      /^id$/i, /^_id$/i, /^uuid$/i,
      /date/i, /time/i, /timestamp/i,
      /count/i, /amount/i, /price/i, /cost/i, /total/i,
      /percent/i, /ratio/i, /rate/i,
      /^is_/i, /^has_/i, /^can_/i,  // Boolean flags
      /phone/i, /email/i, /address/i, /url/i, /link/i,
      /note/i, /comment/i, /description/i, /remark/i
    ];
  }

  /**
   * Convert parsed CSV data to graph nodes and relationships
   * @param {Object} parsedCSV - Output from csvParser.parseContent()
   * @param {Object} options - Configuration options
   */
  convertToGraph(parsedCSV, options = {}) {
    const {
      industry = 'general',
      primaryKeyColumn = null,  // Column that uniquely identifies a row
      nodeColumns = null,       // Specific columns to treat as nodes (null = auto-detect)
      propertyColumns = null,   // Columns to treat as properties
      relationshipConfig = null, // Custom relationship definitions
      createRowNodes = true,    // Create a node for each row (links all values)
      rowNodeType = 'Record',   // Type for row nodes
      columnLabels = {},        // User-defined labels for columns { columnName: 'Label' }
      customRelationships = []  // User-defined relationships [{ from, to, predicate }]
    } = options;

    const { headers, rows, columnAnalysis } = parsedCSV;
    
    // Determine which columns should be nodes vs properties
    const { nodeColumnList, propColumnList } = this.categorizeColumns(
      headers, 
      columnAnalysis, 
      nodeColumns, 
      propertyColumns
    );

    console.log(`   📊 CSV Column Analysis:`);
    console.log(`      Node columns (${nodeColumnList.length}): ${nodeColumnList.join(', ') || 'NONE'}`);
    console.log(`      Property columns (${propColumnList.length}): ${propColumnList.join(', ') || 'NONE'}`);

    // If no node columns detected, treat ALL columns as node columns
    if (nodeColumnList.length === 0) {
      console.log(`   ⚠️ No node columns detected, using ALL columns as nodes`);
      nodeColumnList.push(...headers);
    }

    // Create nodes and relationships
    const nodes = new Map();  // uri -> node
    const relationships = [];
    const rowNodes = [];

    console.log(`   📝 Processing ${rows.length} rows...`);

    // Process each row
    rows.forEach((row, rowIndex) => {
      const rowId = row[primaryKeyColumn] || `row_${rowIndex + 1}`;
      const rowValues = {};  // Track values in this row for relationship creation

      if (rowIndex < 3) {
        console.log(`      Row ${rowIndex + 1}: ${JSON.stringify(row).substring(0, 100)}...`);
      }

      // Create nodes for each node column value
      nodeColumnList.forEach(colName => {
        const value = row[colName];
        if (!value || value.toString().trim() === '') return;

        // Use user-defined label if available, otherwise auto-generate
        const nodeType = columnLabels[colName] || this.sanitizeTypeName(colName);
        const nodeUri = this.generateNodeUri(nodeType, value);
        
        rowValues[colName] = { value, uri: nodeUri, type: nodeType };

        if (!nodes.has(nodeUri)) {
          nodes.set(nodeUri, {
            uri: nodeUri,
            concept_id: uuidv4(),
            label: value.toString().trim(),
            type: nodeType,
            industry: industry,
            source: 'csv',
            confidence: 0.95,
            description: `${nodeType}: ${value}`,
            properties: {
              column: colName,
              originalValue: value,
              userDefinedLabel: !!columnLabels[colName]
            }
          });
        }
      });

      // Create a row node if enabled (acts as a hub connecting all values)
      if (createRowNodes && Object.keys(rowValues).length > 1) {
        const rowNodeUri = `csv://row/${industry}/${rowId}`;
        const rowLabel = primaryKeyColumn && row[primaryKeyColumn] 
          ? row[primaryKeyColumn] 
          : `Record #${rowIndex + 1}`;

        // Collect property values
        const rowProperties = {};
        propColumnList.forEach(col => {
          if (row[col]) {
            rowProperties[this.sanitizePropertyName(col)] = row[col];
          }
        });

        const rowNode = {
          uri: rowNodeUri,
          concept_id: uuidv4(),
          label: rowLabel,
          type: rowNodeType,
          industry: industry,
          source: 'csv',
          confidence: 0.95,
          description: `CSV Row: ${rowLabel}`,
          properties: {
            ...rowProperties,
            rowIndex: rowIndex,
            sourceRow: rowIndex + 1
          }
        };
        
        rowNodes.push(rowNode);

        // Create relationships from row node to each value node
        Object.entries(rowValues).forEach(([colName, nodeInfo]) => {
          const rel = {
            sourceUri: rowNodeUri,
            targetUri: nodeInfo.uri,
            sourceLabel: rowLabel,
            targetLabel: nodeInfo.value,
            predicate: `HAS_${this.sanitizeTypeName(colName).toUpperCase()}`,
            type: 'RELATED_TO',
            relevance: 0.95,
            confidence: 0.95,
            source_uri: rowNodeUri
          };
          relationships.push(rel);
          
          if (rowIndex < 2) {
            console.log(`         Relationship: ${rowLabel} --[${rel.predicate}]--> ${nodeInfo.value}`);
          }
        });
      }

      // Create direct relationships between node columns (for co-occurrence)
      if (!createRowNodes || relationshipConfig || customRelationships.length > 0) {
        this.createColumnRelationships(
          rowValues, 
          relationships, 
          relationshipConfig || customRelationships,
          rowIndex
        );
      }
    });

    // Add row nodes to the main nodes map
    rowNodes.forEach(node => nodes.set(node.uri, node));

    // Generate summary
    const nodesByType = {};
    nodes.forEach(node => {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    });

    console.log(`   ✅ Graph extraction complete:`);
    console.log(`      Total nodes: ${nodes.size}`);
    Object.entries(nodesByType).forEach(([type, count]) => {
      console.log(`        - ${type}: ${count}`);
    });
    console.log(`      Total relationships: ${relationships.length}`);

    return {
      nodes: Array.from(nodes.values()),
      relationships,
      metadata: {
        totalRows: rows.length,
        nodeColumns: nodeColumnList,
        propertyColumns: propColumnList,
        nodesByType,
        totalNodes: nodes.size,
        totalRelationships: relationships.length
      }
    };
  }

  /**
   * Categorize columns into node columns vs property columns
   */
  categorizeColumns(headers, columnAnalysis, explicitNodeCols, explicitPropCols) {
    // If explicitly specified, use those
    if (explicitNodeCols && explicitPropCols) {
      return {
        nodeColumnList: explicitNodeCols,
        propColumnList: explicitPropCols
      };
    }

    // If only node columns specified, rest are properties
    if (explicitNodeCols) {
      return {
        nodeColumnList: explicitNodeCols,
        propColumnList: headers.filter(h => !explicitNodeCols.includes(h))
      };
    }

    const nodeColumnList = [];
    const propColumnList = [];

    console.log(`   🔍 Analyzing columns for categorization:`);

    headers.forEach(header => {
      const analysis = columnAnalysis?.columns?.[header] || {};
      
      // Check if this looks like a property column by name pattern
      const matchesPropertyPattern = this.propertyPatterns.some(pattern => 
        pattern.test(header)
      );
      
      // Numeric/Date columns are properties
      const isNumericOrDate = analysis.isNumeric || analysis.isDate;
      
      // ID columns could go either way, but if named 'id' exactly, treat as property
      const isIdColumn = analysis.isId && header.toLowerCase() === 'id';

      // Columns with very long text (like descriptions) are better as properties
      const isLongText = (analysis.avgLength || 0) > 100;

      // Debug logging
      console.log(`      - ${header}: pattern=${matchesPropertyPattern}, numeric=${isNumericOrDate}, id=${isIdColumn}, longText=${isLongText}`);

      if (matchesPropertyPattern || isNumericOrDate || isIdColumn || isLongText) {
        propColumnList.push(header);
        console.log(`        → Property column`);
      } else {
        nodeColumnList.push(header);
        console.log(`        → Node column`);
      }
    });

    // Ensure we have at least some node columns
    if (nodeColumnList.length === 0 && headers.length > 0) {
      // Use all columns as nodes if none detected
      return {
        nodeColumnList: headers,
        propColumnList: []
      };
    }

    return { nodeColumnList, propColumnList };
  }

  /**
   * Create relationships between columns based on row co-occurrence
   */
  createColumnRelationships(rowValues, relationships, config, rowIndex) {
    const columns = Object.keys(rowValues);
    
    if (config && config.length > 0) {
      // Use explicit relationship configuration
      config.forEach(rel => {
        // Support both formats: {sourceColumn, targetColumn} and {from, to, fromColumn, toColumn}
        const sourceCol = rel.sourceColumn || rel.fromColumn || rel.from;
        const targetCol = rel.targetColumn || rel.toColumn || rel.to;
        const source = rowValues[sourceCol];
        const target = rowValues[targetCol];
        
        if (source && target) {
          const predicate = rel.predicate || rel.userPredicate || rel.suggestedPredicate || 'RELATED_TO';
          relationships.push({
            sourceUri: source.uri,
            targetUri: target.uri,
            sourceLabel: source.value,
            targetLabel: target.value,
            predicate: predicate,
            type: 'RELATED_TO',
            relevance: 0.9,
            confidence: rel.confidence || 0.9,
            source_uri: source.uri
          });
        }
      });
    } else {
      // Auto-generate relationships: connect adjacent columns
      for (let i = 0; i < columns.length - 1; i++) {
        const sourceCol = columns[i];
        const targetCol = columns[i + 1];
        const source = rowValues[sourceCol];
        const target = rowValues[targetCol];

        if (source && target) {
          relationships.push({
            sourceUri: source.uri,
            targetUri: target.uri,
            sourceLabel: source.value,
            targetLabel: target.value,
            predicate: `${this.sanitizeTypeName(sourceCol).toUpperCase()}_TO_${this.sanitizeTypeName(targetCol).toUpperCase()}`,
            type: 'RELATED_TO',
            relevance: 0.85,
            confidence: 0.85,
            source_uri: source.uri
          });
        }
      }
    }
  }

  /**
   * Sanitize a column name to be a valid Neo4j node type
   */
  sanitizeTypeName(name) {
    if (!name) return 'Entity';
    
    // Convert to PascalCase
    return name
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  /**
   * Sanitize a column name to be a valid property name
   */
  sanitizePropertyName(name) {
    if (!name) return 'value';
    
    // Convert to camelCase
    const words = name
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .split(/[\s_-]+/);
    
    return words
      .map((word, index) => 
        index === 0 
          ? word.toLowerCase() 
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');
  }

  /**
   * Generate a unique URI for a node
   */
  generateNodeUri(type, value) {
      const crypto = require('crypto');
      const normalizedValue = value.toString().trim();
      const hash = crypto.createHash('sha256').update(normalizedValue).digest('hex').substring(0, 16);
      // Include a readable prefix (truncated, safe) plus hash for uniqueness
      const readablePrefix = normalizedValue
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 40);

      return `csv://${type.toLowerCase()}/${readablePrefix}_${hash}`;
    }

  /**
   * Analyze CSV and suggest optimal graph conversion settings
   */
  analyzeForGraphConversion(parsedCSV) {
    const { headers, rows, columnAnalysis } = parsedCSV;
    
    const suggestions = {
      recommendedNodeColumns: [],
      recommendedPropertyColumns: [],
      suggestedRelationships: [],
      primaryKeyColumn: null
    };

    // Find primary key column (high uniqueness, short values)
    headers.forEach(header => {
      const analysis = columnAnalysis?.columns?.[header] || {};
      
      if (analysis.isId || 
          (analysis.uniqueCount === rows.length && analysis.avgLength < 50)) {
        suggestions.primaryKeyColumn = header;
      }

      // Categorize columns
      if (analysis.isNumeric || analysis.isDate || 
          this.propertyPatterns.some(p => p.test(header))) {
        suggestions.recommendedPropertyColumns.push(header);
      } else {
        suggestions.recommendedNodeColumns.push(header);
      }
    });

    // Suggest relationships based on column names
    const relationshipKeywords = {
      'manager': 'MANAGED_BY',
      'supervisor': 'SUPERVISED_BY',
      'parent': 'CHILD_OF',
      'department': 'WORKS_IN',
      'team': 'MEMBER_OF',
      'project': 'WORKS_ON',
      'category': 'BELONGS_TO',
      'type': 'IS_TYPE',
      'owner': 'OWNED_BY',
      'author': 'AUTHORED_BY',
      'created_by': 'CREATED_BY',
      'assigned_to': 'ASSIGNED_TO',
      'belongs_to': 'BELONGS_TO',
      'related_to': 'RELATED_TO',
      'location': 'LOCATED_IN',
      'company': 'WORKS_AT',
      'organization': 'PART_OF'
    };

    headers.forEach((header, idx) => {
      const lowerHeader = header.toLowerCase();
      Object.entries(relationshipKeywords).forEach(([keyword, predicate]) => {
        if (lowerHeader.includes(keyword)) {
          // Find a source column (usually a name/id column)
          const sourceCol = suggestions.recommendedNodeColumns.find(col => 
            col.toLowerCase().includes('name') || 
            col.toLowerCase().includes('title') ||
            col === headers[0]
          ) || headers[0];

          if (sourceCol !== header) {
            suggestions.suggestedRelationships.push({
              sourceColumn: sourceCol,
              targetColumn: header,
              predicate: predicate
            });
          }
        }
      });
    });

    return suggestions;
  }

  /**
   * Convert CSV with ontology-aware mapping
   * Maps columns to ontology classes and uses ontology relationships
   * @param {Object} parsedCSV - Parsed CSV data
   * @param {Object} ontology - Ontology structure with classes and properties
   * @param {Object} columnMapping - User-defined column to class mapping
   * @param {Array} relationshipMapping - User-defined relationships
   */
  convertWithOntology(parsedCSV, ontology, columnMapping = {}, relationshipMapping = []) {
      const { headers, rows } = parsedCSV;

      logger.info(`📊 Ontology-aware CSV processing: ${rows.length} rows`);

      // Get ontology classes for validation
      const ontologyClasses = new Set(
        (ontology?.classes || ontology?.entityTypes || [])
          .map(c => (c.label || c.userLabel || c.uri?.split('#').pop() || '').toLowerCase())
      );

      const ontologyRelationships = ontology?.properties || ontology?.relationships || [];

      // Use only explicit column mappings — no auto-matching fallback.
      // Auto-matching (substring matching) was fragile and caused false positives.
      // The frontend (StagedDocumentReview) always sends explicit mappings.
      const effectiveMapping = {};
      headers.forEach(header => {
        if (columnMapping[header]) {
          effectiveMapping[header] = columnMapping[header];
        }
      });

      logger.info(`   Column mappings: ${JSON.stringify(effectiveMapping)}`);

      const nodes = new Map();
      const relationships = [];
      const unmappedColumns = headers.filter(h => !effectiveMapping[h]);

      if (unmappedColumns.length > 0) {
        logger.warn(`   Unmapped columns (will be properties): ${unmappedColumns.join(', ')}`);
      }

      // Process rows
      rows.forEach((row, rowIndex) => {
        const rowValues = {};
        const rowProperties = {};

        headers.forEach(header => {
          const value = row[header];
          if (!value || value.toString().trim() === '') return;

          const ontologyClass = effectiveMapping[header];

          if (ontologyClass) {
            // This column maps to an ontology class - create node
            const nodeUri = this.generateNodeUri(ontologyClass, value);
            rowValues[header] = { value, uri: nodeUri, type: ontologyClass };

            if (!nodes.has(nodeUri)) {
              nodes.set(nodeUri, {
                uri: nodeUri,
                concept_id: uuidv4(),
                label: value.toString().trim(),
                type: ontologyClass,
                ontology_class: ontologyClass,
                source: 'csv',
                confidence: 0.95,
                properties: { sourceColumn: header }
              });
            }
          } else {
            // Unmapped column - treat as property
            rowProperties[this.sanitizePropertyName(header)] = value;
          }
        });

        // Create relationships from mapping
        if (relationshipMapping && relationshipMapping.length > 0) {
          relationshipMapping.forEach(rel => {
            const sourceCol = rel.fromColumn || rel.from;
            const targetCol = rel.toColumn || rel.to;
            const source = rowValues[sourceCol];
            const target = rowValues[targetCol];

            if (source && target) {
              relationships.push({
                sourceUri: source.uri,
                targetUri: target.uri,
                sourceLabel: source.value,
                targetLabel: target.value,
                predicate: rel.predicate || rel.userPredicate || 'RELATED_TO',
                type: rel.predicate || 'RELATED_TO',
                confidence: 0.9,
                source: 'csv_ontology_mapping'
              });
            }
          });
        } else {
          // Auto-create relationships between mapped columns based on ontology
          const mappedCols = Object.keys(rowValues);
          ontologyRelationships.forEach(ontRel => {
            const domain = ontRel.domain?.split('#').pop() || ontRel.from;
            const range = ontRel.range?.split('#').pop() || ontRel.to;
            const predicate = ontRel.label || ontRel.predicate || ontRel.uri?.split('#').pop();

            // Find columns that match domain and range
            const sourceCol = mappedCols.find(c => 
              effectiveMapping[c]?.toLowerCase() === domain?.toLowerCase()
            );
            const targetCol = mappedCols.find(c => 
              effectiveMapping[c]?.toLowerCase() === range?.toLowerCase()
            );

            if (sourceCol && targetCol && rowValues[sourceCol] && rowValues[targetCol]) {
              relationships.push({
                sourceUri: rowValues[sourceCol].uri,
                targetUri: rowValues[targetCol].uri,
                sourceLabel: rowValues[sourceCol].value,
                targetLabel: rowValues[targetCol].value,
                predicate: predicate,
                type: predicate,
                confidence: 0.85,
                source: 'ontology_inferred'
              });
            }
          });
        }
      });

      const result = {
        nodes: Array.from(nodes.values()),
        relationships,
        metadata: {
          totalRows: rows.length,
          columnMapping: effectiveMapping,
          unmappedColumns,
          ontologyClasses: Array.from(ontologyClasses),
          totalNodes: nodes.size,
          totalRelationships: relationships.length
        }
      };

      logger.info(`   ✅ Ontology-aware extraction: ${result.nodes.length} nodes, ${result.relationships.length} relationships`);

      return result;
    }
}

module.exports = new CsvToGraphService();

