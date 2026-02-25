/**
 * OntologyBrowser Component
 * Browse and fork available ontologies from global templates and tenant library
 */

import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../../contexts/TenantContext';

const API_BASE_URL = '/api';

const OntologyBrowser = ({ onClose, onForkComplete }) => {
  const { currentWorkspace, currentTenant, getTenantHeaders } = useTenant();
  const [availableOntologies, setAvailableOntologies] = useState({ global: [], tenant: [] });
  const [loading, setLoading] = useState(true);
  const [forking, setForking] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch available ontologies (global + tenant)
  const fetchAvailable = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      if (currentTenant?.tenant_id) {
        params.append('tenant_id', currentTenant.tenant_id);
      }

      const response = await fetch(`${API_BASE_URL}/ontology-packs?${params}`, {
        headers: getTenantHeaders()
      });
      
      if (!response.ok) throw new Error('Failed to fetch ontologies');
      
      const data = await response.json();
      
      setAvailableOntologies({
        global: data.global || [],
        tenant: data.tenant || []
      });
    } catch (error) {
      console.error('Error fetching available ontologies:', error);
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace, currentTenant, getTenantHeaders]);

  useEffect(() => {
    fetchAvailable();
  }, [fetchAvailable]);

  // Fork ontology to workspace
  const forkToWorkspace = async (ontology) => {
    if (!currentWorkspace?.workspace_id) {
      alert('Please select a workspace first');
      return;
    }

    const newName = prompt('Enter name for your copy:', ontology.name);
    if (!newName) return;

    setForking(ontology.id);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology-packs/${ontology.id}/fork-to-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          workspace_id: currentWorkspace.workspace_id,
          tenant_id: currentTenant?.tenant_id,
          name: newName
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fork ontology');
      }

      const result = await response.json();
      alert(`✅ "${newName}" added to your workspace!`);
      
      if (onForkComplete) {
        onForkComplete(result.ontology);
      }
    } catch (error) {
      console.error('Fork failed:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setForking(null);
    }
  };

  // Filter ontologies
  const getFilteredOntologies = () => {
    let ontologies = [];
    
    if (filter === 'all' || filter === 'global') {
      ontologies = [...ontologies, ...availableOntologies.global.map(o => ({ ...o, source: 'global' }))];
    }
    if (filter === 'all' || filter === 'tenant') {
      ontologies = [...ontologies, ...availableOntologies.tenant.map(o => ({ ...o, source: 'tenant' }))];
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      ontologies = ontologies.filter(o => 
        o.name.toLowerCase().includes(query) ||
        o.description?.toLowerCase().includes(query) ||
        o.industry?.toLowerCase().includes(query)
      );
    }

    return ontologies;
  };

  const filteredOntologies = getFilteredOntologies();

  return (
    <div className="op-modal-overlay" onClick={onClose}>
      <div className="op-modal op-modal-large" onClick={e => e.stopPropagation()}>
        <div className="op-modal-header">
          <h3>📚 Ontology Library</h3>
          <p className="op-modal-subtitle">
            Browse and add ontologies to your workspace
          </p>
          <button className="op-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="op-modal-body">
          {/* Search and Filter */}
          <div className="ob-controls">
            <input
              type="text"
              placeholder="Search ontologies..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ob-search"
            />
            <div className="ob-filters">
              <button 
                className={`ob-filter-btn ${filter === 'all' ? 'active' : ''}`}
                onClick={() => setFilter('all')}
              >
                All ({availableOntologies.global.length + availableOntologies.tenant.length})
              </button>
              <button 
                className={`ob-filter-btn ${filter === 'global' ? 'active' : ''}`}
                onClick={() => setFilter('global')}
              >
                🌐 Templates ({availableOntologies.global.length})
              </button>
              <button 
                className={`ob-filter-btn ${filter === 'tenant' ? 'active' : ''}`}
                onClick={() => setFilter('tenant')}
              >
                🏢 Organization ({availableOntologies.tenant.length})
              </button>
            </div>
          </div>

          {/* Ontology Grid */}
          {loading ? (
            <div className="ob-loading">Loading available ontologies...</div>
          ) : filteredOntologies.length === 0 ? (
            <div className="ob-empty">
              <p>No ontologies found</p>
              {searchQuery && (
                <button onClick={() => setSearchQuery('')}>Clear search</button>
              )}
            </div>
          ) : (
            <div className="ob-grid">
              {filteredOntologies.map(ontology => (
                <div key={`${ontology.source}-${ontology.id}`} className="ob-card">
                  <div className="ob-card-header">
                    <span className="ob-card-icon">
                      {ontology.source === 'global' ? '🌐' : '🏢'}
                    </span>
                    <div className="ob-card-title">
                      <h4>{ontology.name}</h4>
                      <span className="ob-card-source">
                        {ontology.source === 'global' ? 'Global Template' : 'Organization'}
                      </span>
                    </div>
                  </div>
                  
                  <p className="ob-card-desc">
                    {ontology.description || 'No description'}
                  </p>
                  
                  <div className="ob-card-meta">
                    <span>{ontology.entityCount || ontology.classes?.length || 0} classes</span>
                    <span>•</span>
                    <span>{ontology.relationshipCount || ontology.relationships?.length || 0} relations</span>
                    {ontology.industry && (
                      <>
                        <span>•</span>
                        <span className="ob-card-industry">{ontology.industry}</span>
                      </>
                    )}
                  </div>

                  <button 
                    className="ob-card-action"
                    onClick={() => forkToWorkspace(ontology)}
                    disabled={forking === ontology.id}
                  >
                    {forking === ontology.id ? '⏳ Adding...' : '📥 Add to Workspace'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="op-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default OntologyBrowser;
