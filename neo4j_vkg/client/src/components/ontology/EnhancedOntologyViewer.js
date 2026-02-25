/**
 * Enhanced Ontology Viewer Component
 * Modern, intuitive interface for viewing and editing ontologies
 */

import { useState, useEffect } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import CopyOntologyModal from './CopyOntologyModal';
import OntologyVersioningModal from './OntologyVersioningModal';
import './EnhancedOntologyViewer.css';

const EnhancedOntologyViewer = ({ ontology, onEdit, onCopyGlobal, onVersion }) => {
  console.log('[EnhancedOntologyViewer] RENDER - ontology:', ontology?.ontologyId, 'scope:', ontology?.scope);
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [activeTab, setActiveTab] = useState('overview');
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [showVersioningModal, setShowVersioningModal] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [propertySubTab, setPropertySubTab] = useState('object');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [structure, setStructure] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ttlContent, setTtlContent] = useState('');
  const [ttlLoading, setTtlLoading] = useState(false);

  useEffect(() => {
    setTtlContent(''); // Reset TTL when ontology changes
    if (ontology?.ontologyId || ontology?.iri) {
      loadStructure();
    } else {
      setLoading(false);
    }
  }, [ontology, currentWorkspace]);

  const loadStructure = async () => {
    const id = ontology?.ontologyId || ontology?.iri?.split(/[#/]/).pop();
    console.log('[Viewer] Loading structure for:', { id, ontologyId: ontology?.ontologyId, scope: ontology?.scope });
    
    if (!id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const tenantId = currentWorkspace?.tenant_id || 'default';
      const workspaceId = currentWorkspace?.workspace_id || 'default';
      const scope = ontology?.scope || 'all';
      const url = `/api/owl/structure/${encodeURIComponent(id)}?tenantId=${tenantId}&workspaceId=${workspaceId}&scope=${scope}`;
      console.log('[Viewer] Fetching:', url);
      const response = await fetch(url, { headers: getTenantHeaders() });
      console.log('[Viewer] Response status:', response.status);
      if (response.ok) {
        const data = await response.json();
        console.log('[Viewer] Got data:', { classes: data.classes?.length, properties: data.properties?.length });
        setStructure(data);
      } else {
        console.error('[Viewer] Failed:', await response.text());
        setStructure({ classes: [], properties: [], relationships: [] });
      }
    } finally {
      setLoading(false);
    }
  };

  const loadTtl = async () => {
    const id = ontology?.ontologyId || ontology?.iri?.split(/[#/]/).pop();
    if (!id) return;
    
    setTtlLoading(true);
    try {
      const tenantId = currentWorkspace?.tenant_id || 'default';
      const workspaceId = currentWorkspace?.workspace_id || 'default';
      const scope = ontology?.scope || 'global';
      const response = await fetch(
        `/api/owl/export?ontologyId=${encodeURIComponent(id)}&tenantId=${tenantId}&workspaceId=${workspaceId}&scope=${scope}`,
        { headers: getTenantHeaders() }
      );
      if (response.ok) {
        const text = await response.text();
        setTtlContent(text || '# Empty ontology');
      } else {
        setTtlContent('# Failed to load TTL content');
      }
    } finally {
      setTtlLoading(false);
    }
  };

  const filteredClasses = structure?.classes?.filter(cls => 
    !searchTerm || (
      cls.label?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cls.comment?.toLowerCase().includes(searchTerm.toLowerCase())
    )
  ) || [];

  const handleCopyToWorkspace = async ({ globalOntologyId, workspaceName, customOntologyId }) => {
    try {
      const response = await fetch('/api/owl/copy-global', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        },
        body: JSON.stringify({
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          globalOntologyId,
          workspaceName,
          customOntologyId
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || data.error || 'Failed to copy ontology');
      }

      // Call parent callback if provided and wait for it
      if (onCopyGlobal) {
        await onCopyGlobal();
      }
    } catch (error) {
      throw error;
    }
  };

  const renderOverview = () => (
    <div className="eov-overview">
      <div className="eov-stats-grid">
        <div className="eov-stat-card">
          <div className="eov-stat-icon">🏷️</div>
          <div className="eov-stat-content">
            <div className="eov-stat-number">{structure?.classes?.length || 0}</div>
            <div className="eov-stat-label">Classes</div>
          </div>
        </div>
        
        <div className="eov-stat-card">
          <div className="eov-stat-icon">🔗</div>
          <div className="eov-stat-content">
            <div className="eov-stat-number">{structure?.properties?.filter(p => p.type === 'objectProperty').length || 0}</div>
            <div className="eov-stat-label">Relationships</div>
          </div>
        </div>
        
        <div className="eov-stat-card">
          <div className="eov-stat-icon">📊</div>
          <div className="eov-stat-content">
            <div className="eov-stat-number">{structure?.properties?.filter(p => p.type === 'datatypeProperty').length || 0}</div>
            <div className="eov-stat-label">Data Fields</div>
          </div>
        </div>
        
        <div className="eov-stat-card">
          <div className="eov-stat-icon">📊</div>
          <div className="eov-stat-content">
            <div className="eov-stat-number">{ontology.scope === 'global' ? 'Global' : 'Workspace'}</div>
            <div className="eov-stat-label">Scope</div>
          </div>
        </div>
      </div>

      <div className="eov-description-card">
        <h4>Description</h4>
        <p>{ontology.description || 'No description available'}</p>
        
        <div className="eov-metadata">
          <div className="eov-meta-item">
            <span className="eov-meta-label">IRI:</span>
            <code className="eov-meta-value">{ontology.iri}</code>
          </div>
          {ontology.version && (
            <div className="eov-meta-item">
              <span className="eov-meta-label">Version:</span>
              <span className="eov-meta-value">{ontology.version}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderClasses = () => (
    <div className="eov-classes">
      <div className="eov-search-bar">
        <input
          type="text"
          placeholder="Search classes..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="eov-search-input"
        />
      </div>

      <div className="eov-classes-grid">
        {filteredClasses.map((cls, index) => (
          <div key={cls.iri || index} className="eov-class-card">
            <div className="eov-class-header">
              <div className="eov-class-icon">🏷️</div>
              <div className="eov-class-name">{cls.label || cls.iri?.split('#').pop()}</div>
            </div>
            
            {cls.comment && (
              <div className="eov-class-description">{cls.comment}</div>
            )}
            
            <div className="eov-class-meta">
              {cls.subClassOf && (
                <div className="eov-class-parent">
                  Extends: {cls.subClassOf}
                </div>
              )}
              
              <div className="eov-class-uri">
                <code>{cls.iri}</code>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderProperties = () => {
    const allProperties = structure?.properties || [];
    
    const objectProperties = allProperties.filter(prop => 
      prop.type === 'objectProperty' &&
      (searchTerm === '' || 
       prop.label?.toLowerCase().includes(searchTerm.toLowerCase()) ||
       prop.comment?.toLowerCase().includes(searchTerm.toLowerCase()) ||
       prop.iri?.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const dataProperties = allProperties.filter(prop => 
      prop.type === 'datatypeProperty' &&
      (searchTerm === '' || 
       prop.label?.toLowerCase().includes(searchTerm.toLowerCase()) ||
       prop.comment?.toLowerCase().includes(searchTerm.toLowerCase()) ||
       prop.iri?.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const currentProperties = propertySubTab === 'object' ? objectProperties : dataProperties;

    return (
      <div className="eov-properties">
        <div className="eov-search-bar">
          <input
            type="text"
            placeholder={`Search ${propertySubTab} properties...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="eov-search-input"
          />
        </div>

        <div className="eov-property-subtabs">
          <button 
            className={`eov-subtab ${propertySubTab === 'object' ? 'active' : ''}`}
            onClick={() => setPropertySubTab('object')}
          >
            🔗 Relationships ({objectProperties.length})
          </button>
          <button 
            className={`eov-subtab ${propertySubTab === 'data' ? 'active' : ''}`}
            onClick={() => setPropertySubTab('data')}
          >
            📊 Data Properties ({dataProperties.length})
          </button>
        </div>

        <div className="eov-properties-list">
          {currentProperties.length > 0 ? currentProperties.map((prop, index) => (
            <div 
              key={prop.iri || index}
              className={`eov-property-card ${selectedProperty?.iri === prop.iri ? 'selected' : ''}`}
              onClick={() => setSelectedProperty(selectedProperty?.iri === prop.iri ? null : prop)}
            >
              <div className="eov-property-header">
                <div className="eov-property-icon">
                  {prop.type === 'objectProperty' ? '🔗' : '📊'}
                </div>
                <div className="eov-property-name">{prop.label || prop.iri?.split('#').pop()}</div>
                <div className="eov-property-type-badge">
                  {prop.type === 'objectProperty' ? 'Relationship' : 'Data'}
                </div>
              </div>
              
              {prop.comment && (
                <div className="eov-property-description">{prop.comment}</div>
              )}
              
              <div className="eov-property-relationship">
                <span className="eov-domain">{prop.domain || 'Any'}</span>
                <span className="eov-arrow">→</span>
                <span className="eov-range">{prop.range || 'Any'}</span>
              </div>

              {selectedProperty?.iri === prop.iri && (
                <div className="eov-property-details-inline">
                  <div className="eov-details-grid">
                    <div className="eov-detail-item">
                      <span className="eov-detail-label">Type:</span>
                      <span className="eov-detail-value">
                        {prop.type === 'objectProperty' ? 'Relationship' : 'Data Property'}
                      </span>
                    </div>
                    <div className="eov-detail-item">
                      <span className="eov-detail-label">Domain:</span>
                      <span className="eov-detail-value">{prop.domain || 'Any'}</span>
                    </div>
                    <div className="eov-detail-item">
                      <span className="eov-detail-label">Range:</span>
                      <span className="eov-detail-value">{prop.range || 'Any'}</span>
                    </div>
                    <div className="eov-detail-item">
                      <span className="eov-detail-label">IRI:</span>
                      <code className="eov-detail-value">{prop.iri}</code>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )) : (
            <div className="eov-empty">
              No {propertySubTab === 'object' ? 'relationships' : 'data properties'} found
            </div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="eov-loading">
        <div className="eov-spinner"></div>
        <p>Loading ontology structure...</p>
      </div>
    );
  }

  return (
    <div className="enhanced-ontology-viewer">
      <div className="eov-header">
        <div className="eov-title-section">
          <div className="eov-icon">
            {ontology.scope === 'global' ? '🌐' : '📁'}
          </div>
          <div className="eov-title-content">
            <h2>{ontology.name || ontology.label}</h2>
            <p>{ontology.description || 'No description available'}</p>
          </div>
        </div>
        
        <div className="eov-actions">
          {ontology.scope === 'global' && onCopyGlobal && (
            <button 
              className="eov-btn eov-btn-secondary" 
              onClick={() => setShowCopyModal(true)}
            >
              📋 Copy to Workspace
            </button>
          )}
          
          {ontology.scope === 'workspace' && (
            <>
              <button 
                className="eov-btn eov-btn-secondary" 
                onClick={() => setShowVersioningModal(true)}
              >
                📜 Version History
              </button>
              {onEdit && <button className="eov-btn eov-btn-primary" onClick={onEdit}>
                ✏️ Edit
              </button>}
            </>
          )}
        </div>
      </div>

      <div className="eov-tabs">
        <button 
          className={`eov-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          📊 Overview
        </button>
        <button 
          className={`eov-tab ${activeTab === 'classes' ? 'active' : ''}`}
          onClick={() => setActiveTab('classes')}
        >
          🏷️ Classes ({structure?.classes?.length || 0})
        </button>
        <button 
          className={`eov-tab ${activeTab === 'properties' ? 'active' : ''}`}
          onClick={() => setActiveTab('properties')}
        >
          📋 Properties ({structure?.properties?.length || 0})
        </button>
        <button 
          className={`eov-tab ${activeTab === 'ttl' ? 'active' : ''}`}
          onClick={() => { setActiveTab('ttl'); loadTtl(); }}
        >
          📄 TTL Source
        </button>
      </div>

      <div className="eov-content">
        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'classes' && renderClasses()}
        {activeTab === 'properties' && renderProperties()}
        {activeTab === 'ttl' && (
          <div className="eov-ttl">
            {ttlLoading ? (
              <div className="eov-loading">
                <div className="eov-spinner"></div>
                <p>Loading TTL content...</p>
              </div>
            ) : (
              <pre className="eov-ttl-content">{ttlContent || '# No TTL content available'}</pre>
            )}
          </div>
        )}
      </div>

      {showCopyModal && (
        <CopyOntologyModal
          ontology={ontology}
          onClose={() => setShowCopyModal(false)}
          onCopy={handleCopyToWorkspace}
        />
      )}

      {showVersioningModal && (
        <OntologyVersioningModal
          ontology={ontology}
          onClose={() => setShowVersioningModal(false)}
          onVersionAction={(action, data) => {
            console.log('Version action:', action, data);
            if (onVersion) {
              onVersion(action, data);
            }
          }}
        />
      )}
    </div>
  );
};

export default EnhancedOntologyViewer;
