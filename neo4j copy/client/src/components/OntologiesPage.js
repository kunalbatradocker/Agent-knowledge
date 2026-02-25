import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import './OntologiesPage.css';
import './ontology/OntologyGenerator.css';
import {
  OntologyList,
  OntologyEditor,
  OntologyBrowser,
  OntologyGenerator,
  OntologyLibrary,
  EnhancedOntologyViewer,
  EnhancedOntologyEditor,
  OntologyBuilder
} from './ontology';

const API_BASE_URL = '/api';

/**
 * OntologiesPage Component
 * Dedicated page for managing ontologies (predefined and custom)
 */
const OntologiesPage = () => {
  const { currentWorkspace, currentTenant, getTenantHeaders } = useTenant();
  const { canManageOntology, canUpload } = usePermissions();
  const [ontologies, setOntologies] = useState([]);
  const [selectedOntology, setSelectedOntology] = useState(null);
  const [loading, setLoading] = useState(true);
  const [storageStatus, setStorageStatus] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editedOntology, setEditedOntology] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [filter, setFilter] = useState('all');
  const [editingName, setEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  // Callback after global ontology is copied - just refresh the list
  const handleCopyGlobal = () => {
    fetchOntologies();
  };

  // Fetch all ontologies
  const fetchOntologies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        tenantId: currentWorkspace?.tenant_id || 'default',
        workspaceId: currentWorkspace?.workspace_id || 'default',
        scope: 'all' // Fetch both global and workspace ontologies
      });
      
      const [ontResponse, statusResponse] = await Promise.all([
        // Fetch from OWL API (GraphDB) - all ontologies
        fetch(`${API_BASE_URL}/owl/list?${params}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          credentials: 'same-origin',
          cache: 'default'
        }),
        fetch(`${API_BASE_URL}/ontology/storage-status`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'default'
        })
      ]);
      
      if (!ontResponse.ok) {
        throw new Error(`HTTP ${ontResponse.status}: ${ontResponse.statusText}`);
      }
      
      const ontData = await ontResponse.json();
      const statusData = statusResponse.ok ? await statusResponse.json() : null;
      
      // Transform OWL ontologies and load structure data
      const transformedOntologies = await Promise.all(
        (ontData.ontologies || []).map(async ont => {
          // Load structure data to get counts
          let classCount = 0;
          let relationshipCount = 0;
          
          const ontologyId = ont.ontologyId || ont.iri?.split(/[#/]/).pop()?.toLowerCase() || `ont_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          // Only fetch structure if we have a real ontologyId (not a generated fallback)
          if (ontologyId && !ontologyId.startsWith('ont_')) {
            try {
              const structureResponse = await fetch(
                `${API_BASE_URL}/owl/structure/${encodeURIComponent(ontologyId)}?tenantId=${currentWorkspace?.tenant_id || 'default'}&workspaceId=${currentWorkspace?.workspace_id || 'default'}&scope=all`,
                {
                  headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
                }
              );
              
              if (structureResponse.ok) {
                const structure = await structureResponse.json();
                classCount = structure.classes?.length || 0;
                relationshipCount = structure.stats?.relationshipCount 
                  || (structure.properties || []).filter(p => p.type === 'objectProperty').length
                  || 0;
              }
            } catch (error) {
              // Silently ignore structure loading errors
            }
          }

          // Fetch version count for workspace ontologies
          let versionLabel = ont.versionInfo || null;
          if (ont.scope === 'workspace' && ontologyId && !ontologyId.startsWith('ont_')) {
            try {
              const vRes = await fetch(`${API_BASE_URL}/ontology-versions/${ontologyId}/versions?limit=1`, { headers: getTenantHeaders() });
              if (vRes.ok) {
                const vData = await vRes.json();
                const count = vData.total_versions || 0;
                if (count > 0) versionLabel = `v${count}`;
              }
            } catch (e) { /* ignore */ }
          }

          return {
            id: ontologyId,
            iri: ont.iri,
            name: ont.label || ont.iri?.split(/[#/]/).pop() || 'Unnamed Ontology',
            label: ont.label,
            description: ont.comment,
            version: versionLabel,
            ontologyId: ontologyId,
            graphIRI: ont.graphIRI,
            scope: ont.scope || 'global',
            isCustom: ont.scope === 'workspace',
            isAutoGenerated: false,
            entityTypes: Array(classCount).fill({}),
            relationships: Array(relationshipCount).fill({})
          };
        })
      );
      
      setOntologies(transformedOntologies);
      setStorageStatus(statusData || { storageType: 'graphdb', redisAvailable: false });
    } catch (error) {
      console.error('[OntologiesPage] Failed to fetch ontologies:', error);
      setOntologies([]);
      setStorageStatus({ storageType: 'error', redisAvailable: false });
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace?.workspace_id, currentWorkspace?.tenant_id, getTenantHeaders]);

  useEffect(() => {
    fetchOntologies();
  }, [fetchOntologies]);

  // Select an ontology
  const selectOntology = async (ont) => {
    if (ont.relationships) {
      ont.relationships = ont.relationships.map(rel => ({
        ...rel,
        type: rel.type || rel.predicate,
        from: rel.from || '',
        to: rel.to || ''
      }));
    }
    
    setSelectedOntology(ont);
    setEditMode(false);
    setEditedOntology(null);

    // For workspace ontologies, try to fetch additional details but preserve original fields
    if (ont.isCustom && ont.scope === 'workspace') {
      try {
        const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${ont.id}`);
        if (response.ok) {
          const data = await response.json();
          if (data.ontology) {
            // Merge fetched data with original, preserving ontologyId and scope
            setSelectedOntology(prev => ({
              ...prev,
              ...data.ontology,
              ontologyId: prev.ontologyId,
              scope: prev.scope,
              id: prev.id
            }));
          }
        }
      } catch (error) {
        // Keep original ontology on error
      }
    }
  };

  // Start editing
  const startEdit = () => {
    let entityTypes = selectedOntology.entityTypes || selectedOntology.originalEntityTypes || [];
    
    if (entityTypes.length === 0) {
      const simpleTypes = selectedOntology.nodeTypes || selectedOntology.conceptTypes || [];
      entityTypes = simpleTypes.map(t => ({
        label: t,
        userLabel: t,
        description: '',
        include: true,
        properties: selectedOntology.nodeProperties?.[t] || []
      }));
    } else {
      entityTypes = entityTypes.map(et => ({
        label: et.label || et.userLabel,
        userLabel: et.userLabel || et.label,
        description: et.description || '',
        include: et.include !== false,
        properties: et.properties || []
      }));
    }
    
    const nodeTypes = entityTypes.map(et => et.userLabel || et.label).filter(Boolean);
    const relationships = (selectedOntology.originalRelationships ||
      (selectedOntology.relationships || [])).map((r) => {
        let from = r.from || '';
        let to = r.to || '';
        
        if (!from && nodeTypes.length > 0) {
          from = inferFromEntity(r, nodeTypes);
        }
        if (!to && nodeTypes.length > 0) {
          to = inferToEntity(r, nodeTypes);
        }
        
        return {
          predicate: r.type || r.predicate || r,
          userPredicate: r.type || r.predicate || r,
          from,
          to,
          properties: r.properties || ['confidence', 'source_uri'],
          include: true
        };
      });

    setEditedOntology({ ...selectedOntology, entityTypes, relationships });
    setNewName(selectedOntology.isCustom ? selectedOntology.name : `${selectedOntology.name} (Custom)`);
    setNewDescription(selectedOntology.description || '');
    setEditMode(true);
  };

  // Helper to infer 'from' entity based on relationship name
  const inferFromEntity = (r, nodeTypes) => {
    const relName = (r.type || r.predicate || '').toLowerCase();
    if (relName.includes('supplies')) {
      return nodeTypes.find(t => t.toLowerCase().includes('supplier')) || nodeTypes[0];
    }
    if (relName.includes('ships') || relName.includes('routes')) {
      return nodeTypes.find(t => t.toLowerCase().includes('shipment') || t.toLowerCase().includes('order')) || nodeTypes[0];
    }
    if (relName.includes('stores') || relName.includes('contains')) {
      return nodeTypes.find(t => t.toLowerCase().includes('warehouse') || t.toLowerCase().includes('location')) || nodeTypes[0];
    }
    if (relName.includes('originates')) {
      return nodeTypes.find(t => t.toLowerCase().includes('supplier') || t.toLowerCase().includes('origin')) || nodeTypes[0];
    }
    if (relName.includes('fulfills') || relName.includes('procures')) {
      return nodeTypes.find(t => t.toLowerCase().includes('order') || t.toLowerCase().includes('purchase')) || nodeTypes[0];
    }
    return nodeTypes[0] || '';
  };

  // Helper to infer 'to' entity based on relationship name
  const inferToEntity = (r, nodeTypes) => {
    const relName = (r.type || r.predicate || '').toLowerCase();
    if (nodeTypes.length < 2) return nodeTypes[0] || '';
    
    if (relName.includes('ships') || relName.includes('routes')) {
      return nodeTypes.find(t => t.toLowerCase().includes('location') || t.toLowerCase().includes('destination')) || nodeTypes[1];
    }
    if (relName.includes('supplies')) {
      return nodeTypes.find(t => t.toLowerCase().includes('product') || t.toLowerCase().includes('order')) || nodeTypes[1];
    }
    if (relName.includes('stores') || relName.includes('contains')) {
      return nodeTypes.find(t => t.toLowerCase().includes('product') || t.toLowerCase().includes('inventory')) || nodeTypes[1];
    }
    if (relName.includes('originates')) {
      return nodeTypes.find(t => t.toLowerCase().includes('location') || t.toLowerCase().includes('destination')) || nodeTypes[1];
    }
    if (relName.includes('fulfills')) {
      return nodeTypes.find(t => t.toLowerCase().includes('order') || t.toLowerCase().includes('demand')) || nodeTypes[1];
    }
    if (relName.includes('procures')) {
      return nodeTypes.find(t => t.toLowerCase().includes('supplier') || t.toLowerCase().includes('source')) || nodeTypes[1];
    }
    return nodeTypes[1] || nodeTypes[0] || '';
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditedOntology(null);
  };

  // Entity type handlers
  const updateEntityType = (index, field, value) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.entityTypes = [...prev.entityTypes];
      updated.entityTypes[index] = { ...updated.entityTypes[index], [field]: value };
      return updated;
    });
  };

  const removeEntityType = (index) => {
    setEditedOntology(prev => ({
      ...prev,
      entityTypes: prev.entityTypes.filter((_, i) => i !== index)
    }));
  };

  const addEntityType = () => {
    setEditedOntology(prev => ({
      ...prev,
      entityTypes: [...prev.entityTypes, { label: '', userLabel: '', description: '', properties: [], include: true }]
    }));
  };

  const addEntityProperty = (entityIndex) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.entityTypes = prev.entityTypes.map((et, idx) => {
        if (idx !== entityIndex) return et;
        // Clone the entity type and add new property
        const currentProps = et.properties || [];
        return {
          ...et,
          properties: [...currentProps, { name: '', data_type: 'string' }]
        };
      });
      return updated;
    });
  };

  const updateEntityProperty = (entityIndex, propertyIndex, field, value) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.entityTypes = [...prev.entityTypes];
      updated.entityTypes[entityIndex] = { ...updated.entityTypes[entityIndex] };
      updated.entityTypes[entityIndex].properties = [...updated.entityTypes[entityIndex].properties];
      
      // Get current property
      let currentProp = updated.entityTypes[entityIndex].properties[propertyIndex];
      
      // Convert string to object if needed
      if (typeof currentProp === 'string') {
        currentProp = { name: currentProp, data_type: 'string' };
      } else {
        currentProp = { ...currentProp };
      }
      
      // Update the field
      currentProp[field] = value;
      updated.entityTypes[entityIndex].properties[propertyIndex] = currentProp;
      
      return updated;
    });
  };

  const removeEntityProperty = (entityIndex, propertyIndex) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.entityTypes = [...prev.entityTypes];
      updated.entityTypes[entityIndex].properties = updated.entityTypes[entityIndex].properties.filter((_, i) => i !== propertyIndex);
      return updated;
    });
  };

  // Relationship handlers
  const updateRelationship = (index, field, value) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.relationships = [...prev.relationships];
      if (field === 'predicate') {
        const formattedValue = value.toUpperCase().replace(/\s+/g, '_');
        updated.relationships[index] = { ...updated.relationships[index], predicate: formattedValue, userPredicate: formattedValue };
      } else {
        updated.relationships[index] = { ...updated.relationships[index], [field]: value };
      }
      return updated;
    });
  };

  const addRelationshipProperty = (relIndex) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.relationships = prev.relationships.map((rel, idx) => {
        if (idx !== relIndex) return rel;
        // Clone the relationship and add new property
        const currentProps = rel.properties || [];
        return {
          ...rel,
          properties: [...currentProps, { name: '', data_type: 'string' }]
        };
      });
      return updated;
    });
  };

  const updateRelationshipProperty = (relIndex, propertyIndex, field, value) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.relationships = [...prev.relationships];
      updated.relationships[relIndex] = { ...updated.relationships[relIndex] };
      updated.relationships[relIndex].properties = [...updated.relationships[relIndex].properties];
      
      // Get current property
      let currentProp = updated.relationships[relIndex].properties[propertyIndex];
      
      // Convert string to object if needed
      if (typeof currentProp === 'string') {
        currentProp = { name: currentProp, data_type: 'string' };
      } else {
        currentProp = { ...currentProp };
      }
      
      // Update the field
      currentProp[field] = value;
      updated.relationships[relIndex].properties[propertyIndex] = currentProp;
      
      return updated;
    });
  };

  const removeRelationshipProperty = (relIndex, propertyIndex) => {
    setEditedOntology(prev => {
      const updated = { ...prev };
      updated.relationships = [...prev.relationships];
      updated.relationships[relIndex].properties = updated.relationships[relIndex].properties.filter((_, i) => i !== propertyIndex);
      return updated;
    });
  };

  const removeRelationship = (index) => {
    setEditedOntology(prev => ({
      ...prev,
      relationships: prev.relationships.filter((_, i) => i !== index)
    }));
  };

  const addRelationship = () => {
    setEditedOntology(prev => ({
      ...prev,
      relationships: [...prev.relationships, { predicate: '', userPredicate: '', from: '', to: '', properties: ['confidence', 'source_uri'], include: true }]
    }));
  };

  // Auto-create version using ontology-versions API (same backend the viewer reads)
  const autoCreateVersion = async (ontologyId, actionDescription) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology-versions/${ontologyId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ description: actionDescription })
      });
      if (response.ok) {
        const data = await response.json();
        return data.version?.version_id;
      }
    } catch (error) {
      console.error('Auto-version failed:', error);
    }
    return null;
  };

  // Save as new
  const saveAsNew = async () => {
    if (!newName.trim()) {
      alert('Please enter a name for the ontology');
      return;
    }

    const validEntityTypes = editedOntology.entityTypes.filter(et => (et.userLabel || et.label)?.trim());
    if (validEntityTypes.length === 0) {
      alert('Please add at least one class');
      return;
    }

    setSaving(true);
    try {
      const ontologyPayload = {
        name: newName.trim(),
        description: newDescription.trim(),
        workspace_id: currentWorkspace?.workspace_id || '',
        entityTypes: validEntityTypes.map(et => ({ ...et, label: et.userLabel || et.label, include: true })),
        relationships: editedOntology.relationships.filter(r => (r.userPredicate || r.predicate)?.trim()).map(r => ({
          ...r,
          predicate: r.userPredicate || r.predicate,
          include: true
        })),
        sourceDocument: selectedOntology.isCustom 
          ? `Modified from: ${selectedOntology.name}`
          : `Customized from predefined: ${selectedOntology.name}`
      };

      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(ontologyPayload)
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
      await fetchOntologies();
      setEditMode(false);
      setEditedOntology(null);
      
      if (result.ontology) {
        setSelectedOntology(result.ontology);
        await autoCreateVersion(result.ontology.id, `Ontology "${newName}" created`);
      }
      alert(`✅ Ontology "${newName}" saved successfully!`);
    } catch (error) {
      console.error('Save failed:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Update existing
  const updateExisting = async () => {
    if (!selectedOntology.isCustom) {
      await saveAsNew();
      return;
    }

    setSaving(true);
    try {
      const ontologyPayload = {
        name: newName.trim(),
        description: newDescription.trim(),
        workspace_id: currentWorkspace?.workspace_id || '',
        entityTypes: editedOntology.entityTypes.filter(et => (et.userLabel || et.label)?.trim()),
        relationships: editedOntology.relationships.filter(r => (r.userPredicate || r.predicate)?.trim())
      };

      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${selectedOntology.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(ontologyPayload)
      });

      if (!response.ok) throw new Error('Failed to update ontology');

      await fetchOntologies();
      setEditMode(false);
      setEditedOntology(null);
      await selectOntology({ ...selectedOntology, id: selectedOntology.id });
      
      await autoCreateVersion(selectedOntology.id, `Ontology "${newName}" updated`);
    } catch (error) {
      console.error('Update failed:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Name editing handlers
  const startEditingName = () => {
    if (!selectedOntology.isCustom) return;
    setEditingNameValue(selectedOntology.name);
    setEditingName(true);
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setEditingNameValue('');
  };

  const saveName = async () => {
    if (!selectedOntology.isCustom || !editingNameValue.trim()) {
      alert('Please enter a valid name');
      return;
    }

    if (editingNameValue.trim() === selectedOntology.name) {
      setEditingName(false);
      return;
    }

    setSavingName(true);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${selectedOntology.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          name: editingNameValue.trim(),
          description: selectedOntology.description || '',
          workspace_id: currentWorkspace?.workspace_id || '',
          entityTypes: selectedOntology.originalEntityTypes || 
            (selectedOntology.conceptTypes || selectedOntology.nodeTypes || []).map(type => ({
              label: type,
              userLabel: type,
              description: '',
              include: true
            })),
          relationships: selectedOntology.originalRelationships || selectedOntology.relationships || []
        })
      });

      if (!response.ok) {
        let errorMessage = 'Failed to update name';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch (e) {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      alert(`✅ Ontology name updated to "${editingNameValue.trim()}"`);
      
      await fetchOntologies();
      if (result.ontology) {
        setSelectedOntology(result.ontology);
      } else {
        await selectOntology({ ...selectedOntology, id: selectedOntology.id });
      }
      
      setEditingName(false);
    } catch (error) {
      console.error('Update name failed:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setSavingName(false);
    }
  };

  // Delete ontology
  const deleteOntology = async () => {
    if (!selectedOntology.isCustom) {
      alert('Cannot delete predefined ontologies');
      return;
    }

    if (!window.confirm(`Delete "${selectedOntology.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${selectedOntology.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete ontology');

      alert('Ontology deleted');
      await fetchOntologies();
      setSelectedOntology(null);
    } catch (error) {
      console.error('Delete failed:', error);
      alert(`Error: ${error.message}`);
    }
  };

  // Get entity labels for relationship dropdowns
  const getEntityLabels = () => {
    if (editMode && editedOntology) {
      const fromEntityTypes = editedOntology.entityTypes.map(et => et.userLabel || et.label).filter(Boolean);
      const fromNodeTypes = [...(selectedOntology?.nodeTypes || []), ...(selectedOntology?.conceptTypes || [])].filter(Boolean);
      return [...new Set([...fromEntityTypes, ...fromNodeTypes])];
    }
    
    if (selectedOntology) {
      return [
        ...(selectedOntology.nodeTypes || []),
        ...(selectedOntology.conceptTypes || []),
        ...(selectedOntology.entityTypes?.map(et => et.label || et.userLabel) || [])
      ].filter(Boolean);
    }
    
    return [];
  };

  // Create new ontology handler - opens the step-by-step builder
  const handleCreateNew = () => {
    setShowBuilder(true);
  };

  // Browse library handler
  const handleBrowseLibrary = () => {
    setShowLibrary(true);
  };

  // Generate ontology handler
  const handleGenerate = () => {
    setShowGenerator(true);
  };

  // Delete ontology handler
  const handleDeleteOntology = async (ontology) => {
    // Enhanced confirmation with warning about associated data
    const confirmMessage = `Delete "${ontology.name}"?\n\n⚠️ This will also remove any extracted data associated with this ontology.\n\nThis action cannot be undone.`;
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setLoading(true);
      
      const tenantId = currentWorkspace?.tenant_id || 'default';
      const workspaceId = currentWorkspace?.workspace_id || 'default';
      
      const response = await fetch(`/api/owl/${encodeURIComponent(ontology.iri)}?tenantId=${tenantId}&workspaceId=${workspaceId}`, {
        method: 'DELETE',
        headers: { ...getTenantHeaders() }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to delete ontology');
      }

      // Clear selection if deleted ontology was selected
      if (selectedOntology?.id === ontology.id) {
        setSelectedOntology(null);
        setEditMode(false);
      }

      // Refresh ontologies list
      await fetchOntologies();

      alert(`✅ Ontology "${ontology.name}" deleted successfully`);
      
    } catch (error) {
      console.error('Error deleting ontology:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Handle generated ontology - either saved or needs editing
  const handleGeneratedOntology = (generatedOntology) => {
    setShowGenerator(false);
    
    // If ontology needs editing (Edit First clicked)
    if (generatedOntology && generatedOntology.needsEditing) {
      // Open in editor with the generated data
      setSelectedOntology({
        id: 'generated',
        name: generatedOntology.name || 'Generated Ontology',
        isCustom: true,
        scope: 'workspace',
        ontologyId: 'generated',
        entityTypes: generatedOntology.entityTypes || [],
        relationships: generatedOntology.relationships || [],
        description: generatedOntology.description || '',
        industry: generatedOntology.industry || ''
      });
      setEditMode(true);
    } else {
      // Already saved, just refresh
      fetchOntologies();
    }
  };

  // Fork complete handler
  const handleForkComplete = async (forkedOntology) => {
    setShowBrowser(false);
    await fetchOntologies();
    if (forkedOntology) {
      setSelectedOntology(forkedOntology);
    }
  };

  return (
    <div className="ontologies-page">
      <div className="op-header">
        <h1>Ontologies</h1>
        <span className="op-count">{ontologies.length} ontologies</span>
      </div>

      <div className="op-content">
        <OntologyList
          ontologies={ontologies}
          selectedOntology={selectedOntology}
          loading={loading}
          filter={filter}
          onFilterChange={setFilter}
          onSelectOntology={selectOntology}
          onCreateNew={canManageOntology ? handleCreateNew : undefined}
          onBrowseLibrary={canManageOntology ? handleBrowseLibrary : undefined}
          onGenerate={canManageOntology ? handleGenerate : undefined}
          onDeleteOntology={canManageOntology ? handleDeleteOntology : undefined}
        />

        <div className="op-details">
          {!selectedOntology ? (
            <div className="op-placeholder">
              <div className="op-placeholder-icon">📋</div>
              <h3>Select an Ontology</h3>
              <p>Choose an ontology from the list to view its classes and relationships</p>
            </div>
          ) : editMode ? (
            console.log('[OntologiesPage] Edit mode, scope:', selectedOntology?.scope, 'id:', selectedOntology?.id) ||
            (selectedOntology?.scope === 'workspace' || selectedOntology?.id === 'new' || selectedOntology?.id === 'generated') ? (
              <EnhancedOntologyEditor
                ontology={selectedOntology}
                onSave={() => {
                  setEditMode(false);
                  setSelectedOntology(null);
                  fetchOntologies();
                }}
                onCancel={() => {
                  setEditMode(false);
                  if (selectedOntology?.id === 'new' || selectedOntology?.id === 'generated') {
                    setSelectedOntology(null);
                  }
                }}
              />
            ) : (
              <OntologyEditor
              selectedOntology={selectedOntology}
              editedOntology={editedOntology}
              newName={newName}
              newDescription={newDescription}
              saving={saving}
              entityLabels={getEntityLabels()}
              onNameChange={setNewName}
              onDescriptionChange={setNewDescription}
              onUpdateEntityType={updateEntityType}
              onRemoveEntityType={removeEntityType}
              onAddEntityType={addEntityType}
              onAddEntityProperty={addEntityProperty}
              onUpdateEntityProperty={updateEntityProperty}
              onRemoveEntityProperty={removeEntityProperty}
              onUpdateRelationship={updateRelationship}
              onAddRelationshipProperty={addRelationshipProperty}
              onUpdateRelationshipProperty={updateRelationshipProperty}
              onRemoveRelationshipProperty={removeRelationshipProperty}
              onRemoveRelationship={removeRelationship}
              onAddRelationship={addRelationship}
              onCancel={cancelEdit}
              onUpdateExisting={updateExisting}
              onSaveAsNew={saveAsNew}
              onUpdateFromYaml={(yamlData) => {
                setEditedOntology(prev => ({
                  ...prev,
                  entityTypes: yamlData.entityTypes,
                  relationships: yamlData.relationships
                }));
              }}
            />
            )
          ) : (
            <EnhancedOntologyViewer
              ontology={selectedOntology}
              onEdit={canManageOntology ? () => setEditMode(true) : undefined}
              onCopyGlobal={selectedOntology?.scope === 'global' ? handleCopyGlobal : null}
              onVersion={async (action, data) => {
                if (action === 'rollback') {
                  // Refresh ontology data after rollback
                  await fetchOntologies();
                  if (selectedOntology) {
                    // Re-select to get updated structure
                    const updated = ontologies.find(o => o.id === selectedOntology.id);
                    if (updated) setSelectedOntology(updated);
                  }
                } else if (action === 'created' || action === 'branch_created' || action === 'tag_created' || action === 'branch_switched') {
                  await fetchOntologies();
                }
              }}
            />
          )}
        </div>
      </div>

      {showLibrary && (
        <OntologyLibrary
          isOpen={showLibrary}
          onClose={() => setShowLibrary(false)}
          onCopyToWorkspace={fetchOntologies}
          getTenantHeaders={getTenantHeaders}
          currentWorkspace={currentWorkspace}
        />
      )}

      {showBrowser && (
        <OntologyBrowser
          onClose={() => setShowBrowser(false)}
          onForkComplete={handleForkComplete}
        />
      )}

      {showGenerator && (
        <OntologyGenerator
          onClose={() => setShowGenerator(false)}
          onGenerated={handleGeneratedOntology}
        />
      )}

      {showBuilder && (
        <OntologyBuilder
          onClose={() => setShowBuilder(false)}
          onCreated={() => {
            setShowBuilder(false);
            fetchOntologies();
          }}
        />
      )}
    </div>
  );
};

export default OntologiesPage;
