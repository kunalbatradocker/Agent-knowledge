import React, { useState, useEffect, useCallback } from 'react';

export default function SyncStatus() {
  const [status, setStatus] = useState(null);
  const [polling, setPolling] = useState(false);
  const [mode, setMode] = useState('full');

  const fetchStatus = useCallback(async () => {
    const res = await fetch('/api/sync/status');
    const data = await res.json();
    setStatus(data);
    return data;
  }, []);

  const triggerSync = async (type = 'all') => {
    await fetch('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, mode })
    });
    setPolling(true);
  };

  const removeOrphans = async () => {
    if (!window.confirm('Remove entities from Neo4j that no longer exist in GraphDB?')) return;
    const res = await fetch('/api/sync/remove-orphans', { method: 'POST' });
    const data = await res.json();
    alert(data.success ? `Removed ${data.deleted} orphaned entities` : `Error: ${data.error}`);
  };

  // Poll while running
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      const data = await fetchStatus();
      if (data.status !== 'running') setPolling(false);
    }, 1000);
    return () => clearInterval(interval);
  }, [polling, fetchStatus]);

  if (!status) return <div>Loading...</div>;

  return (
    <div className="sync-status" style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3>GraphDB → Neo4j Sync</h3>
      
      <div style={{ marginBottom: '1rem' }}>
        <strong>Status:</strong>{' '}
        <span style={{ 
          color: status.status === 'completed' ? 'green' : 
                 status.status === 'failed' ? 'red' : 
                 status.status === 'running' ? 'blue' : 'gray' 
        }}>
          {status.status}
        </span>
        {status.message && <span> - {status.message}</span>}
      </div>

      {status.status === 'running' && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ background: '#eee', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ 
              width: `${status.progress}%`, 
              background: '#4CAF50', 
              height: '20px',
              transition: 'width 0.3s'
            }} />
          </div>
          <small>{status.progress}%</small>
        </div>
      )}

      {status.error && (
        <div style={{ color: 'red', marginBottom: '1rem' }}>Error: {status.error}</div>
      )}

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ marginRight: '1rem' }}>
          <input type="radio" name="mode" value="full" checked={mode === 'full'} onChange={() => setMode('full')} />
          {' '}Full Sync <small>(clears & rebuilds)</small>
        </label>
        <label>
          <input type="radio" name="mode" value="incremental" checked={mode === 'incremental'} onChange={() => setMode('incremental')} />
          {' '}Incremental <small>(add/update only)</small>
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => triggerSync('all')} disabled={status.status === 'running'}>
          Sync All
        </button>
        <button onClick={() => triggerSync('schema')} disabled={status.status === 'running'}>
          Schema Only
        </button>
        <button onClick={() => triggerSync('instances')} disabled={status.status === 'running'}>
          Instances Only
        </button>
        <button onClick={removeOrphans} disabled={status.status === 'running'} style={{ background: '#ff9800', color: '#fff', border: 'none' }}>
          🧹 Remove Orphans
        </button>
      </div>

      {status.completedAt && (
        <small style={{ display: 'block', marginTop: '0.5rem', color: '#666' }}>
          Last sync: {new Date(status.completedAt).toLocaleString()}
        </small>
      )}

      {status.stats && (
        <pre style={{ marginTop: '0.5rem', fontSize: '11px', background: '#f5f5f5', padding: '0.5rem', borderRadius: '4px' }}>
          {JSON.stringify(status.stats, null, 2)}
        </pre>
      )}
    </div>
  );
}
