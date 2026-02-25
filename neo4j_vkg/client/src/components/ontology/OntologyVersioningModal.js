import React, { useState, useEffect } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import './OntologyVersioningModal.css';

const OntologyVersioningModal = ({ ontology, onClose, onVersionAction }) => {
  const { getTenantHeaders } = useTenant();
  const [activeTab, setActiveTab] = useState('history');
  const [versions, setVersions] = useState([]);
  const [branches, setBranches] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(null);

  // Form states
  const [newVersionForm, setNewVersionForm] = useState({ description: '', branch: 'main', tag: '' });
  const [newBranchForm, setNewBranchForm] = useState({ name: '', description: '', fromVersion: '' });
  const [newTagForm, setNewTagForm] = useState({ name: '', description: '', versionId: '' });
  const [compareVersions, setCompareVersions] = useState({ v1: '', v2: '' });

  useEffect(() => {
    if (ontology) {
      loadVersionData();
    }
  }, [ontology]);

  const loadVersionData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadVersionHistory(),
        loadBranches(),
        loadTags()
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadVersionHistory = async () => {
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/versions`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setVersions(data.versions || []);
        setCurrentVersion(data.current_version);
      }
    } catch (error) {
      console.error('Failed to load version history:', error);
    }
  };

  const loadBranches = async () => {
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/branches`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setBranches(data.branches || []);
      }
    } catch (error) {
      console.error('Failed to load branches:', error);
    }
  };

  const loadTags = async () => {
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/tags`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setTags(data.tags || []);
      }
    } catch (error) {
      console.error('Failed to load tags:', error);
    }
  };

  const handleCreateVersion = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(newVersionForm)
      });
      
      if (response.ok) {
        setNewVersionForm({ description: '', branch: 'main', tag: '' });
        await loadVersionData();
        onVersionAction?.('created');
      }
    } catch (error) {
      console.error('Failed to create version:', error);
    }
  };

  const handleRollback = async (versionId) => {
    if (!window.confirm('Are you sure you want to rollback to this version?')) return;
    
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ version_id: versionId, reason: 'Manual rollback from UI' })
      });
      
      if (response.ok) {
        await loadVersionData();
        onVersionAction?.('rollback', versionId);
      }
    } catch (error) {
      console.error('Failed to rollback:', error);
    }
  };

  const handleCreateBranch = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          branch_name: newBranchForm.name,
          description: newBranchForm.description,
          from_version: newBranchForm.fromVersion || null
        })
      });
      
      if (response.ok) {
        setNewBranchForm({ name: '', description: '', fromVersion: '' });
        await loadBranches();
        onVersionAction?.('branch_created');
      }
    } catch (error) {
      console.error('Failed to create branch:', error);
    }
  };

  const handleSwitchBranch = async (branchName) => {
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/branches/${branchName}/switch`, {
        method: 'POST',
        headers: getTenantHeaders()
      });
      
      if (response.ok) {
        await loadVersionData();
        onVersionAction?.('branch_switched', branchName);
      }
    } catch (error) {
      console.error('Failed to switch branch:', error);
    }
  };

  const handleCreateTag = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`/api/ontology-versions/${ontology.ontologyId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tag_name: newTagForm.name,
          description: newTagForm.description,
          version_id: newTagForm.versionId || null
        })
      });
      
      if (response.ok) {
        setNewTagForm({ name: '', description: '', versionId: '' });
        await loadTags();
        onVersionAction?.('tag_created');
      }
    } catch (error) {
      console.error('Failed to create tag:', error);
    }
  };

  const handleCompare = async () => {
    if (!compareVersions.v1 || !compareVersions.v2) return;
    
    try {
      const response = await fetch(
        `/api/ontology-versions/${ontology.ontologyId}/compare?v1=${compareVersions.v1}&v2=${compareVersions.v2}`,
        { headers: getTenantHeaders() }
      );
      
      if (response.ok) {
        const data = await response.json();
        onVersionAction?.('compare', data);
      }
    } catch (error) {
      console.error('Failed to compare versions:', error);
    }
  };

  const renderVersionHistory = () => (
    <div className="version-history">
      <div className="version-actions">
        <form onSubmit={handleCreateVersion} className="create-version-form">
          <input
            type="text"
            placeholder="Version description"
            value={newVersionForm.description}
            onChange={(e) => setNewVersionForm({...newVersionForm, description: e.target.value})}
            required
          />
          <select
            value={newVersionForm.branch}
            onChange={(e) => setNewVersionForm({...newVersionForm, branch: e.target.value})}
          >
            <option value="main">main</option>
            {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
          <input
            type="text"
            placeholder="Optional tag name"
            value={newVersionForm.tag}
            onChange={(e) => setNewVersionForm({...newVersionForm, tag: e.target.value})}
          />
          <button type="submit">Create Version</button>
        </form>
      </div>

      <div className="versions-list">
        {versions.map(version => (
          <div key={version.version_id} className={`version-item ${version.version_id === currentVersion ? 'current' : ''}`}>
            <div className="version-header">
              <span className="version-id">{version.version_id}</span>
              {version.version_id === currentVersion && <span className="current-badge">CURRENT</span>}
              <span className="version-branch">#{version.branch}</span>
            </div>
            <div className="version-meta">
              <div className="version-description">{version.description || 'No description'}</div>
              <div className="version-stats">
                {version.class_count} classes • {version.property_count} properties
              </div>
              <div className="version-info">
                Created by {version.created_by} on {new Date(version.created_at).toLocaleString()}
              </div>
            </div>
            <div className="version-actions">
              {version.version_id !== currentVersion && (
                <button onClick={() => handleRollback(version.version_id)} className="rollback-btn">
                  Rollback
                </button>
              )}
              <button onClick={() => setCompareVersions({...compareVersions, v1: version.version_id})}>
                Compare
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderBranches = () => (
    <div className="branches-section">
      <form onSubmit={handleCreateBranch} className="create-branch-form">
        <input
          type="text"
          placeholder="Branch name"
          value={newBranchForm.name}
          onChange={(e) => setNewBranchForm({...newBranchForm, name: e.target.value})}
          required
        />
        <input
          type="text"
          placeholder="Description"
          value={newBranchForm.description}
          onChange={(e) => setNewBranchForm({...newBranchForm, description: e.target.value})}
        />
        <select
          value={newBranchForm.fromVersion}
          onChange={(e) => setNewBranchForm({...newBranchForm, fromVersion: e.target.value})}
        >
          <option value="">From current version</option>
          {versions.map(v => <option key={v.version_id} value={v.version_id}>{v.version_id}</option>)}
        </select>
        <button type="submit">Create Branch</button>
      </form>

      <div className="branches-list">
        {branches.map(branch => (
          <div key={branch.name} className="branch-item">
            <div className="branch-header">
              <span className="branch-name">#{branch.name}</span>
              <span className="branch-version">{branch.current_version}</span>
            </div>
            <div className="branch-meta">
              Last updated: {new Date(branch.last_updated).toLocaleString()}
            </div>
            <div className="branch-actions">
              <button onClick={() => handleSwitchBranch(branch.name)}>Switch</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderTags = () => (
    <div className="tags-section">
      <form onSubmit={handleCreateTag} className="create-tag-form">
        <input
          type="text"
          placeholder="Tag name"
          value={newTagForm.name}
          onChange={(e) => setNewTagForm({...newTagForm, name: e.target.value})}
          required
        />
        <input
          type="text"
          placeholder="Description"
          value={newTagForm.description}
          onChange={(e) => setNewTagForm({...newTagForm, description: e.target.value})}
        />
        <select
          value={newTagForm.versionId}
          onChange={(e) => setNewTagForm({...newTagForm, versionId: e.target.value})}
        >
          <option value="">Current version</option>
          {versions.map(v => <option key={v.version_id} value={v.version_id}>{v.version_id}</option>)}
        </select>
        <button type="submit">Create Tag</button>
      </form>

      <div className="tags-list">
        {tags.map(tag => (
          <div key={tag.name} className="tag-item">
            <div className="tag-header">
              <span className="tag-name">🏷️ {tag.name}</span>
              <span className="tag-version">{tag.version_id}</span>
            </div>
            <div className="tag-meta">
              {tag.description && <div className="tag-description">{tag.description}</div>}
              <div className="tag-info">
                Created by {tag.created_by} on {new Date(tag.created_at).toLocaleString()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderCompare = () => (
    <div className="compare-section">
      <div className="compare-form">
        <select
          value={compareVersions.v1}
          onChange={(e) => setCompareVersions({...compareVersions, v1: e.target.value})}
        >
          <option value="">Select first version</option>
          {versions.map(v => <option key={v.version_id} value={v.version_id}>{v.version_id}</option>)}
        </select>
        <select
          value={compareVersions.v2}
          onChange={(e) => setCompareVersions({...compareVersions, v2: e.target.value})}
        >
          <option value="">Select second version</option>
          {versions.map(v => <option key={v.version_id} value={v.version_id}>{v.version_id}</option>)}
        </select>
        <button onClick={handleCompare} disabled={!compareVersions.v1 || !compareVersions.v2}>
          Compare
        </button>
      </div>
    </div>
  );

  return (
    <div className="versioning-modal-overlay">
      <div className="versioning-modal">
        <div className="versioning-modal-header">
          <h3>Version Management - {ontology.name}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="versioning-tabs">
          <button 
            className={activeTab === 'history' ? 'active' : ''} 
            onClick={() => setActiveTab('history')}
          >
            History ({versions.length})
          </button>
          <button 
            className={activeTab === 'branches' ? 'active' : ''} 
            onClick={() => setActiveTab('branches')}
          >
            Branches ({branches.length})
          </button>
          <button 
            className={activeTab === 'tags' ? 'active' : ''} 
            onClick={() => setActiveTab('tags')}
          >
            Tags ({tags.length})
          </button>
          <button 
            className={activeTab === 'compare' ? 'active' : ''} 
            onClick={() => setActiveTab('compare')}
          >
            Compare
          </button>
        </div>

        <div className="versioning-content">
          {loading ? (
            <div className="loading">Loading version data...</div>
          ) : (
            <>
              {activeTab === 'history' && renderVersionHistory()}
              {activeTab === 'branches' && renderBranches()}
              {activeTab === 'tags' && renderTags()}
              {activeTab === 'compare' && renderCompare()}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default OntologyVersioningModal;
