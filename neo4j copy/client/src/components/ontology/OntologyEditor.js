/**
 * OntologyEditor Component
 * Enhanced edit mode for creating/modifying ontologies with data type support
 * Supports both visual form editing and YAML text editing
 */

import { useState, useEffect, useCallback } from 'react';
import yaml from 'js-yaml';

// Available data types for attributes
const DATA_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'DateTime' },
  { value: 'enum', label: 'Enum' },
  { value: 'array', label: 'Array' },
  { value: 'json', label: 'JSON' }
];

const OntologyEditor = ({
  selectedOntology,
  editedOntology,
  newName,
  newDescription,
  saving,
  entityLabels,
  onNameChange,
  onDescriptionChange,
  onUpdateEntityType,
  onRemoveEntityType,
  onAddEntityType,
  onAddEntityProperty,
  onUpdateEntityProperty,
  onRemoveEntityProperty,
  onUpdateRelationship,
  onAddRelationshipProperty,
  onUpdateRelationshipProperty,
  onRemoveRelationshipProperty,
  onRemoveRelationship,
  onAddRelationship,
  onCancel,
  onUpdateExisting,
  onSaveAsNew,
  // New: callback to update entire ontology from YAML
  onUpdateFromYaml
}) => {
  const isNew = selectedOntology.id === 'new';
  const isCustom = selectedOntology.isCustom;
  
  // YAML editing state
  const [editMode, setEditMode] = useState('visual'); // 'visual' or 'yaml'
  const [yamlContent, setYamlContent] = useState('');
  const [yamlError, setYamlError] = useState(null);

  // Convert ontology to YAML format
  const ontologyToYaml = useCallback(() => {
    const yamlObj = {
      metadata: {
        name: newName || '',
        description: newDescription || ''
      },
      classes: (editedOntology?.entityTypes || []).map(et => ({
        name: et.userLabel || et.label || '',
        description: et.description || '',
        properties: (et.properties || []).map(p => {
          if (typeof p === 'string') return { name: p, type: 'string' };
          return {
            name: p.name || '',
            type: p.data_type || p.type || 'string',
            ...(p.is_identity && { is_identity: true }),
            ...(p.validation_rules && { validation_rules: p.validation_rules })
          };
        })
      })),
      relationships: (editedOntology?.relationships || []).map(r => ({
        type: r.userPredicate || r.predicate || '',
        from: r.from || '',
        to: r.to || '',
        description: r.description || '',
        properties: (r.properties || []).map(p => {
          if (typeof p === 'string') return { name: p, type: 'string' };
          return {
            name: p.name || '',
            type: p.data_type || p.type || 'string'
          };
        })
      }))
    };
    
    return yaml.dump(yamlObj, { 
      indent: 2, 
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });
  }, [editedOntology, newName, newDescription]);

  // Update YAML content when switching to YAML mode or when ontology changes
  useEffect(() => {
    if (editMode === 'yaml') {
      setYamlContent(ontologyToYaml());
      setYamlError(null);
    }
  }, [editMode, ontologyToYaml]);

  // Parse YAML and update ontology
  const parseYamlAndUpdate = (yamlStr) => {
    try {
      const parsed = yaml.load(yamlStr);
      setYamlError(null);
      
      // Validate structure
      if (!parsed || typeof parsed !== 'object') {
        setYamlError('Invalid YAML: must be an object');
        return false;
      }
      
      return parsed;
    } catch (e) {
      setYamlError(`YAML Error: ${e.message}`);
      return false;
    }
  };

  // Apply YAML changes to ontology
  const applyYamlChanges = () => {
    const parsed = parseYamlAndUpdate(yamlContent);
    if (!parsed) return false;
    
    // Update name and description
    if (parsed.metadata) {
      if (parsed.metadata.name) onNameChange(parsed.metadata.name);
      if (parsed.metadata.description !== undefined) onDescriptionChange(parsed.metadata.description);
    }
    
    // Convert parsed YAML to ontology format
    const newEntityTypes = (parsed.classes || []).map(c => ({
      label: c.name || '',
      userLabel: c.name || '',
      description: c.description || '',
      include: true,
      properties: (c.properties || []).map(p => ({
        name: typeof p === 'string' ? p : (p.name || ''),
        data_type: typeof p === 'string' ? 'string' : (p.type || 'string'),
        is_identity: p.is_identity || false,
        validation_rules: p.validation_rules || null
      }))
    }));
    
    const newRelationships = (parsed.relationships || []).map(r => ({
      predicate: r.type || '',
      userPredicate: r.type || '',
      from: r.from || '',
      to: r.to || '',
      description: r.description || '',
      include: true,
      properties: (r.properties || []).map(p => ({
        name: typeof p === 'string' ? p : (p.name || ''),
        data_type: typeof p === 'string' ? 'string' : (p.type || 'string')
      }))
    }));
    
    // Call the update callback if provided
    if (onUpdateFromYaml) {
      onUpdateFromYaml({
        entityTypes: newEntityTypes,
        relationships: newRelationships
      });
    }
    
    return true;
  };

  // Switch between modes
  const switchToYaml = () => {
    setYamlContent(ontologyToYaml());
    setYamlError(null);
    setEditMode('yaml');
  };

  const switchToVisual = () => {
    if (yamlContent !== ontologyToYaml()) {
      // YAML was modified, try to apply changes
      if (!applyYamlChanges()) {
        if (!window.confirm('YAML has errors. Discard changes and switch to visual mode?')) {
          return;
        }
      }
    }
    setEditMode('visual');
  };

  // Helper to get property name and type
  const getPropertyInfo = (prop) => {
    if (typeof prop === 'object' && prop !== null) {
      return {
        name: prop.name || '',
        dataType: prop.data_type || prop.type || 'string'
      };
    }
    return { name: prop || '', dataType: 'string' };
  };

  return (
    <div className="op-edit-panel">
      <div className="op-edit-header">
        <h2>
          {isNew ? '✨ Create New Ontology' : 
           isCustom ? '✏️ Edit Ontology' : '🔧 Customize Ontology'}
        </h2>
        {!isCustom && !isNew && (
          <div className="op-edit-notice">
            ⚠️ Predefined ontologies cannot be modified directly. Your changes will be saved as a new custom ontology.
          </div>
        )}
        
        {/* Mode Toggle */}
        <div className="op-edit-mode-toggle">
          <button 
            className={`mode-btn ${editMode === 'visual' ? 'active' : ''}`}
            onClick={() => editMode !== 'visual' && switchToVisual()}
          >
            📝 Visual
          </button>
          <button 
            className={`mode-btn ${editMode === 'yaml' ? 'active' : ''}`}
            onClick={() => editMode !== 'yaml' && switchToYaml()}
          >
            📄 YAML
          </button>
        </div>
      </div>

      {editMode === 'yaml' ? (
        /* YAML Editor Mode */
        <div className="op-yaml-editor">
          <div className="op-yaml-toolbar">
            <span className="yaml-hint">Edit ontology in YAML format. Changes are applied when switching back to Visual mode.</span>
            {yamlError && <span className="yaml-error">{yamlError}</span>}
          </div>
          <textarea
            className="op-yaml-textarea"
            value={yamlContent}
            onChange={(e) => {
              setYamlContent(e.target.value);
              // Validate on change
              parseYamlAndUpdate(e.target.value);
            }}
            spellCheck={false}
            placeholder="# Ontology YAML..."
          />
          <div className="op-yaml-actions">
            <button 
              className="btn btn-apply"
              onClick={() => {
                if (applyYamlChanges()) {
                  alert('✅ YAML changes applied!');
                }
              }}
              disabled={!!yamlError}
            >
              ✓ Apply Changes
            </button>
            <button 
              className="btn btn-reset"
              onClick={() => {
                setYamlContent(ontologyToYaml());
                setYamlError(null);
              }}
            >
              ↺ Reset
            </button>
          </div>
        </div>
      ) : (
        /* Visual Editor Mode */
        <div className="op-edit-form">
          {/* Basic Info */}
          <div className="op-form-row">
            <div className="op-form-group">
              <label>Name *</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="e.g., Customer Management Schema"
              />
            </div>
            <div className="op-form-group">
              <label>Description</label>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => onDescriptionChange(e.target.value)}
                placeholder="Brief description of this ontology..."
              />
            </div>
          </div>

          {/* Classes Section */}
          <div className="op-edit-section">
            <div className="op-edit-section-header">
              <h3>📦 Classes ({editedOntology?.entityTypes?.length || 0})</h3>
              <button className="op-add-btn" onClick={onAddEntityType}>
                + Add Class
              </button>
            </div>
            <div className="op-items-grid">
              {editedOntology?.entityTypes?.map((et, index) => (
                <div key={index} className="op-edit-item">
                  <div className="op-edit-item-content">
                    <div className="op-edit-item-row">
                      <input
                        type="text"
                        value={et.userLabel || et.label || ''}
                        onChange={(e) => onUpdateEntityType(index, 'userLabel', e.target.value)}
                        placeholder="Class name (e.g., Customer, Account)"
                        className="op-input-main"
                      />
                      <input
                        type="text"
                        value={et.description || ''}
                        onChange={(e) => onUpdateEntityType(index, 'description', e.target.value)}
                        placeholder="Description..."
                        className="op-input-desc"
                      />
                      <button 
                        className="op-remove-btn" 
                        onClick={() => onRemoveEntityType(index)}
                        title="Remove class"
                      >
                        ×
                      </button>
                    </div>

                    {/* Attributes */}
                    <div className="op-properties-section">
                      <div className="op-properties-header">
                        <span className="op-properties-label">Attributes</span>
                        <button 
                          className="op-add-property-btn"
                          onClick={() => onAddEntityProperty(index)}
                        >
                          + Add Attribute
                        </button>
                      </div>
                      <div className="op-properties-list">
                        {(et.properties || []).map((prop, propIndex) => {
                          const { name, dataType } = getPropertyInfo(prop);
                          return (
                            <div key={propIndex} className="op-property-item">
                              <input
                                type="text"
                                value={name}
                                onChange={(e) => onUpdateEntityProperty(index, propIndex, 'name', e.target.value)}
                                placeholder="attribute_name"
                                className="op-property-name-input"
                              />
                              <select
                                value={dataType}
                                onChange={(e) => onUpdateEntityProperty(index, propIndex, 'data_type', e.target.value)}
                                className="op-property-type-select"
                              >
                                {DATA_TYPES.map(dt => (
                                  <option key={dt.value} value={dt.value}>{dt.label}</option>
                                ))}
                              </select>
                              <button
                                className="op-property-remove"
                                onClick={() => onRemoveEntityProperty(index, propIndex)}
                                title="Remove attribute"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                        {(!et.properties || et.properties.length === 0) && (
                          <span className="op-no-properties">No attributes defined</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {(!editedOntology?.entityTypes || editedOntology.entityTypes.length === 0) && (
                <div className="op-empty-text">No classes defined. Click "Add Class" to create one.</div>
              )}
            </div>
          </div>

          {/* Relationships Section */}
          <div className="op-edit-section">
            <div className="op-edit-section-header">
              <h3>🔗 Relationships ({editedOntology?.relationships?.length || 0})</h3>
              <button className="op-add-btn" onClick={onAddRelationship}>
                + Add Relationship
              </button>
            </div>
            <div className="op-items-grid">
              {editedOntology?.relationships?.map((rel, index) => (
                <div key={index} className="op-edit-item">
                  <div className="op-edit-item-content">
                    <div className="op-edit-item-row op-relationship-row">
                      <select
                        value={rel.from || ''}
                        onChange={(e) => onUpdateRelationship(index, 'from', e.target.value)}
                        className="op-select"
                      >
                        <option value="">From class...</option>
                        {entityLabels.map(label => (
                          <option key={label} value={label}>{label}</option>
                        ))}
                      </select>
                      <span className="op-arrow">→</span>
                      <input
                        type="text"
                        value={rel.userPredicate || rel.predicate || ''}
                        onChange={(e) => onUpdateRelationship(index, 'predicate', e.target.value)}
                        placeholder="RELATIONSHIP_TYPE"
                        className="op-input-predicate"
                      />
                      <span className="op-arrow">→</span>
                      <select
                        value={rel.to || ''}
                        onChange={(e) => onUpdateRelationship(index, 'to', e.target.value)}
                        className="op-select"
                      >
                        <option value="">To class...</option>
                        {entityLabels.map(label => (
                          <option key={label} value={label}>{label}</option>
                        ))}
                      </select>
                      <button 
                        className="op-remove-btn" 
                        onClick={() => onRemoveRelationship(index)}
                        title="Remove relationship"
                      >
                        ×
                      </button>
                    </div>

                    {/* Relationship Properties */}
                    <div className="op-properties-section">
                      <div className="op-properties-header">
                        <span className="op-properties-label">Properties</span>
                        <button 
                          className="op-add-property-btn"
                          onClick={() => onAddRelationshipProperty(index)}
                        >
                          + Add Property
                        </button>
                      </div>
                      <div className="op-properties-list">
                        {(rel.properties || []).map((prop, propIndex) => {
                          const { name, dataType } = getPropertyInfo(prop);
                          return (
                            <div key={propIndex} className="op-property-item">
                              <input
                                type="text"
                                value={name}
                                onChange={(e) => onUpdateRelationshipProperty(index, propIndex, 'name', e.target.value)}
                                placeholder="property_name"
                                className="op-property-name-input"
                              />
                              <select
                                value={dataType}
                                onChange={(e) => onUpdateRelationshipProperty(index, propIndex, 'data_type', e.target.value)}
                                className="op-property-type-select"
                              >
                                {DATA_TYPES.map(dt => (
                                  <option key={dt.value} value={dt.value}>{dt.label}</option>
                                ))}
                              </select>
                              <button
                                className="op-property-remove"
                                onClick={() => onRemoveRelationshipProperty(index, propIndex)}
                                title="Remove property"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                        {(!rel.properties || rel.properties.length === 0) && (
                          <span className="op-no-properties">No properties defined</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {(!editedOntology?.relationships || editedOntology.relationships.length === 0) && (
                <div className="op-empty-text">No relationships defined. Click "Add Relationship" to create one.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="op-edit-actions">
        <button className="btn btn-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {isCustom && !isNew && (
          <button className="btn btn-update" onClick={onUpdateExisting} disabled={saving}>
            {saving ? '⏳ Saving...' : '💾 Update'}
          </button>
        )}
        <button className="btn btn-save" onClick={onSaveAsNew} disabled={saving}>
          {saving ? '⏳ Saving...' : isNew ? '✨ Create Ontology' : '📋 Save as New'}
        </button>
      </div>
    </div>
  );
};

export default OntologyEditor;
