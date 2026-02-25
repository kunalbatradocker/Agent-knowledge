/**
 * useOntologies Hook
 * Centralized state management for ontologies
 */

import { useState, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';

const API_BASE_URL = '/api';

/**
 * Custom hook for managing ontology state and operations
 */
export function useOntologies() {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [ontologies, setOntologies] = useState([]);
  const [selectedOntology, setSelectedOntology] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [storageStatus, setStorageStatus] = useState(null);

  // Normalize relationships to ensure they have from/to fields
  const normalizeRelationships = (relationships) => {
    if (!relationships || !Array.isArray(relationships)) return [];
    return relationships.map(rel => ({
      ...rel,
      type: rel.type || rel.predicate || '',
      from: rel.from || '',
      to: rel.to || ''
    }));
  };

  // Fetch all ontologies
  const fetchOntologies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      
      const [ontResponse, statusResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/ontology/all?${params}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          credentials: 'same-origin'
        }),
        fetch(`${API_BASE_URL}/ontology/storage-status`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin'
        })
      ]);
      
      if (!ontResponse.ok) {
        throw new Error(`HTTP ${ontResponse.status}: ${ontResponse.statusText}`);
      }
      
      const ontData = await ontResponse.json();
      const statusData = statusResponse.ok ? await statusResponse.json() : null;
      
      const ontologiesArray = Array.isArray(ontData.ontologies) ? ontData.ontologies : [];
      const normalizedOntologies = ontologiesArray.map(ont => ({
        ...ont,
        relationships: normalizeRelationships(ont.relationships)
      }));
      
      setOntologies(normalizedOntologies);
      setStorageStatus(statusData || ontData.storage || { storageType: 'unknown', redisAvailable: false });
    } catch (err) {
      console.error('[useOntologies] Failed to fetch:', err);
      setError(err.message);
      setOntologies([]);
      setStorageStatus({ storageType: 'error', redisAvailable: false });
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace?.workspace_id, getTenantHeaders]);

  // Select an ontology
  const selectOntology = useCallback(async (ont) => {
    const normalized = {
      ...ont,
      relationships: normalizeRelationships(ont.relationships)
    };
    setSelectedOntology(normalized);

    // Fetch full details for custom ontologies
    if (ont.isCustom) {
      try {
        const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${ont.id}`);
        const data = await response.json();
        if (data.ontology) {
          setSelectedOntology({
            ...data.ontology,
            relationships: normalizeRelationships(data.ontology.relationships)
          });
        }
      } catch (err) {
        console.error('Failed to fetch ontology details:', err);
      }
    }
  }, []);

  // Save ontology
  const saveOntology = useCallback(async (ontologyData) => {
    try {
      const isNew = !ontologyData.id;
      const url = isNew 
        ? `${API_BASE_URL}/ontology/custom-ontology`
        : `${API_BASE_URL}/ontology/custom-ontology/${ontologyData.id}`;
      
      // Add workspace_id if not already present
      const dataWithWorkspace = {
        ...ontologyData,
        workspace_id: ontologyData.workspace_id || currentWorkspace?.workspace_id || ''
      };
      
      const response = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(dataWithWorkspace)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to save: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Refresh list
      await fetchOntologies();
      
      return { success: true, ontology: data.ontology };
    } catch (err) {
      console.error('Failed to save ontology:', err);
      return { success: false, error: err.message };
    }
  }, [fetchOntologies, currentWorkspace?.workspace_id, getTenantHeaders]);

  // Delete ontology
  const deleteOntology = useCallback(async (ontologyId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${ontologyId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to delete: ${response.statusText}`);
      }
      
      // Clear selection if deleted
      if (selectedOntology?.id === ontologyId) {
        setSelectedOntology(null);
      }
      
      // Refresh list
      await fetchOntologies();
      
      return { success: true };
    } catch (err) {
      console.error('Failed to delete ontology:', err);
      return { success: false, error: err.message };
    }
  }, [fetchOntologies, selectedOntology]);

  // Update ontology name
  const updateOntologyName = useCallback(async (ontologyId, newName) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology/${ontologyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update name: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Update selected ontology
      if (selectedOntology?.id === ontologyId) {
        setSelectedOntology(prev => ({ ...prev, name: newName }));
      }
      
      // Refresh list
      await fetchOntologies();
      
      return { success: true, ontology: data.ontology };
    } catch (err) {
      console.error('Failed to update ontology name:', err);
      return { success: false, error: err.message };
    }
  }, [fetchOntologies, selectedOntology]);

  return {
    // State
    ontologies,
    selectedOntology,
    loading,
    error,
    storageStatus,
    
    // Actions
    fetchOntologies,
    selectOntology,
    saveOntology,
    deleteOntology,
    updateOntologyName,
    setSelectedOntology
  };
}

export default useOntologies;
