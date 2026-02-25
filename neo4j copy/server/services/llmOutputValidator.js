/**
 * LLM Output Validator — validates LLM extraction/mapping results against ontology
 * 
 * Every LLM response is validated before being used:
 * - Schema analysis outputs checked for valid structure
 * - Column mappings validated against ontology classes/properties
 * - Entity extractions validated against allowed types
 * - Relationship extractions validated against allowed predicates
 */

const logger = require('../utils/logger');

class LLMOutputValidator {
  
  /**
   * Validate a schema analysis result from LLM.
   * Ensures required fields exist and types are reasonable.
   */
  validateSchemaAnalysis(analysis, headers) {
    const errors = [];
    const warnings = [];
    
    if (!analysis) {
      return { valid: false, errors: ['Analysis is null/undefined'], warnings: [], cleaned: null };
    }
    
    // Must have primaryClass
    if (!analysis.primaryClass || typeof analysis.primaryClass !== 'string') {
      errors.push('Missing or invalid primaryClass');
      analysis.primaryClass = 'Record';
    }
    
    // Validate columns array
    if (!Array.isArray(analysis.columns)) {
      warnings.push('Missing columns array, generating from headers');
      analysis.columns = headers.map(h => ({
        column: h, type: 'text', includeAsNode: false, linkedClass: '', dataProperty: h
      }));
    } else {
      // Check each column references a real header
      const headerSet = new Set(headers.map(h => h.toLowerCase()));
      for (const col of analysis.columns) {
        if (col.column && !headerSet.has(col.column.toLowerCase())) {
          warnings.push(`Column "${col.column}" not found in headers`);
        }
        // Validate type
        const validTypes = ['id', 'date', 'numeric', 'boolean', 'text', 'category', 'entity'];
        if (col.type && !validTypes.includes(col.type)) {
          warnings.push(`Column "${col.column}" has invalid type "${col.type}", defaulting to "text"`);
          col.type = 'text';
        }
        // If includeAsNode but no linkedClass, fix
        if (col.includeAsNode && !col.linkedClass) {
          warnings.push(`Column "${col.column}" marked as node but no linkedClass`);
        }
      }
      
      // Ensure all headers are covered
      const coveredHeaders = new Set(analysis.columns.map(c => c.column?.toLowerCase()));
      for (const h of headers) {
        if (h !== '__sheet' && !coveredHeaders.has(h.toLowerCase())) {
          warnings.push(`Header "${h}" not covered in analysis, adding as text`);
          analysis.columns.push({
            column: h, type: 'text', includeAsNode: false, linkedClass: '', dataProperty: h
          });
        }
      }
    }
    
    // Validate entityTypes
    if (!Array.isArray(analysis.entityTypes)) {
      analysis.entityTypes = [{ name: analysis.primaryClass, description: 'Primary entity' }];
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      cleaned: analysis,
    };
  }
  
  /**
   * Validate column mapping results against an ontology.
   * Ensures mapped classes/properties actually exist.
   */
  validateColumnMapping(mappingResult, ontology, headers) {
    const errors = [];
    const warnings = [];
    
    if (!mappingResult) {
      return { valid: false, errors: ['Mapping result is null'], warnings: [], cleaned: null };
    }
    
    const classLabels = new Set((ontology?.classes || []).map(c => (c.label || c.localName || '').toLowerCase()));
    const classIRIs = new Set((ontology?.classes || []).map(c => c.iri));
    const propLabels = new Set([
      ...(ontology?.properties || []),
      ...(ontology?.dataProperties || []),
      ...(ontology?.objectProperties || []),
    ].map(p => (p.label || p.localName || '').toLowerCase()));
    
    // Validate primaryClass
    if (mappingResult.primaryClass) {
      const pcLower = mappingResult.primaryClass.toLowerCase();
      if (!classLabels.has(pcLower) && !classIRIs.has(mappingResult.primaryClass)) {
        warnings.push(`primaryClass "${mappingResult.primaryClass}" not found in ontology`);
      }
    }
    
    // Validate each mapping
    const mappings = mappingResult.mappings || [];
    const headerSet = new Set(headers.map(h => h.toLowerCase()));
    
    for (const mapping of mappings) {
      // Check column exists
      if (mapping.column && !headerSet.has(mapping.column.toLowerCase())) {
        warnings.push(`Mapped column "${mapping.column}" not in headers`);
      }
      
      // Check property exists (if not marked as new)
      if (mapping.property && !mapping.propertyIsNew) {
        if (!propLabels.has(mapping.property.toLowerCase())) {
          warnings.push(`Property "${mapping.property}" not found in ontology, marking as new`);
          mapping.propertyIsNew = true;
        }
      }
      
      // Check linkedClass exists (if not marked as new)
      if (mapping.linkedClass && !mapping.linkedClassIsNew) {
        const lcLower = mapping.linkedClass.toLowerCase();
        if (!classLabels.has(lcLower) && !classIRIs.has(mapping.linkedClass)) {
          warnings.push(`Linked class "${mapping.linkedClass}" not found in ontology, marking as new`);
          mapping.linkedClassIsNew = true;
        }
      }
    }
    
    // Ensure all headers have a mapping
    const mappedHeaders = new Set(mappings.map(m => m.column?.toLowerCase()));
    for (const h of headers) {
      if (h !== '__sheet' && !mappedHeaders.has(h.toLowerCase())) {
        warnings.push(`Header "${h}" has no mapping, adding identity mapping`);
        mappings.push({
          column: h, isLiteral: true, property: h, propertyIsNew: true,
          linkedClass: '', linkedClassIsNew: false,
        });
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      cleaned: { ...mappingResult, mappings },
    };
  }
  
  /**
   * Validate entity extraction results against ontology.
   */
  validateEntityExtraction(extraction, ontology) {
    const warnings = [];
    
    if (!extraction) {
      return { valid: false, errors: ['Extraction is null'], warnings: [], cleaned: { entities: [], relationships: [] } };
    }
    
    const allowedClasses = new Set();
    if (ontology?.classes) {
      for (const c of ontology.classes) {
        allowedClasses.add(c.label || c.localName || '');
        allowedClasses.add((c.label || c.localName || '').toLowerCase());
      }
    }
    if (ontology?.entityTypes) {
      for (const et of ontology.entityTypes) {
        allowedClasses.add(et.label || et.userLabel || et);
        allowedClasses.add((et.label || et.userLabel || et || '').toLowerCase());
      }
    }
    
    const validEntities = [];
    const invalidEntities = [];
    
    for (const entity of (extraction.entities || [])) {
      const entityClass = entity.class || entity.type || '';
      
      // Basic validation
      if (!entity.name || entity.name.trim().length < 2) {
        invalidEntities.push({ ...entity, reason: 'Name too short or empty' });
        continue;
      }
      
      // Check class against ontology (if ontology provided)
      if (allowedClasses.size > 0 && !allowedClasses.has(entityClass) && !allowedClasses.has(entityClass.toLowerCase())) {
        warnings.push(`Entity "${entity.name}" has class "${entityClass}" not in ontology`);
        // Don't reject — mark as candidate
        entity._unmatchedClass = true;
      }
      
      // Validate confidence
      if (entity.confidence !== undefined) {
        entity.confidence = Math.max(0, Math.min(1, Number(entity.confidence) || 0));
      }
      
      validEntities.push(entity);
    }
    
    // Validate relationships
    const validRelationships = [];
    const entityNames = new Set(validEntities.map(e => (e.name || '').toLowerCase()));
    
    for (const rel of (extraction.relationships || [])) {
      const fromName = rel.from_entity || rel.from || '';
      const toName = rel.to_entity || rel.to || '';
      
      if (!fromName || !toName) {
        warnings.push(`Relationship missing from/to entity`);
        continue;
      }
      
      // Check endpoints exist in extracted entities
      if (!entityNames.has(fromName.toLowerCase())) {
        warnings.push(`Relationship from "${fromName}" — entity not found in extraction`);
      }
      if (!entityNames.has(toName.toLowerCase())) {
        warnings.push(`Relationship to "${toName}" — entity not found in extraction`);
      }
      
      if (rel.confidence !== undefined) {
        rel.confidence = Math.max(0, Math.min(1, Number(rel.confidence) || 0));
      }
      
      validRelationships.push(rel);
    }
    
    return {
      valid: true,
      errors: [],
      warnings,
      cleaned: {
        entities: validEntities,
        relationships: validRelationships,
        invalidEntities,
        candidate_concepts: extraction.candidate_concepts || [],
      },
    };
  }
}

module.exports = new LLMOutputValidator();
