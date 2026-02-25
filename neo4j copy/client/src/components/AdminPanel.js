import { useState, useEffect, useCallback } from 'react';
import './AdminPanel.css';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import DatabaseManager from './DatabaseManager';
import DataSourcesManager from './DataSourcesManager';
import SyncStatus from './SyncStatus';
import SystemStatus from './SystemStatus';

const API_BASE_URL = '/api';

// Role definitions matching server/config/roles.js
const ROLE_DEFINITIONS = [
  { id: 'viewer',  name: 'Viewer',  description: 'Read-only access to dashboards, queries, chat',
    permissions: ['dashboard:view','query:execute','chat:use','documents:read','entities:read','ontology:read','graph:read','stats:view'] },
  { id: 'member',  name: 'Member',  description: 'Upload docs, run extractions, contribute content',
    permissions: ['documents:write','documents:delete','extraction:run','chat:delete','datasource:manage'] },
  { id: 'manager', name: 'Manager', description: 'Manage ontologies, clear data, organize workspace',
    permissions: ['ontology:manage','data:clear','folders:manage','identity:manage','sync:trigger','schema:manage'] },
  { id: 'admin',   name: 'Admin',   description: 'Full access to everything',
    permissions: ['admin:users','admin:settings','admin:llm','workspace:create','workspace:delete','tenant:manage','purge'] },
];

function AdminPanel() {
  const [roles, setRoles] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState('global'); // 'global' | 'workspace'
  const [activeTab, setActiveTab] = useState('system-status');
  const { isAdmin, isManager } = usePermissions();
  const { currentWorkspace } = useTenant();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const fetchWithErrorHandling = async (url) => {
        const response = await fetch(url);
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error('Server returned non-JSON response. Make sure the server is running.');
        }
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        return response.json();
      };

      const [rolesRes, auditRes] = await Promise.allSettled([
        fetchWithErrorHandling(`${API_BASE_URL}/enterprise/rbac/roles`),
        fetchWithErrorHandling(`${API_BASE_URL}/enterprise/rbac/audit?limit=200`)
      ]);

      if (rolesRes.status === 'fulfilled') {
        setRoles(Array.isArray(rolesRes.value) ? rolesRes.value : []);
      }

      if (auditRes.status === 'fulfilled') {
        setAuditLog(Array.isArray(auditRes.value) ? auditRes.value : []);
      }
    } catch (error) {
      console.error('Error loading admin data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="admin-panel">
        <div className="ap-loading">
          <div className="loading-spinner"></div>
          <p>Loading administration data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-panel">
      <div className="ap-header">
        <div className="ap-title">
          <h2>⚙️ Administration</h2>
          <p>System overview, access control, and activity monitoring</p>
        </div>
        <div className="ap-actions">
          <button className="ap-btn secondary" onClick={loadData}>
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Top-level section toggle: Global vs Workspace */}
      <div className="ap-section-toggle">
        <button
          className={`ap-section-btn ${section === 'global' ? 'active' : ''}`}
          onClick={() => { setSection('global'); setActiveTab('system-status'); }}
        >
          🌍 Global Settings
        </button>
        <button
          className={`ap-section-btn ${section === 'workspace' ? 'active' : ''}`}
          onClick={() => { setSection('workspace'); setActiveTab('datasources'); }}
        >
          📂 Workspace Settings
          {currentWorkspace?.name && (
            <span className="ap-section-ws-badge">{currentWorkspace.name}</span>
          )}
        </button>
      </div>

      {/* Sub-tabs for the active section */}
      {section === 'global' && (
        <div className="ap-tabs">
          <button className={`ap-tab ${activeTab === 'system-status' ? 'active' : ''}`} onClick={() => setActiveTab('system-status')}>
            📡 System Status
          </button>
          {isAdmin && (
            <button className={`ap-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
              👥 Users
            </button>
          )}
          {isAdmin && (
            <button className={`ap-tab ${activeTab === 'tenants' ? 'active' : ''}`} onClick={() => setActiveTab('tenants')}>
              🏢 Tenants
            </button>
          )}
          <button className={`ap-tab ${activeTab === 'roles' ? 'active' : ''}`} onClick={() => setActiveTab('roles')}>
            🔐 Roles
          </button>
          <button className={`ap-tab ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>
            📋 Audit Log
          </button>
          {isManager && (
            <button className={`ap-tab ${activeTab === 'llm-monitor' ? 'active' : ''}`} onClick={() => setActiveTab('llm-monitor')}>
              🧠 LLM Monitor
            </button>
          )}
        </div>
      )}

      {section === 'workspace' && (
        <div className="ap-tabs">
          {isManager && (
            <button className={`ap-tab ${activeTab === 'databases' ? 'active' : ''}`} onClick={() => setActiveTab('databases')}>
              🗄️ Databases
            </button>
          )}
          {isManager && (
            <button className={`ap-tab ${activeTab === 'datasources' ? 'active' : ''}`} onClick={() => setActiveTab('datasources')}>
              🌐 Federated Data Sources
            </button>
          )}
          <button className={`ap-tab ${activeTab === 'sync' ? 'active' : ''}`} onClick={() => setActiveTab('sync')}>
            🔄 Sync
          </button>
        </div>
      )}

      {/* Tab Content */}
      <div className="ap-content">
        {/* Global tabs */}
        {activeTab === 'system-status' && section === 'global' && <SystemStatus />}
        {activeTab === 'users' && section === 'global' && isAdmin && <UserManagement />}
        {activeTab === 'tenants' && section === 'global' && isAdmin && <TenantManagement />}

        {activeTab === 'roles' && section === 'global' && (
          <div className="ap-roles">
            <div className="roles-header">
              <h4>Role Hierarchy</h4>
              <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>Roles are defined in code (server/config/roles.js). Each role inherits all permissions from lower roles.</p>
            </div>
            <div className="roles-grid">
              {ROLE_DEFINITIONS.map((role, idx) => {
                const cumulative = ROLE_DEFINITIONS.slice(0, idx + 1).flatMap(r => r.permissions);
                return (
                  <div key={role.id} className="role-card">
                    <div className="role-header">
                      <span className="role-name">{role.name}</span>
                      <span style={{ fontSize: 11, color: '#888' }}>{cumulative.length} permissions</span>
                    </div>
                    <p className="role-desc">{role.description}</p>
                    <div className="role-permissions">
                      {role.permissions.map((perm, i) => (
                        <span key={i} className="perm-tag">{perm}</span>
                      ))}
                      {idx > 0 && (
                        <span className="perm-more" title={`Inherits from ${ROLE_DEFINITIONS.slice(0, idx).map(r => r.name).join(', ')}`}>
                          + inherits {ROLE_DEFINITIONS.slice(0, idx).flatMap(r => r.permissions).length} from below
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'audit' && section === 'global' && <AuditLogTab auditLog={auditLog} onRefresh={loadData} />}
        {activeTab === 'llm-monitor' && section === 'global' && isManager && <LLMMonitor />}

        {/* Workspace tabs */}
        {activeTab === 'databases' && section === 'workspace' && isManager && <DatabaseManager />}
        {activeTab === 'datasources' && section === 'workspace' && isManager && (
          <div className="ap-datasources">
            <DataSourcesManager />
          </div>
        )}

        {activeTab === 'sync' && section === 'workspace' && (
          <div className="ap-sync">
            <SyncStatus />
          </div>
        )}
      </div>
    </div>
  );
}

// Audit Log Tab with filtering
function AuditLogTab({ auditLog, onRefresh }) {
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedLog, setSelectedLog] = useState(null);

  const filtered = auditLog.filter(log => {
    if (statusFilter === 'success' && !log.success) return false;
    if (statusFilter === 'failed' && log.success) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return (
        (log.userId || '').toLowerCase().includes(q) ||
        (log.action || '').toLowerCase().includes(q) ||
        (log.resource || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="ap-audit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0 }}>Activity Log</h4>
        <span style={{ fontSize: 12, color: '#888' }}>({filtered.length} of {auditLog.length} entries, 7-day retention)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Filter by user, action, resource..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12, borderRadius: 4, border: '1px solid #444', background: '#1e1e2e', color: '#ccc', width: 220 }}
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12, borderRadius: 4, border: '1px solid #444', background: '#1e1e2e', color: '#ccc' }}
          >
            <option value="all">All</option>
            <option value="success">✓ Success</option>
            <option value="failed">✗ Failed</option>
          </select>
          <button className="ap-btn secondary" onClick={onRefresh} style={{ padding: '4px 10px', fontSize: 12 }}>🔄</button>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="ap-empty">
          <span className="empty-icon">📋</span>
          <p>{auditLog.length === 0 ? 'No audit logs yet. Activity will appear here as users interact with the system.' : 'No entries match your filter.'}</p>
        </div>
      ) : (
        <div className="audit-table-container">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Status</th>
                <th>Duration</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log, i) => (
                <tr key={i} className={!log.success ? 'audit-row-failed' : ''}>
                  <td className="time-cell">{new Date(log.timestamp).toLocaleString()}</td>
                  <td>{log.userId || 'anonymous'}</td>
                  <td><span className="action-badge">{log.action}</span></td>
                  <td className="resource-cell">{log.resource || '-'}</td>
                  <td>
                    <span className={`status-badge ${log.success ? 'success' : 'failed'}`}>
                      {log.success ? '✓' : '✗'}{log.statusCode ? ` ${log.statusCode}` : ''}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: '#888' }}>{log.durationMs ? `${log.durationMs}ms` : '-'}</td>
                  <td>
                    <button
                      onClick={() => setSelectedLog(log)}
                      style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #555', background: '#2a2a3e', color: '#aaa', cursor: 'pointer' }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Details Modal */}
      {selectedLog && (
        <div className="audit-detail-overlay" onClick={() => setSelectedLog(null)}>
          <div className="audit-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="audit-detail-header">
              <h4>Activity Details</h4>
              <button className="audit-detail-close" onClick={() => setSelectedLog(null)}>✕</button>
            </div>
            <div className="audit-detail-grid">
              <span className="audit-detail-label">Timestamp</span>
              <span className="audit-detail-value">{new Date(selectedLog.timestamp).toLocaleString()}</span>
              
              <span className="audit-detail-label">User</span>
              <span className="audit-detail-value">{selectedLog.userId || 'anonymous'}</span>
              
              <span className="audit-detail-label">Action</span>
              <span className="audit-detail-value"><span className="action-badge">{selectedLog.action}</span></span>
              
              <span className="audit-detail-label">Resource</span>
              <span className="audit-detail-value resource">{selectedLog.resource || '-'}</span>
              
              <span className="audit-detail-label">Method</span>
              <span className="audit-detail-value">
                {selectedLog.method ? <span className={`method-badge method-${selectedLog.method?.toLowerCase()}`}>{selectedLog.method}</span> : '-'}
              </span>
              
              <span className="audit-detail-label">Status Code</span>
              <span className="audit-detail-value">
                {selectedLog.statusCode ? <span className={`status-code-badge ${selectedLog.statusCode < 400 ? 'ok' : 'err'}`}>{selectedLog.statusCode}</span> : '-'}
              </span>
              
              <span className="audit-detail-label">Success</span>
              <span className="audit-detail-value">
                <span className={`status-badge ${selectedLog.success ? 'success' : 'failed'}`}>
                  {selectedLog.success ? '✓ Yes' : '✗ No'}
                </span>
              </span>
              
              <span className="audit-detail-label">Duration</span>
              <span className="audit-detail-value">{selectedLog.durationMs ? `${selectedLog.durationMs}ms` : '-'}</span>
              
              <span className="audit-detail-label">IP Address</span>
              <span className="audit-detail-value">{selectedLog.ip || '-'}</span>
              
              <span className="audit-detail-label">Workspace</span>
              <span className="audit-detail-value">{selectedLog.workspaceId || '-'}</span>
            </div>
            {selectedLog.requestBody && (
              <div className="audit-detail-body-section">
                <div className="audit-detail-body-label">Request Body (Input)</div>
                <pre className="audit-detail-pre">{JSON.stringify(selectedLog.requestBody, null, 2)}</pre>
              </div>
            )}
            {selectedLog.responseBody && (
              <div className="audit-detail-body-section">
                <div className="audit-detail-body-label">Response Body (Output)</div>
                <pre className="audit-detail-pre">{JSON.stringify(selectedLog.responseBody, null, 2)}</pre>
              </div>
            )}
            {!selectedLog.requestBody && !selectedLog.responseBody && (
              <div className="audit-detail-empty">No request/response body captured for this activity.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// LLM Settings Component
function LLMMonitor() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/llm/status`);
      if (res.ok) setStatus(await res.json());
    } catch (e) {
      console.error('LLM status fetch failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    if (!autoRefresh) return;
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, [fetchStatus, autoRefresh]);

  const cancelQueued = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/llm/cancel-queued`, { method: 'POST' });
      const data = await res.json();
      alert(`🛑 Cancelled ${data.cancelled} queued requests`);
      fetchStatus();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  if (loading) return <div className="ap-loading-inline">Loading LLM status...</div>;

  return (
    <div className="llm-monitor">
      <div className="llm-monitor-header">
        <h4>🧠 LLM Request Monitor</h4>
        <label className="auto-refresh-toggle">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto-refresh (2s)
        </label>
      </div>

      {status && (
        <>
          <div className="llm-stats-row">
            <div className="llm-stat-card">
              <div className="llm-stat-label">Provider</div>
              <div className="llm-stat-value">{status.provider}</div>
            </div>
            <div className="llm-stat-card">
              <div className="llm-stat-label">Model</div>
              <div className="llm-stat-value" title={status.model}>{status.model?.split('/').pop()?.split(':')[0] || status.model}</div>
            </div>
            <div className={`llm-stat-card ${status.activeRequests >= status.maxConcurrent ? 'stat-warn' : ''}`}>
              <div className="llm-stat-label">Active</div>
              <div className="llm-stat-value">{status.activeRequests} / {status.maxConcurrent}</div>
            </div>
            <div className={`llm-stat-card ${status.queuedRequests > 0 ? 'stat-warn' : ''}`}>
              <div className="llm-stat-label">Queued</div>
              <div className="llm-stat-value">{status.queuedRequests}</div>
            </div>
          </div>

          {status.queuedRequests > 0 && (
            <div className="llm-actions">
              <button className="btn-cancel" onClick={cancelQueued}>
                🛑 Cancel {status.queuedRequests} Queued Request{status.queuedRequests > 1 ? 's' : ''}
              </button>
            </div>
          )}

          <div className="llm-requests-section">
            <h5>Recent Requests</h5>
            {status.recentRequests?.length > 0 ? (
              <table className="llm-requests-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Elapsed</th>
                    <th>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {[...status.recentRequests].reverse().map((req, i) => (
                    <tr key={req.id || i} className={`req-${req.status}`}>
                      <td>
                        <span className={`req-badge ${req.status}`}>
                          {req.status === 'active' ? '🟢 Active' :
                           req.status === 'done' ? '✅ Done' :
                           req.status === 'failed' ? '❌ Failed' :
                           req.status?.startsWith('retry') ? `🔄 ${req.status}` : req.status}
                        </span>
                      </td>
                      <td>{req.elapsed < 1000 ? `${req.elapsed}ms` : `${(req.elapsed / 1000).toFixed(1)}s`}</td>
                      <td className="req-preview">{req.preview || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="no-requests">No recent requests</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}



function TenantManagement() {
  const [tenants, setTenants] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  const [newWorkspace, setNewWorkspace] = useState({ name: '', description: '' });
  
  // Get the global tenant context refresh function
  const tenantContext = useTenant();

  const loadTenants = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/tenants`);
      if (response.ok) {
        const data = await response.json();
        // API returns { success: true, tenants: [...] }
        setTenants(Array.isArray(data) ? data : (data.tenants || []));
      }
    } catch (error) {
      console.error('Error loading tenants:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadWorkspaces = async (tenantId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/tenants/${tenantId}/workspaces`);
      if (response.ok) {
        const data = await response.json();
        // API returns { success: true, workspaces: [...] }
        setWorkspaces(Array.isArray(data) ? data : (data.workspaces || []));
      }
    } catch (error) {
      console.error('Error loading workspaces:', error);
      setWorkspaces([]);
    }
  };

  useEffect(() => {
    loadTenants();
  }, []);

  useEffect(() => {
    if (selectedTenant) {
      loadWorkspaces(selectedTenant.tenant_id);
    } else {
      setWorkspaces([]);
    }
  }, [selectedTenant]);

  const refreshAll = () => {
    loadTenants();
    // Also refresh the global tenant context
    if (tenantContext?.refresh) {
      tenantContext.refresh();
    }
  };

  const createTenant = async () => {
    if (!newTenantName.trim()) return;
    try {
      const response = await fetch(`${API_BASE_URL}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTenantName.trim() })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setNewTenantName('');
        setShowCreateTenant(false);
        refreshAll();
        alert('✅ Tenant created successfully');
      } else {
        alert(`Error: ${data.error || 'Failed to create tenant'}`);
      }
    } catch (error) {
      console.error('Create tenant error:', error);
      alert(`Error: ${error.message}`);
    }
  };

  const createWorkspace = async () => {
    if (!newWorkspace.name.trim() || !selectedTenant) return;
    try {
      const response = await fetch(`${API_BASE_URL}/tenants/${selectedTenant.tenant_id}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newWorkspace.name.trim(),
          description: newWorkspace.description
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setNewWorkspace({ name: '', description: '' });
        setShowCreateWorkspace(false);
        loadWorkspaces(selectedTenant.tenant_id);
        refreshAll();
        alert('✅ Workspace created successfully');
      } else {
        alert(`Error: ${data.error || 'Failed to create workspace'}`);
      }
    } catch (error) {
      console.error('Create workspace error:', error);
      alert(`Error: ${error.message}`);
    }
  };

  const deleteTenant = async (tenantId) => {
    const tenant = tenants.find(t => t.tenant_id === tenantId);
    
    // First try without cascade to check if it has content
    try {
      const response = await fetch(`${API_BASE_URL}/tenants/${tenantId}`, { method: 'DELETE' });
      const data = await response.json();
      
      if (response.ok && data.success) {
        if (selectedTenant?.tenant_id === tenantId) {
          setSelectedTenant(null);
        }
        refreshAll();
        alert('✅ Tenant deleted');
        return;
      }
      
      // If failed due to content, ask user if they want to force delete
      if (data.workspaceCount > 0 || data.folderCount > 0 || data.documentCount > 0) {
        const confirmMsg = `⚠️ Tenant "${tenant?.name}" contains:\n` +
          `• ${data.workspaceCount || 0} workspace(s)\n` +
          `• ${data.folderCount || 0} folder(s)\n` +
          `• ${data.documentCount || 0} document(s)\n\n` +
          `Delete everything? This cannot be undone.`;
        
        if (!window.confirm(confirmMsg)) return;
        
        // Force delete with cascade
        const cascadeResponse = await fetch(`${API_BASE_URL}/tenants/${tenantId}?cascade=true`, { method: 'DELETE' });
        if (cascadeResponse.ok) {
          if (selectedTenant?.tenant_id === tenantId) {
            setSelectedTenant(null);
          }
          refreshAll();
          alert('✅ Tenant and all contents deleted');
        } else {
          const cascadeData = await cascadeResponse.json();
          alert(`Error: ${cascadeData.error || 'Failed to delete tenant'}`);
        }
      } else {
        alert(`Error: ${data.error || 'Failed to delete tenant'}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  const deleteWorkspace = async (workspaceId) => {
    const workspace = workspaces.find(w => w.workspace_id === workspaceId);
    
    // First try without cascade to check if it has content
    try {
      const response = await fetch(`${API_BASE_URL}/tenants/${selectedTenant.tenant_id}/workspaces/${workspaceId}`, { method: 'DELETE' });
      const data = await response.json();
      
      if (response.ok && data.success) {
        loadWorkspaces(selectedTenant.tenant_id);
        refreshAll();
        alert('✅ Workspace deleted');
        return;
      }
      
      // If failed due to content, ask user if they want to force delete
      if (data.folderCount > 0 || data.documentCount > 0) {
        const confirmMsg = `⚠️ Workspace "${workspace?.name}" contains:\n` +
          `• ${data.folderCount || 0} folder(s)\n` +
          `• ${data.documentCount || 0} document(s)\n\n` +
          `Delete everything? This cannot be undone.`;
        
        if (!window.confirm(confirmMsg)) return;
        
        // Force delete with cascade
        const cascadeResponse = await fetch(`${API_BASE_URL}/tenants/${selectedTenant.tenant_id}/workspaces/${workspaceId}?cascade=true`, { method: 'DELETE' });
        if (cascadeResponse.ok) {
          loadWorkspaces(selectedTenant.tenant_id);
          refreshAll();
          alert('✅ Workspace and all contents deleted');
        } else {
          const cascadeData = await cascadeResponse.json();
          alert(`Error: ${cascadeData.error || 'Failed to delete workspace'}`);
        }
      } else {
        alert(`Error: ${data.error || 'Failed to delete workspace'}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  const runMigration = async () => {
    if (!window.confirm('Run migration to create default tenant/workspace and link orphaned data?')) return;
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/migration/run`, { method: 'POST' });
      const data = await response.json();
      if (response.ok) {
        alert(`✅ Migration complete!\n${JSON.stringify(data.results, null, 2)}`);
        loadTenants();
      } else {
        alert(`Error: ${data.error || 'Migration failed'}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  };

  if (loading) {
    return <div className="ap-loading-inline">Loading tenants...</div>;
  }

  return (
    <div className="tenant-management">
      <div className="tm-header">
        <h4>🏢 Tenant & Workspace Management</h4>
        <div className="tm-actions">
          <button className="ap-btn secondary" onClick={runMigration}>
            🔄 Run Migration
          </button>
          <button className="ap-btn primary" onClick={() => setShowCreateTenant(true)}>
            ➕ Create Tenant
          </button>
        </div>
      </div>

      <div className="tm-layout">
        {/* Tenants List */}
        <div className="tm-tenants">
          <h5>Tenants ({tenants.length})</h5>
          {tenants.length === 0 ? (
            <div className="tm-empty">
              <p>No tenants yet. Create one or run migration.</p>
            </div>
          ) : (
            <div className="tm-list">
              {tenants.map(tenant => (
                <div 
                  key={tenant.tenant_id} 
                  className={`tm-item ${selectedTenant?.tenant_id === tenant.tenant_id ? 'selected' : ''}`}
                  onClick={() => setSelectedTenant(tenant)}
                >
                  <div className="tm-item-info">
                    <span className="tm-item-name">{tenant.name}</span>
                    <span className="tm-item-meta">{tenant.workspaceCount || 0} workspaces</span>
                  </div>
                  <button 
                    className="tm-item-delete" 
                    onClick={(e) => { e.stopPropagation(); deleteTenant(tenant.tenant_id); }}
                    title="Delete tenant"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Workspaces List */}
        <div className="tm-workspaces">
          <div className="tm-ws-header">
            <h5>Workspaces {selectedTenant ? `in ${selectedTenant.name}` : ''}</h5>
            {selectedTenant && (
              <button className="ap-btn small primary" onClick={() => setShowCreateWorkspace(true)}>
                ➕ Add
              </button>
            )}
          </div>
          {!selectedTenant ? (
            <div className="tm-empty">
              <p>Select a tenant to view workspaces</p>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="tm-empty">
              <p>No workspaces in this tenant</p>
            </div>
          ) : (
            <div className="tm-list">
              {workspaces.map(ws => (
                <div key={ws.workspace_id} className="tm-item workspace">
                  <div className="tm-item-info">
                    <span className="tm-item-name">{ws.name}</span>
                    <span className="tm-item-meta">
                      {ws.documentCount || 0} docs • {ws.folderCount || 0} folders
                    </span>
                  </div>
                  <button 
                    className="tm-item-delete" 
                    onClick={() => deleteWorkspace(ws.workspace_id)}
                    title="Delete workspace"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create Tenant Modal */}
      {showCreateTenant && (
        <div className="ap-modal-overlay" onClick={() => setShowCreateTenant(false)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <div className="ap-modal-header">
              <h3>Create New Tenant</h3>
              <button className="ap-modal-close" onClick={() => setShowCreateTenant(false)}>×</button>
            </div>
            <div className="ap-modal-body">
              <div className="form-group">
                <label>Tenant Name *</label>
                <input 
                  type="text" 
                  value={newTenantName} 
                  onChange={e => setNewTenantName(e.target.value)} 
                  placeholder="e.g., Acme Corporation" 
                  autoFocus
                />
              </div>
            </div>
            <div className="ap-modal-footer">
              <button className="ap-btn secondary" onClick={() => setShowCreateTenant(false)}>Cancel</button>
              <button className="ap-btn primary" onClick={createTenant} disabled={!newTenantName.trim()}>
                Create Tenant
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Workspace Modal */}
      {showCreateWorkspace && (
        <div className="ap-modal-overlay" onClick={() => setShowCreateWorkspace(false)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <div className="ap-modal-header">
              <h3>Create New Workspace</h3>
              <button className="ap-modal-close" onClick={() => setShowCreateWorkspace(false)}>×</button>
            </div>
            <div className="ap-modal-body">
              <p style={{ marginBottom: '16px', opacity: 0.7 }}>in {selectedTenant?.name}</p>
              <div className="form-group">
                <label>Workspace Name *</label>
                <input 
                  type="text" 
                  value={newWorkspace.name} 
                  onChange={e => setNewWorkspace({...newWorkspace, name: e.target.value})} 
                  placeholder="e.g., Legal Documents" 
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newWorkspace.description} 
                  onChange={e => setNewWorkspace({...newWorkspace, description: e.target.value})} 
                  placeholder="Optional description..." 
                  rows={2}
                />
              </div>
              <p style={{ marginTop: '12px', fontSize: '0.8em', opacity: 0.6 }}>
                💡 Ontologies are assigned at the folder level, not workspace level.
              </p>
            </div>
            <div className="ap-modal-footer">
              <button className="ap-btn secondary" onClick={() => setShowCreateWorkspace(false)}>Cancel</button>
              <button className="ap-btn primary" onClick={createWorkspace} disabled={!newWorkspace.name.trim()}>
                Create Workspace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// User Management Component
function UserManagement() {
  const [users, setUsers] = useState([]);
  const [allWorkspaces, setAllWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'viewer', workspaces: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Roles: admin = full access, manager = manage ontologies/data/structure, member = read+write content, viewer = read-only
  const AUTH_ROLES = [
    { value: 'admin', label: 'Admin', desc: 'Full access to all workspaces and settings' },
    { value: 'manager', label: 'Manager', desc: 'Manage ontologies, clear data, organize structure' },
    { value: 'member', label: 'Member', desc: 'Upload docs, run extractions, contribute content' },
    { value: 'viewer', label: 'Viewer', desc: 'Read-only: dashboards, queries, chat' },
  ];

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/users`);
      if (res.ok) setUsers(await res.json());
    } catch (e) {
      console.error('Failed to load users:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const tenantsRes = await fetch(`${API_BASE_URL}/tenants`);
      if (!tenantsRes.ok) return;
      const tenantsData = await tenantsRes.json();
      const tenants = tenantsData.tenants || tenantsData || [];
      const ws = [];
      for (const t of tenants) {
        const wsRes = await fetch(`${API_BASE_URL}/tenants/${t.tenant_id}/workspaces`);
        if (wsRes.ok) {
          const wsData = await wsRes.json();
          const workspaces = wsData.workspaces || wsData || [];
          workspaces.forEach(w => ws.push({ ...w, tenantName: t.name || t.tenant_id }));
        }
      }
      setAllWorkspaces(ws);
    } catch (e) {
      console.error('Failed to load workspaces:', e);
    }
  }, []);

  useEffect(() => { loadUsers(); loadWorkspaces(); }, [loadUsers, loadWorkspaces]);

  const toggleWorkspace = (wsId) => {
    setForm(prev => ({
      ...prev,
      workspaces: prev.workspaces.includes(wsId)
        ? prev.workspaces.filter(id => id !== wsId)
        : [...prev.workspaces, wsId]
    }));
  };

  const handleCreate = async () => {
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setSaving(false); return; }
      setShowCreate(false);
      setForm({ email: '', password: '', name: '', role: 'viewer', workspaces: [] });
      loadUsers();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    setError('');
    setSaving(true);
    try {
      const body = { name: form.name, role: form.role, workspaces: form.workspaces };
      if (form.password) body.password = form.password;
      const res = await fetch(`${API_BASE_URL}/auth/users/${encodeURIComponent(editingUser)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setSaving(false); return; }
      setEditingUser(null);
      setForm({ email: '', password: '', name: '', role: 'viewer', workspaces: [] });
      loadUsers();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (email) => {
    if (!window.confirm(`Delete user "${email}"?`)) return;
    try {
      const res = await fetch(`${API_BASE_URL}/auth/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
      if (res.ok) loadUsers();
      else {
        const data = await res.json();
        alert(data.error || 'Failed to delete user');
      }
    } catch (e) {
      alert(e.message);
    }
  };

  const openEdit = (user) => {
    setEditingUser(user.email);
    setForm({ email: user.email, password: '', name: user.name, role: user.role, workspaces: user.workspaces || [] });
    setError('');
  };

  const roleBadgeColor = (role) => {
    switch (role) {
      case 'admin': return '#DC2626';
      case 'manager': return '#D97706';
      case 'member': return '#2563EB';
      case 'viewer': return '#6B7280';
      default: return '#6B7280';
    }
  };

  const formatWorkspaces = (ws) => {
    if (!ws || ws.length === 0) return '—';
    return ws.map(id => {
      const found = allWorkspaces.find(w => w.workspace_id === id);
      return found ? (found.name || id) : id;
    }).join(', ');
  };

  if (loading) return <div className="ap-loading"><div className="loading-spinner"></div><p>Loading users...</p></div>;

  return (
    <div className="ap-roles">
      <div className="roles-header">
        <h4>User Accounts ({users.length})</h4>
        <button className="ap-btn primary" onClick={() => { setShowCreate(true); setEditingUser(null); setForm({ email: '', password: '', name: '', role: 'viewer', workspaces: [] }); setError(''); }}>
          ➕ Add User
        </button>
      </div>

      {users.length === 0 ? (
        <div className="ap-empty">
          <span className="empty-icon">👥</span>
          <h4>No users found</h4>
        </div>
      ) : (
        <div className="audit-table-container">
          <table className="audit-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Workspaces</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.email}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td><span style={{ background: roleBadgeColor(u.role), color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{u.role}</span></td>
                  <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.role === 'admin' ? 'All' : formatWorkspaces(u.workspaces)}</td>
                  <td className="time-cell">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    <button className="ap-btn secondary" style={{ marginRight: 4, padding: '4px 10px', fontSize: 12 }} onClick={() => openEdit(u)}>✏️ Edit</button>
                    <button className="ap-btn secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#DC2626' }} onClick={() => handleDelete(u.email)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Modal */}
      {(showCreate || editingUser) && (
        <div className="ap-modal-overlay" onClick={() => { setShowCreate(false); setEditingUser(null); }}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <div className="ap-modal-header">
              <h3>{editingUser ? 'Edit User' : 'Create User'}</h3>
              <button className="ap-modal-close" onClick={() => { setShowCreate(false); setEditingUser(null); }}>×</button>
            </div>
            <div className="ap-modal-body">
              {error && <div style={{ background: '#FEF2F2', color: '#DC2626', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{error}</div>}
              {!editingUser && (
                <div className="form-group">
                  <label>Email *</label>
                  <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="user@example.com" />
                </div>
              )}
              <div className="form-group">
                <label>Name</label>
                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Display name" />
              </div>
              <div className="form-group">
                <label>{editingUser ? 'New Password (leave blank to keep)' : 'Password *'}</label>
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Min 8 chars, upper+lower+number+special" autoComplete="new-password" />
              </div>
              <div className="form-group">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 14, width: '100%' }}>
                  {AUTH_ROLES.map(r => <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>)}
                </select>
              </div>
              {form.role !== 'admin' && (
                <div className="form-group">
                  <label>Workspace Access</label>
                  <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 8px' }}>Select which workspaces this user can access. If none selected, user can access all workspaces.</p>
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #E5E7EB', borderRadius: 6, padding: 8 }}>
                    {allWorkspaces.length === 0 ? (
                      <p style={{ fontSize: 13, color: '#9CA3AF' }}>No workspaces found</p>
                    ) : (
                      allWorkspaces.map(ws => (
                        <label key={ws.workspace_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={form.workspaces.includes(ws.workspace_id)}
                            onChange={() => toggleWorkspace(ws.workspace_id)}
                          />
                          <span>{ws.name || ws.workspace_id}</span>
                          <span style={{ fontSize: 11, color: '#9CA3AF' }}>({ws.tenantName})</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="ap-modal-footer">
              <button className="ap-btn secondary" onClick={() => { setShowCreate(false); setEditingUser(null); }}>Cancel</button>
              <button className="ap-btn primary" onClick={editingUser ? handleUpdate : handleCreate} disabled={saving || (!editingUser && (!form.email || !form.password))}>
                {saving ? '⏳ Saving...' : editingUser ? 'Update User' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
