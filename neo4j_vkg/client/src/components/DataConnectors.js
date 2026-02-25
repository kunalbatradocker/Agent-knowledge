import { useState, useEffect, useRef } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import './DataConnectors.css';

const API_BASE_URL = '/api';

function DataConnectors() {
  const { canUpload, canDelete, canManageOntology } = usePermissions();
  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newConnector, setNewConnector] = useState({ name: '', type: 'csv', connectionConfig: {}, mapping: {} });
  const fileInputRef = useRef(null);
  const [uploadStatus, setUploadStatus] = useState(null);

  useEffect(() => { loadConnectors(); }, []);

  const loadConnectors = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/connectors`);
      const data = await response.json();
      setConnectors(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error loading connectors:', error);
    } finally {
      setLoading(false);
    }
  };

  const createConnector = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConnector)
      });
      if (response.ok) {
        setShowCreate(false);
        setNewConnector({ name: '', type: 'csv', connectionConfig: {}, mapping: {} });
        loadConnectors();
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  const deleteConnector = async (id) => {
    if (!window.confirm('Delete this connector?')) return;
    try {
      await fetch(`${API_BASE_URL}/enterprise/connectors/${id}`, { method: 'DELETE' });
      loadConnectors();
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadStatus({ status: 'uploading', fileName: file.name });
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mapping', JSON.stringify({ entityType: 'Entity', fields: {} }));
    formData.append('dryRun', 'true');

    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/connectors/upload`, {
        method: 'POST',
        body: formData
      });
      const result = await response.json();
      setUploadStatus({ status: 'complete', fileName: file.name, result });
      loadConnectors();
    } catch (error) {
      setUploadStatus({ status: 'error', fileName: file.name, error: error.message });
    }
  };

  const connectorTypes = [
    { id: 'csv', name: 'CSV File', icon: '📊' },
    { id: 'json', name: 'JSON File', icon: '📋' },
    { id: 'api', name: 'REST API', icon: '🌐' },
    { id: 'database', name: 'Database', icon: '🗄️' },
  ];

  return (
    <div className="data-connectors">
      <div className="dc-header">
        <div className="dc-title">
          <h3>🔌 Data Connectors</h3>
          <p>Import data from various sources into your knowledge graph</p>
        </div>
        <div className="dc-actions">
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv,.json" style={{ display: 'none' }} />
          <button className="btn-enterprise secondary" onClick={() => fileInputRef.current?.click()} disabled={!canUpload}>
            📤 Quick Import
          </button>
          <button className="btn-enterprise" onClick={() => setShowCreate(true)} disabled={!canManageOntology}>
            ➕ New Connector
          </button>
        </div>
      </div>

      {/* Upload Status */}
      {uploadStatus && (
        <div className={`upload-status ${uploadStatus.status}`}>
          <span className="status-icon">
            {uploadStatus.status === 'uploading' && '⏳'}
            {uploadStatus.status === 'complete' && '✅'}
            {uploadStatus.status === 'error' && '❌'}
          </span>
          <span className="status-text">
            {uploadStatus.status === 'uploading' && `Uploading ${uploadStatus.fileName}...`}
            {uploadStatus.status === 'complete' && `Imported ${uploadStatus.result?.entitiesCreated || 0} entities from ${uploadStatus.fileName}`}
            {uploadStatus.status === 'error' && `Error: ${uploadStatus.error}`}
          </span>
          <button className="btn-close" onClick={() => setUploadStatus(null)}>×</button>
        </div>
      )}

      {/* Connector Types */}
      <div className="connector-types">
        <h4>Supported Sources</h4>
        <div className="types-grid">
          {connectorTypes.map(type => (
            <div key={type.id} className="type-card">
              <span className="type-icon">{type.icon}</span>
              <span className="type-name">{type.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Connectors List */}
      <div className="connectors-list">
        <h4>Configured Connectors ({connectors.length})</h4>
        {loading ? (
          <div className="loading-spinner">Loading connectors...</div>
        ) : connectors.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">🔌</span>
            <h4>No connectors configured</h4>
            <p>Create a connector to start importing data</p>
          </div>
        ) : (
          <div className="connectors-grid">
            {connectors.map(conn => (
              <div key={conn.id} className="connector-card">
                <div className="conn-header">
                  <span className="conn-icon">{connectorTypes.find(t => t.id === conn.type)?.icon || '📁'}</span>
                  <div className="conn-info">
                    <span className="conn-name">{conn.name}</span>
                    <span className="conn-type">{conn.type.toUpperCase()}</span>
                  </div>
                </div>
                <div className="conn-stats">
                  <span>Last sync: {conn.lastSync ? new Date(conn.lastSync).toLocaleDateString() : 'Never'}</span>
                </div>
                <div className="conn-actions">
                  <button className="btn-enterprise secondary" onClick={() => {}}>▶️ Run</button>
                  {canDelete && <button className="btn-enterprise danger" onClick={() => deleteConnector(conn.id)}>🗑️</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="modal-enterprise">
          <div className="modal-enterprise-content">
            <div className="modal-enterprise-header">
              <h3>Create Connector</h3>
              <button className="modal-enterprise-close" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <div className="modal-enterprise-body">
              <div className="form-group-enterprise">
                <label>Connector Name</label>
                <input type="text" value={newConnector.name} onChange={e => setNewConnector({...newConnector, name: e.target.value})} placeholder="My Data Source" />
              </div>
              <div className="form-group-enterprise">
                <label>Type</label>
                <select value={newConnector.type} onChange={e => setNewConnector({...newConnector, type: e.target.value})}>
                  {connectorTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {newConnector.type === 'csv' && (
                <div className="form-group-enterprise">
                  <label>File Path</label>
                  <input type="text" placeholder="/path/to/file.csv" onChange={e => setNewConnector({...newConnector, connectionConfig: { filePath: e.target.value }})} />
                </div>
              )}
            </div>
            <div className="modal-enterprise-footer">
              <button className="btn-enterprise secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn-enterprise" onClick={createConnector} disabled={!newConnector.name}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataConnectors;
