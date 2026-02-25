/**
 * DataSourcesManager — UI for registering/managing Trino catalogs (external data sources).
 * Calls /api/trino/catalogs endpoints. Test connectivity, view schema, trigger ontology generation.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './DataSourcesManager.css';

const DB_TYPES = [
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

  const [reviewTab, setReviewTab] = useState('mapping'); // 'mapping' | 'turtle'

  const [form, setForm] = useState({
    name: '', type: 'postgresql', host: '', port: '', database: '', username: '', password: ''
  });

  const tenantId = currentTenant?.tenant_id || 'default';
  const workspaceId = currentWorkspace?.workspace_id || 'default';

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trino/catalogs?tenantId=${tenantId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setCatalogs(data.catalogs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tenantId, getTenantHeaders]);

  useEffect(() => { loadCatalogs(); }, [loadCatalogs]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/trino/catalogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ ...form, tenantId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add catalog');
      setShowAddForm(false);
      setForm({ name: '', type: 'postgresql', host: '', port: '', database: '', username: '', password: '' });
      loadCatalogs();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (catalogName) => {
    if (!window.confirm(`Remove data source "${catalogName}"?`)) return;
    try {
      await fetch(`/api/trino/catalogs/${catalogName}?tenantId=${tenantId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      loadCatalogs();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleTest = async (catalogName) => {
    setTestingId(catalogName);
    try {
      const res = await fetch(`/api/trino/catalogs/${catalogName}/test?tenantId=${tenantId}`, {
        headers: getTenantHeaders()
      });
      const data = await res.json();
      alert(data.connected ? `✅ Connected to ${catalogName}` : `❌ Connection failed: ${data.error}`);
    } catch (e) {
      alert(`❌ ${e.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleIntrospect = async (catalogName) => {
    setIntrospecting(catalogName);
    try {
      const res = await fetch(`/api/trino/catalogs/${catalogName}/introspect?tenantId=${tenantId}`, {
        headers: getTenantHeaders()
      });
      const data = await res.json();
      setSchemaData(prev => ({ ...prev, [catalogName]: data }));
    } catch (e) {
      setError(e.message);
    } finally {
      setIntrospecting(null);
    }
  };

  const handleGenerateOntology = async () => {
    if (!window.confirm('Generate VKG ontology from all registered data sources? This may take a moment.')) return;
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
      // Show preview for review
      setOntologyPreview(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setGeneratingOntology(false);
    }
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
          tenantId,
          workspaceId,
          turtle: ontologyPreview.turtle,
          name: ontologyPreview.ontologyName.trim(),
          baseUri: ontologyPreview.baseUri || 'http://purplefabric.ai/vkg/'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      alert(`✅ Ontology "${ontologyPreview.ontologyName}" saved to GraphDB\nURI: ${data.graphIRI || 'N/A'}`);
      setOntologyPreview(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingOntology(false);
    }
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
      if (data.new > 0) {
        alert(`🔍 Discovered ${data.new} new catalog(s) from Trino (${data.total} total in Trino)`);
      } else {
        alert(`All ${data.total} Trino catalogs already synced.`);
      }
      loadCatalogs();
    } catch (e) {
      setError(e.message);
    } finally {
      setDiscovering(false);
    }
  };

  const defaultPort = (type) => {
    const ports = { postgresql: '5432', mysql: '3306', mariadb: '3306', clickhouse: '8123', sqlserver: '1433', oracle: '1521', mongodb: '27017' };
    return ports[type] || '';
  };

  return (
    <>
    <div className="dsm-container">
      <div className="dsm-header">
        <h2>🌐 Federated Data Sources</h2>
        <p className="dsm-subtitle">Connect external databases for virtual knowledge graph queries via Trino</p>
        <div className="dsm-header-actions">
          <button className="dsm-btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? '✕ Cancel' : '+ Add Data Source'}
          </button>
          <button
            className="dsm-btn-secondary"
            onClick={handleGenerateOntology}
            disabled={generatingOntology || catalogs.length === 0}
          >
            {generatingOntology ? '⏳ Generating...' : '🧬 Generate VKG Ontology'}
          </button>
          <button className="dsm-btn-secondary" onClick={loadCatalogs} disabled={loading}>🔄</button>
          <button className="dsm-btn-secondary" onClick={handleDiscover} disabled={discovering}>
            {discovering ? '⏳ Discovering...' : '🔍 Discover from Trino'}
          </button>
        </div>
      </div>

      {error && <div className="dsm-error">❌ {error} <button onClick={() => setError(null)}>×</button></div>}

      {showAddForm && (
        <form className="dsm-add-form" onSubmit={handleAdd}>
          <div className="dsm-form-row">
            <div className="dsm-field">
              <label>Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="my_postgres" required />
            </div>
            <div className="dsm-field">
              <label>Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value, port: defaultPort(e.target.value) }))}>
                {DB_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
              </select>
            </div>
          </div>
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
          <div className="dsm-form-actions">
            <button type="submit" className="dsm-btn-primary" disabled={loading}>
              {loading ? '⏳ Adding...' : '✓ Add Data Source'}
            </button>
          </div>
        </form>
      )}

      {catalogs.length === 0 && !loading ? (
        <div className="dsm-empty">
          <span className="dsm-empty-icon">🔌</span>
          <p>No data sources registered yet.</p>
          <p>Add an external database to start querying with the Federated mode.</p>
        </div>
      ) : (
        <div className="dsm-catalog-list">
          {catalogs.map(cat => (
            <div key={cat.name} className="dsm-catalog-card">
              <div className="dsm-catalog-header">
                <span className="dsm-catalog-icon">{DB_TYPES.find(t => t.id === cat.type)?.icon || '🗄️'}</span>
                <div className="dsm-catalog-info">
                  <span className="dsm-catalog-name">{cat.name}</span>
                  <span className="dsm-catalog-type">{cat.type} — {cat.host}:{cat.port}/{cat.database}</span>
                </div>
                <div className="dsm-catalog-actions">
                  <button onClick={() => handleTest(cat.name)} disabled={testingId === cat.name} title="Test connection">
                    {testingId === cat.name ? '⏳' : '🔌'} Test
                  </button>
                  <button onClick={() => handleIntrospect(cat.name)} disabled={introspecting === cat.name} title="View schema">
                    {introspecting === cat.name ? '⏳' : '🔍'} Schema
                  </button>
                  <button onClick={() => handleRemove(cat.name)} className="dsm-btn-danger" title="Remove">🗑️</button>
                </div>
              </div>

              {schemaData[cat.name] && (
                <div className="dsm-schema-panel">
                  <h4>Schema: {cat.name}</h4>
                  {(schemaData[cat.name].tables || []).map((tbl, i) => (
                    <details key={i} className="dsm-table-detail">
                      <summary>{tbl.fullName || tbl.name} ({tbl.columns?.length || 0} columns)</summary>
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
                <input
                  type="text"
                  value={ontologyPreview.ontologyName || ''}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, ontologyName: e.target.value }))}
                  placeholder="e.g. Federated Commerce Ontology"
                />
              </div>
              <div className="dsm-review-field">
                <label>Base URI</label>
                <input
                  type="text"
                  value={ontologyPreview.baseUri || 'http://purplefabric.ai/vkg/'}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, baseUri: e.target.value }))}
                  placeholder="http://purplefabric.ai/vkg/"
                />
                <span className="dsm-review-hint">Used as the namespace for all classes and properties</span>
              </div>
            </div>

            {/* Tabs: Mapping Table | Turtle */}
            <div className="dsm-review-tabs">
              <button
                className={`dsm-review-tab ${reviewTab === 'mapping' ? 'active' : ''}`}
                onClick={() => setReviewTab('mapping')}
              >📋 Mapping Table</button>
              <button
                className={`dsm-review-tab ${reviewTab === 'turtle' ? 'active' : ''}`}
                onClick={() => setReviewTab('turtle')}
              >🐢 Turtle (TTL)</button>
            </div>

            {reviewTab === 'mapping' && ontologyPreview.mappingTable && (
              <div className="dsm-mapping-table-wrap">
                <table className="dsm-mapping-table">
                  <thead>
                    <tr>
                      <th>Ontology Element</th>
                      <th>Type</th>
                      <th>Source Table</th>
                      <th>Source Column</th>
                      <th>XSD / Range</th>
                      <th>Domain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ontologyPreview.mappingTable.map((row, i) => (
                      <tr key={i} className={`dsm-mapping-row dsm-mapping-${row.type.toLowerCase()}`}>
                        <td className="dsm-mapping-name">{row.ontologyElement}</td>
                        <td><span className={`dsm-mapping-badge dsm-badge-${row.type.toLowerCase()}`}>{row.type === 'Class' ? '🔷' : row.type === 'DataProperty' ? '🔹' : '🔗'} {row.type}</span></td>
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
              <p style={{ padding: '1rem', color: '#888' }}>No mapping table available. Switch to Turtle tab to view raw ontology.</p>
            )}

            {reviewTab === 'turtle' && (
              <>
                <label>Ontology (Turtle/TTL) — edit before saving if needed:</label>
                <textarea
                  className="dsm-review-editor"
                  value={ontologyPreview.turtle || ''}
                  onChange={e => setOntologyPreview(prev => ({ ...prev, turtle: e.target.value }))}
                  spellCheck={false}
                />
              </>
            )}
          </div>
          <div className="dsm-review-actions">
            <button className="dsm-btn-secondary" onClick={() => setOntologyPreview(null)}>Cancel</button>
            <button className="dsm-btn-primary" onClick={handleSaveOntology} disabled={savingOntology || !ontologyPreview.ontologyName?.trim()}>
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
