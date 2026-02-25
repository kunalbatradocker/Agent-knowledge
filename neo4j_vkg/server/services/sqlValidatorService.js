/**
 * SQL Validator Service
 * Lightweight offline validation of LLM-generated SQL before Trino execution.
 * No LLM calls — fast and deterministic.
 */

const logger = require('../utils/logger');

// Forbidden SQL patterns (DDL/DML — only SELECT allowed)
const FORBIDDEN_PATTERNS = [
  /\b(CREATE|DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|REVOKE|MERGE)\b/i,
  /\bINTO\s+OUTFILE\b/i,
  /\bLOAD\s+DATA\b/i,
  /;\s*\w/  // Multiple statements
];

class SQLValidatorService {
  /**
   * Validate SQL query before execution
   * Returns { valid: boolean, errors: string[], warnings: string[] }
   */
  validate(sql, knownSchema = null, mappings = null) {
      const errors = [];
      const warnings = [];

      if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
        return { valid: false, errors: ['Empty SQL query'], warnings: [] };
      }

      const trimmed = sql.trim();

      // Must be a SELECT query
      if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
        errors.push('Only SELECT queries are allowed. Query must start with SELECT or WITH.');
      }

      // Check for forbidden patterns
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(trimmed)) {
          errors.push(`Forbidden SQL pattern detected: ${pattern.toString()}`);
        }
      }

      // Basic syntax checks
      if (!this._hasBalancedParentheses(trimmed)) {
        errors.push('Unbalanced parentheses in SQL query');
      }

      // Check for common LLM mistakes
      if (/SELECT\s+\*\s+FROM/i.test(trimmed) && !/LIMIT\b/i.test(trimmed)) {
        warnings.push('SELECT * without LIMIT may return excessive data. Consider adding LIMIT.');
      }

      // Validate against known schema (Trino introspection) if provided
      if (knownSchema && errors.length === 0) {
        const schemaErrors = this._validateAgainstSchema(trimmed, knownSchema);
        errors.push(...schemaErrors);
      }

      // Validate against ontology mappings if provided (lighter alternative to Trino introspection)
      if (mappings && !knownSchema && errors.length === 0) {
        const mappingWarnings = this._validateAgainstMappings(trimmed, mappings);
        warnings.push(...mappingWarnings);
      }

      // Trino requires fully-qualified table names (catalog.schema.table)
      // Warn about 2-part (schema.table) or 1-part (table) references
      if (errors.length === 0) {
        const twoPartPattern = /(?:FROM|JOIN)\s+(\w+\.\w+)(?!\.\w)/gi;
        let m;
        while ((m = twoPartPattern.exec(trimmed)) !== null) {
          const before = trimmed.substring(Math.max(0, m.index - 1), m.index);
          if (before !== '.') {
            warnings.push(`Table "${m[1]}" may be missing catalog prefix. Trino requires catalog.schema.table format.`);
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        sql: trimmed
      };
    }


  /**
   * Validate table and column references against known Trino schema
   */
  _validateAgainstSchema(sql, schema) {
    const errors = [];

    // Extract catalog.schema.table references from SQL
    const tableRefs = this._extractTableReferences(sql);

    // Build lookup of known tables
    const knownTables = new Set();
    const knownColumns = new Map();

    for (const catalogSchema of schema) {
      for (const table of (catalogSchema.tables || [])) {
        knownTables.add(table.fullName.toLowerCase());
        const cols = new Set(table.columns.map(c => c.name.toLowerCase()));
        knownColumns.set(table.fullName.toLowerCase(), cols);
      }
    }

    // Check each referenced table exists
    for (const ref of tableRefs) {
      if (!knownTables.has(ref.toLowerCase())) {
        errors.push(`Unknown table reference: ${ref}`);
      }
    }

    return errors;
  }

  /**
   * Validate table references against ontology mappings (no Trino needed).
   * Returns warnings (not errors) since mappings may not cover all tables.
   */
  _validateAgainstMappings(sql, mappings) {
    const warnings = [];
    const tableRefs = this._extractTableReferences(sql);

    // Build set of known tables from mappings
    const knownTables = new Set();
    for (const meta of Object.values(mappings.classes || {})) {
      if (meta.sourceTable) knownTables.add(meta.sourceTable.toLowerCase());
    }

    for (const ref of tableRefs) {
      if (knownTables.size > 0 && !knownTables.has(ref.toLowerCase())) {
        warnings.push(`Table "${ref}" not found in ontology mappings — may not exist in Trino`);
      }
    }

    return warnings;
  }



  /**
   * Extract fully-qualified table references (catalog.schema.table) from SQL
   */
  _extractTableReferences(sql) {
    const refs = new Set();
    // Match patterns like: FROM catalog.schema.table or JOIN catalog.schema.table
    const pattern = /(?:FROM|JOIN)\s+(\w+\.\w+\.\w+)/gi;
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      refs.add(match[1]);
    }
    return Array.from(refs);
  }

  /**
   * Check for balanced parentheses
   */
  _hasBalancedParentheses(sql) {
    let depth = 0;
    for (const char of sql) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  }
}

module.exports = new SQLValidatorService();
