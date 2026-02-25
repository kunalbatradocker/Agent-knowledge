/**
 * ExtractionReview Component
 * Review and edit extracted entities/relationships before committing to graph
 */
import { useState, useEffect } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import { usePermissions } from '../../hooks/usePermissions';
import './ExtractionReview.css';

const ExtractionReview = ({ jobId, onClose, onCommit }) => {
  const { getTenantHeaders } = useTenant();
  const { canUpload, canDelete } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [stageId, setStageId] = useState(null);
  const [entities, setEntities] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [activeTab, setActiveTab] = useState('entities');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState(null);
  const [editingEntity, setEditingEntity] = useState(null);
  const [editingRel, setEditingRel] = useState(null);

  useEffect(() => {
    if (jobId) {
      const doStage = async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await fetch('/api/ontology/extraction-review/stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
            body: JSON.stringify({ jobId })
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error);
          
          setStageId(data.stageId);
          
          // Load staged data
          const loadRes = await fetch(`/api/ontology/extraction-review/${data.stageId}`, {
            headers: getTenantHeaders()
          });
          const loadData = await loadRes.json();
          if (!loadData.success) throw new Error(loadData.error);
          
          setEntities(loadData.staged.entities || []);
          setRelationships(loadData.staged.relationships || []);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };
      doStage();
    }
  }, [jobId, getTenantHeaders]);

  const handleDeleteEntity = (idx) => {
    const entity = entities[idx];
    setEntities(entities.filter((_, i) => i !== idx));
    // Remove relationships involving this entity
    setRelationships(relationships.filter(r => 
      r.sourceLabel !== entity.label && r.targetLabel !== entity.label
    ));
  };

  const handleDeleteRelationship = (idx) => {
    setRelationships(relationships.filter((_, i) => i !== idx));
  };

  const handleEditEntity = (idx, field, value) => {
    const updated = [...entities];
    updated[idx] = { ...updated[idx], [field]: value };
    setEntities(updated);
  };

  const handleEditRelationship = (idx, field, value) => {
    const updated = [...relationships];
    updated[idx] = { ...updated[idx], [field]: value };
    setRelationships(updated);
  };

  const handleCommit = async () => {
    setCommitting(true);
    setError(null);
    try {
      // Save edits first
      await fetch(`/api/ontology/extraction-review/${stageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ entities, relationships })
      });

      // Commit to graph
      const res = await fetch(`/api/ontology/extraction-review/${stageId}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      
      onCommit?.(data.committed);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCommitting(false);
    }
  };

  const handleDiscard = async () => {
    if (!window.confirm('Discard all extracted data? This cannot be undone.')) return;
    try {
      await fetch(`/api/ontology/extraction-review/${stageId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="er-overlay">
        <div className="er-modal">
          <div className="er-loading">Loading extraction results...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="er-overlay">
      <div className="er-modal">
        <div className="er-header">
          <h2>📝 Review Extraction</h2>
          <div className="er-stats">
            <span>{entities.length} entities</span>
            <span>{relationships.length} relationships</span>
          </div>
          <button className="er-close" onClick={onClose}>×</button>
        </div>

        {error && <div className="er-error">{error}</div>}

        <div className="er-tabs">
          <button 
            className={activeTab === 'entities' ? 'active' : ''} 
            onClick={() => setActiveTab('entities')}
          >
            Entities ({entities.length})
          </button>
          <button 
            className={activeTab === 'relationships' ? 'active' : ''} 
            onClick={() => setActiveTab('relationships')}
          >
            Relationships ({relationships.length})
          </button>
        </div>

        <div className="er-content">
          {activeTab === 'entities' && (
            <div className="er-table-wrap">
              <table className="er-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Type</th>
                    <th>Confidence</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entities.map((entity, idx) => (
                    <tr key={idx}>
                      <td>
                        {editingEntity === idx ? (
                          <input
                            value={entity.label || entity.name || ''}
                            onChange={(e) => handleEditEntity(idx, 'label', e.target.value)}
                            onBlur={() => setEditingEntity(null)}
                            autoFocus
                          />
                        ) : (
                          <span onClick={() => setEditingEntity(idx)}>
                            {entity.label || entity.name || '—'}
                          </span>
                        )}
                      </td>
                      <td>
                        <select
                          value={entity.type || ''}
                          onChange={(e) => handleEditEntity(idx, 'type', e.target.value)}
                        >
                          <option value="">Select type...</option>
                          {[...new Set(entities.map(e => e.type).filter(Boolean))].map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`er-confidence ${entity.confidence >= 0.8 ? 'high' : entity.confidence >= 0.5 ? 'medium' : 'low'}`}>
                          {((entity.confidence || 0) * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td>
                        {canDelete && <button className="er-btn-delete" onClick={() => handleDeleteEntity(idx)}>
                          🗑️
                        </button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {entities.length === 0 && (
                <div className="er-empty">No entities extracted</div>
              )}
            </div>
          )}

          {activeTab === 'relationships' && (
            <div className="er-table-wrap">
              <table className="er-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Predicate</th>
                    <th>Target</th>
                    <th>Confidence</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {relationships.map((rel, idx) => (
                    <tr key={idx}>
                      <td>{rel.sourceLabel}</td>
                      <td>
                        {editingRel === idx ? (
                          <input
                            value={rel.predicate || rel.type || ''}
                            onChange={(e) => handleEditRelationship(idx, 'predicate', e.target.value)}
                            onBlur={() => setEditingRel(null)}
                            autoFocus
                          />
                        ) : (
                          <span className="er-predicate" onClick={() => setEditingRel(idx)}>
                            {rel.predicate || rel.type || 'RELATED_TO'}
                          </span>
                        )}
                      </td>
                      <td>{rel.targetLabel}</td>
                      <td>
                        <span className={`er-confidence ${rel.confidence >= 0.8 ? 'high' : rel.confidence >= 0.5 ? 'medium' : 'low'}`}>
                          {((rel.confidence || 0) * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td>
                        {canDelete && <button className="er-btn-delete" onClick={() => handleDeleteRelationship(idx)}>
                          🗑️
                        </button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {relationships.length === 0 && (
                <div className="er-empty">No relationships extracted</div>
              )}
            </div>
          )}
        </div>

        <div className="er-footer">
          {canDelete && <button className="er-btn-discard" onClick={handleDiscard}>
            Discard All
          </button>}
          <div className="er-footer-right">
            <button className="er-btn-cancel" onClick={onClose}>
              Cancel
            </button>
            {canUpload && <button 
              className="er-btn-commit" 
              onClick={handleCommit}
              disabled={committing || (entities.length === 0 && relationships.length === 0)}
            >
              {committing ? 'Committing...' : `Commit to Graph (${entities.length} entities)`}
            </button>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExtractionReview;
