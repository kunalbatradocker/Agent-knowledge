/**
 * OntologyImporter Component
 * Import TTL ontology files into GraphDB
 */

import { useState } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import './OntologyImporter.css';

const OntologyImporter = ({ onClose, onImportComplete }) => {
  const { currentWorkspace, currentTenant, getTenantHeaders } = useTenant();
  const [file, setFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [applyReasoning, setApplyReasoning] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.ttl')) {
        setError('Please select a .ttl (Turtle) file');
        setFile(null);
        return;
      }
      setFile(selectedFile);
      setError(null);
      setSuccess(null);
    }
  };

  const handleImport = async () => {
    if (!file) {
      setError('Please select a file');
      return;
    }

    if (!currentWorkspace?.workspace_id) {
      setError('Please select a workspace first');
      return;
    }

    setImporting(true);
    setError(null);
    setSuccess(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('tenantId', currentTenant?.tenant_id || 'default');
      formData.append('workspaceId', currentWorkspace.workspace_id);
      formData.append('replaceExisting', replaceExisting);
      formData.append('applyReasoning', applyReasoning);

      const response = await fetch('/api/owl/import', {
        method: 'POST',
        headers: getTenantHeaders(),
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Import failed');
      }

      const result = await response.json();
      
      setSuccess(`✅ Successfully imported ontology! 
        ${result.stats.classes} classes, 
        ${result.stats.objectProperties} object properties, 
        ${result.stats.dataProperties} data properties`);
      
      setFile(null);
      
      if (onImportComplete) {
        setTimeout(() => {
          onImportComplete(result);
        }, 1500);
      }

    } catch (err) {
      console.error('Import error:', err);
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const predefinedOntologies = [
    { name: 'Resume', file: 'resume.ttl', description: 'Resume/CV ontology with 11 classes' },
    { name: 'Legal Contract', file: 'legal-contract.ttl', description: 'Legal contracts with 9 classes' },
    { name: 'Banking', file: 'banking.ttl', description: 'Banking operations with 7 classes' },
    { name: 'AML', file: 'aml.ttl', description: 'Anti-Money Laundering with 9 classes' }
  ];

  const importPredefined = async (ontologyFile) => {
    setImporting(true);
    setError(null);
    setSuccess(null);

    try {
      // Fetch the TTL file from server
      const fileResponse = await fetch(`/ontologies/${ontologyFile}`);
      if (!fileResponse.ok) {
        throw new Error('Failed to fetch ontology file');
      }

      const turtleContent = await fileResponse.text();

      const response = await fetch('/api/owl/import-text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        },
        body: JSON.stringify({
          tenantId: currentTenant?.tenant_id || 'default',
          workspaceId: currentWorkspace.workspace_id,
          turtle: turtleContent,
          replaceExisting,
          applyReasoning
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Import failed');
      }

      const result = await response.json();
      
      setSuccess(`✅ Successfully imported ${ontologyFile}! 
        ${result.stats.classes} classes, 
        ${result.stats.objectProperties} object properties, 
        ${result.stats.dataProperties} data properties`);
      
      if (onImportComplete) {
        setTimeout(() => {
          onImportComplete(result);
        }, 1500);
      }

    } catch (err) {
      console.error('Import error:', err);
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="oi-modal-overlay" onClick={onClose}>
      <div className="oi-modal" onClick={e => e.stopPropagation()}>
        <div className="oi-modal-header">
          <h3>📥 Import OWL Ontology</h3>
          <p className="oi-modal-subtitle">
            Import Turtle (.ttl) ontology files into GraphDB
          </p>
          <button className="oi-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="oi-modal-body">
          {/* Predefined Ontologies */}
          <div className="oi-section">
            <h4>Quick Import - Predefined Ontologies</h4>
            <div className="oi-predefined-grid">
              {predefinedOntologies.map(onto => (
                <div key={onto.file} className="oi-predefined-card">
                  <div className="oi-predefined-info">
                    <h5>{onto.name}</h5>
                    <p>{onto.description}</p>
                  </div>
                  <button
                    className="oi-predefined-btn"
                    onClick={() => importPredefined(onto.file)}
                    disabled={importing}
                  >
                    {importing ? '⏳' : '📥'} Import
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="oi-divider">
            <span>OR</span>
          </div>

          {/* Custom File Upload */}
          <div className="oi-section">
            <h4>Upload Custom TTL File</h4>
            
            <div className="oi-file-input-wrapper">
              <input
                type="file"
                accept=".ttl"
                onChange={handleFileChange}
                className="oi-file-input"
                id="ttl-file-input"
                disabled={importing}
              />
              <label htmlFor="ttl-file-input" className="oi-file-label">
                {file ? `📄 ${file.name}` : '📁 Choose TTL file...'}
              </label>
            </div>

            {file && (
              <div className="oi-file-info">
                <span className="oi-file-size">
                  Size: {(file.size / 1024).toFixed(1)} KB
                </span>
              </div>
            )}
          </div>

          {/* Options */}
          <div className="oi-section">
            <h4>Import Options</h4>
            
            <label className="oi-checkbox-label">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                disabled={importing}
              />
              <span>Replace existing ontologies in workspace</span>
            </label>

            <label className="oi-checkbox-label">
              <input
                type="checkbox"
                checked={applyReasoning}
                onChange={(e) => setApplyReasoning(e.target.checked)}
                disabled={importing}
              />
              <span>Apply OWL reasoning (automatic in GraphDB)</span>
            </label>
          </div>

          {/* Status Messages */}
          {error && (
            <div className="oi-message oi-error">
              <span className="oi-message-icon">⚠️</span>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="oi-message oi-success">
              <span className="oi-message-icon">✅</span>
              <span>{success}</span>
            </div>
          )}
        </div>

        <div className="oi-modal-footer">
          <button 
            className="btn btn-secondary" 
            onClick={onClose}
            disabled={importing}
          >
            Cancel
          </button>
          <button 
            className="btn btn-primary" 
            onClick={handleImport}
            disabled={!file || importing}
          >
            {importing ? '⏳ Importing...' : '📥 Import File'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OntologyImporter;
