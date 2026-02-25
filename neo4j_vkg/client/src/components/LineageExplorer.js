import { useState, useEffect } from 'react';
import './LineageExplorer.css';

const API_BASE_URL = '/api';

function LineageExplorer() {
  const [entityUri, setEntityUri] = useState('');
  const [lineage, setLineage] = useState(null);
  const [impact, setImpact] = useState(null);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState('lineage');

  useEffect(() => { loadSources(); }, []);

  const loadSources = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/sources`);
      const data = await response.json();
      setSources(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error loading sources:', error);
    }
  };

  const loadLineage = async () => {
    if (!entityUri) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/lineage/${encodeURIComponent(entityUri)}?depth=3`);
      const data = await response.json();
      setLineage(data);
    } catch (error) {
      console.error('Error loading lineage:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadImpact = async () => {
    if (!entityUri) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/lineage/${encodeURIComponent(entityUri)}/impact`);
      const data = await response.json();
      setImpact(data);
    } catch (error) {
      console.error('Error loading impact:', error);
    } finally {
      setLoading(false);
    }
  };

  const getQualityColor = (score) => {
    if (score >= 0.8) return '#10b981';
    if (score >= 0.5) return '#f59e0b';
    return '#ef4444';
  };

  return (
    <div className="lineage-explorer">
      <div className="le-header">
        <div className="le-title">
          <h3>🌳 Data Lineage Explorer</h3>
          <p>Track data provenance and analyze impact of changes</p>
        </div>
      </div>

      {/* Search */}
      <div className="le-search">
        <input
          type="text"
          placeholder="Enter entity URI (e.g., entity:person-john-doe)"
          value={entityUri}
          onChange={e => setEntityUri(e.target.value)}
          onKeyPress={e => e.key === 'Enter' && loadLineage()}
        />
        <button className="btn-enterprise" onClick={loadLineage} disabled={!entityUri || loading}>
          🔍 Trace Lineage
        </button>
        <button className="btn-enterprise secondary" onClick={loadImpact} disabled={!entityUri || loading}>
          💥 Impact Analysis
        </button>
      </div>

      {/* View Toggle */}
      <div className="le-views">
        <button className={`view-btn ${activeView === 'lineage' ? 'active' : ''}`} onClick={() => setActiveView('lineage')}>
          📊 Lineage
        </button>
        <button className={`view-btn ${activeView === 'impact' ? 'active' : ''}`} onClick={() => setActiveView('impact')}>
          💥 Impact
        </button>
        <button className={`view-btn ${activeView === 'sources' ? 'active' : ''}`} onClick={() => setActiveView('sources')}>
          📁 Sources
        </button>
      </div>

      {/* Content */}
      <div className="le-content">
        {loading ? (
          <div className="loading-spinner">Loading...</div>
        ) : activeView === 'lineage' && lineage ? (
          <div className="lineage-view">
            <div className="lineage-entity">
              <h4>{lineage.entity?.label || 'Entity'}</h4>
              <span className="entity-type">{lineage.entity?.type}</span>
            </div>
            {lineage.provenance && (
              <div className="provenance-info">
                <h5>Provenance</h5>
                <div className="prov-details">
                  <div className="prov-item">
                    <span className="prov-label">Source:</span>
                    <span className="prov-value">{lineage.provenance.source || 'Unknown'}</span>
                  </div>
                  <div className="prov-item">
                    <span className="prov-label">Created:</span>
                    <span className="prov-value">{lineage.provenance.createdAt ? new Date(lineage.provenance.createdAt).toLocaleString() : 'Unknown'}</span>
                  </div>
                  <div className="prov-item">
                    <span className="prov-label">Quality Score:</span>
                    <span className="prov-value" style={{ color: getQualityColor(lineage.provenance.qualityScore || 0) }}>
                      {((lineage.provenance.qualityScore || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
            )}
            {lineage.upstream?.length > 0 && (
              <div className="lineage-section">
                <h5>⬆️ Upstream Dependencies ({lineage.upstream.length})</h5>
                <div className="lineage-nodes">
                  {lineage.upstream.map((node, i) => (
                    <div key={i} className="lineage-node upstream">
                      <span className="node-label">{node.label}</span>
                      <span className="node-type">{node.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {lineage.downstream?.length > 0 && (
              <div className="lineage-section">
                <h5>⬇️ Downstream Dependents ({lineage.downstream.length})</h5>
                <div className="lineage-nodes">
                  {lineage.downstream.map((node, i) => (
                    <div key={i} className="lineage-node downstream">
                      <span className="node-label">{node.label}</span>
                      <span className="node-type">{node.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : activeView === 'impact' && impact ? (
          <div className="impact-view">
            <div className="impact-summary">
              <div className="impact-stat">
                <span className="num">{impact.directImpact || 0}</span>
                <span className="label">Direct Impact</span>
              </div>
              <div className="impact-stat">
                <span className="num">{impact.indirectImpact || 0}</span>
                <span className="label">Indirect Impact</span>
              </div>
              <div className="impact-stat">
                <span className="num">{impact.totalImpact || 0}</span>
                <span className="label">Total Affected</span>
              </div>
            </div>
            {impact.affectedEntities?.length > 0 && (
              <div className="affected-list">
                <h5>Affected Entities</h5>
                {impact.affectedEntities.slice(0, 20).map((entity, i) => (
                  <div key={i} className="affected-item">
                    <span className="affected-label">{entity.label}</span>
                    <span className="affected-type">{entity.type}</span>
                    <span className={`affected-level ${entity.level}`}>{entity.level}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeView === 'sources' ? (
          <div className="sources-view">
            <h4>Registered Data Sources ({sources.length})</h4>
            {sources.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">📁</span>
                <p>No data sources registered yet</p>
              </div>
            ) : (
              <div className="sources-list">
                {sources.map((source, i) => (
                  <div key={i} className="source-card">
                    <span className="source-icon">📁</span>
                    <div className="source-info">
                      <span className="source-name">{source.name}</span>
                      <span className="source-type">{source.type}</span>
                    </div>
                    <span className="source-trust" style={{ color: getQualityColor(source.trustScore || 0.5) }}>
                      Trust: {((source.trustScore || 0.5) * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">🌳</span>
            <h4>Enter an entity URI to explore its lineage</h4>
            <p>Track where your data comes from and what depends on it</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default LineageExplorer;
