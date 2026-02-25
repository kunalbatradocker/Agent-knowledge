/**
 * VersionHistoryModal Component
 * Modal for viewing and managing ontology version history
 */

import { useState, useEffect } from 'react';
import { useTenant } from '../../contexts/TenantContext';

const API_BASE_URL = '/api';

const VersionHistoryModal = ({ ontology, onClose, onRollback }) => {
  const { getTenantHeaders } = useTenant();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [versionDetail, setVersionDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [diff, setDiff] = useState(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareFrom, setCompareFrom] = useState(null);
  const [compareTo, setCompareTo] = useState(null);
  const [viewMode, setViewMode] = useState('list'); // 'list', 'detail', 'diff'
  const [currentVersion, setCurrentVersion] = useState(null);

  // Resolve the ontology identifier used for versioning API
  const ontologyId = ontology?.ontologyId || ontology?.id;

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyId]);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/ontology-versions/${encodeURIComponent(ontologyId)}/versions`,
        { headers: getTenantHeaders() }
      );
      if (response.ok) {
        const data = await response.json();
        const versions = (data.versions || []).map(v => ({
          versionId: v.version_id,
          versionNumber: v.version_id?.split('-')[0]?.replace('v', '') || v.version_id,
          description: v.description || 'No description',
          createdAt: v.created_at,
          createdBy: v.created_by || 'system',
          changeType: v.branch || 'main',
          isActive: v.version_id === data.current_version,
          classCount: v.class_count || 0,
          propertyCount: v.property_count || 0
        }));
        setHistory(versions);
        setCurrentVersion(data.current_version);
      }
    } catch (error) {
      console.error('Error loading version history:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadVersionDetail = async (versionId) => {
    setLoadingDetail(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/ontology-versions/${encodeURIComponent(ontologyId)}/versions/${encodeURIComponent(versionId)}`,
        { headers: getTenantHeaders() }
      );
      if (response.ok) {
        const data = await response.json();
        // Map the ontology-versions API response to the detail format
        setVersionDetail({
          versionId: data.meta?.version_id || versionId,
          versionNumber: data.meta?.version_id?.split('-')[0]?.replace('v', '') || versionId,
          createdAt: data.meta?.created_at,
          createdBy: data.meta?.created_by || 'system',
          changeType: data.meta?.branch || 'main',
          description: data.meta?.description || 'No description',
          isActive: data.meta?.version_id === currentVersion,
          schema: {
            entityTypes: data.data?.classes || [],
            relationships: data.data?.properties?.filter(p => p.type !== 'datatypeProperty') || []
          }
        });
        setViewMode('detail');
      }
    } catch (error) {
      console.error('Error loading version detail:', error);
      alert(`Error loading version: ${error.message}`);
    } finally {
      setLoadingDetail(false);
    }
  };

  const loadDiff = async (fromId, toId) => {
    setLoadingDiff(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/ontology-versions/${encodeURIComponent(ontologyId)}/compare?v1=${encodeURIComponent(fromId)}&v2=${encodeURIComponent(toId)}`,
        { headers: getTenantHeaders() }
      );
      if (response.ok) {
        const data = await response.json();
        setDiff(data);
        setViewMode('diff');
      }
    } catch (error) {
      console.error('Error loading diff:', error);
      alert(`Error loading diff: ${error.message}`);
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleVersionClick = (version) => {
    if (compareMode) {
      if (!compareFrom) {
        setCompareFrom(version);
      } else if (!compareTo && version.versionId !== compareFrom.versionId) {
        setCompareTo(version);
        loadDiff(compareFrom.versionId, version.versionId);
        setCompareMode(false);
      }
    } else {
      setSelectedVersion(version);
      loadVersionDetail(version.versionId);
    }
  };

  const startCompareMode = () => {
    setCompareMode(true);
    setCompareFrom(null);
    setCompareTo(null);
    setDiff(null);
  };

  const cancelCompare = () => {
    setCompareMode(false);
    setCompareFrom(null);
    setCompareTo(null);
  };

  const backToList = () => {
    setViewMode('list');
    setSelectedVersion(null);
    setVersionDetail(null);
    setDiff(null);
    setCompareFrom(null);
    setCompareTo(null);
  };

  const rollbackToVersion = async (versionId) => {
    if (!window.confirm('Rollback to this version? This will restore the ontology to this version\'s schema.')) return;

    try {
      const response = await fetch(`${API_BASE_URL}/ontology-versions/${encodeURIComponent(ontologyId)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ version_id: versionId, reason: 'Manual rollback from version history UI' })
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        alert(`✅ Rollback successful! Ontology restored to version ${versionId}`);
        loadHistory();
        onRollback?.(versionId);
      } else {
        alert(`Error: ${data.error || 'Failed to rollback'}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  const deleteVersion = async (versionId, versionNumber) => {
    // Version deletion not supported — versions are immutable snapshots
    alert('Version deletion is not supported. Versions are immutable snapshots for audit purposes.');
  };

  const exportSchema = async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/owl/export?ontologyId=${encodeURIComponent(ontologyId)}&exportType=schema`,
        { headers: getTenantHeaders() }
      );
      if (response.ok) {
        const text = await response.text();
        const blob = new Blob([text], { type: 'text/turtle' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${ontology.name || ontologyId}-schema.ttl`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      alert(`Export error: ${error.message}`);
    }
  };

  // Render version detail view
  const renderVersionDetail = () => {
    if (!versionDetail) return null;
    const schema = versionDetail.schema || {};
    const entityTypes = schema.entityTypes || [];
    const relationships = schema.relationships || [];

    return (
      <div className="version-detail-view">
        <div className="version-detail-header">
          <button className="btn btn-back" onClick={backToList}>← Back to List</button>
          <h4>Version {versionDetail.versionNumber} Details</h4>
        </div>
        <div className="version-detail-meta">
          <span><strong>Created:</strong> {new Date(versionDetail.createdAt).toLocaleString()}</span>
          <span><strong>By:</strong> {versionDetail.createdBy}</span>
          <span><strong>Branch:</strong> {versionDetail.changeType}</span>
        </div>
        <p className="version-detail-desc">{versionDetail.description}</p>
        
        <div className="version-schema-section">
          <h5>Classes ({entityTypes.length})</h5>
          <div className="version-tags">
            {entityTypes.map((et, i) => (
              <span key={i} className="version-tag entity">
                {typeof et === 'string' ? et : (et.label || et.localName || et.userLabel || 'Unknown')}
              </span>
            ))}
            {entityTypes.length === 0 && <span className="empty-text">No classes</span>}
          </div>
        </div>

        <div className="version-schema-section">
          <h5>Relationships ({relationships.length})</h5>
          <div className="version-relationships">
            {relationships.map((rel, i) => (
              <div key={i} className="version-rel-item">
                <span className="rel-from">{rel.domain?.split('#').pop() || rel.from || '?'}</span>
                <span className="rel-arrow">→</span>
                <span className="rel-type">{rel.label || rel.type || rel.predicate}</span>
                <span className="rel-arrow">→</span>
                <span className="rel-to">{rel.range?.split('#').pop() || rel.to || '?'}</span>
              </div>
            ))}
            {relationships.length === 0 && <span className="empty-text">No relationships</span>}
          </div>
        </div>

        {!versionDetail.isActive && (
          <div className="version-detail-actions">
            <button className="btn btn-primary" onClick={() => rollbackToVersion(versionDetail.versionId)}>
              ↩️ Rollback to This Version
            </button>
          </div>
        )}
      </div>
    );
  };

  // Render diff view
  const renderDiffView = () => {
    if (!diff) return null;
    const diffData = diff.diff || {};
    const summary = diff.summary || {};

    return (
      <div className="version-diff-view">
        <div className="version-detail-header">
          <button className="btn btn-back" onClick={backToList}>← Back to List</button>
          <h4>Comparing Versions</h4>
        </div>
        <div className="diff-versions-info">
          <span className="diff-from">v{compareFrom?.versionNumber}</span>
          <span className="diff-arrow">→</span>
          <span className="diff-to">v{compareTo?.versionNumber}</span>
        </div>

        <div className="diff-summary">
          <div className="diff-stat">
            <span className="diff-stat-value">
              {(summary.classes_added || 0) + (summary.classes_removed || 0) + (summary.classes_modified || 0) + (summary.properties_added || 0) + (summary.properties_removed || 0)}
            </span>
            <span className="diff-stat-label">Total Changes</span>
          </div>
          <div className="diff-stat breaking">
            <span className="diff-stat-value">{(summary.classes_removed || 0) + (summary.properties_removed || 0)}</span>
            <span className="diff-stat-label">Removals</span>
          </div>
        </div>

        {/* Classes Changes */}
        <div className="diff-section">
          <h5>Classes</h5>
          {diffData.classes?.added?.length > 0 && (
            <div className="diff-group added">
              <span className="diff-group-label">+ Added</span>
              <div className="diff-items">
                {diffData.classes.added.map((cls, i) => (
                  <span key={i} className="diff-item added">{cls.label || cls.localName || cls.uri}</span>
                ))}
              </div>
            </div>
          )}
          {diffData.classes?.removed?.length > 0 && (
            <div className="diff-group removed">
              <span className="diff-group-label">- Removed</span>
              <div className="diff-items">
                {diffData.classes.removed.map((cls, i) => (
                  <span key={i} className="diff-item removed">{cls.label || cls.localName || cls.uri}</span>
                ))}
              </div>
            </div>
          )}
          {diffData.classes?.modified?.length > 0 && (
            <div className="diff-group modified">
              <span className="diff-group-label">~ Modified</span>
              <div className="diff-items">
                {diffData.classes.modified.map((mod, i) => (
                  <span key={i} className="diff-item modified">{mod.new?.label || mod.old?.label || 'Unknown'}</span>
                ))}
              </div>
            </div>
          )}
          {(!diffData.classes?.added?.length && !diffData.classes?.removed?.length && !diffData.classes?.modified?.length) && (
            <span className="no-changes">No changes</span>
          )}
        </div>

        {/* Properties Changes */}
        <div className="diff-section">
          <h5>Properties</h5>
          {diffData.properties?.added?.length > 0 && (
            <div className="diff-group added">
              <span className="diff-group-label">+ Added</span>
              <div className="diff-items">
                {diffData.properties.added.map((prop, i) => (
                  <span key={i} className="diff-item added">{prop.label || prop.localName || prop.uri}</span>
                ))}
              </div>
            </div>
          )}
          {diffData.properties?.removed?.length > 0 && (
            <div className="diff-group removed">
              <span className="diff-group-label">- Removed</span>
              <div className="diff-items">
                {diffData.properties.removed.map((prop, i) => (
                  <span key={i} className="diff-item removed">{prop.label || prop.localName || prop.uri}</span>
                ))}
              </div>
            </div>
          )}
          {(!diffData.properties?.added?.length && !diffData.properties?.removed?.length) && (
            <span className="no-changes">No changes</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="op-modal-overlay" onClick={onClose}>
      <div className="op-modal op-modal-large" onClick={e => e.stopPropagation()}>
        <div className="op-modal-header">
          <h3>📜 Version History: {ontology.name}</h3>
          <button className="op-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="op-modal-body">
          {viewMode === 'list' && (
            <>
              <div className="version-actions">
                {history.length >= 2 && !compareMode && (
                  <button className="btn btn-secondary" onClick={startCompareMode}>
                    🔍 Compare Versions
                  </button>
                )}
                {compareMode && (
                  <button className="btn btn-cancel" onClick={cancelCompare}>
                    ✕ Cancel Compare
                  </button>
                )}
                <button className="btn btn-secondary" onClick={exportSchema}>
                  📤 Export JSON-LD
                </button>
              </div>

              {compareMode && (
                <div className="compare-instructions">
                  {!compareFrom ? (
                    <p>👆 Click on the <strong>first version</strong> to compare from</p>
                  ) : (
                    <p>👆 Click on the <strong>second version</strong> to compare to (selected: v{compareFrom.versionNumber})</p>
                  )}
                </div>
              )}
              
              {loading ? (
                <div className="version-loading">Loading version history...</div>
              ) : history.length === 0 ? (
                <div className="version-empty">
                  <p>No version history available.</p>
                  <p>Click "Create Version" to start tracking changes.</p>
                </div>
              ) : (
                <div className="version-list">
                  {history.map((version) => (
                    <div 
                      key={version.versionId} 
                      className={`version-item ${version.isActive ? 'active' : ''} ${compareMode ? 'selectable' : ''} ${compareFrom?.versionId === version.versionId ? 'selected-compare' : ''}`}
                      onClick={() => handleVersionClick(version)}
                    >
                      <div className="version-header">
                        <span className="version-number">v{version.versionNumber}</span>
                        {version.isActive && <span className="version-badge">Current</span>}
                        <span className="version-date">{new Date(version.createdAt).toLocaleDateString()}</span>
                      </div>
                      <p className="version-desc">{version.description}</p>
                      <div className="version-meta">
                        <span>By: {version.createdBy}</span>
                        <span>Branch: {version.changeType}</span>
                        {version.classCount > 0 && <span>{version.classCount} classes, {version.propertyCount} properties</span>}
                      </div>
                      {!compareMode && (
                        <div className="version-item-actions">
                          <button className="btn btn-small" onClick={(e) => { e.stopPropagation(); loadVersionDetail(version.versionId); }}>
                            👁️ View
                          </button>
                          {!version.isActive && (
                            <button className="btn btn-small" onClick={(e) => { e.stopPropagation(); rollbackToVersion(version.versionId); }}>
                              ↩️ Rollback
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {viewMode === 'detail' && (loadingDetail ? (
            <div className="version-loading">Loading version details...</div>
          ) : renderVersionDetail())}

          {viewMode === 'diff' && (loadingDiff ? (
            <div className="version-loading">Loading diff...</div>
          ) : renderDiffView())}
        </div>
      </div>
    </div>
  );
};

export default VersionHistoryModal;
