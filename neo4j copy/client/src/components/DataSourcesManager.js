/**
 * DataSourcesManager — UI for registering/managing data sources.
 * All data sources (Trino + direct DB connections) are workspace-scoped.
 * Trino is added as a source type via "Add Data Source" — not all tenants will have it.
 * Direct DB connections (PostgreSQL, MySQL, MongoDB, etc.) are also workspace-scoped.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './DataSourcesManager.css';

const DB_TYPES = [
  { id: 'trino', label: 'Trino', icon: '⚡' },
  { id: 'postgresql', label: 'PostgreSQL', icon: '🐘' },
  { id: 'mysql', label: 'MySQL', icon: '🐬' },
  { id: 'mariadb', label: 'MariaDB', icon: '🦭' },
  { id: 'clickhouse', label: 'ClickHouse', icon: '🏠' },
  { id: 'sqlserver', label: 'SQL Server', icon: '🪟' },
  { id: 'oracle', label: 'Oracle', icon: '🔶' },
  { id: 'mongodb', label: 'MongoDB', icon: '🍃' },
];

function DataSourcesManager() {
  const { currentTenant, currentWorkspace, getTenantHeaders } = useTenant();
  const [catalogs, setCatalogs] = useState([]);
  const [directConnections, setDirectConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [introspecting, setIntrospecting] = useState(null);
  const [schemaData, setSchemaData] = useState({});
  const [generatingOntology, setGeneratingOntology] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [ontologyPreview, setOntologyPreview] = useState(null);
  const [savingOntology, setSavingOntology] = useState(false);
  const [reviewTab, setReviewTab] = useState('mapping');

  // Trino connection state
  const [trinoConfig, setTrinoConfig] = useState(null);
  const [trinoExpanded, setTrinoExpanded] = useState(false);
  const [trinoShowSettings, setTrinoShowSettings] = useState(false);
  const [trinoTesting, setTrinoTesting] = useState(false);
  const [trinoSaving, setTrinoSaving] = useState(false);
  const [trinoForm, setTrinoForm] = useState({ url: '', user: 'trino', authType: 'none', password: '', jwtToken: '', tlsSkipVerify: false });

  // Direct DB connection state
  const [expandedDirect, setExpandedDirect] = useState({});
  const [editingDirect, setEditingDirect] = useState(null); // connectionId being edited
  const [directEditForm, setDirectEditForm] = useState({});

  // Add-form state
  const [form, setForm] = useState({
    name: '', type: 'trino', host: '', port: '', database: '', username: '', password: '',
    trinoUrl: '', trinoUser: 'trino', authType: 'none', trinoPassword: '', jwtToken: '', tlsSkipVerify: false
  });

  const tenantId = currentTenant?.tenant_id || 'default';
  const workspaceId = currentWorkspace?.workspace_id || 'default';
  const hasTrino = trinoConfig && trinoConfig.source === 'workspace';

  // ─── Load data ──────────────────────────────────────────────────

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trino/catalogs?tenantId=${tenantId}&workspaceId=${workspaceId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setCatalogs(data.catalogs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tenantId, workspaceId, getTenantHeaders]);

  const loadDirectConnections = useCallback(async () => {
    try {
      const res = await fetch(`/api/jdbc/connections?workspaceId=${workspaceId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setDirectConnections(data.connections || []);
    } catch (e) {
      console.error('Failed to load direct connections:', e);
    }
  }, [workspaceId, getTenantHeaders]);

  const loadTrinoConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/trino/connection?workspaceId=${workspaceId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setTrinoConfig(data);
      if (data.source === 'workspace') {
        setTrinoForm({
          url: data.url || '', user: data.user || 'trino',
          authType: data.authType || 'none',
          password: '', jwtToken: '',
          tlsSkipVerify: data.tlsSkipVerify || false
        });
      }
    } catch (e) {
      setTrinoConfig({ source: 'env' });
    }
  }, [workspaceId, getTenantHeaders]);

  useEffect(() => { loadCatalogs(); }, [loadCatalogs]);
  useEffect(() => { loadDirectConnections(); }, [loadDirectConnections]);
  useEffect(() => { loadTrinoConfig(); }, [loadTrinoConfig]);

  // ─── Trino connection handlers ──────────────────────────────────

  const handleTrinoTest = async (configToTest) => {
    setTrinoTesting(true);
    try {
      const payload = configToTest || trinoForm;
      const res = await fetch('/api/trino/connection/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      alert(data.connected ? `✅ Connected to Trino (${data.version})` : `❌ Connection failed: ${data.error}`);
      return data.connected;
    } catch (e) {
      alert(`❌ ${e.message}`);
      return false;
    } finally {
      setTrinoTesting(false);
    }
  };

  const handleTrinoSave = async () => {
    setTrinoSaving(true);
    try {
      const res = await fetch('/api/trino/connection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ ...trinoForm, workspaceId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      loadTrinoConfig();
      loadCatalogs();
    } catch (e) {
      alert(`❌ ${e.message}`);
    } finally {
      setTrinoSaving(false);
    }
  };

  const handleTrinoRemove = async () => {
    if (!window.confirm('Remove Trino connection for this workspace?')) return;
    try {
      await fetch(`/api/trino/connection?workspaceId=${workspaceId}`, {
        method: 'DELETE', headers: getTenantHeaders()
      });
      setTrinoExpanded(false);
      loadTrinoConfig();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  // ─── Direct DB connection handlers ──────────────────────────────

  const handleDirectTest = async (connectionId) => {
    setTestingId(connectionId);
    try {
      const res = await fetch(`/api/jdbc/connections/${connectionId}/test?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      const data = await res.json();
      alert(data.connected ? `✅ Connected (${data.version || data.type})` : `❌ Connection failed: ${data.error}`);
      if (data.connected) loadDirectConnections();
    } catch (e) {
      alert(`❌ ${e.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleDirectRemove = async (connectionId, name) => {
    if (!window.confirm(`Remove data source "${name}"?`)) return;
    try {
      await fetch(`/api/jdbc/connections/${connectionId}?workspaceId=${workspaceId}`, {
        method: 'DELETE', headers: getTenantHeaders()
      });
      loadDirectConnections();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const handleDirectEdit = (conn) => {
    setEditingDirect(conn.id);
    setDirectEditForm({
      name: conn.name, type: conn.type, host: conn.host,
      port: conn.port, database: conn.database, username: conn.username, password: ''
    });
  };

  const handleDirectEditSave = async (connectionId) => {
    try {
      const res = await fetch(`/api/jdbc/connections/${connectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ ...directEditForm, workspaceId })
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setEditingDirect(null);
      loadDirectConnections();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  // ─── Add Data Source (Trino or direct DB) ───────────────────────

  const handleAdd = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (form.type === 'trino') {
        const trinoPayload = {
          url: form.trinoUrl, user: form.trinoUser || 'trino',
          authType: form.authType || 'none',
          password: form.trinoPassword || '', jwtToken: form.jwtToken || '',
          tlsSkipVerify: form.tlsSkipVerify || false,
          workspaceId
        };
        const res = await fetch('/api/trino/connection', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify(trinoPayload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        loadTrinoConfig();
        loadCatalogs();
      } else {
        // Save as direct DB connection (workspace-scoped)
        const payload = {
          name: form.name, type: form.type, host: form.host,
          port: form.port || defaultPort(form.type),
          database: form.database, username: form.username, password: form.password,
          workspaceId
        };
        const res = await fetch('/api/jdbc/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add data source');
        loadDirectConnections();
      }
      setShowAddForm(false);
      resetForm();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setForm({
      name: '', type: 'trino', host: '', port: '', database: '', username: '', password: '',
      trinoUrl: '', trinoUser: 'trino', authType: 'none', trinoPassword: '', jwtToken: '', tlsSkipVerify: false
    });
  };

  // ─── Catalog handlers (Trino sub-catalogs) ─────────────────────

  const handleRemove = async (catalogName) => {
    if (!window.confirm(`Remove data source "${catalogName}"?`)) return;
    try {
      await fetch(`/api/trino/catalogs/${catalogName}?tenantId=${tenantId}&workspaceId=${workspaceId}`, {
        method: 'DELETE', headers: getTenantHeaders()
      });
      loadCatalogs();
    } catch (e) { setError(e.message); }
  };

  const handleTest = async (catalogName) => {
    setTestingId(catalogName);
    try {
      const res = await fetch(`/api/trino/catalogs/${catalogName}/test?tenantId=${tenantId}&workspaceId=${workspaceId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      alert(data.connected ? `✅ Connected to ${catalogName}` : `❌ Connection failed: ${data.error}`);
    } catch (e) { alert(`❌ ${e.message}`); }
    finally { setTestingId(null); }
  };

  const handleIntrospect = async (catalogName) => {
    setIntrospecting(catalogName);
    try {
      const res = await fetch(`/api/trino/catalogs/${catalogName}/introspect?tenantId=${tenantId}&workspaceId=${workspaceId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setSchemaData(prev => ({ ...prev, [catalogName]: data }));
    } catch (e) { setError(e.message); }
    finally { setIntrospecting(null); }
  };

  const handleGenerateOntology = async () => {
    if (!window.confirm('Generate VKG ontology from all registered data sources?')) return;
    setGeneratingOntology(true);
    setError(null);
    try {
      const res = await fetch('/api/vkg/ontology/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ tenantId, workspaceId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setOntologyPreview(data);
    } catch (e) { setError(e.message); }
    finally { setGeneratingOntology(false); }
  };

  const handleSaveOntology = async () => {
    if (!ontologyPreview?.turtle || !ontologyPreview.ontologyName?.trim()) return;
    setSavingOntology(true);
    setError(null);
    try {
      const res = await fetch('/api/vkg/ontology/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId, workspaceId,
          turtle: ontologyPreview.turtle,
          name: ontologyPreview.ontologyName.trim(),
          baseUri: ontologyPreview.baseUri || 'http://purplefabric.ai/vkg/'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      alert(`✅ Ontology "${ontologyPreview.ontologyName}" saved to GraphDB\nURI: ${data.graphIRI || 'N/A'}`);
      setOntologyPreview(null);
    } catch (e) { setError(e.message); }
    finally { setSavingOntology(false); }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await fetch('/api/trino/catalogs/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ tenantId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Discovery failed');
      if (data.new > 0) alert(`🔍 Discovered ${data.new} new catalog(s) from Trino (${data.total} total)`);
      else alert(`All ${data.total} Trino catalogs already synced.`);
      loadCatalogs();
    } catch (e) { setError(e.message); }
    finally { setDiscovering(false); }
  };

  const defaultPort = (type) => {
    const ports = { postgresql: '5432', mysql: '3306', mariadb: '3306', clickhouse: '8123', sqlserver: '1433', oracle: '1521', mongodb: '27017' };
    return ports[type] || '';
  };

  const totalSources = (hasTrino ? 1 : 0) + directConnections.length;

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <>
    <div className="dsm-container">
      <div className="dsm-header">
        <h2>🌐 Federated Data Sources</h2>
        <p className="dsm-subtitle">Connect external databases for virtual knowledge graph queries</p>
        <div className="dsm-header-actions">
          <button className="dsm-btn-primary" onClick={() => { setShowAddForm(!showAddForm); if (!showAddForm) resetForm(); }}>
            {showAddForm ? '✕ Cancel' : '+ Add Data Source'}
          </button>
          <button className="dsm-btn-secondary" onClick={handleGenerateOntology}
            disabled={generatingOntology || (catalogs.length === 0 && !hasTrino && directConnections.length === 0)}>
            {generatingOntology ? '⏳ Generating...' : '🧬 Generate VKG Ontology'}
          </button>
          <button className="dsm-btn-secondary" onClick={() => { loadCatalogs(); loadDirectConnections(); }} disabled={loading}>🔄</button>
        </div>
      </div>

      {error && <div className="dsm-error">❌ {error} <button onClick={() => setError(null)}>×</button></div>}

      {/* ── Add Data Source Form ── */}
      {showAddForm && (
        <form className="dsm-add-form" onSubmit={handleAdd}>
          <div className="dsm-form-row">
            {form.type !== 'trino' && (
              <div className="dsm-field">
                <label>Name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="my_postgres" required />
              </div>
            )}
            <div className="dsm-field">
              <label>Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value, port: defaultPort(e.target.value) }))}>
                {DB_TYPES.map(t => (
                  <option key={t.id} value={t.id}>{t.icon} {t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Trino-specific fields */}
          {form.type === 'trino' && (
            <>
              <div className="dsm-form-row">
                <div className="dsm-field" style={{ flex: 3 }}>
                  <label>Trino URL</label>
                  <input value={form.trinoUrl} onChange={e => setForm(f => ({ ...f, trinoUrl: e.target.value }))}
                    placeholder="https://trino.example.com:8443" required />
                </div>
                <div className="dsm-field" style={{ flex: 1 }}>
                  <label>User</label>
                  <input value={form.trinoUser} onChange={e => setForm(f => ({ ...f, trinoUser: e.target.value }))}
                    placeholder="trino" />
                </div>
                <div className="dsm-field" style={{ flex: 1 }}>
                  <label>Auth Type</label>
                  <select value={form.authType} onChange={e => setForm(f => ({ ...f, authType: e.target.value }))}>
                    <option value="none">None</option>
                    <option value="password">Password</option>
                    <option value="jwt">JWT Token</option>
                  </select>
                </div>
              </div>
              {form.authType === 'password' && (
                <div className="dsm-form-row">
                  <div className="dsm-field">
                    <label>Password</label>
                    <input type="password" value={form.trinoPassword}
                      onChange={e => setForm(f => ({ ...f, trinoPassword: e.target.value }))}
                      placeholder="Enter password" />
                  </div>
                </div>
              )}
              {form.authType === 'jwt' && (
                <div className="dsm-form-row">
                  <div className="dsm-field">
                    <label>JWT Token</label>
                    <textarea className="dsm-jwt-input" value={form.jwtToken}
                      onChange={e => setForm(f => ({ ...f, jwtToken: e.target.value }))}
                      placeholder="Paste JWT token" rows={3} />
                  </div>
                </div>
              )}
              <div className="dsm-form-row">
                <label className="dsm-checkbox-label">
                  <input type="checkbox" checked={form.tlsSkipVerify}
                    onChange={e => setForm(f => ({ ...f, tlsSkipVerify: e.target.checked }))} />
                  Skip TLS certificate verification (for self-signed certs)
                </label>
              </div>
            </>
          )}

          {/* Standard DB fields (non-Trino) */}
          {form.type !== 'trino' && (
            <>
              <div className="dsm-form-row">
                <div className="dsm-field dsm-field-wide">
                  <label>Host</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="db.example.com" required />
                </div>
                <div className="dsm-field dsm-field-narrow">
                  <label>Port</label>
                  <input value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} placeholder={defaultPort(form.type)} />
                </div>
                <div className="dsm-field">
                  <label>Database</label>
                  <input value={form.database} onChange={e => setForm(f => ({ ...f, database: e.target.value }))} placeholder="mydb" required />
                </div>
              </div>
              <div className="dsm-form-row">
                <div className="dsm-field">
                  <label>Username</label>
                  <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="user" required />
                </div>
                <div className="dsm-field">
                  <label>Password</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••" required />
                </div>
              </div>
            </>
          )}

          <div className="dsm-form-actions">
            <button type="submit" className="dsm-btn-primary" disabled={loading}>
              {loading ? '⏳ Adding...' : form.type === 'trino' ? '⚡ Connect Trino' : '✓ Add Data Source'}
            </button>
          </div>
        </form>
      )}

      {/* ── Data Source List ── */}
      <div className="dsm-catalog-list">

        {/* Trino card — only if configured */}
        {hasTrino && (
          <div className={`dsm-catalog-card dsm-trino-card ${trinoExpanded ? 'dsm-card-expanded' : ''}`}>
            <div className="dsm-catalog-header" onClick={() => setTrinoExpanded(!trinoExpanded)} style={{ cursor: 'pointer' }}>
              <span className="dsm-catalog-icon">⚡</span>
              <div className="dsm-catalog-info">
                <span className="dsm-catalog-name">
                  Trino Coordinator
                  <span className="dsm-trino-badge">workspace</span>
                </span>
                <span className="dsm-catalog-type">
                  {trinoConfig?.url} — user: {trinoConfig?.user || 'trino'}
                  {trinoConfig?.authType && trinoConfig.authType !== 'none' ? ` — auth: ${trinoConfig.authType}` : ''}
                  {catalogs.length > 0 ? ` — ${catalogs.length} catalog(s)` : ''}
                </span>
              </div>
              <div className="dsm-catalog-actions" onClick={e => e.stopPropagation()}>
                <button onClick={() => handleTrinoTest()} disabled={trinoTesting} title="Test connection">
                  {trinoTesting ? '⏳' : '🔌'} Test
                </button>
                <button onClick={() => setTrinoExpanded(!trinoExpanded)} title={trinoExpanded ? 'Collapse' : 'Expand'}>
                  {trinoExpanded ? '▲' : '▼'}
                </button>
                <button onClick={handleTrinoRemove} className="dsm-btn-danger" title="Remove Trino">🗑️</button>
              </div>
            </div>

            {trinoExpanded && (
              <div className="dsm-trino-expanded">
                <div className="dsm-trino-catalogs">
                  <div className="dsm-trino-catalogs-header">
                    <span className="dsm-trino-catalogs-title">Discovered Databases ({catalogs.length})</span>
                    <div className="dsm-trino-catalogs-actions">
                      <button className="dsm-btn-secondary dsm-btn-sm" onClick={handleDiscover} disabled={discovering}>
                        {discovering ? '⏳' : '🔍'} Discover
                      </button>
                      <button className="dsm-btn-secondary dsm-btn-sm" onClick={() => setTrinoShowSettings(!trinoShowSettings)}>
                        {trinoShowSettings ? '✕ Close Settings' : '⚙️ Connection Settings'}
                      </button>
                    </div>
                  </div>

                  {catalogs.length === 0 ? (
                    <p className="dsm-trino-catalogs-empty">No catalogs discovered yet. Click "Discover" to scan Trino.</p>
                  ) : (
                    <div className="dsm-trino-catalog-items">
                      {catalogs.map(cat => (
                        <div key={cat.name} className="dsm-trino-catalog-item">
                          <span className="dsm-trino-catalog-icon">{DB_TYPES.find(t => t.id === cat.type)?.icon || '🗄️'}</span>
                          <div className="dsm-trino-catalog-info">
                            <span className="dsm-trino-catalog-name">{cat.name}</span>
                            <span className="dsm-trino-catalog-detail">{cat.type}{cat.host ? ` — ${cat.host}:${cat.port}/${cat.database}` : ''}</span>
                          </div>
                          <div className="dsm-trino-catalog-actions">
                            <button onClick={() => handleTest(cat.name)} disabled={testingId === cat.name} title="Test">
                              {testingId === cat.name ? '⏳' : '🔌'}
                            </button>
                            <button onClick={() => handleIntrospect(cat.name)} disabled={introspecting === cat.name} title="Schema">
                              {introspecting === cat.name ? '⏳' : '🔍'}
                            </button>
                            <button onClick={() => handleRemove(cat.name)} className="dsm-btn-danger-sm" title="Remove">🗑️</button>
                          </div>
                          {schemaData[cat.name] && (
                            <div className="dsm-trino-catalog-schema">
                              {(schemaData[cat.name].tables || []).map((tbl, i) => (
                                <details key={i} className="dsm-table-detail">
                                  <summary>{tbl.fullName || tbl.name} ({tbl.columns?.length || 0} cols)</summary>
                                  <div className="dsm-columns">
                                    {(tbl.columns || []).map((col, j) => (
                                      <span key={j} className="dsm-col">{col.name} <em>{col.type}</em></span>
                                    ))}
                                  </div>
                                </details>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Connection settings (toggled) */}
                {trinoShowSettings && (
                  <div className="dsm-trino-settings">
                    <div className="dsm-form-row">
                      <div className="dsm-field" style={{ flex: 3 }}>
                        <label>Trino URL</label>
                        <input value={trinoForm.url} onChange={e => setTrinoForm(f => ({ ...f, url: e.target.value }))}
                          placeholder="https://trino.example.com:8443" />
                      </div>
                      <div className="dsm-field" style={{ flex: 1 }}>
                        <label>User</label>
                        <input value={trinoForm.user} onChange={e => setTrinoForm(f => ({ ...f, user: e.target.value }))}
                          placeholder="trino" />
                      </div>
                      <div className="dsm-field" style={{ flex: 1 }}>
                        <label>Auth Type</label>
                        <select value={trinoForm.authType} onChange={e => setTrinoForm(f => ({ ...f, authType: e.target.value }))}>
                          <option value="none">None</option>
                          <option value="password">Password</option>
                          <option value="jwt">JWT Token</option>
                        </select>
                      </div>
                    </div>
                    {trinoForm.authType === 'password' && (
                      <div className="dsm-form-row">
                        <div className="dsm-field">
                          <label>Password {trinoConfig?.hasPassword && !trinoForm.password ? <span className="dsm-secret-set">● saved</span> : null}</label>
                          <input type="password" value={trinoForm.password}
                            onChange={e => setTrinoForm(f => ({ ...f, password: e.target.value }))}
                            placeholder={trinoConfig?.hasPassword ? '(unchanged — enter new to replace)' : 'Enter password'} />
                        </div>
                      </div>
                    )}
                    {trinoForm.authType === 'jwt' && (
                      <div className="dsm-form-row">
                        <div className="dsm-field">
                          <label>JWT Token {trinoConfig?.hasJwtToken && !trinoForm.jwtToken ? <span className="dsm-secret-set">● saved</span> : null}</label>
                          <textarea className="dsm-jwt-input" value={trinoForm.jwtToken}
                            onChange={e => setTrinoForm(f => ({ ...f, jwtToken: e.target.value }))}
                            placeholder={trinoConfig?.hasJwtToken ? '(unchanged — enter new to replace)' : 'Paste JWT token'} rows={3} />
                        </div>
                      </div>
                    )}
                    <div className="dsm-form-row">
                      <label className="dsm-checkbox-label">
                        <input type="checkbox" checked={trinoForm.tlsSkipVerify}
                          onChange={e => setTrinoForm(f => ({ ...f, tlsSkipVerify: e.target.checked }))} />
                        Skip TLS certificate verification
                      </label>
                    </div>
                    <div className="dsm-trino-actions">
                      <button className="dsm-btn-secondary dsm-btn-sm" onClick={() => handleTrinoTest()} disabled={trinoTesting || !trinoForm.url}>
                        {trinoTesting ? '⏳ Testing...' : '🔌 Test'}
                      </button>
                      <button className="dsm-btn-primary dsm-btn-sm" onClick={handleTrinoSave} disabled={trinoSaving || !trinoForm.url}>
                        {trinoSaving ? '⏳ Saving...' : '💾 Update'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Direct DB connection cards */}
        {directConnections.map(conn => {
          const dbType = DB_TYPES.find(t => t.id === conn.type);
          const isExpanded = expandedDirect[conn.id];
          const isEditing = editingDirect === conn.id;

          return (
            <div key={conn.id} className={`dsm-catalog-card ${isExpanded ? 'dsm-card-expanded' : ''}`}>
              <div className="dsm-catalog-header" onClick={() => setExpandedDirect(prev => ({ ...prev, [conn.id]: !prev[conn.id] }))} style={{ cursor: 'pointer' }}>
                <span className="dsm-catalog-icon">{dbType?.icon || '🗄️'}</span>
                <div className="dsm-catalog-info">
                  <span className="dsm-catalog-name">
                    {conn.name}
                    <span className="dsm-trino-badge">workspace</span>
                    {conn.status === 'active' && <span className="dsm-status-dot dsm-status-active" title="Active">●</span>}
                  </span>
                  <span className="dsm-catalog-type">
                    {dbType?.label || conn.type} — {conn.host}:{conn.port}/{conn.database}
                    {conn.username ? ` — user: ${conn.username}` : ''}
                  </span>
                </div>
                <div className="dsm-catalog-actions" onClick={e => e.stopPropagation()}>
                  <button onClick={() => handleDirectTest(conn.id)} disabled={testingId === conn.id} title="Test connection">
                    {testingId === conn.id ? '⏳' : '🔌'} Test
                  </button>
                  <button onClick={() => setExpandedDirect(prev => ({ ...prev, [conn.id]: !prev[conn.id] }))}
                    title={isExpanded ? 'Collapse' : 'Expand'}>
                    {isExpanded ? '▲' : '▼'}
                  </button>
                  <button onClick={() => handleDirectRemove(conn.id, conn.name)} className="dsm-btn-danger" title="Remove">🗑️</button>
                </div>
              </div>

              {isExpanded && (
                <div className="dsm-direct-expanded">
                  <div className="dsm-direct-details">
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Type:</span>
                      <span>{dbType?.label || conn.type}</span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Host:</span>
                      <span>{conn.host}:{conn.port}</span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Database:</span>
                      <span>{conn.database || '—'}</span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Username:</span>
                      <span>{conn.username || '—'}</span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Password:</span>
                      <span>{conn.hasPassword ? '●●●●●●' : 'not set'}</span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Status:</span>
                      <span className={`dsm-status-text ${conn.status === 'active' ? 'dsm-status-active-text' : ''}`}>
                        {conn.status || 'registered'}
                      </span>
                    </div>
                    <div className="dsm-direct-detail-row">
                      <span className="dsm-detail-label">Added:</span>
                      <span>{conn.createdAt ? new Date(conn.createdAt).toLocaleDateString() : '—'}</span>
                    </div>
                  </div>

                  <div className="dsm-direct-actions-bar">
                    <button className="dsm-btn-secondary dsm-btn-sm" onClick={() => isEditing ? setEditingDirect(null) : handleDirectEdit(conn)}>
                      {isEditing ? '✕ Cancel Edit' : '⚙️ Edit Connection'}
                    </button>
                  </div>

                  {/* Edit form (toggled) */}
                  {isEditing && (
                    <div className="dsm-trino-settings">
                      <div className="dsm-form-row">
                        <div className="dsm-field">
                          <label>Name</label>
                          <input value={directEditForm.name} onChange={e => setDirectEditForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                        <div className="dsm-field dsm-field-wide">
                          <label>Host</label>
                          <input value={directEditForm.host} onChange={e => setDirectEditForm(f => ({ ...f, host: e.target.value }))} />
                        </div>
                        <div className="dsm-field dsm-field-narrow">
                          <label>Port</label>
                          <input value={directEditForm.port} onChange={e => setDirectEditForm(f => ({ ...f, port: e.target.value }))} />
                        </div>
                      </div>
                      <div className="dsm-form-row">
                        <div className="dsm-field">
                          <label>Database</label>
                          <input value={directEditForm.database} onChange={e => setDirectEditForm(f => ({ ...f, database: e.target.value }))} />
                        </div>
                        <div className="dsm-field">
                          <label>Username</label>
                          <input value={directEditForm.username} onChange={e => setDirectEditForm(f => ({ ...f, username: e.target.value }))} />
                        </div>
                        <div className="dsm-field">
                          <label>Password {conn.hasPassword && !directEditForm.password ? <span className="dsm-secret-set">● saved</span> : null}</label>
                          <input type="password" value={directEditForm.password}
                            onChange={e => setDirectEditForm(f => ({ ...f, password: e.target.value }))}
                            placeholder={conn.hasPassword ? '(unchanged)' : 'Enter password'} />
                        </div>
                      </div>
                      <div className="dsm-trino-actions">
                        <button className="dsm-btn-primary dsm-btn-sm" onClick={() => handleDirectEditSave(conn.id)}>
                          💾 Save Changes
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {totalSources === 0 && !loading && (
          <div className="dsm-empty">
            <span className="dsm-empty-icon">🔌</span>
            <p>No data sources configured yet.</p>
            <p>Click "+ Add Data Source" to connect Trino or an external database.</p>
          </div>
        )}
      </div>
    </div>

    {/* Ontology Review Modal */}
    {ontologyPreview && (
      <div className="dsm-review-overlay" onClick={() => setOntologyPreview(null)}>
        <div className="dsm-review-modal" onClick={e => e.stopPropagation()}>
          <div className="dsm-review-header">
            <h3>🧬 Review Generated Ontology</h3>
            <button className="dsm-review-close" onClick={() => setOntologyPreview(null)}>✕</button>
          </div>
          <div className="dsm-review-meta">
            <span>📊 {ontologyPreview.catalogsUsed?.length || 0} catalog(s)</span>
            <span>📋 {ontologyPreview.tablesFound || 0} tables</span>
            <span>⏱️ {ontologyPreview.durationMs}ms</span>
          </div>
          <div className="dsm-review-body">
            <div className="dsm-review-fields">
              <div className="dsm-review-field">
                <label>Ontology Name</label>
                <input type="text" value={ontologyPreview.ontologyName || ''}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, ontologyName: e.target.value }))}
                  placeholder="e.g. Federated Commerce Ontology" />
              </div>
              <div className="dsm-review-field">
                <label>Base URI</label>
                <input type="text" value={ontologyPreview.baseUri || 'http://purplefabric.ai/vkg/'}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, baseUri: e.target.value }))}
                  placeholder="http://purplefabric.ai/vkg/" />
                <span className="dsm-review-hint">Used as the namespace for all classes and properties</span>
              </div>
            </div>
            <div className="dsm-review-tabs">
              <button className={`dsm-review-tab ${reviewTab === 'mapping' ? 'active' : ''}`}
                onClick={() => setReviewTab('mapping')}>📋 Mapping Table</button>
              <button className={`dsm-review-tab ${reviewTab === 'turtle' ? 'active' : ''}`}
                onClick={() => setReviewTab('turtle')}>🐢 Turtle (TTL)</button>
            </div>
            {reviewTab === 'mapping' && ontologyPreview.mappingTable && (
              <div className="dsm-mapping-table-wrap">
                <table className="dsm-mapping-table">
                  <thead>
                    <tr>
                      <th>Ontology Element</th><th>Type</th><th>Source Table</th>
                      <th>Source Column</th><th>XSD / Range</th><th>Domain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ontologyPreview.mappingTable.map((row, i) => (
                      <tr key={i} className={`dsm-mapping-row dsm-mapping-${row.type.toLowerCase()}`}>
                        <td className="dsm-mapping-name">{row.ontologyElement}</td>
                        <td><span className={`dsm-mapping-badge dsm-badge-${row.type.toLowerCase()}`}>
                          {row.type === 'Class' ? '🔷' : row.type === 'DataProperty' ? '🔹' : '🔗'} {row.type}
                        </span></td>
                        <td className="dsm-mapping-source">{row.sourceTable || '—'}</td>
                        <td className="dsm-mapping-source">{row.sourceColumn || (row.joinSQL ? `JOIN: ${row.joinSQL}` : '—')}</td>
                        <td>{row.xsdType || row.range || '—'}</td>
                        <td>{row.domain || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {reviewTab === 'mapping' && !ontologyPreview.mappingTable && (
              <p style={{ padding: '1rem', color: '#888' }}>No mapping table available. Switch to Turtle tab.</p>
            )}
            {reviewTab === 'turtle' && (
              <>
                <label>Ontology (Turtle/TTL) — edit before saving if needed:</label>
                <textarea className="dsm-review-editor" value={ontologyPreview.turtle || ''}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, turtle: e.target.value }))} spellCheck={false} />
              </>
            )}
          </div>
          <div className="dsm-review-actions">
            <button className="dsm-btn-secondary" onClick={() => setOntologyPreview(null)}>Cancel</button>
            <button className="dsm-btn-primary" onClick={handleSaveOntology}
              disabled={savingOntology || !ontologyPreview.ontologyName?.trim()}>
              {savingOntology ? '⏳ Saving...' : '💾 Save to GraphDB'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

export default DataSourcesManager;
