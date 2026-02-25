import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import './EntityDetail.css';

const API_BASE_URL = '/api';

/**
 * EntityDetail Component
 * Shows detailed view of a single entity with edit capability
 */
const EntityDetail = ({ entityId, onClose, onViewGraph }) => {
  const { currentTenant, currentWorkspace } = useTenant();
  const { canUpload } = usePermissions();
  
  const [entity, setEntity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editedProperties, setEditedProperties] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  
  // Expanded relationship types
  const [expandedRelTypes, setExpandedRelTypes] = useState(new Set());
  const [relationshipDetails, setRelationshipDetails] = useState({});
  const [loadingRels, setLoadingRels] = useState({});
  const [showTechnicalId, setShowTechnicalId] = useState(false);

  // Fetch entity detail
  const fetchEntity = useCallback(async () => {
    if (!entityId || !currentTenant?.tenant_id || !currentWorkspace?.workspace_id) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id
      });

      const response = await fetch(
        `${API_BASE_URL}/entities/${encodeURIComponent(entityId)}?${params}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Entity not found');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setEntity(data);
      setEditedProperties(data.attributes || {});

    } catch (err) {
      console.error('Failed to fetch entity:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [entityId, currentTenant, currentWorkspace]);

  useEffect(() => {
    fetchEntity();
  }, [fetchEntity]);

  // Toggle relationship expansion
  const toggleRelationship = async (relType) => {
    const newExpanded = new Set(expandedRelTypes);
    
    if (newExpanded.has(relType)) {
      newExpanded.delete(relType);
    } else {
      newExpanded.add(relType);
      
      // Fetch relationship details if not already loaded
      if (!relationshipDetails[relType]) {
        await fetchRelationshipDetails(relType);
      }
    }
    
    setExpandedRelTypes(newExpanded);
  };

  // Fetch relationship details
  const fetchRelationshipDetails = async (relType) => {
    setLoadingRels(prev => ({ ...prev, [relType]: true }));

    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id,
        type: relType,
        limit: '20'
      });

      const response = await fetch(
        `${API_BASE_URL}/entities/${encodeURIComponent(entityId)}/relationships?${params}`
      );

      if (response.ok) {
        const data = await response.json();
        setRelationshipDetails(prev => ({
          ...prev,
          [relType]: data.items || []
        }));
      }
    } catch (err) {
      console.error('Failed to fetch relationships:', err);
    } finally {
      setLoadingRels(prev => ({ ...prev, [relType]: false }));
    }
  };

  // Format date - handle various formats including Neo4j DateTime objects
  const formatDate = (dateValue) => {
    if (!dateValue) return '-';
    
    try {
      // Handle Neo4j DateTime objects (have year, month, day properties)
      if (typeof dateValue === 'object' && dateValue.year !== undefined) {
        const { year, month, day, hour = 0, minute = 0, second = 0 } = dateValue;
        const date = new Date(year, month - 1, day, hour, minute, second);
        return date.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
      
      // Handle Neo4j integer timestamps
      if (typeof dateValue === 'number') {
        return new Date(dateValue).toLocaleString();
      }
      
      // Handle ISO strings
      if (typeof dateValue === 'string') {
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) {
          return dateValue; // Return as-is if can't parse
        }
        
        return date.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
      
      // Fallback - convert to string
      return String(dateValue);
    } catch {
      return String(dateValue);
    }
  };
  
  // Safely render any value (handles Neo4j objects)
  const safeRender = (value) => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') {
      // Check if it's a Neo4j DateTime
      if (value.year !== undefined && value.month !== undefined) {
        return formatDate(value);
      }
      return JSON.stringify(value);
    }
    return String(value);
  };

  // Humanize relationship type names (e.g., DEFINES → Defines, HAS_ACCOUNT → Has Account)
  const humanizeRelType = (type) => {
    if (!type) return type;
    return type
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  // Humanize method names for display
  const humanizeMethod = (method) => {
    if (!method) return null;
    const map = {
      'llm_extraction': 'AI-extracted',
      'llm extraction': 'AI-extracted',
      'manual': 'Manually entered',
      'import': 'Imported',
      'rule_based': 'Rule-based',
      'ocr': 'Scanned (OCR)',
    };
    return map[method.toLowerCase()] || method.replace(/_/g, ' ');
  };

  // Format confidence as a human-readable label
  const confidenceLabel = (confidence) => {
    if (!confidence) return null;
    const pct = Math.round(confidence * 100);
    if (confidence >= 0.85) return `High confidence (${pct}%)`;
    if (confidence >= 0.65) return `Medium confidence (${pct}%)`;
    return `Low confidence (${pct}%)`;
  };

  // Format claim status for display
  const claimStatusLabel = (status) => {
    if (!status) return null;
    const map = {
      'FACT': 'Verified',
      'CLAIM': 'Unverified',
      'CANDIDATE': 'Needs Review',
    };
    return map[status.toUpperCase()] || status;
  };

  // Handle property edit
  const handlePropertyChange = (key, value) => {
    setEditedProperties(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // Save changes
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);

    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id
      });

      const response = await fetch(
        `${API_BASE_URL}/entities/${encodeURIComponent(entityId)}?${params}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: editedProperties })
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to save');
      }

      // Refresh entity data
      await fetchEntity();
      setIsEditing(false);

    } catch (err) {
      console.error('Failed to save entity:', err);
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Cancel editing
  const handleCancel = () => {
    setEditedProperties(entity?.attributes || {});
    setIsEditing(false);
    setSaveError(null);
  };

  if (loading) {
    return (
      <div className="entity-detail">
        <div className="entity-detail-loading">
          <div className="loading-spinner"></div>
          <span>Loading entity...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="entity-detail">
        <div className="entity-detail-error">
          <span className="error-icon">⚠️</span>
          <p>{error}</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (!entity) {
    return null;
  }

  return (
    <div className="entity-detail">
      {/* Header */}
      <div className="entity-detail-header">
        <button className="back-btn" onClick={onClose}>
          ← Back
        </button>
        
        <div className="entity-header-content">
          <div className="entity-title">
            <h2>{entity.displayName}</h2>
            <span className="entity-class-badge" title="Entity type from the ontology">{entity.class}</span>
          </div>
          <div className="entity-canonical-id">
            <button 
              className="toggle-id-btn"
              onClick={() => setShowTechnicalId(!showTechnicalId)}
              title="Show/hide technical identifier"
            >
              {showTechnicalId ? '▾ Hide ID' : '▸ Show ID'}
            </button>
            {showTechnicalId && (
              <code>{entity.canonicalId || entity.entityId}</code>
            )}
          </div>
        </div>
        
        <button 
          className="view-graph-btn"
          onClick={() => onViewGraph?.(entity)}
        >
          🔗 View Connections
        </button>
      </div>

      <div className="entity-detail-content">
        {/* Attributes Section */}
        <section className="detail-section">
          <div className="section-header-row">
            <h3>📦 Attributes</h3>
            {!isEditing ? (
              canUpload && <button className="edit-btn" onClick={() => setIsEditing(true)}>
                ✏️ Edit
              </button>
            ) : (
              <div className="edit-actions">
                <button 
                  className="save-btn" 
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : '💾 Save'}
                </button>
                <button 
                  className="cancel-btn" 
                  onClick={handleCancel}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          
          {saveError && (
            <div className="save-error">⚠️ {saveError}</div>
          )}
          
          <div className="attributes-grid">
            {Object.entries(isEditing ? editedProperties : (entity.attributes || {})).length === 0 ? (
              <p className="no-data">No attributes</p>
            ) : (
              Object.entries(isEditing ? editedProperties : (entity.attributes || {})).map(([key, value]) => (
                <div key={key} className="attribute-item">
                  <span className="attribute-key">{key}</span>
                  {isEditing ? (
                    <input
                      type="text"
                      className="attribute-input"
                      value={typeof value === 'object' ? JSON.stringify(value) : String(value || '')}
                      onChange={(e) => handlePropertyChange(key, e.target.value)}
                    />
                  ) : (
                    <span className="attribute-value">
                      {safeRender(value)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Source Information Section */}
        <section className="detail-section">
          <h3>📍 Source Information</h3>
          <div className="provenance-grid">
            <div className="provenance-item">
              <span className="provenance-label">Created At</span>
              <span className="provenance-value">
                {formatDate(entity.provenance?.createdAt || entity.attributes?.created_at || entity.attributes?.extracted_at)}
              </span>
            </div>
            {entity.provenance?.updatedAt && (
              <div className="provenance-item">
                <span className="provenance-label">Updated At</span>
                <span className="provenance-value">{formatDate(entity.provenance.updatedAt)}</span>
              </div>
            )}
            {entity.provenance?.sourceSystem && (
              <div className="provenance-item">
                <span className="provenance-label">Source System</span>
                <span className="provenance-value">{entity.provenance.sourceSystem}</span>
              </div>
            )}
            {entity.provenance?.sourceSystems?.length > 0 && (
              <div className="provenance-item">
                <span className="provenance-label">Source Systems</span>
                <span className="provenance-value">
                  {entity.provenance.sourceSystems.join(', ')}
                </span>
              </div>
            )}
            {entity.provenance?.sourceFile && (
              <div className="provenance-item">
                <span className="provenance-label">Source File</span>
                <span className="provenance-value">{entity.provenance.sourceFile}</span>
              </div>
            )}
            {entity.attributes?.source_document && (
              <div className="provenance-item">
                <span className="provenance-label">Source Document</span>
                <span className="provenance-value">{entity.attributes.source_document}</span>
              </div>
            )}
          </div>
        </section>

        {/* Connections Section */}
        <section className="detail-section">
          <h3>🔗 Connections</h3>
          {entity.relationships?.length === 0 ? (
            <p className="no-data">No connections to other entities</p>
          ) : (
            <div className="relationships-list">
              {entity.relationships?.map((rel) => (
                <div key={rel.type} className="relationship-group">
                  <button
                    className={`relationship-header ${expandedRelTypes.has(rel.type) ? 'expanded' : ''}`}
                    onClick={() => toggleRelationship(rel.type)}
                  >
                    <span className="rel-type">{humanizeRelType(rel.type)}</span>
                    <span className="rel-counts">
                      {rel.outgoing > 0 && <span className="outgoing">{rel.outgoing} outgoing</span>}
                      {rel.incoming > 0 && <span className="incoming">{rel.incoming} incoming</span>}
                    </span>
                    <span className="expand-icon">{expandedRelTypes.has(rel.type) ? '▼' : '▶'}</span>
                  </button>
                  
                  {expandedRelTypes.has(rel.type) && (
                    <div className="relationship-details">
                      {loadingRels[rel.type] ? (
                        <div className="rel-loading">Loading...</div>
                      ) : relationshipDetails[rel.type]?.length > 0 ? (
                        <ul className="rel-targets">
                          {relationshipDetails[rel.type].map((item, idx) => (
                            <li key={idx} className="rel-target-item">
                              <span className={`rel-direction ${item.direction}`}>
                                {item.direction === 'outgoing' ? '→' : '←'}
                              </span>
                              <span className="rel-target-class">{item.target?.class || 'Unknown'}</span>
                              <span className="rel-target-name">{item.target?.displayName || item.target?.entityId || 'Unknown'}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="no-data">No connected entities found</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Supporting Evidence Section */}
        <section className="detail-section">
          <h3>📄 Supporting Evidence</h3>
          {entity.evidence?.length === 0 ? (
            <p className="no-data">No supporting documents found</p>
          ) : (
            <div className="evidence-list">
              {entity.evidence?.map((ev, idx) => (
                <div key={idx} className="evidence-item">
                  <div className="evidence-header">
                    <span className="evidence-doc">{ev.documentTitle || ev.documentId || 'Document'}</span>
                    {ev.page && <span className="evidence-page">Page {ev.page}</span>}
                    {ev.confidence && (
                      <span className={`evidence-confidence ${ev.confidence >= 0.85 ? 'high' : ev.confidence >= 0.65 ? 'medium' : 'low'}`}
                            title={`Extraction confidence: ${Math.round(ev.confidence * 100)}%`}>
                        {confidenceLabel(ev.confidence)}
                      </span>
                    )}
                    {ev.method && <span className="evidence-method">{humanizeMethod(ev.method)}</span>}
                  </div>
                  {(ev.quote || ev.text) && (
                    <p className="evidence-text">"{ev.quote || ev.text}..."</p>
                  )}
                  {ev.sectionPath && (
                    <span className="evidence-section">Section: {ev.sectionPath}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Extracted Relationships Section (Assertions with Evidence) */}
        {entity.assertions?.length > 0 && (
          <section className="detail-section">
            <h3>🔍 Extracted Relationships</h3>
            <p className="section-description">
              These relationships were extracted from documents. Each one links back to the source text.
            </p>
            <div className="assertions-list">
              {entity.assertions.map((a, idx) => (
                <div key={idx} className="assertion-item">
                  <div className="assertion-header">
                    <span className="assertion-predicate">{humanizeRelType(a.predicate)}</span>
                    <span className="assertion-arrow">→</span>
                    <span className="assertion-target">
                      <span className="assertion-target-class">{a.targetClass}</span>
                      {' '}{a.targetName}
                    </span>
                    {a.confidence && (
                      <span className={`assertion-confidence ${a.confidence >= 0.85 ? 'high' : a.confidence >= 0.65 ? 'medium' : 'low'}`}
                            title={`Extraction confidence: ${Math.round(a.confidence * 100)}%`}>
                        {confidenceLabel(a.confidence)}
                      </span>
                    )}
                    {a.claimStatus && (
                      <span className={`assertion-status ${a.claimStatus.toLowerCase()}`}
                            title={a.claimStatus === 'FACT' ? 'This relationship has been verified' : 'This relationship has not been verified yet'}>
                        {claimStatusLabel(a.claimStatus)}
                      </span>
                    )}
                  </div>
                  {a.evidenceQuote && (
                    <p className="assertion-evidence">"{a.evidenceQuote}"</p>
                  )}
                  <div className="assertion-meta">
                    {a.method && <span>{humanizeMethod(a.method)}</span>}
                    {a.evidenceDoc && <span>From: {a.evidenceDoc}</span>}
                    {a.evidencePage && <span>Page {a.evidencePage}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default EntityDetail;
