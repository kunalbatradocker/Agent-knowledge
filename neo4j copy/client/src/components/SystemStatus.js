/**
 * SystemStatus — Shows live connectivity status of all external systems.
 * Polls /api/health and displays each service with status, details, and latency.
 */
import { useState, useEffect, useCallback } from 'react';
import './SystemStatus.css';

function SystemStatus() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try {
      const start = Date.now();
      const res = await fetch('/api/health');
      const data = await res.json();
      data._latencyMs = Date.now() - start;
      setHealth(data);
      setLastChecked(new Date());
    } catch (e) {
      setHealth({ status: 'error', error: e.message, connections: {} });
      setLastChecked(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchHealth, 15000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchHealth]);

  const connections = health?.connections || {};

  const services = [
    {
      key: 'api',
      name: 'API Server',
      icon: '🖥️',
      connected: health?.status === 'ok',
      details: health ? `Port ${window.location.port || '—'} • ${health._latencyMs}ms` : null,
      info: health?.message
    },
    {
      key: 'graphdb',
      name: 'GraphDB (RDF/SPARQL)',
      icon: '🔷',
      connected: connections.graphdb?.connected,
      details: connections.graphdb?.url,
      info: connections.graphdb?.repository ? `Repository: ${connections.graphdb.repository}` : connections.graphdb?.message
    },
    {
      key: 'neo4j',
      name: 'Neo4j (Graph Analytics)',
      icon: '🟢',
      connected: connections.neo4j?.connected,
      details: connections.neo4j?.uri,
      info: connections.neo4j?.database ? `Database: ${connections.neo4j.database}` : connections.neo4j?.message
    },
    {
      key: 'redis',
      name: 'Redis (Vectors/Cache)',
      icon: '🔴',
      connected: connections.redis?.connected,
      details: connections.redis?.url,
      info: connections.redis?.message
    },
    {
      key: 'trino',
      name: 'Trino (Federated SQL)',
      icon: '🌐',
      connected: connections.trino?.connected,
      details: connections.trino?.version ? `v${connections.trino.version}` : null,
      info: connections.trino?.connected ? `Uptime: ${connections.trino.uptime || '—'}` : connections.trino?.error || 'Not running'
    },
    {
      key: 'ollama',
      name: 'Ollama (Local LLM)',
      icon: '🧠',
      connected: connections.ollama?.connected,
      details: connections.ollama?.configuredModel,
      info: connections.ollama?.message
    }
  ];

  const connectedCount = services.filter(s => s.connected).length;
  const totalCount = services.length;

  return (
    <div className="ss-container">
      <div className="ss-header">
        <div className="ss-header-left">
          <h3>System Status</h3>
          <span className={`ss-overall ${connectedCount === totalCount ? 'all-ok' : connectedCount > 2 ? 'partial' : 'down'}`}>
            {connectedCount}/{totalCount} connected
          </span>
        </div>
        <div className="ss-header-right">
          <label className="ss-auto-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Auto-refresh (15s)
          </label>
          <button className="ss-refresh-btn" onClick={fetchHealth} disabled={loading}>
            {loading ? '⏳' : '🔄'} Check Now
          </button>
        </div>
      </div>

      {lastChecked && (
        <p className="ss-last-checked">Last checked: {lastChecked.toLocaleTimeString()}</p>
      )}

      <div className="ss-grid">
        {services.map(svc => (
          <div key={svc.key} className={`ss-card ${svc.connected ? 'connected' : 'disconnected'}`}>
            <div className="ss-card-header">
              <span className="ss-card-icon">{svc.icon}</span>
              <div className="ss-card-title">
                <span className="ss-card-name">{svc.name}</span>
                {svc.details && <span className="ss-card-details">{svc.details}</span>}
              </div>
              <span className={`ss-status-dot ${svc.connected ? 'on' : 'off'}`} title={svc.connected ? 'Connected' : 'Disconnected'} />
            </div>
            <div className="ss-card-body">
              <span className={`ss-status-label ${svc.connected ? 'ok' : 'err'}`}>
                {svc.connected ? '● Connected' : '○ Disconnected'}
              </span>
              {svc.info && <span className="ss-card-info">{svc.info}</span>}
            </div>
          </div>
        ))}
      </div>

      {health?.connections?.ollama?.models?.length > 0 && (
        <div className="ss-extra">
          <h4>Available Ollama Models</h4>
          <div className="ss-model-list">
            {health.connections.ollama.models.map((m, i) => (
              <span key={i} className={`ss-model-tag ${health.connections.ollama.configuredModel && m.includes(health.connections.ollama.configuredModel.split(':')[0]) ? 'active' : ''}`}>
                {m}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default SystemStatus;
