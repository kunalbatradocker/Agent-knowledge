/**
 * DatabaseManager - Separate management UI for GraphDB and Neo4j
 * Allows viewing, CRUD operations, and cleanup for each database
 */
import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import './DatabaseManager.css';

function DatabaseManager() {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const { canClearData, canPurge, isMember, isManager } = usePermissions();
  const [activeDb, setActiveDb] = useState('graphdb');
  const [activeTab, setActiveTab] = useState('stats');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ graphdb: null, neo4j: null, redis: null });
  const [data, setData] = useState({ graphdb: [], neo4j: [] });
  const [selectedItems, setSelectedItems] = useState([]);
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState(null);
  const [queryHistory, setQueryHistory] = useState([]);
  const [error, setError] = useState(null);
  
  // Query Builder state
  const [ontology, setOntology] = useState({ classes: [], properties: [] });
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedProperties, setSelectedProperties] = useState([]);
  const [filters, setFilters] = useState([]);
  const [queryLimit, setQueryLimit] = useState(100);

  // Load stats for both databases
  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [graphdbRes, neo4jRes, redisRes] = await Promise.allSettled([
        fetch('/api/admin/graphdb/stats', { headers: getTenantHeaders() }),
        fetch('/api/admin/neo4j/stats', { headers: getTenantHeaders() }),
        fetch('/api/admin/redis/stats', { headers: getTenantHeaders() })
      ]);

      if (graphdbRes.status === 'fulfilled' && graphdbRes.value.ok) {
        const data = await graphdbRes.value.json();
        setStats(prev => ({ ...prev, graphdb: data }));
      }
      if (neo4jRes.status === 'fulfilled' && neo4jRes.value.ok) {
        const data = await neo4jRes.value.json();
        setStats(prev => ({ ...prev, neo4j: data }));
      }
      if (redisRes.status === 'fulfilled' && redisRes.value.ok) {
        const data = await redisRes.value.json();
        setStats(prev => ({ ...prev, redis: data }));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [getTenantHeaders]);

  // Load ontology for query builder
  const loadOntology = useCallback(async () => {
    try {
      const res = await fetch('/api/owl/list?scope=all', { headers: getTenantHeaders() });
      const data = await res.json();
      if (data.ontologies?.length > 0) {
        const allClasses = [];
        const allProps = [];
        data.ontologies.forEach(ont => {
          (ont.classes || []).forEach(c => allClasses.push({ ...c, ontology: ont.name }));
          [...(ont.dataProperties || []), ...(ont.objectProperties || [])].forEach(p => allProps.push({ ...p, ontology: ont.name }));
        });
        setOntology({ classes: allClasses, properties: allProps });
      }
    } catch (err) {
      console.error('Failed to load ontology:', err);
    }
  }, [getTenantHeaders]);

  // Load query history
  const loadQueryHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/sparql/history', { headers: getTenantHeaders() });
      const data = await res.json();
      setQueryHistory(data.queries || []);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }, [getTenantHeaders]);

  useEffect(() => {
    loadStats();
    loadOntology();
    loadQueryHistory();
  }, [loadStats, loadOntology, loadQueryHistory]);

  // Load data from selected database
  const loadData = async (db, type = 'all') => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = db === 'graphdb' 
        ? `/api/admin/graphdb/browse?type=${type}`
        : `/api/admin/neo4j/browse?type=${type}`;
      
      const res = await fetch(endpoint, { headers: getTenantHeaders() });
      const result = await res.json();
      
      if (result.success) {
        setData(prev => ({ ...prev, [db]: result.data || [] }));
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Execute query
  const executeQuery = async (queryToRun = query) => {
    if (!queryToRun.trim()) return;
    setLoading(true);
    setError(null);
    setQueryResult(null);
    
    try {
      const endpoint = activeDb === 'graphdb'
        ? '/api/sparql/query'
        : '/api/admin/neo4j/query';
      
      const body = activeDb === 'graphdb'
        ? { query: queryToRun, tenantId: currentWorkspace?.tenant_id || 'default', workspaceId: currentWorkspace?.workspace_id || 'default' }
        : { query: queryToRun };
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 'default', ...getTenantHeaders() },
        body: JSON.stringify(body)
      });
      
      const result = await res.json();
      setQueryResult(result);
      loadQueryHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Generate SPARQL from query builder
  const generateSPARQL = () => {
    if (!selectedClass) return '';
    const classLocal = selectedClass.split('#').pop().split('/').pop();
    const varName = classLocal.toLowerCase();
    
    let selectVars = [`?${varName}`];
    let patterns = [`?${varName} a <${selectedClass}> .`];

    selectedProperties.forEach(prop => {
      const propLocal = prop.split('#').pop().split('/').pop();
      selectVars.push(`?${propLocal}`);
      patterns.push(`OPTIONAL { ?${varName} <${prop}> ?${propLocal} . }`);
    });

    filters.forEach(f => {
      if (f.property && f.value) {
        const propLocal = f.property.split('#').pop().split('/').pop();
        if (f.operator === 'contains') {
          patterns.push(`FILTER(CONTAINS(LCASE(STR(?${propLocal})), LCASE("${f.value}")))`);
        } else {
          patterns.push(`FILTER(?${propLocal} ${f.operator} "${f.value}")`);
        }
      }
    });

    return `SELECT ${selectVars.join(' ')}\nWHERE {\n  ${patterns.join('\n  ')}\n}\nLIMIT ${queryLimit}`;
  };

  const applyGeneratedQuery = () => {
    const generated = generateSPARQL();
    if (generated) {
      setQuery(generated);
      setActiveTab('query');
    }
  };

  // Delete selected items
  const deleteSelected = async () => {
    if (selectedItems.length === 0) return;
    if (!window.confirm(`Delete ${selectedItems.length} items from ${activeDb.toUpperCase()}?`)) return;
    
    setLoading(true);
    try {
      const endpoint = activeDb === 'graphdb'
        ? '/api/admin/graphdb/delete'
        : '/api/admin/neo4j/delete';
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ uris: selectedItems })
      });
      
      const result = await res.json();
      if (result.success) {
        setSelectedItems([]);
        loadData(activeDb);
        loadStats();
        alert(`✅ Deleted ${result.deleted} items`);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Cleanup database - only deletes user content (conversations, chunks, vectors, raw data)
  const cleanupDatabase = async (type) => {
    const labels = {
      vectors: 'vectors',
      chunks: 'chunks',
      conversations: 'conversations',
      data: 'instance data',
      audit: 'audit trail',
      ontologies: 'workspace ontologies',
      entities: 'entities',
      relationships: 'relationships',
      all: `all user data from ${activeDb.toUpperCase()} (config and structure preserved)`
    };
    const confirmMsg = `⚠️ Delete ${labels[type] || type}?`;
    
    if (!window.confirm(confirmMsg)) return;
    if (type === 'all' && !window.confirm('This cannot be undone. Are you sure?')) return;
    
    setLoading(true);
    try {
      const endpoint = activeDb === 'graphdb'
        ? '/api/admin/graphdb/cleanup'
        : activeDb === 'redis'
        ? '/api/admin/redis/cleanup'
        : '/api/admin/neo4j/cleanup';
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ type, tenantId: currentWorkspace?.tenant_id, workspaceId: currentWorkspace?.workspace_id })
      });
      
      const result = await res.json();
      if (result.success) {
        loadStats();
        setData(prev => ({ ...prev, [activeDb]: [] }));
        alert(`✅ ${result.message}`);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Purge entire workspace across all databases
  const purgeWorkspace = async () => {
    if (!currentWorkspace?.workspace_id) {
      alert('Please select a workspace first.');
      return;
    }
    const name = currentWorkspace.name || currentWorkspace.workspace_id;
    if (!window.confirm(`🔴 PERMANENTLY DELETE workspace "${name}" and ALL its data from every database?\n\nThis removes:\n• All documents, chunks, vectors\n• All Neo4j entities and relationships\n• All GraphDB data graphs\n• The workspace itself\n\nThis cannot be undone.`)) return;
    if (!window.confirm(`Type YES to confirm: delete workspace "${name}" forever?`)) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/workspace/${encodeURIComponent(currentWorkspace.workspace_id)}/purge?tenantId=${encodeURIComponent(currentWorkspace.tenant_id || 'default')}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      const result = await res.json();
      if (result.success) {
        alert(`✅ ${result.message}`);
        window.location.reload();
      } else {
        alert(`❌ ${result.message || result.error}`);
      }
    } catch (e) {
      alert(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Purge entire tenant and all its workspaces
  const purgeTenant = async () => {
    const tenantId = currentWorkspace?.tenant_id;
    if (!tenantId) {
      alert('No tenant selected.');
      return;
    }
    if (tenantId === 'default') {
      alert('Cannot delete the default tenant.');
      return;
    }
    if (!window.confirm(`🔴 PERMANENTLY DELETE tenant "${tenantId}" and ALL its workspaces + data?\n\nThis cannot be undone.`)) return;
    if (!window.confirm('Are you absolutely sure? This deletes everything in this tenant.')) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tenant/${encodeURIComponent(tenantId)}/purge`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      const result = await res.json();
      if (result.success) {
        alert(`✅ ${result.message}`);
        window.location.reload();
      } else {
        alert(`❌ ${result.message || result.error}`);
      }
    } catch (e) {
      alert(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Sync GraphDB to Neo4j
  const syncDatabases = async () => {
    if (!window.confirm('Sync data from GraphDB to Neo4j?')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/sync/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ 
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          type: 'all',
          mode: 'full'
        })
      });
      const result = await res.json();
      if (res.ok) {
        loadStats();
        alert('✅ Sync started! Check sync status for progress.');
      } else {
        setError(result.error || result.message);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const renderStats = (db) => {
    const s = stats[db];
    if (!s) return <p className="dbm-no-data">No stats available</p>;
    
    if (db === 'graphdb') {
      return (
        <>
          <div className="dbm-stats-grid">
            <div className="dbm-stat"><span className="dbm-stat-value">{s.totalTriples?.toLocaleString() || 0}</span><span className="dbm-stat-label">Total Triples</span></div>
            <div className="dbm-stat"><span className="dbm-stat-value">{s.totalGraphs || 0}</span><span className="dbm-stat-label">Named Graphs</span></div>
            <div className="dbm-stat"><span className="dbm-stat-value">{s.ontologies || 0}</span><span className="dbm-stat-label">Ontology Graphs</span></div>
            <div className="dbm-stat"><span className="dbm-stat-value">{s.dataGraphs || 0}</span><span className="dbm-stat-label">Data Graphs</span></div>
          </div>
          {s.graphs?.length > 0 && (
            <div className="dbm-graph-list">
              <h4>Graphs</h4>
              {s.graphs.map((g, i) => (
                <div key={i} className="dbm-graph-item">
                  <span className="dbm-graph-name" title={g.name}>{g.name?.split('/').slice(-3).join('/') || g.name}</span>
                  <span className="dbm-graph-count">{g.triples?.toLocaleString()} triples</span>
                </div>
              ))}
            </div>
          )}
        </>
      );
    } else if (db === 'redis') {
      return (
        <div className="dbm-stats-grid">
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalVectors?.toLocaleString() || 0}</span><span className="dbm-stat-label">Vectors</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalChunks?.toLocaleString() || 0}</span><span className="dbm-stat-label">Chunks</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalDocuments?.toLocaleString() || 0}</span><span className="dbm-stat-label">Documents</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalConversations?.toLocaleString() || 0}</span><span className="dbm-stat-label">Conversations</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalKeys?.toLocaleString() || 0}</span><span className="dbm-stat-label">Total Keys</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.memoryUsed || '—'}</span><span className="dbm-stat-label">Memory</span></div>
        </div>
      );
    } else {
      return (
        <div className="dbm-stats-grid">
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalNodes?.toLocaleString() || 0}</span><span className="dbm-stat-label">Nodes</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.totalRelationships?.toLocaleString() || 0}</span><span className="dbm-stat-label">Relationships</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.labels?.length || 0}</span><span className="dbm-stat-label">Labels</span></div>
          <div className="dbm-stat"><span className="dbm-stat-value">{s.relationshipTypes?.length || 0}</span><span className="dbm-stat-label">Rel Types</span></div>
        </div>
      );
    }
  };

  const renderQueryBuilder = () => (
    <div className="dbm-query-builder">
      <div className="dbm-qb-row">
        <div className="dbm-qb-field">
          <label>Select Class</label>
          <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
            <option value="">-- Choose a class --</option>
            {ontology.classes.map(c => (
              <option key={c.uri || c.iri} value={c.uri || c.iri}>
                {c.label || c.localName || c.uri?.split('#').pop()}
              </option>
            ))}
          </select>
        </div>
        <div className="dbm-qb-field">
          <label>Limit</label>
          <input type="number" value={queryLimit} onChange={(e) => setQueryLimit(parseInt(e.target.value) || 100)} min="1" max="10000" />
        </div>
      </div>

      {selectedClass && (
        <>
          <div className="dbm-qb-field">
            <label>Select Properties</label>
            <div className="dbm-qb-props">
              {ontology.properties.slice(0, 20).map(p => (
                <label key={p.uri || p.iri} className="dbm-qb-prop-item">
                  <input
                    type="checkbox"
                    checked={selectedProperties.includes(p.uri || p.iri)}
                    onChange={(e) => {
                      const uri = p.uri || p.iri;
                      setSelectedProperties(prev => e.target.checked ? [...prev, uri] : prev.filter(x => x !== uri));
                    }}
                  />
                  {p.label || p.localName || p.uri?.split('#').pop()}
                </label>
              ))}
            </div>
          </div>

          <div className="dbm-qb-field">
            <label>Filters <button className="dbm-btn-small" onClick={() => setFilters([...filters, { property: '', operator: '=', value: '' }])}>+ Add</button></label>
            {filters.map((f, i) => (
              <div key={i} className="dbm-qb-filter">
                <select value={f.property} onChange={(e) => { const nf = [...filters]; nf[i].property = e.target.value; setFilters(nf); }}>
                  <option value="">Property</option>
                  {ontology.properties.map(p => <option key={p.uri || p.iri} value={p.uri || p.iri}>{p.label || p.localName}</option>)}
                </select>
                <select value={f.operator} onChange={(e) => { const nf = [...filters]; nf[i].operator = e.target.value; setFilters(nf); }}>
                  <option value="=">=</option>
                  <option value="contains">contains</option>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                </select>
                <input placeholder="Value" value={f.value} onChange={(e) => { const nf = [...filters]; nf[i].value = e.target.value; setFilters(nf); }} />
                <button className="dbm-btn-small dbm-btn-danger" onClick={() => setFilters(filters.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="dbm-qb-preview">
        <label>Generated SPARQL</label>
        <pre>{generateSPARQL() || 'Select a class to generate query'}</pre>
      </div>

      <div className="dbm-qb-actions">
        <button className="dbm-btn-primary" onClick={applyGeneratedQuery} disabled={!selectedClass}>
          Use This Query
        </button>
        <button className="dbm-btn-secondary" onClick={() => { setSelectedClass(''); setSelectedProperties([]); setFilters([]); }}>
          Reset
        </button>
      </div>
    </div>
  );

  const renderQueryResults = () => {
    if (!queryResult) return null;
    
    const bindings = queryResult.results?.bindings || queryResult.results?.results?.bindings || [];
    const vars = queryResult.results?.head?.vars || queryResult.head?.vars || (bindings[0] ? Object.keys(bindings[0]) : []);
    
    if (bindings.length === 0) {
      return <p className="dbm-no-data">No results found</p>;
    }

    return (
      <div className="dbm-results-table-wrap">
        <p className="dbm-results-count">{bindings.length} result{bindings.length !== 1 ? 's' : ''} {queryResult.executionTime && `(${queryResult.executionTime}ms)`}</p>
        <table className="dbm-results-table">
          <thead>
            <tr>{vars.map(v => <th key={v}>{v}</th>)}</tr>
          </thead>
          <tbody>
            {bindings.slice(0, 100).map((row, i) => (
              <tr key={i}>
                {vars.map(v => <td key={v} title={row[v]?.value}>{(row[v]?.value || '').slice(0, 80)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {bindings.length > 100 && <p className="dbm-truncated">Showing 100 of {bindings.length}</p>}
      </div>
    );
  };

  return (
    <div className="dbm-container">
      <div className="dbm-header">
        <h2>🗄️ Database Manager</h2>
        <div className="dbm-db-tabs">
          <button className={`dbm-tab ${activeDb === 'graphdb' ? 'active' : ''}`} onClick={() => setActiveDb('graphdb')}>
            <span className="dbm-tab-icon">🔷</span> GraphDB
          </button>
          <button className={`dbm-tab ${activeDb === 'neo4j' ? 'active' : ''}`} onClick={() => setActiveDb('neo4j')}>
            <span className="dbm-tab-icon">🟢</span> Neo4j
          </button>
          <button className={`dbm-tab ${activeDb === 'redis' ? 'active' : ''}`} onClick={() => { setActiveDb('redis'); setActiveTab('stats'); }}>
            <span className="dbm-tab-icon">🔴</span> Redis
          </button>
        </div>
      </div>

      {error && <div className="dbm-error">❌ {error} <button onClick={() => setError(null)}>×</button></div>}

      {/* Sub-tabs */}
      <div className="dbm-subtabs">
        <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}>📊 Overview</button>
        {activeDb !== 'redis' && <button className={activeTab === 'query' ? 'active' : ''} onClick={() => setActiveTab('query')}>🔍 Query</button>}
        {activeDb === 'graphdb' && <button className={activeTab === 'builder' ? 'active' : ''} onClick={() => setActiveTab('builder')}>🛠️ Query Builder</button>}
        {activeDb !== 'redis' && <button className={activeTab === 'browse' ? 'active' : ''} onClick={() => setActiveTab('browse')}>📂 Browse</button>}
        {isManager && <button className={activeTab === 'admin' ? 'active' : ''} onClick={() => setActiveTab('admin')}>⚙️ Admin</button>}
      </div>

      <div className="dbm-content">
        {/* Stats Tab */}
        {activeTab === 'stats' && (
          <div className="dbm-section">
            <div className="dbm-section-header">
              <h3>Statistics</h3>
              <button onClick={loadStats} disabled={loading} className="dbm-btn-refresh">🔄</button>
            </div>
            {loading ? <p>Loading...</p> : renderStats(activeDb)}
          </div>
        )}

        {/* Query Tab */}
        {activeTab === 'query' && (
          <div className="dbm-section">
            <div className="dbm-section-header">
              <h3>{activeDb === 'graphdb' ? 'SPARQL Query' : 'Cypher Query'}</h3>
            </div>
            <textarea
              className="dbm-query-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={activeDb === 'graphdb' 
                ? 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10'
                : 'MATCH (n) RETURN n LIMIT 10'}
              rows={6}
            />
            <div className="dbm-query-actions">
              <button onClick={() => executeQuery()} disabled={loading || !query.trim()} className="dbm-btn-primary">
                {loading ? '⏳' : '▶️'} Execute
              </button>
              <button onClick={() => { setQuery(''); setQueryResult(null); }} className="dbm-btn-secondary">Clear</button>
            </div>
            {renderQueryResults()}
            
            {queryHistory.length > 0 && (
              <div className="dbm-history">
                <h4>Recent Queries</h4>
                {queryHistory.slice(0, 5).map((h, i) => (
                  <div key={i} className="dbm-history-item" onClick={() => setQuery(h.query)}>
                    <code>{h.query.slice(0, 60)}...</code>
                    <span className="dbm-history-meta">{h.resultCount} results • {new Date(h.timestamp).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Query Builder Tab (GraphDB only) */}
        {activeTab === 'builder' && activeDb === 'graphdb' && (
          <div className="dbm-section">
            <div className="dbm-section-header">
              <h3>Visual Query Builder</h3>
            </div>
            {renderQueryBuilder()}
          </div>
        )}

        {/* Browse Tab */}
        {activeTab === 'browse' && (
          <div className="dbm-section">
            <div className="dbm-section-header">
              <h3>Browse Data</h3>
              <div className="dbm-browse-actions">
                <button onClick={() => loadData(activeDb, 'ontologies')} disabled={loading}>Ontologies</button>
                <button onClick={() => loadData(activeDb, 'entities')} disabled={loading}>Entities</button>
                <button onClick={() => loadData(activeDb, 'all')} disabled={loading}>All</button>
              </div>
            </div>
            {data[activeDb]?.length > 0 ? (
              <div className="dbm-data-list">
                <div className="dbm-list-header">
                  <input 
                    type="checkbox" 
                    onChange={(e) => setSelectedItems(e.target.checked ? data[activeDb].map(d => d.uri || d.id) : [])}
                    checked={selectedItems.length === data[activeDb].length && data[activeDb].length > 0}
                  />
                  <span>URI / ID</span>
                  <span>Type</span>
                  <span>Label</span>
                </div>
                {data[activeDb].slice(0, 100).map((item, i) => (
                  <div key={i} className="dbm-list-item">
                    <input 
                      type="checkbox"
                      checked={selectedItems.includes(item.uri || item.id)}
                      onChange={(e) => {
                        const id = item.uri || item.id;
                        setSelectedItems(prev => e.target.checked ? [...prev, id] : prev.filter(x => x !== id));
                      }}
                    />
                    <span className="dbm-item-uri" title={item.uri || item.id}>{(item.uri || item.id || '').slice(-50)}</span>
                    <span className="dbm-item-type">{item.type || item.labels?.join(', ') || '-'}</span>
                    <span className="dbm-item-label">{item.label || item.name || '-'}</span>
                  </div>
                ))}
                {data[activeDb].length > 100 && <p className="dbm-truncated">Showing 100 of {data[activeDb].length}</p>}
              </div>
            ) : (
              <p className="dbm-no-data">Click a button above to load data</p>
            )}
            {selectedItems.length > 0 && isMember && (
              <div className="dbm-selection-actions">
                <span>{selectedItems.length} selected</span>
                <button onClick={deleteSelected} className="dbm-btn-danger">🗑️ Delete</button>
              </div>
            )}
          </div>
        )}

        {/* Admin Tab */}
        {activeTab === 'admin' && isManager && (
          <div className="dbm-section dbm-danger-zone">
            <div className="dbm-section-header">
              <h3>⚠️ Clear Data (current DB)</h3>
              <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>Removes user content only. Config, auth, tenant/workspace structure are preserved.</p>
            </div>
            <div className="dbm-cleanup-actions">
              {activeDb === 'graphdb' ? (
                <>
                  <button onClick={() => cleanupDatabase('data')} className="dbm-btn-warning" disabled={!canClearData}>Clear Data Graphs</button>
                  <button onClick={() => cleanupDatabase('audit')} className="dbm-btn-warning" disabled={!canClearData}>Clear Audit Graph</button>
                  <button onClick={() => cleanupDatabase('ontologies')} className="dbm-btn-warning" disabled={!canClearData}>Clear Ontologies</button>
                  <button onClick={() => cleanupDatabase('all')} className="dbm-btn-danger" disabled={!canClearData}>🗑️ Clear All Data</button>
                </>
              ) : activeDb === 'redis' ? (
                <>
                  <button onClick={() => cleanupDatabase('vectors')} className="dbm-btn-warning" disabled={!canClearData}>Clear Vectors</button>
                  <button onClick={() => cleanupDatabase('chunks')} className="dbm-btn-warning" disabled={!canClearData}>Clear Chunks</button>
                  <button onClick={() => cleanupDatabase('conversations')} className="dbm-btn-warning" disabled={!canClearData}>Clear Conversations</button>
                  <button onClick={() => cleanupDatabase('all')} className="dbm-btn-danger" disabled={!canClearData}>🗑️ Clear All Data</button>
                </>
              ) : (
                <>
                  <button onClick={() => cleanupDatabase('entities')} className="dbm-btn-warning" disabled={!canClearData}>Clear Entities</button>
                  <button onClick={() => cleanupDatabase('relationships')} className="dbm-btn-warning" disabled={!canClearData}>Clear Relationships</button>
                  <button onClick={() => cleanupDatabase('all')} className="dbm-btn-danger" disabled={!canClearData}>🗑️ Clear All Data</button>
                </>
              )}
            </div>

            <div className="dbm-sync-section">
              <h4>🔄 Sync Databases</h4>
              <p>Sync from GraphDB to Neo4j</p>
              <button onClick={syncDatabases} disabled={loading} className="dbm-btn-primary">
                Sync GraphDB → Neo4j
              </button>
            </div>

            {canPurge && (
              <div className="dbm-sync-section" style={{ borderTop: '2px solid #FCA5A5', paddingTop: 16, marginTop: 16 }}>
                <h4>🔴 Destructive Actions</h4>
                <p style={{ fontSize: 13, color: '#DC2626', marginBottom: 12 }}>These permanently delete a workspace or tenant and ALL related data across every database.</p>
                <div className="dbm-cleanup-actions">
                  <button onClick={purgeWorkspace} className="dbm-btn-danger" disabled={loading || !currentWorkspace?.workspace_id || currentWorkspace?.workspace_id === 'default'}>
                    🗑️ Delete Current Workspace
                  </button>
                  <button onClick={purgeTenant} className="dbm-btn-danger" disabled={loading || !currentWorkspace?.tenant_id || currentWorkspace?.tenant_id === 'default'}>
                    💀 Delete Entire Tenant
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DatabaseManager;
