import React, { useState, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './SchemaReview.css';

/**
 * SchemaReview Component
 * Allows users to review, edit, add, and remove schema elements before creating nodes
 */
// Use relative URL for API calls
const API_BASE_URL = '/api';

const SchemaReview = ({ analysis, onApprove, onCancel, onUpdate, isPredefined = false }) => {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [columns, setColumns] = useState(analysis?.columns || []);
  const [relationships, setRelationships] = useState(
    (analysis?.relationships || []).map(r => ({ ...r, include: r.include !== false }))
  );
  const [entityTypes, setEntityTypes] = useState(
    (analysis?.entityTypes || []).map(et => ({ 
      ...et, 
      include: et.include !== false,
      // Ensure properties are properly formatted
      properties: (et.properties || et.suggestedProperties || []).map(p =>
        typeof p === 'string' ? { name: p, data_type: 'string' } : p
      )
    }))
  );

  // Update state when analysis prop changes
  React.useEffect(() => {
    console.log('SchemaReview - Analysis object updated:', analysis);
    console.log('SchemaReview - EntityTypes:', analysis?.entityTypes);
    console.log('SchemaReview - Relationships:', analysis?.relationships);
    console.log('SchemaReview - Columns:', analysis?.columns);
    
    if (analysis) {
      // Update columns if they exist
      if (analysis.columns) {
        setColumns(analysis.columns);
      }
      
      // Update relationships if they exist
      if (analysis.relationships) {
        setRelationships(analysis.relationships.map(r => ({ ...r, include: r.include !== false })));
      }
      
      // Update entityTypes if they exist
      if (analysis.entityTypes) {
        setEntityTypes(analysis.entityTypes.map(et => ({ 
          ...et, 
          include: et.include !== false,
          // Ensure properties are properly formatted
          properties: (et.properties || et.suggestedProperties || []).map(p =>
            typeof p === 'string' ? { name: p, data_type: 'string' } : p
          )
        })));
      }
    }
  }, [analysis]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAddEntity, setShowAddEntity] = useState(false);
  const [showAddRelationship, setShowAddRelationship] = useState(false);
  const [newEntity, setNewEntity] = useState({ label: '', description: '' });
  const [newRelationship, setNewRelationship] = useState({ from: '', predicate: '', to: '', description: '' });
  
  // Save ontology state
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [ontologyName, setOntologyName] = useState('');
  const [ontologyDescription, setOntologyDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const isCSV = analysis?.fileType === 'csv';
  
  // Get ontology classes for CSV column mapping
  const ontologyClasses = analysis?.ontologyClasses || analysis?.originalSchema?.entityTypes?.map(e => e.label || e.userLabel) || [];
  const ontologyRelationships = analysis?.ontologyRelationships || analysis?.originalSchema?.relationships || [];
  
  // Common type suggestions - combine with ontology classes
  const commonTypes = [
    ...ontologyClasses,
    'Person', 'Organization', 'Product', 'Location', 'Event', 'Document',
    'Technology', 'Process', 'Concept', 'Service', 'Role', 'Skill',
    'Project', 'Education', 'Date', 'Achievement', 'TimePeriod',
    'Drug', 'Disease', 'Symptom', 'Treatment', 'Contract', 'Regulation'
  ].filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates
  
  // Common relationship suggestions - combine with ontology relationships
  const commonRelationships = [
    ...ontologyRelationships.map(r => r.predicate || r.userPredicate || r.type),
    'WORKS_AT', 'HAS_SKILL', 'WORKED_ON', 'STUDIED_AT', 'MANAGES',
    'BELONGS_TO', 'REPORTS_TO', 'CREATED_BY', 'CONTAINS', 'PART_OF', 
    'RELATED_TO', 'DEPENDS_ON', 'USES', 'LOCATED_IN', 'HAS',
    'TREATS', 'CAUSES', 'OWNS', 'PRODUCES', 'EMPLOYED_BY'
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  // Handle column label change (maps to ontology class)
  const handleColumnLabelChange = useCallback((index, newLabel) => {
    setColumns(prev => {
      const updated = [...prev];
      updated[index] = { 
        ...updated[index], 
        userLabel: newLabel,
        ontologyClass: ontologyClasses.includes(newLabel) ? newLabel : null
      };
      return updated;
    });
  }, [ontologyClasses]);

  // Handle column type toggle (node vs property)
  const handleColumnTypeToggle = useCallback((index) => {
    setColumns(prev => {
      const updated = [...prev];
      const current = updated[index];
      updated[index] = {
        ...current,
        includeAsNode: !current.includeAsNode,
        includeAsProperty: current.includeAsNode
      };
      return updated;
    });
  }, []);

  // Handle relationship field changes
  const handleRelationshipChange = useCallback((index, field, value) => {
    setRelationships(prev => {
      const updated = [...prev];
      if (field === 'predicate') {
        updated[index] = { ...updated[index], userPredicate: value.toUpperCase().replace(/\s+/g, '_') };
      } else if (field === 'from') {
        updated[index] = { ...updated[index], from: value, fromColumn: value };
      } else if (field === 'to') {
        updated[index] = { ...updated[index], to: value, toColumn: value };
      } else {
        updated[index] = { ...updated[index], [field]: value };
      }
      return updated;
    });
  }, []);

  // Handle relationship toggle
  const handleRelationshipToggle = useCallback((index) => {
    setRelationships(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], include: !updated[index].include };
      return updated;
    });
  }, []);

  // Remove relationship
  const handleRemoveRelationship = useCallback((index) => {
    setRelationships(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Add new relationship
  const handleAddRelationship = useCallback(() => {
    if (newRelationship.from && newRelationship.predicate && newRelationship.to) {
      setRelationships(prev => [...prev, {
        from: newRelationship.from,
        fromColumn: newRelationship.from,
        to: newRelationship.to,
        toColumn: newRelationship.to,
        predicate: newRelationship.predicate.toUpperCase().replace(/\s+/g, '_'),
        userPredicate: newRelationship.predicate.toUpperCase().replace(/\s+/g, '_'),
        suggestedPredicate: newRelationship.predicate.toUpperCase().replace(/\s+/g, '_'),
        description: newRelationship.description,
        include: true,
        confidence: 1.0
      }]);
      setNewRelationship({ from: '', predicate: '', to: '', description: '' });
      setShowAddRelationship(false);
    }
  }, [newRelationship]);

  // Handle entity type field changes
  const handleEntityTypeChange = useCallback((index, field, value) => {
    setEntityTypes(prev => {
      const updated = [...prev];
      if (field === 'label') {
        updated[index] = { ...updated[index], userLabel: value, label: value };
      } else {
        updated[index] = { ...updated[index], [field]: value };
      }
      return updated;
    });
  }, []);

  // Handle entity type toggle
  const handleEntityTypeToggle = useCallback((index) => {
    setEntityTypes(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], include: !updated[index].include };
      return updated;
    });
  }, []);

  // Remove entity type
  const handleRemoveEntityType = useCallback((index) => {
    setEntityTypes(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Add new entity type
  const handleAddEntityType = useCallback(() => {
    if (newEntity.label) {
      setEntityTypes(prev => [...prev, {
        label: newEntity.label,
        userLabel: newEntity.label,
        description: newEntity.description || `Custom entity type: ${newEntity.label}`,
        examples: [],
        confidence: 1.0,
        include: true
      }]);
      setNewEntity({ label: '', description: '' });
      setShowAddEntity(false);
    }
  }, [newEntity]);

  // Handle approve
  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      // Build column mapping for CSV (column name -> ontology class)
      const columnMapping = {};
      if (isCSV) {
        columns.forEach(col => {
          if (col.includeAsNode && (col.userLabel || col.suggestedLabel)) {
            columnMapping[col.column] = col.userLabel || col.suggestedLabel;
          }
        });
      }

      // Build the approved data
      const approvedData = {
        columns: isCSV ? columns : undefined,
        entityTypes: !isCSV ? entityTypes : undefined,
        relationships,
        // Include mapping data for CSV processing
        columnMapping: isCSV ? columnMapping : undefined,
        relationshipMapping: isCSV ? relationships.filter(r => r.include) : undefined
      };
      
      // Validate that we have at least some approved items
      if (isCSV) {
        const hasNodeColumns = columns.some(c => c.includeAsNode);
        if (!hasNodeColumns) {
          throw new Error('Please select at least one column to include as a node');
        }
      } else {
        const hasEntityTypes = entityTypes.some(et => et.include !== false);
        if (!hasEntityTypes) {
          throw new Error('Please select at least one entity type');
        }
      }
      
      // For predefined schemas, we don't need to update the server
      // The analysis is local-only and we pass the approved data directly to onApprove
      if (isPredefined) {
        console.log('[SchemaReview] Predefined schema - updating locally');
        if (onUpdate) {
          // Local update only - doesn't need to return anything meaningful
          onUpdate(approvedData);
        }
      } else {
        // For LLM-analyzed files, update the server with changes
        if (onUpdate) {
          console.log('[SchemaReview] Updating analysis with approved data...');
          console.log('[SchemaReview] Approved data:', approvedData);
          try {
            const updatedAnalysis = await onUpdate(approvedData);
            console.log('[SchemaReview] Analysis updated successfully:', updatedAnalysis);
            
            if (!updatedAnalysis) {
              console.error('[SchemaReview] onUpdate returned null/undefined');
              throw new Error('Failed to update analysis on server: Update returned no data');
            }
          } catch (updateError) {
            console.error('[SchemaReview] Error updating analysis:', updateError);
            console.error('[SchemaReview] Error message:', updateError.message);
            console.error('[SchemaReview] Error stack:', updateError.stack);
            throw new Error(`Failed to update analysis on server: ${updateError.message || 'Unknown error'}`);
          }
        } else {
          console.warn('[SchemaReview] No onUpdate handler provided - approved data may not be saved');
        }
      }
      
      // Then approve and pass the approved data
      console.log('Calling onApprove with approved data');
      await onApprove(approvedData);
    } catch (error) {
      console.error('Approval failed:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
      alert(`Error: ${error.message || 'Failed to approve and create nodes'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle save ontology
  const handleSaveOntology = async () => {
    if (!ontologyName.trim()) {
      alert('Please enter a name for the ontology');
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          name: ontologyName.trim(),
          description: ontologyDescription.trim(),
          workspace_id: currentWorkspace?.workspace_id || '',
          entityTypes: entityTypes,
          relationships: relationships,
          sourceDocument: analysis?.documentName
        })
      });

      if (!response.ok) {
        let errorMessage = 'Failed to save ontology';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch (e) {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log('Save ontology result:', result);
      alert(`✅ Ontology "${ontologyName}" saved! You can now select it from the dropdown for future uploads.`);
      setShowSaveDialog(false);
      setOntologyName('');
      setOntologyDescription('');
    } catch (error) {
      console.error('Save ontology failed:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const nodeColumnCount = columns.filter(c => c.includeAsNode).length;
  const propertyColumnCount = columns.filter(c => c.includeAsProperty).length;
  const activeRelationshipCount = relationships.filter(r => r.include).length;
  const activeEntityTypeCount = entityTypes.filter(e => e.include).length;

  // Get all entity type labels for relationship dropdowns
  // Include both entityTypes and nodeTypes/conceptTypes from analysis
  const entityTypeLabels = [
    ...entityTypes.map(et => et.userLabel || et.label),
    ...(analysis?.nodeTypes || []),
    ...(analysis?.conceptTypes || []),
    ...(analysis?.originalSchema?.nodeTypes || []),
    ...(analysis?.originalSchema?.conceptTypes || [])
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates

  return (
    <div className="schema-review">
      <div className="schema-review-header">
        <h2>{isPredefined ? '🏭 Predefined Schema' : '📋 Review Schema'}</h2>
        <p className="schema-review-subtitle">
          {isPredefined 
            ? `Edit the ${analysis?.originalSchema?.name || analysis?.industry || 'industry'} schema - add, remove, or modify entity types and relationships.`
            : 'Review and edit the suggested labels before creating nodes in the database.'
          }
        </p>
      </div>

      {/* Document Info */}
      <div className="schema-review-info">
        <div className="info-item">
          <span className="info-label">Document:</span>
          <span className="info-value">
            {analysis?.multiFileUpload 
              ? `${analysis?.totalFiles} files (starting with ${analysis?.documentName})`
              : analysis?.documentName
            }
          </span>
        </div>
        {analysis?.multiFileUpload && (
          <div className="info-item multi-file-notice">
            <span className="info-label">📁</span>
            <span className="info-value">This schema will be applied to all {analysis?.totalFiles} files</span>
          </div>
        )}
        <div className="info-item">
          <span className="info-label">Type:</span>
          <span className="info-value">{analysis?.fileType?.toUpperCase()}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Industry:</span>
          <span className="info-value">{analysis?.industry}</span>
        </div>
        {isCSV && (
          <div className="info-item">
            <span className="info-label">Rows:</span>
            <span className="info-value">{analysis?.summary?.totalRows}</span>
          </div>
        )}
      </div>

      {/* CSV Columns */}
      {isCSV && (
        <div className="schema-section">
          <h3>
            📊 Columns 
            <span className="section-count">
              {nodeColumnCount} nodes, {propertyColumnCount} properties
            </span>
          </h3>
          <div className="columns-table">
            <div className="table-header">
              <div className="col-column">Column</div>
              <div className="col-label">Neo4j Label (Type)</div>
              <div className="col-samples">Sample Values</div>
              <div className="col-type">Include As</div>
              <div className="col-confidence">Confidence</div>
            </div>
            {columns.map((col, index) => (
              <div key={col.column} className={`table-row ${col.includeAsNode ? 'node' : 'property'}`}>
                <div className="col-column">
                  <code>{col.column}</code>
                </div>
                <div className="col-label">
                  <div className="label-input-group">
                    <input
                      type="text"
                      value={col.userLabel || col.suggestedLabel}
                      onChange={(e) => handleColumnLabelChange(index, e.target.value)}
                      className="label-input"
                      placeholder="Enter node type..."
                      list={`type-suggestions-${index}`}
                    />
                    <datalist id={`type-suggestions-${index}`}>
                      {commonTypes.map(type => (
                        <option key={type} value={type} />
                      ))}
                    </datalist>
                  </div>
                </div>
                <div className="col-samples">
                  {col.sampleValues?.slice(0, 3).map((val, i) => (
                    <span key={i} className="sample-value">{val}</span>
                  ))}
                </div>
                <div className="col-type">
                  <button
                    className={`type-toggle ${col.includeAsNode ? 'node' : 'property'}`}
                    onClick={() => handleColumnTypeToggle(index)}
                  >
                    {col.includeAsNode ? '🏷️ Node' : '📝 Property'}
                  </button>
                </div>
                <div className="col-confidence">
                  <span className={`confidence ${col.confidence >= 0.8 ? 'high' : col.confidence >= 0.6 ? 'medium' : 'low'}`}>
                    {Math.round(col.confidence * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Text Entity Types */}
      {!isCSV && (
        <div className="schema-section">
          <div className="section-header-row">
            <h3>
              🏷️ Entity Types (Neo4j Labels)
              <span className="section-count">{activeEntityTypeCount} active</span>
            </h3>
            <button 
              className="btn-add"
              onClick={() => setShowAddEntity(!showAddEntity)}
            >
              {showAddEntity ? '✕ Cancel' : '+ Add Entity Type'}
            </button>
          </div>
          <p className="section-description">
            Edit the type names below. These become actual Neo4j labels like <code>:Person</code>, <code>:Skill</code>
          </p>
          
          {/* Add new entity form */}
          {showAddEntity && (
            <div className="add-form">
              <input
                type="text"
                value={newEntity.label}
                onChange={(e) => setNewEntity(prev => ({ ...prev, label: e.target.value }))}
                placeholder="Entity type name (e.g., Technology)"
                className="add-input"
                list="new-entity-suggestions"
              />
              <datalist id="new-entity-suggestions">
                {commonTypes.filter(t => !entityTypes.some(et => et.label === t)).map(type => (
                  <option key={type} value={type} />
                ))}
              </datalist>
              <input
                type="text"
                value={newEntity.description}
                onChange={(e) => setNewEntity(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Description (optional)"
                className="add-input"
              />
              <button className="btn-confirm" onClick={handleAddEntityType}>
                ✓ Add
              </button>
            </div>
          )}

          <div className="entity-types-list">
            {entityTypes.map((et, index) => (
              <div key={`${et.label}-${index}`} className={`entity-type-card ${et.include ? 'active' : 'inactive'}`}>
                <div className="entity-type-header">
                  <input
                    type="checkbox"
                    checked={et.include}
                    onChange={() => handleEntityTypeToggle(index)}
                    className="entity-checkbox"
                  />
                  <div className="entity-label-group">
                    <input
                      type="text"
                      value={et.userLabel || et.label}
                      onChange={(e) => handleEntityTypeChange(index, 'label', e.target.value)}
                      className={`entity-label-input ${et.include ? 'editable' : ''}`}
                      list="entity-type-suggestions"
                    />
                    <span className="label-preview">:{et.userLabel || et.label}</span>
                  </div>
                  <span className={`confidence ${et.confidence >= 0.8 ? 'high' : et.confidence >= 0.6 ? 'medium' : 'low'}`}>
                    {Math.round((et.confidence || 0.5) * 100)}%
                  </span>
                  <button 
                    className="btn-remove"
                    onClick={() => handleRemoveEntityType(index)}
                    title="Remove this entity type"
                  >
                    ✕
                  </button>
                </div>
                <p className="entity-description">{et.description}</p>
                {et.examples?.length > 0 && (
                  <div className="entity-examples">
                    Examples: {et.examples.slice(0, 3).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
          <datalist id="entity-type-suggestions">
            {commonTypes.map(type => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </div>
      )}

      {/* Relationships */}
      <div className="schema-section">
        <div className="section-header-row">
          <h3>
            🔗 Relationship Types
            <span className="section-count">{activeRelationshipCount} active</span>
          </h3>
          <button 
            className="btn-add"
            onClick={() => setShowAddRelationship(!showAddRelationship)}
          >
            {showAddRelationship ? '✕ Cancel' : '+ Add Relationship'}
          </button>
        </div>
        <p className="section-description">
          Edit the relationship names. These become Neo4j relationship types like <code>-[:WORKS_AT]-&gt;</code>
        </p>

        {/* Add new relationship form */}
        {showAddRelationship && (
          <div className="add-form relationship-form">
            <div className="relationship-inputs">
              <select
                value={newRelationship.from}
                onChange={(e) => setNewRelationship(prev => ({ ...prev, from: e.target.value }))}
                className="add-select"
              >
                <option value="">From Entity...</option>
                {entityTypeLabels.map(label => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </select>
              <span className="arrow">→</span>
              <input
                type="text"
                value={newRelationship.predicate}
                onChange={(e) => setNewRelationship(prev => ({ ...prev, predicate: e.target.value.toUpperCase().replace(/\s+/g, '_') }))}
                placeholder="RELATIONSHIP_TYPE"
                className="add-input predicate-input"
                list="new-rel-suggestions"
              />
              <datalist id="new-rel-suggestions">
                {commonRelationships.map(rel => (
                  <option key={rel} value={rel} />
                ))}
              </datalist>
              <span className="arrow">→</span>
              <select
                value={newRelationship.to}
                onChange={(e) => setNewRelationship(prev => ({ ...prev, to: e.target.value }))}
                className="add-select"
              >
                <option value="">To Entity...</option>
                {entityTypeLabels.map(label => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={newRelationship.description}
              onChange={(e) => setNewRelationship(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Description (optional)"
              className="add-input full-width"
            />
            <button className="btn-confirm" onClick={handleAddRelationship}>
              ✓ Add Relationship
            </button>
          </div>
        )}

        <div className="relationships-list">
          {relationships.map((rel, index) => (
            <div key={index} className={`relationship-card ${rel.include ? 'active' : 'inactive'}`}>
              <input
                type="checkbox"
                checked={rel.include}
                onChange={() => handleRelationshipToggle(index)}
                className="rel-checkbox"
              />
              <div className="relationship-visual">
                <select
                  value={rel.from || rel.fromColumn || ''}
                  onChange={(e) => handleRelationshipChange(index, 'from', e.target.value)}
                  className={`rel-select ${rel.include ? 'editable' : ''}`}
                >
                  <option value="">-- Select --</option>
                  {entityTypeLabels.length > 0 ? (
                    entityTypeLabels.map(label => (
                      <option key={label} value={label}>{label}</option>
                    ))
                  ) : (
                    commonTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))
                  )}
                  {/* Keep current value if not in list */}
                  {rel.from && !entityTypeLabels.includes(rel.from) && (
                    <option value={rel.from}>{rel.from}</option>
                  )}
                </select>
                <div className="rel-predicate">
                  <span className="arrow">→</span>
                  <input
                    type="text"
                    value={rel.userPredicate || rel.suggestedPredicate || rel.predicate || ''}
                    onChange={(e) => handleRelationshipChange(index, 'predicate', e.target.value)}
                    className={`predicate-input ${rel.include ? 'editable' : ''}`}
                    list="relationship-suggestions"
                    placeholder="RELATIONSHIP_TYPE"
                  />
                  <span className="arrow">→</span>
                </div>
                <select
                  value={rel.to || rel.toColumn || ''}
                  onChange={(e) => handleRelationshipChange(index, 'to', e.target.value)}
                  className={`rel-select ${rel.include ? 'editable' : ''}`}
                >
                  <option value="">-- Select --</option>
                  {entityTypeLabels.length > 0 ? (
                    entityTypeLabels.map(label => (
                      <option key={label} value={label}>{label}</option>
                    ))
                  ) : (
                    commonTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))
                  )}
                  {/* Keep current value if not in list */}
                  {rel.to && !entityTypeLabels.includes(rel.to) && (
                    <option value={rel.to}>{rel.to}</option>
                  )}
                </select>
              </div>
              {rel.description && (
                <p className="rel-description">{rel.description}</p>
              )}
              <button 
                className="btn-remove"
                onClick={() => handleRemoveRelationship(index)}
                title="Remove this relationship"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <datalist id="relationship-suggestions">
          {commonRelationships.map(rel => (
            <option key={rel} value={rel} />
          ))}
        </datalist>
      </div>

      {/* Summary */}
      <div className="schema-summary">
        <h3>Summary</h3>
        <div className="summary-stats">
          {isCSV ? (
            <>
              <div className="stat">
                <span className="stat-value">{nodeColumnCount}</span>
                <span className="stat-label">Node Types</span>
              </div>
              <div className="stat">
                <span className="stat-value">{propertyColumnCount}</span>
                <span className="stat-label">Properties</span>
              </div>
            </>
          ) : (
            <div className="stat">
              <span className="stat-value">{activeEntityTypeCount}</span>
              <span className="stat-label">Entity Types</span>
            </div>
          )}
          <div className="stat">
            <span className="stat-value">{activeRelationshipCount}</span>
            <span className="stat-label">Relationships</span>
          </div>
        </div>
      </div>

      {/* Save Ontology Dialog */}
      {showSaveDialog && (
        <div className="save-ontology-dialog">
          <div className="save-dialog-content">
            <h3>💾 Save Ontology for Reuse</h3>
            <p className="save-dialog-hint">
              Save this schema to use with similar documents in the future
            </p>
            <div className="save-form">
              <div className="form-group">
                <label>Ontology Name *</label>
                <input
                  type="text"
                  value={ontologyName}
                  onChange={(e) => setOntologyName(e.target.value)}
                  placeholder="e.g., Lyft Receipt, Medical Report, Resume..."
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Description (optional)</label>
                <input
                  type="text"
                  value={ontologyDescription}
                  onChange={(e) => setOntologyDescription(e.target.value)}
                  placeholder="e.g., For rideshare receipts and travel expenses"
                />
              </div>
              <div className="save-preview">
                <span className="preview-label">Will save:</span>
                <span className="preview-value">
                  {entityTypes.filter(e => e.include !== false).length} entity types, 
                  {' '}{relationships.filter(r => r.include !== false).length} relationships
                </span>
              </div>
            </div>
            <div className="save-dialog-actions">
              <button 
                className="btn btn-cancel" 
                onClick={() => setShowSaveDialog(false)}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button 
                className="btn btn-save" 
                onClick={handleSaveOntology}
                disabled={isSaving || !ontologyName.trim()}
              >
                {isSaving ? '⏳ Saving...' : '💾 Save Ontology'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="schema-actions">
        <button 
          className="btn btn-cancel" 
          onClick={onCancel}
          disabled={isSubmitting}
        >
          ❌ Cancel
        </button>
        <button 
          className="btn btn-save-ontology" 
          onClick={() => setShowSaveDialog(true)}
          disabled={isSubmitting || activeEntityTypeCount === 0}
          title="Save this schema for reuse with similar documents"
        >
          💾 Save Ontology
        </button>
        <button 
          className="btn btn-approve" 
          onClick={handleApprove}
          disabled={isSubmitting || (isCSV && nodeColumnCount === 0) || (!isCSV && activeEntityTypeCount === 0)}
        >
          {isSubmitting ? '⏳ Creating...' : '✅ Approve & Create Nodes'}
        </button>
      </div>
    </div>
  );
};

export default SchemaReview;
