/**
 * OntologyLibrary Component
 * Shows global ontologies available for copying to workspace
 */

import { useState, useEffect } from 'react';
import './OntologyLibrary.css';

const OntologyLibrary = ({ isOpen, onClose, onCopyToWorkspace, getTenantHeaders, currentWorkspace }) => {
  const [globalOntologies, setGlobalOntologies] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchGlobalOntologies();
    }
  }, [isOpen]);

  const fetchGlobalOntologies = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        tenantId: currentWorkspace?.tenant_id || 'default',
        workspaceId: currentWorkspace?.workspace_id || 'default',
        scope: 'global'
      });
      
      const response = await fetch(`/api/owl/list?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      
      if (response.ok) {
        const data = await response.json();
        setGlobalOntologies(data.ontologies || []);
      }
    } catch (error) {
      console.error('Failed to fetch global ontologies:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (ontology) => {
    // Prompt user for workspace name
    const workspaceName = prompt(`Enter a name for your workspace copy of "${ontology.label || ontology.ontologyId}":`);
    
    if (!workspaceName || !workspaceName.trim()) {
      return; // User cancelled or entered empty name
    }

    try {
      const response = await fetch('/api/owl/copy-global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          globalOntologyId: ontology.ontologyId,
          workspaceName: workspaceName.trim()
        })
      });

      if (response.ok) {
        const result = await response.json();
        alert(`✅ Copied "${ontology.label}" to workspace as "${workspaceName}" v${result.version}`);
        if (onCopyToWorkspace) {
          await onCopyToWorkspace(); // Wait for refresh to complete
        }
        onClose();
      } else {
        const error = await response.json();
        alert(`❌ Failed to copy: ${error.message}`);
      }
    } catch (error) {
      console.error('Failed to copy ontology:', error);
      alert('❌ Failed to copy ontology');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="library-modal-overlay">
      <div className="library-modal">
        <div className="library-header">
          <h2>📚 Ontology Library</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="library-content">
          {loading ? (
            <div className="loading">Loading global ontologies...</div>
          ) : (
            <div className="library-grid">
              {globalOntologies.map(ont => (
                <div key={ont.ontologyId} className="library-card">
                  <div className="library-card-header">
                    <h3>{ont.label || ont.ontologyId}</h3>
                    <span className="version-badge">v{ont.versionInfo}</span>
                  </div>
                  
                  {ont.comment && (
                    <p className="library-description">{ont.comment}</p>
                  )}
                  
                  <div className="library-card-footer">
                    <span className="scope-badge global">Global</span>
                    <button 
                      className="copy-btn"
                      onClick={() => handleCopy(ont)}
                    >
                      Copy to Workspace
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {!loading && globalOntologies.length === 0 && (
            <div className="empty-library">
              <p>No global ontologies available</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OntologyLibrary;
