import React, { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './EntityRegistry.css';

const API_BASE_URL = '/api';

/**
 * EntityRegistry Component
 * Tabular, paginated view of entities (graph node instances)
 * 
 * TERMINOLOGY:
 * - Class = Ontology type (shown in Class column)
 * - Entity = Instance in the graph (each row)
 */
const EntityRegistry = ({ onSelectEntity }) => {
  const { currentTenant, currentWorkspace } = useTenant();
  
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClass, setSelectedClass] = useState('');
  const [availableClasses, setAvailableClasses] = useState([]);
  
  // Pagination
  const [cursor, setCursor] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [totalEstimate, setTotalEstimate] = useState(0);
  const [limit] = useState(50);

  // Fetch available classes
  useEffect(() => {
    if (!currentTenant?.tenant_id || !currentWorkspace?.workspace_id) return;
    
    const fetchClasses = async () => {
      try {
        const params = new URLSearchParams({
          tenantId: currentTenant.tenant_id,
          workspaceId: currentWorkspace.workspace_id
        });
        
        const response = await fetch(`${API_BASE_URL}/entities/classes?${params}`);
        if (response.ok) {
          const data = await response.json();
          setAvailableClasses(data.classes || []);
        }
      } catch (err) {
        console.error('Failed to fetch classes:', err);
      }
    };
    
    fetchClasses();
  }, [currentTenant, currentWorkspace]);

  // Fetch entities
  const fetchEntities = useCallback(async (pageCursor = null) => {
    if (!currentTenant?.tenant_id || !currentWorkspace?.workspace_id) {
      setError('Please select a tenant and workspace');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id,
        limit: limit.toString()
      });

      if (selectedClass) {
        params.append('class', selectedClass);
      }

      if (searchTerm) {
        params.append('search', searchTerm);
      }

      if (pageCursor) {
        params.append('cursor', pageCursor);
      }

      const response = await fetch(`${API_BASE_URL}/entities?${params}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      setEntities(data.items || []);
      setNextCursor(data.nextCursor || null);
      setTotalEstimate(data.totalEstimate || 0);
      setCursor(pageCursor);

    } catch (err) {
      console.error('Failed to fetch entities:', err);
      setError(err.message);
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, [currentTenant, currentWorkspace, selectedClass, searchTerm, limit]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
    fetchEntities(null);
  }, [currentTenant, currentWorkspace, selectedClass, searchTerm]);

  // Handle search with debounce
  const [searchInput, setSearchInput] = useState('');
  
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchTerm(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Pagination handlers
  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory(prev => [...prev, cursor]);
      fetchEntities(nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevCursor = cursorHistory[cursorHistory.length - 1];
      setCursorHistory(prev => prev.slice(0, -1));
      fetchEntities(prevCursor);
    }
  };

  // Format date
  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  };

  // Get primary identifier display
  const getPrimaryIdentifier = (identifiers) => {
    if (!identifiers || Object.keys(identifiers).length === 0) return '-';
    const [key, value] = Object.entries(identifiers)[0];
    return `${value}`;
  };

  if (!currentTenant || !currentWorkspace) {
    return (
      <div className="entity-registry">
        <div className="entity-registry-empty">
          <span className="empty-icon">🏢</span>
          <p>Please select a tenant and workspace to view entities</p>
        </div>
      </div>
    );
  }

  return (
    <div className="entity-registry">
      <div className="entity-registry-header">
        <div className="header-title">
          <h2>📋 Entity Registry</h2>
          <span className="entity-count">
            {totalEstimate > 0 ? `~${totalEstimate.toLocaleString()} entities` : 'No entities'}
          </span>
        </div>
        
        <div className="header-filters">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search by name or ID..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="search-input"
            />
            {searchInput && (
              <button 
                className="clear-search"
                onClick={() => setSearchInput('')}
              >
                ×
              </button>
            )}
          </div>
          
          <select
            value={selectedClass}
            onChange={(e) => setSelectedClass(e.target.value)}
            className="class-filter"
          >
            <option value="">All Types</option>
            {availableClasses.map(c => (
              <option key={c.class} value={c.class}>
                {c.class} ({c.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="entity-registry-error">
          <span>⚠️ {error}</span>
          <button onClick={() => fetchEntities(cursor)}>Retry</button>
        </div>
      )}

      <div className="entity-table-container">
        <table className="entity-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Identifier</th>
              <th title="How this entity connects to others">Connections</th>
              <th>Last Updated</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="6" className="loading-cell">
                  <div className="loading-spinner"></div>
                  <span>Loading entities...</span>
                </td>
              </tr>
            ) : entities.length === 0 ? (
              <tr>
                <td colSpan="6" className="empty-cell">
                  <span className="empty-icon">📭</span>
                  <span>No entities found</span>
                  {(searchTerm || selectedClass) && (
                    <button 
                      className="clear-filters-btn"
                      onClick={() => {
                        setSearchInput('');
                        setSelectedClass('');
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              entities.map((entity) => (
                <tr 
                  key={entity.entityId}
                  onClick={() => onSelectEntity?.(entity)}
                  className="entity-row"
                >
                  <td className="name-cell">
                    <span className="entity-name">{entity.displayName}</span>
                  </td>
                  <td>
                    <span className="class-badge" title="Entity type from the ontology">{entity.class}</span>
                  </td>
                  <td className="id-cell">
                    {getPrimaryIdentifier(entity.identifiers)}
                  </td>
                  <td className="relationships-cell">
                    {entity.relationshipCounts?.total > 0 ? (
                      <span className="rel-count">
                        {entity.relationshipCounts.outgoing > 0 && (
                          <span className="rel-out" title="Links from this entity to others">
                            {entity.relationshipCounts.outgoing} outgoing
                          </span>
                        )}
                        {entity.relationshipCounts.incoming > 0 && (
                          <span className="rel-in" title="Links from other entities to this one">
                            {entity.relationshipCounts.incoming} incoming
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="rel-none">None</span>
                    )}
                  </td>
                  <td className="date-cell">
                    {formatDate(entity.lastUpdated)}
                  </td>
                  <td className="sources-cell">
                    {entity.sources?.map((source, i) => (
                      <span key={i} className="source-tag">{source}</span>
                    ))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="entity-pagination">
        <button
          onClick={handlePrevPage}
          disabled={cursorHistory.length === 0 || loading}
          className="pagination-btn"
        >
          ← Previous
        </button>
        
        <span className="pagination-info">
          Showing {entities.length} of ~{totalEstimate.toLocaleString()}
        </span>
        
        <button
          onClick={handleNextPage}
          disabled={!nextCursor || loading}
          className="pagination-btn"
        >
          Next →
        </button>
      </div>
    </div>
  );
};

export default EntityRegistry;
