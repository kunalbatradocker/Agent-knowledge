/**
 * Context Graph Builder
 * Constructs ephemeral evidence graphs from query results + ontology.
 * Used by both VKG (Trino results) and materialized (GraphDB/Neo4j results) paths.
 *
 * The context graph is NOT stored — it's built per-query, returned in the response,
 * rendered in the UI, and discarded. It's evidence of how the answer was derived.
 */

const logger = require('../utils/logger');

class ContextGraphBuilder {
  /**
   * Build a context graph from Trino SQL results + ontology mappings.
   *
   * @param {Array} rows - Result rows from Trino (array of arrays)
   * @param {Array} columns - Column metadata [{name, type}]
   * @param {Object} ontologySchema - Classes, properties, relationships from GraphDB
   * @param {Object} mappings - vkgmap: annotations {classes, properties, relationships}
   * @param {Object} meta - Additional metadata {sql, databases}
   * @returns {Object} { nodes, edges, statistics, provenance }
   */
  buildGraph(rows, columns, ontologySchema = {}, mappings = {}, meta = {}) {
    if (!rows || rows.length === 0) {
      return { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0 }, provenance: meta };
    }

    const colNames = columns.map(c => c.name);
    const nodeMap = new Map();   // id → node
    const edgeSet = new Set();   // dedup key → edge
    const colToClass = this._mapColumnsToClasses(colNames, mappings);

    // Process each row
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowObj = {};
      colNames.forEach((col, i) => { rowObj[col] = row[i]; });

      // Create nodes for each column value
      for (let i = 0; i < colNames.length; i++) {
        const colName = colNames[i];
        const value = row[i];
        if (value === null || value === undefined) continue;

        const classInfo = colToClass[colName];
        if (!classInfo) continue;

        const nodeId = `${classInfo.className}_${String(value).substring(0, 50)}`;
        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId,
            type: classInfo.className,
            label: classInfo.propertyLabel || colName,
            value: String(value),
            source: classInfo.sourceTable || '',
            properties: {}
          });
        }

        // Add this column value as a property on the node
        nodeMap.get(nodeId).properties[colName] = value;
      }

      // Create edges between related columns in the same row
      this._inferEdges(rowObj, colToClass, edgeSet, ontologySchema);
    }

    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeSet).map(key => {
      const [source, target, relation] = key.split('|||');
      return { source, target, relation };
    });

    // Compute statistics
    const cardinality = {};
    for (const node of nodes) {
      cardinality[node.type] = (cardinality[node.type] || 0) + 1;
    }

    return {
      nodes,
      edges,
      statistics: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        cardinality,
        rowCount: rows.length,
        databasesQueried: meta.databases || []
      },
      provenance: {
        sql: meta.sql || '',
        databases: meta.databases || [],
        queryMode: 'vkg_federated'
      }
    };
  }

  /**
   * Build a reasoning trace from the context graph.
   * Step-by-step evidence chain showing how the answer was derived.
   */
  buildReasoningTrace(graph, question = '', meta = {}) {
    const trace = [];

    if (!graph || graph.nodes.length === 0) {
      trace.push({
        step: 'Query returned no results',
        evidence: [],
        sources: meta.databases || []
      });
      return trace;
    }

    const { statistics } = graph;

    // Step 1: Identify entities found
    const entityTypes = Object.entries(statistics.cardinality || {});
    if (entityTypes.length > 0) {
      const entitySummary = entityTypes.map(([type, count]) => `${count} ${type}(s)`).join(', ');
      trace.push({
        step: `Identified entities: ${entitySummary}`,
        evidence: graph.nodes.slice(0, 5).map(n => n.id),
        sources: [...new Set(graph.nodes.map(n => n.source).filter(Boolean))]
      });
    }

    // Step 2: Describe relationships traversed
    if (graph.edges.length > 0) {
      const relationTypes = [...new Set(graph.edges.map(e => e.relation))];
      trace.push({
        step: `Traversed ${graph.edges.length} relationship(s): ${relationTypes.join(', ')}`,
        evidence: graph.edges.slice(0, 5).map(e => `${e.source}→${e.target}`),
        sources: meta.databases || []
      });
    }

    // Step 3: Describe the query path
    if (entityTypes.length > 1) {
      const path = entityTypes.map(([type]) => type).join(' → ');
      trace.push({
        step: `Entity traversal path: ${path}`,
        evidence: entityTypes.map(([type]) => type),
        sources: meta.databases || []
      });
    }

    // Step 4: Result summary
    trace.push({
      step: `Result: ${statistics.rowCount} row(s) spanning ${(meta.databases || []).length} database(s), yielding ${statistics.nodeCount} unique entities`,
      evidence: graph.nodes.map(n => n.id),
      sources: meta.databases || []
    });

    return trace;
  }

  /**
   * Build context graph from GraphDB/Neo4j SPARQL/Cypher results (materialized path).
   * Adapts the same graph format for non-VKG query results.
   */
  buildFromSPARQLBindings(bindings, variables, ontologySchema = {}) {
    if (!bindings || bindings.length === 0) {
      return { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0 }, provenance: {} };
    }

    const nodeMap = new Map();
    const edgeSet = new Set();

    for (const binding of bindings) {
      for (const varName of variables) {
        const val = binding[varName];
        if (!val) continue;

        const value = val.value || val;
        const type = this._inferTypeFromVariable(varName);
        const nodeId = `${type}_${String(value).substring(0, 50)}`;

        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId,
            type,
            label: varName,
            value: String(value),
            source: 'graphdb',
            properties: { [varName]: value }
          });
        }
      }
    }

    const nodes = Array.from(nodeMap.values());
    const cardinality = {};
    for (const node of nodes) {
      cardinality[node.type] = (cardinality[node.type] || 0) + 1;
    }

    return {
      nodes,
      edges: [],
      statistics: { nodeCount: nodes.length, edgeCount: 0, cardinality, rowCount: bindings.length },
      provenance: { queryMode: 'materialized' }
    };
  }

  /**
   * Map column names to ontology classes using mapping annotations
   */
  _mapColumnsToClasses(colNames, mappings) {
    const colToClass = {};

    // Build reverse lookup: column → class
    const classForTable = {};
    for (const [className, meta] of Object.entries(mappings.classes || {})) {
      if (meta.sourceTable) classForTable[meta.sourceTable] = className;
    }

    for (const [propName, meta] of Object.entries(mappings.properties || {})) {
      if (meta.sourceColumn && meta.domain) {
        // Find the column name in our result set
        const col = colNames.find(c => c === meta.sourceColumn || c.endsWith(meta.sourceColumn));
        if (col) {
          colToClass[col] = {
            className: meta.domain,
            propertyLabel: propName,
            sourceTable: mappings.classes?.[meta.domain]?.sourceTable || ''
          };
        }
      }
    }

    // Fallback: infer from column naming conventions
    for (const col of colNames) {
      if (colToClass[col]) continue;
      colToClass[col] = {
        className: this._inferTypeFromVariable(col),
        propertyLabel: col,
        sourceTable: ''
      };
    }

    return colToClass;
  }

  /**
   * Infer edges between nodes in the same row based on ontology relationships
   */
  _inferEdges(rowObj, colToClass, edgeSet, ontologySchema) {
    const colNames = Object.keys(rowObj);
    const classesInRow = {};

    // Group columns by their class
    for (const col of colNames) {
      const info = colToClass[col];
      if (!info) continue;
      if (!classesInRow[info.className]) classesInRow[info.className] = [];
      classesInRow[info.className].push({ col, value: rowObj[col] });
    }

    // For each pair of classes, check if there's a known relationship
    const classNames = Object.keys(classesInRow);
    for (let i = 0; i < classNames.length; i++) {
      for (let j = i + 1; j < classNames.length; j++) {
        const classA = classNames[i];
        const classB = classNames[j];
        const relation = this._findRelation(classA, classB, ontologySchema);
        if (!relation) continue;

        const nodeA = classesInRow[classA][0];
        const nodeB = classesInRow[classB][0];
        if (!nodeA?.value || !nodeB?.value) continue;

        const nodeIdA = `${classA}_${String(nodeA.value).substring(0, 50)}`;
        const nodeIdB = `${classB}_${String(nodeB.value).substring(0, 50)}`;
        const edgeKey = `${nodeIdA}|||${nodeIdB}|||${relation}`;
        edgeSet.add(edgeKey);
      }
    }
  }

  /**
   * Find a relationship name between two classes from ontology schema
   */
  _findRelation(classA, classB, ontologySchema) {
    // Check ontology object properties
    if (ontologySchema.objectProperties) {
      for (const prop of ontologySchema.objectProperties) {
        const domain = prop.domain?.split('/').pop() || prop.domain || '';
        const range = prop.range?.split('/').pop() || prop.range || '';
        if ((domain === classA && range === classB) || (domain === classB && range === classA)) {
          return prop.label || prop.name || 'relatedTo';
        }
      }
    }
    // Fallback: generic relation
    return `${classA}_to_${classB}`;
  }

  /**
   * Infer ontology class type from a variable/column name
   */
  _inferTypeFromVariable(name) {
    const lower = name.toLowerCase();
    if (lower.includes('customer')) return 'Customer';
    if (lower.includes('transaction') || lower === 'tx') return 'Transaction';
    if (lower.includes('merchant')) return 'Merchant';
    if (lower.includes('account')) return 'Account';
    if (lower.includes('category')) return 'Category';
    if (lower.includes('product')) return 'Product';
    if (lower.includes('address')) return 'Address';
    if (lower.includes('order')) return 'Order';
    if (lower.includes('invoice')) return 'Invoice';
    if (lower.includes('payment')) return 'Payment';
    // Default: capitalize first letter
    return name.charAt(0).toUpperCase() + name.slice(1).replace(/_\w/g, m => m[1].toUpperCase());
  }
}

module.exports = new ContextGraphBuilder();
