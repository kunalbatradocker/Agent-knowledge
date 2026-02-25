import { useState, useEffect } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import './EntityResolution.css';

const API_BASE_URL = '/api';

function EntityResolution() {
  const { canManageOntology } = usePermissions();
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [filters, setFilters] = useState({ minScore: 0.7, entityType: '', limit: 50 });
  const [selectedPair, setSelectedPair] = useState(null);
  const [autoResolveResults, setAutoResolveResults] = useState(null);

  useEffect(() => {
    loadCandidates();
  }, []);

  const loadCandidates = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        minScore: filters.minScore,
        limit: filters.limit,
        ...(filters.entityType && { entityType: filters.entityType })
      });
      const response = await fetch(`${API_BASE_URL}/enterprise/entity-resolution/candidates?${params}`);
      const data = await response.json();
      setCandidates(data.candidates || data || []);
    } catch (error) {
      console.error('Error loading candidates:', error);
    } finally {
      setLoading(false);
    }
  };

  const mergeEntities = async (sourceUri, targetUri, keepSource = false) => {
    setMerging(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/entity-resolution/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUri, targetUri, keepSource, mergeStrategy: 'prefer_target' })
      });
      const result = await response.json();
      if (response.ok) {
        alert(`✅ Merged successfully! ${result.relationshipsTransferred || 0} relationships transferred.`);
        setSelectedPair(null);
        loadCandidates();
      } else {
        alert(`❌ ${result.error}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    } finally {
      setMerging(false);
    }
  };

  const autoResolve = async (dryRun = true) => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/entity-resolution/auto-resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minScore: 0.85, maxMerges: 50, dryRun })
      });
      const result = await response.json();
      setAutoResolveResults(result);
      if (!dryRun) {
        loadCandidates();
      }
    } catch (error) {
      console.error('Auto-resolve error:', error);
    } finally {
      setLoading(false);
    }
  };

  const getScoreColor = (score) => {
    if (score >= 0.9) return '#10b981';
    if (score >= 0.8) return '#f59e0b';
    return '#ef4444';
  };

  return (
    <div className="entity-resolution">
      {/* Header */}
      <div className="er-header">
        <div className="er-title">
          <h3>🔗 Entity Resolution</h3>
          <p>Find and merge duplicate entities in your knowledge graph</p>
        </div>
        <div className="er-actions">
          <button className="btn-enterprise secondary" onClick={() => autoResolve(true)} disabled={!canManageOntology}>
            🔍 Preview Auto-Resolve
          </button>
          <button className="btn-enterprise" onClick={loadCandidates} disabled={loading}>
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="er-filters">
        <div className="filter-group">
          <label>Min Similarity Score</label>
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.05"
            value={filters.minScore}
            onChange={e => setFilters({...filters, minScore: parseFloat(e.target.value)})}
          />
          <span className="filter-value">{(filters.minScore * 100).toFixed(0)}%</span>
        </div>
        <div className="filter-group">
          <label>Entity Type</label>
          <input
            type="text"
            placeholder="All types"
            value={filters.entityType}
            onChange={e => setFilters({...filters, entityType: e.target.value})}
          />
        </div>
        <div className="filter-group">
          <label>Limit</label>
          <select value={filters.limit} onChange={e => setFilters({...filters, limit: parseInt(e.target.value)})}>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
        <button className="btn-enterprise" onClick={loadCandidates}>Apply Filters</button>
      </div>

      {/* Auto-Resolve Results */}
      {autoResolveResults && (
        <div className="auto-resolve-panel">
          <div className="ar-header">
            <h4>Auto-Resolve {autoResolveResults.dryRun ? 'Preview' : 'Results'}</h4>
            <button className="btn-close" onClick={() => setAutoResolveResults(null)}>×</button>
          </div>
          <div className="ar-stats">
            <div className="ar-stat">
              <span className="num">{autoResolveResults.candidatesFound || 0}</span>
              <span className="label">Candidates Found</span>
            </div>
            <div className="ar-stat">
              <span className="num">{autoResolveResults.mergesPerformed || autoResolveResults.proposedMerges?.length || 0}</span>
              <span className="label">{autoResolveResults.dryRun ? 'Proposed Merges' : 'Merges Performed'}</span>
            </div>
          </div>
          {autoResolveResults.dryRun && autoResolveResults.proposedMerges?.length > 0 && (
            <>
              <div className="ar-list">
                {autoResolveResults.proposedMerges.slice(0, 10).map((merge, i) => (
                  <div key={i} className="ar-item">
                    <span className="ar-source">{merge.source}</span>
                    <span className="ar-arrow">→</span>
                    <span className="ar-target">{merge.target}</span>
                    <span className="ar-score" style={{ color: getScoreColor(merge.score) }}>
                      {(merge.score * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
              <button className="btn-enterprise success" onClick={() => autoResolve(false)} disabled={!canManageOntology}>
                ✅ Execute {autoResolveResults.proposedMerges.length} Merges
              </button>
            </>
          )}
        </div>
      )}

      {/* Candidates List */}
      <div className="er-candidates">
        <h4>Duplicate Candidates ({candidates.length})</h4>
        {loading ? (
          <div className="loading-spinner">Loading candidates...</div>
        ) : candidates.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">✨</span>
            <h4>No duplicates found</h4>
            <p>Your knowledge graph looks clean! Try lowering the similarity threshold.</p>
          </div>
        ) : (
          <div className="candidates-list">
            {candidates.map((pair, i) => (
              <div
                key={i}
                className={`candidate-card ${selectedPair === i ? 'selected' : ''}`}
                onClick={() => setSelectedPair(selectedPair === i ? null : i)}
              >
                <div className="candidate-header">
                  <div className="candidate-score" style={{ background: getScoreColor(pair.similarity) }}>
                    {(pair.similarity * 100).toFixed(0)}%
                  </div>
                  <span className="candidate-type">{pair.entityType || 'Entity'}</span>
                </div>
                <div className="candidate-entities">
                  <div className="entity-box">
                    <span className="entity-label">{pair.entity1?.label || pair.label1}</span>
                    <span className="entity-uri">{pair.entity1?.uri || pair.uri1}</span>
                  </div>
                  <span className="vs">≈</span>
                  <div className="entity-box">
                    <span className="entity-label">{pair.entity2?.label || pair.label2}</span>
                    <span className="entity-uri">{pair.entity2?.uri || pair.uri2}</span>
                  </div>
                </div>
                {selectedPair === i && (
                  <div className="candidate-actions">
                    <button
                      className="btn-enterprise"
                      onClick={(e) => { e.stopPropagation(); mergeEntities(pair.entity1?.uri || pair.uri1, pair.entity2?.uri || pair.uri2); }}
                      disabled={merging || !canManageOntology}
                    >
                      {merging ? '⏳' : '🔗'} Merge (Keep Right)
                    </button>
                    <button
                      className="btn-enterprise secondary"
                      onClick={(e) => { e.stopPropagation(); mergeEntities(pair.entity2?.uri || pair.uri2, pair.entity1?.uri || pair.uri1); }}
                      disabled={merging || !canManageOntology}
                    >
                      🔗 Merge (Keep Left)
                    </button>
                    <button
                      className="btn-enterprise danger"
                      onClick={(e) => { e.stopPropagation(); setSelectedPair(null); }}
                    >
                      ✕ Skip
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default EntityResolution;
