import React, { useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './StatsPanel.css';

// Use relative URL - the proxy (setupProxy.js) forwards /api to the server
const API_BASE_URL = '/api';

const StatsPanel = ({ stats, onRefresh }) => {
  const [clearing, setClearing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const { getTenantHeaders, currentWorkspace } = useTenant();

  // Handle both old format (array) and new format (object with knowledgeGraph/vectorStore)
  const hasNewFormat = stats && stats.knowledgeGraph;
  const hasOldFormat = stats && Array.isArray(stats) && stats.length > 0;

  const handleClearDatabase = async () => {
    if (!currentWorkspace?.workspace_id) {
      alert('Please select a workspace first.');
      return;
    }
    if (!window.confirm(`⚠️ This will delete ALL data from workspace "${currentWorkspace.name}". Are you sure?`)) {
      return;
    }

    setClearing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/graph/clear`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        }
      });
      
      if (response.ok) {
        alert('✅ Database cleared successfully!');
        if (onRefresh) onRefresh();
      } else {
        const data = await response.json();
        alert(`❌ Failed to clear: ${data.message}`);
      }
    } catch (error) {
      alert(`❌ Error: ${error.message}`);
    } finally {
      setClearing(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const response = await fetch(`${API_BASE_URL}/graph/cleanup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        const { orphanedConcepts = 0, orphanedChunks = 0 } = data.stats || {};
        if (orphanedConcepts > 0 || orphanedChunks > 0) {
          alert(`✅ Cleaned up ${orphanedConcepts} orphaned concepts, ${orphanedChunks} orphaned chunks`);
        } else {
          alert('✅ No orphaned data found');
        }
        if (onRefresh) onRefresh();
      } else {
        const data = await response.json();
        alert(`❌ Cleanup failed: ${data.error}`);
      }
    } catch (error) {
      alert(`❌ Error: ${error.message}`);
    } finally {
      setCleaning(false);
    }
  };

  if (!stats || (!hasNewFormat && !hasOldFormat)) {
    return (
      <div className="stats-panel">
        <h2>📊 Knowledge Graph Statistics</h2>
        <div className="no-stats">
          <p>No data uploaded yet.</p>
          <p>Upload a document to see statistics.</p>
        </div>
      </div>
    );
  }

  // New format stats
  if (hasNewFormat) {
    const kg = stats.knowledgeGraph || {};
    const vs = stats.vectorStore || {};
    const details = stats.graphDetails || {};

    const hasData = (kg.documents || 0) + (kg.chunks || 0) + (kg.concepts || 0) > 0;

    return (
      <div className="stats-panel">
        <div className="stats-header">
          <h2>📊 Knowledge Graph Statistics</h2>
          <div className="stats-actions">
            <button 
              className="cleanup-btn" 
              onClick={handleCleanup}
              disabled={cleaning}
              title="Clean up orphaned entities"
            >
              {cleaning ? '⏳...' : '🧹 Cleanup'}
            </button>
            {hasData && (
              <button 
                className="clear-db-btn" 
                onClick={handleClearDatabase}
                disabled={clearing}
                title="Clear all data from database"
              >
                {clearing ? '⏳ Clearing...' : '🗑️ Clear All'}
              </button>
            )}
          </div>
        </div>
        
        {/* Main stats cards */}
        <div className="total-stats">
          <div className="stat-card">
            <div className="stat-icon">📄</div>
            <div className="stat-value">{kg.documents || 0}</div>
            <div className="stat-label">Documents</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">📝</div>
            <div className="stat-value">{kg.chunks || vs.totalChunks || 0}</div>
            <div className="stat-label">Chunks</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">💡</div>
            <div className="stat-value">{kg.concepts || 0}</div>
            <div className="stat-label">Concepts</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🔗</div>
            <div className="stat-value">{kg.relations || 0}</div>
            <div className="stat-label">Relationships</div>
          </div>
        </div>

        {/* Vector Store Stats */}
        {vs.totalVectors > 0 && (
          <div className="stats-section">
            <h3>🧮 Vector Store</h3>
            <div className="stats-row">
              <span className="stats-label">Embeddings:</span>
              <span className="stats-value">{vs.totalVectors}</span>
            </div>
            <div className="stats-row">
              <span className="stats-label">Documents:</span>
              <span className="stats-value">{vs.totalDocuments}</span>
            </div>
          </div>
        )}

        {/* Node Types Breakdown */}
        {details.nodesByLabel && details.nodesByLabel.length > 0 && (
          <div className="stats-section">
            <h3>🏷️ Node Types</h3>
            {details.nodesByLabel.map((item, idx) => (
              <div key={idx} className="stats-row">
                <span className="stats-label">{item.label}:</span>
                <span className="stats-value">{item.count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Relationship Types Breakdown */}
        {details.relationshipsByType && details.relationshipsByType.length > 0 && (
          <div className="stats-section">
            <h3>🔗 Relationship Types</h3>
            {details.relationshipsByType.map((item, idx) => (
              <div key={idx} className="stats-row">
                <span className="stats-label">{item.type}:</span>
                <span className="stats-value">{item.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Old format (array of ontologies) - backward compatibility
  const totalStats = stats.reduce(
    (acc, stat) => ({
      classCount: acc.classCount + (stat.classCount || stat.chunks || 0),
      propertyCount: acc.propertyCount + (stat.propertyCount || stat.concepts || 0),
      individualCount: acc.individualCount + (stat.individualCount || 0),
    }),
    { classCount: 0, propertyCount: 0, individualCount: 0 }
  );

  return (
    <div className="stats-panel">
      <div className="stats-header">
        <h2>📊 Knowledge Graph Statistics</h2>
        <button 
          className="clear-db-btn" 
          onClick={handleClearDatabase}
          disabled={clearing}
        >
          {clearing ? '⏳ Clearing...' : '🗑️ Clear All'}
        </button>
      </div>
      
      <div className="total-stats">
        <div className="stat-card">
          <div className="stat-icon">📄</div>
          <div className="stat-value">{stats.length}</div>
          <div className="stat-label">Documents</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📝</div>
          <div className="stat-value">{totalStats.classCount}</div>
          <div className="stat-label">Chunks</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">💡</div>
          <div className="stat-value">{totalStats.propertyCount}</div>
          <div className="stat-label">Concepts</div>
        </div>
      </div>

      <div className="ontology-list">
        <h3>📚 Documents</h3>
        {stats.map((stat, index) => (
          <div key={index} className="ontology-item">
            <div className="ontology-name">{stat.title || stat.ontologyName || 'Document ' + (index + 1)}</div>
            <div className="ontology-stats">
              <span>{stat.chunks || stat.classCount || 0} Chunks</span>
              <span>{stat.concepts || stat.propertyCount || 0} Concepts</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StatsPanel;
