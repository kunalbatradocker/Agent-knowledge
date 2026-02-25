/**
 * GraphDB Triple Service
 * Strict triple generation with ontology validation - NO FALLBACKS
 */

const graphDBStore = require('./graphDBStore');
const logger = require('../utils/logger');

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const PF = 'http://purplefabric.ai/ontology#';

class GraphDBTripleService {
  
  /**
   * Detect XSD datatype from value - strict typing
   */
  detectXSDType(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (str === '') return null;
    
    // Boolean
    if (str === 'true' || str === 'false') return `${XSD}boolean`;
    
    // Date patterns
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str)) return `${XSD}dateTime`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return `${XSD}date`;
    
    // Numeric - must be pure number
    if (/^-?\d+$/.test(str)) return `${XSD}integer`;
    if (/^-?\d+\.\d+$/.test(str)) return `${XSD}decimal`;
    
    return `${XSD}string`;
  }

  /**
   * Escape string for Turtle literal
   */
  escapeTurtleLiteral(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  /**
   * Generate URI-safe identifier
   */
  toURISafe(value) {
    return encodeURIComponent(String(value).trim().replace(/\s+/g, '_'));
  }

  /**
   * Validate class exists in ontology - throws if not found
   */
  validateClass(classIRI, ontology) {
    if (!ontology || !ontology.classes || ontology.classes.length === 0) {
      throw new Error('Ontology is required with at least one class defined');
    }
    const found = ontology.classes.find(c => c.iri === classIRI || c.label === classIRI);
    if (!found) {
      const available = ontology.classes.map(c => c.label || c.iri).join(', ');
      throw new Error(`Class "${classIRI}" not found in ontology. Available: ${available}`);
    }
    return found;
  }

  /**
   * Validate property exists in ontology - throws if not found
   */
  validateProperty(propIRI, ontology) {
    if (!ontology || !ontology.properties) {
      throw new Error('Ontology with properties is required');
    }
    const found = ontology.properties.find(p => p.iri === propIRI || p.label === propIRI);
    if (!found) {
      const available = ontology.properties.map(p => p.label || p.iri).join(', ');
      throw new Error(`Property "${propIRI}" not found in ontology. Available: ${available}`);
    }
    return found;
  }

  /**
   * Build typed literal triple
   */
  buildLiteralTriple(subject, predicate, value) {
    const escaped = this.escapeTurtleLiteral(value);
    const xsdType = this.detectXSDType(value);
    if (!xsdType) return null;
    return `<${subject}> <${predicate}> "${escaped}"^^<${xsdType}> .`;
  }

  /**
   * Build URI reference triple
   */
  buildURITriple(subject, predicate, object) {
    return `<${subject}> <${predicate}> <${object}> .`;
  }

  /**
   * Auto-detect the primary key column for a set of headers and rows.
   * Prefers columns named 'id', '*_id', '*Id', then falls back to first column with all unique values.
   */
  detectPrimaryKeyColumn(headers, rows) {
    // Priority 1: exact 'id' column
    const exactId = headers.find(h => /^id$/i.test(h));
    if (exactId) return exactId;

    // Priority 2: columns ending in _id, Id, _key, _pk, _code, _ref, _number, _num
    const idSuffix = headers.find(h => /[_]id$/i.test(h) || /[a-z]Id$/.test(h) || /[_](pk|key|code|ref|number|num)$/i.test(h));
    if (idSuffix) return idSuffix;

    // Priority 3: first column with all unique non-empty values
    for (const h of headers) {
      if (h === '__sheet') continue;
      const vals = rows.map(r => r[h]).filter(v => v != null && v !== '');
      if (vals.length > 0 && vals.length === new Set(vals.map(String)).size) {
        return h;
      }
    }

    return null;
  }

  /**
   * Build a stable, natural-key-based URI for a row entity.
   * Uses className + primary key value so the same entity across files maps to the same URI.
   */
  buildEntityUri(dataGraphIRI, className, primaryKeyValue) {
    const safeClass = this.toURISafe(className);
    const safeKey = this.toURISafe(String(primaryKeyValue));
    return `${dataGraphIRI}/entity/${safeClass}/${safeKey}`;
  }

  /**
   * Generate triples for CSV/Excel data with:
   * - Natural key URIs (dedup across files)
   * - Version tracking (pf:lastUpdatedBy, pf:updatedAt)
   * - Cross-sheet ID lookup returned for relationship resolution
   */
  generateCSVTriples(csvData, ontology, columnMappings, options = {}) {
    const { tenantId, workspaceId, docUri, primaryClass, strictMode = false, sheetClassMap } = options;
    
    if (!primaryClass) {
      throw new Error('primaryClass is required for CSV import');
    }
    
    const OWL = 'http://www.w3.org/2002/07/owl#';
    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    const triples = [];
    const warnings = [];
    const now = new Date().toISOString();
    
    // Determine primary class IRI
    let primaryClassIRI = primaryClass;
    if (ontology?.classes?.length > 0) {
      const primaryClassDef = ontology.classes.find(c => c.iri === primaryClass || c.label === primaryClass);
      if (primaryClassDef) {
        primaryClassIRI = primaryClassDef.iri;
      } else if (strictMode) {
        throw new Error(`Primary class "${primaryClass}" not found in ontology`);
      } else {
        warnings.push(`Primary class "${primaryClass}" not found in ontology, using as-is`);
      }
    }
    
    // Build ontology namespace for auto-generated properties
    const ontologyNS = ontology?.ontologyIRI 
      ? `${ontology.ontologyIRI}#`
      : `${dataGraphIRI}/property/`;
    
    // Document triple
    triples.push(this.buildURITriple(docUri, `${RDF}type`, `${PF}Document`));
    triples.push(`<${docUri}> <${RDFS}label> "${this.escapeTurtleLiteral(options.docTitle || 'Document')}"^^<${XSD}string> .`);
    
    const rows = csvData.rows || [];
    const headers = csvData.headers || [];
    
    // Pre-validate mappings in strict mode
    if (strictMode && ontology) {
      const errors = [];
      for (const col of headers) {
        const mapping = columnMappings?.[col];
        if (!mapping || mapping.ignore) continue;
        if (mapping.property) {
          const allProps = [...(ontology.properties || []), ...(ontology.objectProperties || []), ...(ontology.dataProperties || [])];
          const propExists = allProps.some(p => p.iri === mapping.property || p.label === mapping.property);
          if (!propExists) errors.push(`Column "${col}": Property "${mapping.property}" not found in ontology`);
        }
        if (mapping.linkedClass) {
          const classExists = ontology.classes?.some(c => c.iri === mapping.linkedClass || c.label === mapping.linkedClass);
          if (!classExists) errors.push(`Column "${col}": Linked class "${mapping.linkedClass}" not found in ontology`);
        }
      }
      if (errors.length > 0) throw new Error(`Ontology validation failed:\n${errors.join('\n')}`);
    }
    
    // Build sheet-to-class IRI map for multi-sheet Excel
    const resolvedSheetClassMap = {};
    const sheetClassLabels = {}; // sheetName → class label (for URI building)
    if (sheetClassMap && Object.keys(sheetClassMap).length > 0) {
      for (const [sheetName, classNameOrIri] of Object.entries(sheetClassMap)) {
        const classDef = ontology?.classes?.find(c => 
          c.iri === classNameOrIri || c.label === classNameOrIri || c.iri?.endsWith('#' + classNameOrIri)
        );
        resolvedSheetClassMap[sheetName] = classDef?.iri || classNameOrIri;
        sheetClassLabels[sheetName] = classDef?.label || classNameOrIri.split('#').pop() || sheetName;
      }
      logger.info(`[CSV Triples] Sheet class map: ${JSON.stringify(resolvedSheetClassMap)}`);
      // Declare each sheet class as owl:Class
      for (const [sheetName, classIRI] of Object.entries(resolvedSheetClassMap)) {
        triples.push(this.buildURITriple(classIRI, `${RDF}type`, `${OWL}Class`));
        triples.push(`<${classIRI}> <${RDFS}label> "${this.escapeTurtleLiteral(sheetClassLabels[sheetName])}"^^<${XSD}string> .`);
      }
    }

    // Detect primary key column per sheet (or global)
    const sheetPKColumns = {}; // sheetName → pk column name
    let globalPKColumn = null;
    if (sheetClassMap && Object.keys(sheetClassMap).length > 0) {
      // Multi-sheet: detect PK per sheet
      for (const sheetName of Object.keys(sheetClassMap)) {
        const sheetRows = rows.filter(r => r.__sheet === sheetName);
        const sheetHeaders = headers.filter(h => h !== '__sheet');
        sheetPKColumns[sheetName] = this.detectPrimaryKeyColumn(sheetHeaders, sheetRows);
        logger.info(`[CSV Triples] Sheet "${sheetName}" PK column: ${sheetPKColumns[sheetName] || '(none, using row index)'}`);
      }
    } else {
      // Single sheet
      globalPKColumn = this.detectPrimaryKeyColumn(headers, rows);
      logger.info(`[CSV Triples] Global PK column: ${globalPKColumn || '(none, using row index)'}`);
    }

    // Declare pf:sourceDocument, pf:rowIndex, pf:lastUpdatedBy, pf:updatedAt
    triples.push(`<${PF}sourceDocument> <${RDF}type> <${OWL}ObjectProperty> .`);
    triples.push(`<${PF}rowIndex> <${RDF}type> <${OWL}DatatypeProperty> .`);
    triples.push(`<${PF}lastUpdatedBy> <${RDF}type> <${OWL}ObjectProperty> .`);
    triples.push(`<${PF}updatedAt> <${RDF}type> <${OWL}DatatypeProperty> .`);

    // PASS 1: Build natural-key entity URIs and ID lookup
    // idLookup maps "value" → entityUri for cross-sheet FK resolution
    const idLookup = {};       // { "CUST001": entityUri, "ClassName:CUST001": entityUri }
    const rowToUri = [];       // rowIndex → entityUri
    const entityUriSet = new Set(); // track unique URIs to count deduped entities

    rows.forEach((row, i) => {
      const sheetName = row.__sheet;
      const rowClassIRI = (sheetName && resolvedSheetClassMap[sheetName]) || primaryClassIRI;
      const classLabel = (sheetName && sheetClassLabels[sheetName]) 
        || (ontology?.classes?.find(c => c.iri === primaryClassIRI)?.label)
        || primaryClassIRI.split('#').pop() || 'Record';

      // Determine PK column and value
      const pkCol = (sheetName && sheetPKColumns[sheetName]) || globalPKColumn;
      const pkValue = pkCol && row[pkCol] != null && row[pkCol] !== '' ? String(row[pkCol]) : null;

      let entityUri;
      if (pkValue) {
        // Natural key URI — stable across files
        entityUri = this.buildEntityUri(dataGraphIRI, classLabel, pkValue);
      } else {
        // Fallback: positional URI (unique per document)
        entityUri = `${dataGraphIRI}/entity/${this.toURISafe(classLabel)}/${this.toURISafe(docUri)}_row${i}`;
        warnings.push(`Row ${i}: no primary key found, using positional URI`);
      }

      rowToUri[i] = entityUri;
      entityUriSet.add(entityUri);

      // Index for cross-sheet FK resolution — ONLY the PK value identifies this entity
      if (pkValue) {
        idLookup[`${classLabel}:${pkValue}`] = entityUri;
        if (!idLookup[pkValue]) idLookup[pkValue] = entityUri; // first-come for unqualified
      }
    });

    logger.info(`[CSV Triples] Built ID lookup: ${Object.keys(idLookup).length} entries, ${entityUriSet.size} unique entities from ${rows.length} rows`);

    // PASS 2: Generate triples for each row
    rows.forEach((row, i) => {
      const sheetName = row.__sheet;
      const rowClassIRI = (sheetName && resolvedSheetClassMap[sheetName]) || primaryClassIRI;
      const entityUri = rowToUri[i];
      
      // Entity type + provenance
      triples.push(this.buildURITriple(entityUri, `${RDF}type`, rowClassIRI));
      triples.push(this.buildURITriple(entityUri, `${PF}sourceDocument`, docUri));
      triples.push(`<${entityUri}> <${PF}rowIndex> "${i}"^^<${XSD}integer> .`);
      
      // Version tracking — latest file that touched this entity
      triples.push(this.buildURITriple(entityUri, `${PF}lastUpdatedBy`, docUri));
      triples.push(`<${entityUri}> <${PF}updatedAt> "${now}"^^<${XSD}dateTime> .`);
      
      // rdfs:label from PK or first name-like column
      const pkCol = (sheetName && sheetPKColumns[sheetName]) || globalPKColumn;
      const labelCol = headers.find(h => /^(name|fullname|title|label)$/i.test(h) && row[h])
        || (pkCol && row[pkCol] ? pkCol : null)
        || headers.find(h => h !== '__sheet' && row[h]);
      if (labelCol && row[labelCol]) {
        triples.push(`<${entityUri}> <${RDFS}label> "${this.escapeTurtleLiteral(String(row[labelCol]))}"^^<${XSD}string> .`);
      }
      
      // Process each column
      headers.forEach(col => {
        if (col === '__sheet') return;
        const value = row[col];
        if (value === null || value === undefined || value === '') return;
        
        const mapping = (sheetName && columnMappings?.[`${sheetName}:${col}`]) || columnMappings?.[col] || {};
        if (mapping.ignore) return;

        // If this column is the PK of the current sheet, always treat as data property
        const isPK = col === pkCol;
        const effectiveLinkedClass = isPK ? '' : (mapping.linkedClass || '');
        
        // Determine property IRI
        let propIRI;
        if (mapping.property) {
          const allProps = [...(ontology?.properties || []), ...(ontology?.objectProperties || []), ...(ontology?.dataProperties || [])];
          const propDef = allProps.find(p => p.iri === mapping.property || p.label === mapping.property);
          propIRI = propDef?.iri || mapping.property;
          
          // Safety: if linkedClass is set but the resolved property is a DatatypeProperty,
          // it can't serve as an object link. Fall back to auto-generated property name.
          if (effectiveLinkedClass && propDef) {
            const isDataProp = (ontology?.dataProperties || []).some(dp => dp.iri === propDef.iri);
            const isObjProp = (ontology?.objectProperties || []).some(op => op.iri === propDef.iri);
            if (isDataProp && !isObjProp) {
              const linkedLabel = mapping.linkedClassLabel || effectiveLinkedClass.split('#').pop() || col;
              const safeName = `has${linkedLabel.replace(/[^a-zA-Z0-9]/g, '')}`;
              propIRI = `${ontologyNS}${safeName}`;
              warnings.push(`Col "${col}": property "${propDef.label || propDef.iri}" is a DatatypeProperty but linkedClass is set — using "${safeName}" instead`);
            }
          }
        } else {
          const safePropName = col.replace(/[^a-zA-Z0-9]/g, '_');
          propIRI = `${ontologyNS}${safePropName}`;
        }
        
        if (effectiveLinkedClass) {
          // Object property — link to entity
          const linkedClassDef = ontology?.classes?.find(c => c.iri === effectiveLinkedClass || c.label === effectiveLinkedClass);
          const linkedClassIRI = linkedClassDef?.iri || effectiveLinkedClass;
          const linkedClassLabel = linkedClassDef?.label || mapping.linkedClass.split('#').pop() || col;
          
          // Resolve to existing entity via ID lookup
          const qualifiedKey = `${linkedClassLabel}:${String(value)}`;
          const existingUri = idLookup[qualifiedKey] || idLookup[String(value)];
          if (existingUri) {
            triples.push(this.buildURITriple(entityUri, propIRI, existingUri));
          } else {
            // Create stub linked entity
            const linkedUri = this.buildEntityUri(dataGraphIRI, linkedClassLabel, value);
            triples.push(this.buildURITriple(linkedUri, `${RDF}type`, linkedClassIRI));
            triples.push(`<${linkedUri}> <${RDFS}label> "${this.escapeTurtleLiteral(value)}"^^<${XSD}string> .`);
            triples.push(this.buildURITriple(linkedUri, `${PF}sourceDocument`, docUri));
            triples.push(this.buildURITriple(entityUri, propIRI, linkedUri));
          }
        } else {
          // Data property — determine target entity based on domain
          // If mapping.domain is set and differs from the row entity class, attach to the linked entity instead
          let targetUri = entityUri;
          if (mapping.domain) {
            const domainClassDef = ontology?.classes?.find(c => c.iri === mapping.domain || c.label === mapping.domain);
            const domainClassIRI = domainClassDef?.iri || mapping.domain;
            const domainClassLabel = domainClassDef?.label || mapping.domainLabel || mapping.domain.split('#').pop();
            
            // Only reroute if domain differs from the row's class
            if (domainClassIRI !== rowClassIRI) {
              // Find the linked entity of the domain class from this row's other columns
              // Look through other columns in this row that link to the domain class
              let foundTarget = null;
              headers.forEach(otherCol => {
                if (otherCol === col || otherCol === '__sheet' || foundTarget) return;
                const otherMapping = (sheetName && columnMappings?.[`${sheetName}:${otherCol}`]) || columnMappings?.[otherCol] || {};
                if (!otherMapping.linkedClass) return;
                const otherLinkedDef = ontology?.classes?.find(c => c.iri === otherMapping.linkedClass || c.label === otherMapping.linkedClass);
                const otherLinkedIRI = otherLinkedDef?.iri || otherMapping.linkedClass;
                if (otherLinkedIRI === domainClassIRI) {
                  // This column links to the domain class — use its value to find the entity
                  const otherValue = row[otherCol];
                  if (otherValue != null && otherValue !== '') {
                    const qualKey = `${domainClassLabel}:${String(otherValue)}`;
                    foundTarget = idLookup[qualKey] || idLookup[String(otherValue)];
                    if (!foundTarget) {
                      // Build the URI the same way the object property handler would
                      foundTarget = this.buildEntityUri(dataGraphIRI, domainClassLabel, otherValue);
                    }
                  }
                }
              });
              if (foundTarget) {
                targetUri = foundTarget;
              } else {
                warnings.push(`Row ${i}, col "${col}": domain "${domainClassLabel}" not resolvable from row data, attaching to row entity`);
              }
            }
          }
          const triple = this.buildLiteralTriple(targetUri, propIRI, value);
          if (triple) triples.push(triple);
        }
      });
    });
    
    return {
      triples,
      entityCount: entityUriSet.size,
      tripleCount: triples.length,
      warnings,
      // Expose for relationship resolution in caller
      idLookup,
      rowToUri,
      resolvedSheetClassMap,
      sheetClassLabels,
      ontologyNS
    };
  }

  /**
   * Generate triples for extracted entities with STRICT ontology validation
   */
  generateEntityTriples(entities, relationships, ontology, options = {}) {
    const { tenantId, workspaceId, docUri } = options;
    
    if (!ontology) {
      throw new Error('Ontology is required for entity extraction');
    }
    if (!entities || entities.length === 0) {
      throw new Error('At least one entity is required');
    }
    
    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    const triples = [];
    const entityURIs = new Map(); // label -> URI mapping for relationships
    
    // Validate all entity types exist in ontology
    const invalidTypes = [];
    for (const entity of entities) {
      const type = entity.type || entity.class;
      if (!type) {
        throw new Error(`Entity "${entity.label}" has no type specified`);
      }
      const classDef = ontology.classes.find(c => 
        c.iri === type || c.label === type || c.label?.toLowerCase() === type.toLowerCase()
      );
      if (!classDef) {
        invalidTypes.push(type);
      }
    }
    
    if (invalidTypes.length > 0) {
      const available = ontology.classes.map(c => c.label || c.iri).join(', ');
      throw new Error(`Entity types not found in ontology: ${[...new Set(invalidTypes)].join(', ')}. Available: ${available}`);
    }
    
    // Generate entity triples
    for (const entity of entities) {
      const type = entity.type || entity.class;
      const label = entity.label || entity.name;
      if (!label) {
        throw new Error('Entity must have a label or name');
      }
      
      const classDef = ontology.classes.find(c => 
        c.iri === type || c.label === type || c.label?.toLowerCase() === type.toLowerCase()
      );
      const classIRI = classDef.iri;
      const entityUri = `${dataGraphIRI}/${this.toURISafe(classDef.label || type)}/${this.toURISafe(label)}`;
      
      entityURIs.set(label.toLowerCase(), entityUri);
      
      triples.push(this.buildURITriple(entityUri, `${RDF}type`, classIRI));
      triples.push(`<${entityUri}> <${RDFS}label> "${this.escapeTurtleLiteral(label)}"^^<${XSD}string> .`);
      
      if (docUri) {
        triples.push(this.buildURITriple(entityUri, `${PF}sourceDocument`, docUri));
      }
      
      if (entity.confidence !== undefined) {
        triples.push(`<${entityUri}> <${PF}confidence> "${entity.confidence}"^^<${XSD}decimal> .`);
      }
      
      if (entity.sourceSpan) {
        triples.push(`<${entityUri}> <${PF}sourceSpan> "${this.escapeTurtleLiteral(entity.sourceSpan)}"^^<${XSD}string> .`);
      }
      
      // Add entity properties
      if (entity.properties) {
        for (const [propName, propValue] of Object.entries(entity.properties)) {
          if (propValue === null || propValue === undefined) continue;
          const propDef = ontology.properties.find(p => 
            p.label === propName || p.iri?.endsWith(`#${propName}`)
          );
          if (propDef) {
            const triple = this.buildLiteralTriple(entityUri, propDef.iri, propValue);
            if (triple) triples.push(triple);
          }
        }
      }
    }
    
    // Generate relationship triples
    if (relationships && relationships.length > 0) {
      for (const rel of relationships) {
        const sourceLabel = (rel.sourceLabel || rel.from || rel.source || '').toLowerCase();
        const targetLabel = (rel.targetLabel || rel.to || rel.target || '').toLowerCase();
        const predicate = rel.predicate || rel.type;
        
        if (!predicate) {
          throw new Error('Relationship must have a predicate or type');
        }
        
        const sourceUri = entityURIs.get(sourceLabel);
        const targetUri = entityURIs.get(targetLabel);
        
        if (!sourceUri) {
          throw new Error(`Relationship source "${rel.sourceLabel || rel.from}" not found in entities`);
        }
        if (!targetUri) {
          throw new Error(`Relationship target "${rel.targetLabel || rel.to}" not found in entities`);
        }
        
        // Validate predicate exists in ontology
        const propDef = ontology.properties.find(p => 
          p.label === predicate || 
          p.label?.toUpperCase() === predicate.toUpperCase() ||
          p.iri?.endsWith(`#${predicate}`)
        );
        
        if (!propDef) {
          const available = ontology.properties.filter(p => p.type === 'ObjectProperty').map(p => p.label).join(', ');
          throw new Error(`Relationship predicate "${predicate}" not found in ontology. Available: ${available}`);
        }
        
        triples.push(this.buildURITriple(sourceUri, propDef.iri, targetUri));
        
        if (rel.confidence !== undefined) {
          // Create reified statement for confidence
          const stmtUri = `${sourceUri}/rel/${this.toURISafe(predicate)}/${this.toURISafe(targetLabel)}`;
          triples.push(this.buildURITriple(stmtUri, `${RDF}type`, `${RDF}Statement`));
          triples.push(this.buildURITriple(stmtUri, `${RDF}subject`, sourceUri));
          triples.push(this.buildURITriple(stmtUri, `${RDF}predicate`, propDef.iri));
          triples.push(this.buildURITriple(stmtUri, `${RDF}object`, targetUri));
          triples.push(`<${stmtUri}> <${PF}confidence> "${rel.confidence}"^^<${XSD}decimal> .`);
        }
      }
    }
    
    return {
      triples,
      entityCount: entities.length,
      relationshipCount: relationships?.length || 0,
      tripleCount: triples.length,
      entityURIs: Object.fromEntries(entityURIs)
    };
  }

  /**
   * Delete all triples for the given entity URIs from the data graph.
   * Uses SPARQL UPDATE DELETE WHERE, batching URIs in groups of 100.
   * @param {string} tenantId
   * @param {string} workspaceId
   * @param {string[]} entityURIs - URIs of entities whose triples should be deleted
   */
  async deleteEntityTriples(tenantId, workspaceId, entityURIs) {
    if (!entityURIs || entityURIs.length === 0) {
      return;
    }

    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/statements`;
    const BATCH_SIZE = 100;

    logger.info(`[deleteEntityTriples] Deleting triples for ${entityURIs.length} entities from ${dataGraphIRI}`);

    for (let i = 0; i < entityURIs.length; i += BATCH_SIZE) {
      const batch = entityURIs.slice(i, i + BATCH_SIZE);
      const valuesClause = batch.map(uri => `<${uri}>`).join(' ');

      const sparql = `DELETE WHERE {\n  GRAPH <${dataGraphIRI}> {\n    ?s ?p ?o .\n  }\n  VALUES ?s { ${valuesClause} }\n}`;

      const response = await graphDBStore._fetchWithPool(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: sparql
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GraphDB delete failed at batch ${Math.floor(i / BATCH_SIZE) + 1}: ${response.status} - ${error}`);
      }

      logger.info(`[deleteEntityTriples] Deleted batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(entityURIs.length / BATCH_SIZE)} (${batch.length} entities)`);
    }
  }

  /**
   * Write triples to GraphDB with atomic transaction behavior
   * Uses _fetchWithPool for concurrency control and timeout
   */
  async writeTriplesToGraphDB(tenantId, workspaceId, triples, options = {}) {
    if (!triples || triples.length === 0) {
      throw new Error('No triples to write');
    }

    const { sourceDocumentURI } = options;

    // Step 1: Pre-commit audit (only if sourceDocumentURI is provided)
    if (sourceDocumentURI) {
      const auditService = require('./auditService'); // lazy require to avoid circular dep
      let auditResult;
      try {
        auditResult = await auditService.preCommitAudit(
          tenantId, workspaceId, triples, sourceDocumentURI
        );
      } catch (err) {
        throw new Error(`Audit failed, aborting data write: ${err.message}`);
      }

      // Step 2: Delete old triples for affected entities
      if (auditResult.entityURIsToDelete.length > 0) {
        await this.deleteEntityTriples(tenantId, workspaceId, auditResult.entityURIsToDelete);
      }
    }

    // Step 3: Insert new triples (existing batch POST logic)
    const dataGraphIRI = graphDBStore.getDataGraphIRI(tenantId, workspaceId);
    const url = `${graphDBStore.baseUrl}/repositories/${graphDBStore.repository}/rdf-graphs/service?graph=${encodeURIComponent(dataGraphIRI)}`;
    
    const BATCH_SIZE = 10000;
    const prefixes = [
      `@prefix rdf: <${RDF}> .`,
      `@prefix rdfs: <${RDFS}> .`,
      `@prefix xsd: <${XSD}> .`,
      `@prefix pf: <${PF}> .`,
      ''
    ].join('\n');
    
    for (let i = 0; i < triples.length; i += BATCH_SIZE) {
      const batch = triples.slice(i, i + BATCH_SIZE);
      const turtle = prefixes + '\n' + batch.join('\n');
      
      const response = await graphDBStore._fetchWithPool(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GraphDB write failed at batch ${Math.floor(i / BATCH_SIZE) + 1}: ${response.status} - ${error}`);
      }
      
      logger.info(`✅ Wrote batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(triples.length / BATCH_SIZE)} (${batch.length} triples)`);
    }
    
    logger.info(`✅ Wrote ${triples.length} total triples to GraphDB: ${dataGraphIRI}`);
    
    return {
      success: true,
      graphIRI: dataGraphIRI,
      tripleCount: triples.length
    };
  }
}

module.exports = new GraphDBTripleService();
