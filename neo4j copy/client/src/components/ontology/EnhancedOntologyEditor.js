/**
 * Enhanced Ontology Editor Component
 * Modern, intuitive interface for editing ontologies with real-time validation
 */

import { useState, useEffect } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import './EnhancedOntologyEditor.css';

const EnhancedOntologyEditor = ({ ontology, onSave, onCancel }) => {
  console.log('[EnhancedOntologyEditor] RENDER - ontology:', ontology?.ontologyId, 'scope:', ontology?.scope);
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [structure, setStructure] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('classes');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClass, setSelectedClass] = useState(null);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [changes, setChanges] = useState({});
  const [validationErrors, setValidationErrors] = useState({});
  
  // Undo/Redo state
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const MAX_UNDO_STACK = 10;
  
  const tenantId = currentWorkspace?.tenant_id || 'default';
  const workspaceId = currentWorkspace?.workspace_id || 'default';

  // Push current state to undo stack before making changes
  const pushToUndoStack = () => {
    if (!structure) return;
    const snapshot = JSON.stringify({ structure, changes });
    setUndoStack(prev => [...prev.slice(-(MAX_UNDO_STACK - 1)), snapshot]);
    setRedoStack([]); // Clear redo stack on new change
  };

  // Undo last change
  const undo = () => {
    if (undoStack.length === 0) return;
    const currentSnapshot = JSON.stringify({ structure, changes });
    setRedoStack(prev => [...prev, currentSnapshot]);
    
    const previousSnapshot = undoStack[undoStack.length - 1];
    const { structure: prevStructure, changes: prevChanges } = JSON.parse(previousSnapshot);
    setStructure(prevStructure);
    setChanges(prevChanges);
    setUndoStack(prev => prev.slice(0, -1));
  };

  // Redo last undone change
  const redo = () => {
    if (redoStack.length === 0) return;
    const currentSnapshot = JSON.stringify({ structure, changes });
    setUndoStack(prev => [...prev, currentSnapshot]);
    
    const nextSnapshot = redoStack[redoStack.length - 1];
    const { structure: nextStructure, changes: nextChanges } = JSON.parse(nextSnapshot);
    setStructure(nextStructure);
    setChanges(nextChanges);
    setRedoStack(prev => prev.slice(0, -1));
  };

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undoStack, redoStack, structure, changes]);

  // Load ontology structure
  useEffect(() => {
    if (ontology?.id === 'generated' && ontology?.entityTypes) {
      // Generated ontology - use provided data directly
      const classes = (ontology.entityTypes || []).map((et, idx) => ({
        iri: `http://purplefabric.ai/generated#${(et.label || et.name || '').replace(/\s+/g, '')}`,
        label: et.label || et.name,
        localName: et.label || et.name,
        comment: et.description || ''
      }));
      const properties = (ontology.relationships || []).map((rel, idx) => ({
        iri: `http://purplefabric.ai/generated#${(rel.type || rel.predicate || '').replace(/\s+/g, '_')}`,
        label: rel.type || rel.predicate,
        localName: rel.type || rel.predicate,
        comment: rel.description || '',
        propertyType: 'ObjectProperty',
        domain: rel.from,
        range: rel.to
      }));
      setStructure({
        classes,
        properties,
        label: ontology.name || 'Generated Ontology',
        ontologyIRI: 'http://purplefabric.ai/generated'
      });
      setLoading(false);
    } else if (ontology?.ontologyId || ontology?.iri) {
      loadStructure();
    } else if (ontology?.id === 'new') {
      // New ontology - start with empty structure
      setStructure({ 
        classes: [], 
        properties: [],
        label: ontology.name || 'New Ontology'
      });
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [ontology]);

  const loadStructure = async () => {
    const id = ontology?.ontologyId || ontology?.iri?.split(/[#/]/).pop();
    console.log('[Editor] Loading structure for:', { id, ontologyId: ontology?.ontologyId, scope: ontology?.scope });
    
    if (!id || id === 'new') {
      setStructure({ classes: [], properties: [], label: ontology?.name || 'New Ontology' });
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const scope = ontology?.scope || 'all';
      const url = `/api/owl/structure/${encodeURIComponent(id)}?tenantId=${tenantId}&workspaceId=${workspaceId}&scope=${scope}`;
      console.log('[Editor] Fetching:', url);
      const response = await fetch(url, { headers: getTenantHeaders() });
      console.log('[Editor] Response status:', response.status);
      if (response.ok) {
        const data = await response.json();
        console.log('[Editor] Got data:', { classes: data.classes?.length, properties: data.properties?.length });
        // Map API field names to editor field names
        const mappedStructure = {
          ...data,
          label: data.label || ontology?.name || data.ontologyId,
          classes: (data.classes || []).map(cls => ({
            ...cls,
            uri: cls.iri,
            label: cls.label || cls.localName
          })),
          properties: (data.properties || []).map(prop => ({
            ...prop,
            uri: prop.iri,
            label: prop.label || prop.localName,
            propertyType: prop.type === 'datatypeProperty' ? 'DatatypeProperty' : 'ObjectProperty'
          }))
        };
        setStructure(mappedStructure);
        setChanges({});
      } else {
        console.error('[Editor] Failed to load:', await response.text());
        setStructure({ classes: [], properties: [], label: ontology?.name || id });
      }
    } catch (error) {
      console.error('[Editor] Error loading structure:', error);
      setStructure({ classes: [], properties: [], label: ontology?.name || 'Ontology' });
    } finally {
      setLoading(false);
    }
  };

  // Track changes
  const trackChange = (type, id, field, value) => {
    pushToUndoStack(); // Save state before change
    setChanges(prev => ({
      ...prev,
      [type]: {
        ...prev[type],
        [id]: {
          ...prev[type]?.[id],
          [field]: value
        }
      }
    }));
    
    // Clear validation error for this field
    const errorKey = `${type}.${id}.${field}`;
    if (validationErrors[errorKey]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[errorKey];
        return newErrors;
      });
    }
  };

  // Validate field
  const validateField = (type, id, field, value) => {
    const errorKey = `${type}.${id}.${field}`;
    let error = null;

    if (field === 'label' && !value?.trim()) {
      error = 'Label is required';
    } else if (field === 'uri' && !value?.trim()) {
      error = 'URI is required';
    } else if (field === 'uri' && value && !isValidURI(value)) {
      error = 'Invalid URI format';
    }

    setValidationErrors(prev => {
      const newErrors = { ...prev };
      if (error) {
        newErrors[errorKey] = error;
      } else {
        delete newErrors[errorKey];
      }
      return newErrors;
    });

    return !error;
  };

  const isValidURI = (uri) => {
    try {
      new URL(uri);
      return true;
    } catch {
      return false;
    }
  };

  // Generate proper base URI for new elements
  const getBaseUri = () => {
    if (ontology?.ontologyId && ontology.ontologyId !== 'new' && ontology.ontologyId !== 'generated') {
      return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontology.ontologyId}`;
    }
    const ontologySlug = (structure?.label || 'new-ontology').toLowerCase().replace(/\s+/g, '-');
    return `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologySlug}`;
  };

  // Add new class
  const addClass = () => {
    const newClass = {
      uri: `${getBaseUri()}#Class${Date.now()}`,
      label: 'New Class',
      comment: '',
      subClassOf: [],
      isNew: true
    };
    
    setStructure(prev => ({
      ...prev,
      classes: [...(prev.classes || []), newClass]
    }));
    
    setSelectedClass(newClass);
  };

  // Add new property
  const addProperty = () => {
    const newProperty = {
      uri: `${getBaseUri()}#property${Date.now()}`,
      label: 'New Property',
      comment: '',
      propertyType: 'ObjectProperty',
      domain: '',
      range: '',
      isNew: true
    };
    
    setStructure(prev => ({
      ...prev,
      properties: [...(prev.properties || []), newProperty]
    }));
    
    setSelectedProperty(newProperty);
  };

  // Delete class
  const deleteClass = (classToDelete) => {
    if (window.confirm(`Delete class "${classToDelete.label}"?`)) {
      setStructure(prev => ({
        ...prev,
        classes: prev.classes.filter(cls => cls.uri !== classToDelete.uri)
      }));
      
      if (selectedClass?.uri === classToDelete.uri) {
        setSelectedClass(null);
      }
    }
  };

  // Delete property
  const deleteProperty = (propertyToDelete) => {
    if (window.confirm(`Delete property "${propertyToDelete.label}"?`)) {
      setStructure(prev => ({
        ...prev,
        properties: prev.properties.filter(prop => prop.uri !== propertyToDelete.uri)
      }));
      
      if (selectedProperty?.uri === propertyToDelete.uri) {
        setSelectedProperty(null);
      }
    }
  };

  // Save changes
  const handleSave = async () => {
    // Validate all fields
    let hasErrors = false;
    
    structure.classes?.forEach((cls, index) => {
      if (!validateField('classes', index, 'label', cls.label)) hasErrors = true;
      if (!validateField('classes', index, 'uri', cls.uri || cls.iri)) hasErrors = true;
    });
    
    structure.properties?.forEach((prop, index) => {
      if (!validateField('properties', index, 'label', prop.label)) hasErrors = true;
      if (!validateField('properties', index, 'uri', prop.uri || prop.iri)) hasErrors = true;
    });

    if (hasErrors) {
      alert('Please fix validation errors before saving. Each class and property requires a valid URI.');
      return;
    }

    const ontologyId = ontology?.ontologyId || ontology?.id;
    const isNew = ontologyId === 'new' || ontologyId === 'generated';

    // Impact check for existing ontologies
    if (!isNew) {
      try {
        const impactParams = new URLSearchParams({
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default'
        });
        const impactRes = await fetch(`/api/owl/${encodeURIComponent(ontologyId)}/impact?${impactParams}`, { headers: getTenantHeaders() });
        const impactData = await impactRes.json();
        if (impactData.success && impactData.impact?.hasDownstreamData) {
          const imp = impactData.impact;
          const msg = `⚠️ This ontology has downstream data:\n\n` +
            `• ${imp.documentCount} committed document(s)\n` +
            `• ${imp.totalTriples} triples in the data graph\n` +
            (imp.activeMapping ? `• Active column mapping (v${imp.activeMapping.version})\n` : '') +
            `\nModifying classes or properties may orphan existing data.\nProceed with save?`;
          if (!window.confirm(msg)) return;
        }
      } catch (e) {
        console.warn('Impact check failed (non-blocking):', e.message);
      }
    }

    setSaving(true);
    try {
      
      let response;
      if (isNew) {
        // Create new ontology
        const baseUri = `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${(structure.label || 'new-ontology').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-ontology'}`;
        response = await fetch('/api/owl/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({
            tenantId,
            workspaceId,
            ontology: {
              iri: baseUri,
              label: structure.label || 'New Ontology',
              comment: structure.comment || '',
              classes: structure.classes?.map(cls => ({
                iri: cls.uri || cls.iri || `${baseUri}#${(cls.label || 'Class').replace(/\s+/g, '')}`,
                label: cls.label,
                comment: cls.comment,
                superClasses: Array.isArray(cls.subClassOf) ? cls.subClassOf : (cls.subClassOf ? [cls.subClassOf] : [])
              })) || [],
              objectProperties: structure.properties?.filter(p => p.propertyType !== 'DatatypeProperty').map(prop => ({
                iri: prop.uri || prop.iri || `${baseUri}#${(prop.label || 'property').replace(/\s+/g, '')}`,
                label: prop.label,
                comment: prop.comment,
                domain: prop.domain ? [prop.domain] : [],
                range: prop.range ? [prop.range] : []
              })) || [],
              dataProperties: structure.properties?.filter(p => p.propertyType === 'DatatypeProperty').map(prop => ({
                iri: prop.uri || prop.iri || `${baseUri}#${(prop.label || 'dataProp').replace(/\s+/g, '')}`,
                label: prop.label,
                comment: prop.comment,
                domain: prop.domain ? [prop.domain] : [],
                range: prop.range ? [prop.range] : []
              })) || []
            }
          })
        });
      } else {
        // Update existing ontology
        response = await fetch(`/api/owl/${encodeURIComponent(ontologyId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({
            tenantId,
            workspaceId,
            structure
          })
        });
      }

      if (response.ok) {
        alert(isNew ? '✅ Ontology created successfully!' : '✅ Ontology saved successfully!');
        onSave?.();
      } else {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save ontology');
      }
    } catch (error) {
      console.error('Save failed:', error);
      alert(`Failed to save ontology: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Filter items based on search
  const filteredClasses = structure?.classes?.filter(cls => 
    cls.label?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    cls.comment?.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const filteredProperties = structure?.properties?.filter(prop => 
    prop.label?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    prop.comment?.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const renderClassEditor = () => (
    <div className="eoe-editor-section">
      <div className="eoe-section-header">
        <h3>Classes ({filteredClasses.length})</h3>
        <button className="eoe-btn eoe-btn-primary" onClick={addClass}>
          ➕ Add Class
        </button>
      </div>

      <div className="eoe-search-bar">
        <input
          type="text"
          placeholder="Search classes..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="eoe-search-input"
        />
      </div>

      <div className="eoe-editor-layout">
        <div className="eoe-items-list">
          {filteredClasses.map((cls, index) => (
            <div 
              key={cls.uri}
              className={`eoe-item-card ${selectedClass?.uri === cls.uri ? 'selected' : ''} ${cls.isNew ? 'new' : ''}`}
              onClick={() => setSelectedClass(cls)}
            >
              <div className="eoe-item-header">
                <div className="eoe-item-icon">🏷️</div>
                <div className="eoe-item-name">{cls.label}</div>
                {cls.isNew && <span className="eoe-new-badge">New</span>}
                <button 
                  className="eoe-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteClass(cls);
                  }}
                >
                  🗑️
                </button>
              </div>
              {cls.comment && (
                <div className="eoe-item-description">{cls.comment}</div>
              )}
            </div>
          ))}
        </div>

        {selectedClass && (
          <div className="eoe-details-panel">
            <h4>Edit Class: {selectedClass.label}</h4>
            
            <div className="eoe-form-group">
              <label>Label *</label>
              <input
                type="text"
                value={selectedClass.label || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedClass(prev => ({ ...prev, label: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    classes: prev.classes.map(cls => 
                      cls.uri === selectedClass.uri ? { ...cls, label: newValue } : cls
                    )
                  }));
                  trackChange('classes', selectedClass.uri, 'label', newValue);
                }}
                className={validationErrors[`classes.${selectedClass.uri}.label`] ? 'error' : ''}
              />
              {validationErrors[`classes.${selectedClass.uri}.label`] && (
                <span className="eoe-error">{validationErrors[`classes.${selectedClass.uri}.label`]}</span>
              )}
            </div>

            <div className="eoe-form-group">
              <label>URI *</label>
              <input
                type="text"
                value={selectedClass.uri || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedClass(prev => ({ ...prev, uri: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    classes: prev.classes.map(cls => 
                      cls.uri === selectedClass.uri ? { ...cls, uri: newValue } : cls
                    )
                  }));
                  trackChange('classes', selectedClass.uri, 'uri', newValue);
                }}
                className={validationErrors[`classes.${selectedClass.uri}.uri`] ? 'error' : ''}
              />
              {validationErrors[`classes.${selectedClass.uri}.uri`] && (
                <span className="eoe-error">{validationErrors[`classes.${selectedClass.uri}.uri`]}</span>
              )}
            </div>

            <div className="eoe-form-group">
              <label>Description</label>
              <textarea
                value={selectedClass.comment || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedClass(prev => ({ ...prev, comment: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    classes: prev.classes.map(cls => 
                      cls.uri === selectedClass.uri ? { ...cls, comment: newValue } : cls
                    )
                  }));
                  trackChange('classes', selectedClass.uri, 'comment', newValue);
                }}
                rows={3}
              />
            </div>

            <div className="eoe-form-group">
              <label>Parent Classes</label>
              <div className="eoe-checkbox-list">
                {structure.classes?.filter(cls => cls.uri !== selectedClass.uri).map(cls => {
                  const parentList = selectedClass.subClassOf || [];
                  const isChecked = parentList.includes(cls.uri) || parentList.includes(cls.label);
                  return (
                    <label key={cls.uri} className="eoe-checkbox-item">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          const current = selectedClass.subClassOf || [];
                          const newValue = e.target.checked 
                            ? [...current, cls.uri]
                            : current.filter(u => u !== cls.uri && u !== cls.label);
                          setSelectedClass(prev => ({ ...prev, subClassOf: newValue }));
                          setStructure(prev => ({
                            ...prev,
                            classes: prev.classes.map(c => 
                              c.uri === selectedClass.uri ? { ...c, subClassOf: newValue } : c
                            )
                          }));
                          trackChange('classes', selectedClass.uri, 'subClassOf', newValue);
                        }}
                      />
                      <span>{cls.label}</span>
                    </label>
                  );
                })}
                {structure.classes?.filter(cls => cls.uri !== selectedClass.uri).length === 0 && (
                  <span className="eoe-no-items">No other classes available</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderPropertyEditor = () => (
    <div className="eoe-editor-section">
      <div className="eoe-section-header">
        <h3>Properties ({filteredProperties.length})</h3>
        <button className="eoe-btn eoe-btn-primary" onClick={addProperty}>
          ➕ Add Property
        </button>
      </div>

      <div className="eoe-search-bar">
        <input
          type="text"
          placeholder="Search properties..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="eoe-search-input"
        />
      </div>

      <div className="eoe-editor-layout">
        <div className="eoe-items-list">
          {filteredProperties.map((prop, index) => (
            <div 
              key={prop.uri}
              className={`eoe-item-card ${selectedProperty?.uri === prop.uri ? 'selected' : ''} ${prop.isNew ? 'new' : ''}`}
              onClick={() => setSelectedProperty(prop)}
            >
              <div className="eoe-item-header">
                <div className="eoe-item-icon">🔗</div>
                <div className="eoe-item-name">{prop.label}</div>
                <span className="eoe-property-type-badge">
                  {prop.propertyType === 'DatatypeProperty' ? 'Data' : 'Object'}
                </span>
                {prop.isNew && <span className="eoe-new-badge">New</span>}
                <button 
                  className="eoe-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteProperty(prop);
                  }}
                >
                  🗑️
                </button>
              </div>
              {prop.comment && (
                <div className="eoe-item-description">{prop.comment}</div>
              )}
              <div className="eoe-property-relationship">
                <span>{prop.domain?.split('#').pop() || 'Any'}</span>
                <span className="eoe-arrow">→</span>
                <span>{prop.range?.split('#').pop() || 'Any'}</span>
              </div>
            </div>
          ))}
        </div>

        {selectedProperty && (
          <div className="eoe-details-panel">
            <h4>Edit Property: {selectedProperty.label}</h4>
            
            <div className="eoe-form-group">
              <label>Label *</label>
              <input
                type="text"
                value={selectedProperty.label || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedProperty(prev => ({ ...prev, label: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    properties: prev.properties.map(prop => 
                      prop.uri === selectedProperty.uri ? { ...prop, label: newValue } : prop
                    )
                  }));
                  trackChange('properties', selectedProperty.uri, 'label', newValue);
                }}
                className={validationErrors[`properties.${selectedProperty.uri}.label`] ? 'error' : ''}
              />
              {validationErrors[`properties.${selectedProperty.uri}.label`] && (
                <span className="eoe-error">{validationErrors[`properties.${selectedProperty.uri}.label`]}</span>
              )}
            </div>

            <div className="eoe-form-group">
              <label>URI *</label>
              <input
                type="text"
                value={selectedProperty.uri || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedProperty(prev => ({ ...prev, uri: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    properties: prev.properties.map(prop => 
                      prop.uri === selectedProperty.uri ? { ...prop, uri: newValue } : prop
                    )
                  }));
                  trackChange('properties', selectedProperty.uri, 'uri', newValue);
                }}
                className={validationErrors[`properties.${selectedProperty.uri}.uri`] ? 'error' : ''}
              />
              {validationErrors[`properties.${selectedProperty.uri}.uri`] && (
                <span className="eoe-error">{validationErrors[`properties.${selectedProperty.uri}.uri`]}</span>
              )}
            </div>

            <div className="eoe-form-group">
              <label>Type</label>
              <select
                value={selectedProperty.propertyType || 'ObjectProperty'}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedProperty(prev => ({ ...prev, propertyType: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    properties: prev.properties.map(prop => 
                      prop.uri === selectedProperty.uri ? { ...prop, propertyType: newValue } : prop
                    )
                  }));
                  trackChange('properties', selectedProperty.uri, 'propertyType', newValue);
                }}
              >
                <option value="ObjectProperty">Object Property</option>
                <option value="DatatypeProperty">Datatype Property</option>
              </select>
            </div>

            <div className="eoe-form-group">
              <label>Description</label>
              <textarea
                value={selectedProperty.comment || ''}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setSelectedProperty(prev => ({ ...prev, comment: newValue }));
                  setStructure(prev => ({
                    ...prev,
                    properties: prev.properties.map(prop => 
                      prop.uri === selectedProperty.uri ? { ...prop, comment: newValue } : prop
                    )
                  }));
                  trackChange('properties', selectedProperty.uri, 'comment', newValue);
                }}
                rows={3}
              />
            </div>

            <div className="eoe-form-row">
              <div className="eoe-form-group">
                <label>Domain</label>
                <select
                  value={selectedProperty.domain || ''}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setSelectedProperty(prev => ({ ...prev, domain: newValue }));
                    setStructure(prev => ({
                      ...prev,
                      properties: prev.properties.map(prop => 
                        prop.uri === selectedProperty.uri ? { ...prop, domain: newValue } : prop
                      )
                    }));
                    trackChange('properties', selectedProperty.uri, 'domain', newValue);
                  }}
                >
                  <option value="">Any</option>
                  {structure.classes?.map(cls => (
                    <option key={cls.uri} value={cls.uri}>
                      {cls.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="eoe-form-group">
                <label>Range</label>
                <select
                  value={selectedProperty.range || ''}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setSelectedProperty(prev => ({ ...prev, range: newValue }));
                    setStructure(prev => ({
                      ...prev,
                      properties: prev.properties.map(prop => 
                        prop.uri === selectedProperty.uri ? { ...prop, range: newValue } : prop
                      )
                    }));
                    trackChange('properties', selectedProperty.uri, 'range', newValue);
                  }}
                >
                  <option value="">Any</option>
                  {selectedProperty.propertyType === 'ObjectProperty' ? (
                    structure.classes?.map(cls => (
                      <option key={cls.uri} value={cls.uri}>
                        {cls.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="xsd:string">String</option>
                      <option value="xsd:integer">Integer</option>
                      <option value="xsd:decimal">Decimal</option>
                      <option value="xsd:boolean">Boolean</option>
                      <option value="xsd:date">Date</option>
                      <option value="xsd:dateTime">DateTime</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="eoe-loading">
        <div className="eoe-spinner"></div>
        <p>Loading ontology structure...</p>
      </div>
    );
  }

  const hasChanges = Object.keys(changes).length > 0 || 
    structure?.label !== (ontology?.name || 'New Ontology') ||
    structure?.comment !== (ontology?.description || '');
  const hasErrors = Object.keys(validationErrors).length > 0;
  const isNew = ontology?.id === 'new' || ontology?.ontologyId === 'new' || ontology?.ontologyId === 'generated';

  return (
    <div className="enhanced-ontology-editor">
      <div className="eoe-header">
        <div className="eoe-title-section">
          <h2>{isNew ? 'Create New Ontology' : `Edit Ontology: ${structure?.label || ontology?.name}`}</h2>
          <p>{isNew ? 'Define your ontology name, classes and properties' : 'Make changes to classes and properties'}</p>
        </div>
        
        <div className="eoe-actions">
          {/* Undo/Redo buttons */}
          <button 
            className="eoe-btn eoe-btn-icon" 
            onClick={undo}
            disabled={undoStack.length === 0}
            title="Undo (Ctrl+Z)"
          >
            ↩️ Undo
          </button>
          <button 
            className="eoe-btn eoe-btn-icon" 
            onClick={redo}
            disabled={redoStack.length === 0}
            title="Redo (Ctrl+Shift+Z)"
          >
            ↪️ Redo
          </button>
          <span className="eoe-undo-count" title="Undo history">
            {undoStack.length > 0 && `(${undoStack.length})`}
          </span>
          
          <button className="eoe-btn eoe-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button 
            className="eoe-btn eoe-btn-primary" 
            onClick={handleSave}
            disabled={saving || hasErrors || (!hasChanges && !isNew)}
          >
            {saving ? 'Saving...' : isNew ? 'Create Ontology' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Ontology Metadata Section */}
      <div className="eoe-metadata-section">
        <div className="eoe-form-row">
          <div className="eoe-form-group">
            <label>Ontology Name *</label>
            <input
              type="text"
              value={structure?.label || ''}
              onChange={(e) => {
                setStructure(prev => ({ ...prev, label: e.target.value }));
              }}
              placeholder="e.g., Customer Ontology"
              className={!structure?.label?.trim() ? 'error' : ''}
            />
            {!structure?.label?.trim() && (
              <span className="eoe-error">Ontology name is required</span>
            )}
          </div>
          <div className="eoe-form-group">
            <label>Description</label>
            <input
              type="text"
              value={structure?.comment || ''}
              onChange={(e) => {
                setStructure(prev => ({ ...prev, comment: e.target.value }));
              }}
              placeholder="Brief description of this ontology"
            />
          </div>
        </div>
      </div>

      {hasChanges && (
        <div className="eoe-changes-indicator">
          <span className="eoe-changes-icon">●</span>
          You have unsaved changes
        </div>
      )}

      <div className="eoe-tabs">
        <button 
          className={`eoe-tab ${activeTab === 'classes' ? 'active' : ''}`}
          onClick={() => setActiveTab('classes')}
        >
          🏷️ Classes ({structure?.classes?.length || 0})
        </button>
        <button 
          className={`eoe-tab ${activeTab === 'properties' ? 'active' : ''}`}
          onClick={() => setActiveTab('properties')}
        >
          🔗 Properties ({structure?.properties?.length || 0})
        </button>
      </div>

      <div className="eoe-content">
        {activeTab === 'classes' && renderClassEditor()}
        {activeTab === 'properties' && renderPropertyEditor()}
      </div>
    </div>
  );
};

export default EnhancedOntologyEditor;
