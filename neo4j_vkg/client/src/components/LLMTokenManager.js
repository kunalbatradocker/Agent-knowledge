/**
 * LLM Token Manager - Per-user Bedrock bearer token management
 * Accessible to all authenticated users (viewer and above)
 */
import React, { useState, useEffect, useCallback } from 'react';
import './LLMTokenManager.css';

const API_BASE_URL = '/api';

function LLMTokenManager({ onClose }) {
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/llm-token/status`);
      if (res.ok) setTokenStatus(await res.json());
    } catch (e) { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/llm-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: data.message });
        setTokenInput('');
        fetchStatus();
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to save token' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setSaving(false);
  };

  const removeToken = async () => {
    if (!window.confirm('Remove your Bedrock token?')) return;
    try {
      await fetch(`${API_BASE_URL}/auth/llm-token`, { method: 'DELETE' });
      setMessage({ type: 'success', text: 'Token removed' });
      fetchStatus();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
  };

  const formatRemaining = (seconds) => {
    if (!seconds || seconds <= 0) return 'Expired';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m remaining`;
    return `${m}m remaining`;
  };

  if (loading) return <div className="ltm-overlay"><div className="ltm-panel"><p>Loading...</p></div></div>;

  return (
    <div className="ltm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ltm-panel" role="dialog" aria-label="LLM Token Manager">
        <div className="ltm-header">
          <h3>🔑 LLM Token</h3>
          <button className="ltm-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="ltm-desc">Add your AWS Bedrock bearer token to use AI features like chat, extraction, and ontology generation.</p>

        <div className="ltm-status-row">
          <div className={`ltm-status-card ${tokenStatus?.server?.hasToken ? (tokenStatus.server.expired ? 'expired' : 'active') : 'none'}`}>
            <span className="ltm-status-label">Server</span>
            <span className="ltm-status-value">
              {!tokenStatus?.server?.hasToken ? 'Not set' :
               tokenStatus.server.expired ? '⛔ Expired' :
               `✅ ${formatRemaining(tokenStatus.server.remainingSeconds)}`}
            </span>
          </div>
          <div className={`ltm-status-card ${tokenStatus?.user?.hasToken ? (tokenStatus.user.expired ? 'expired' : 'active') : 'none'}`}>
            <span className="ltm-status-label">Your Token</span>
            <span className="ltm-status-value">
              {!tokenStatus?.user?.hasToken ? 'Not set' :
               tokenStatus.user.expired ? '⛔ Expired' :
               `✅ ${formatRemaining(tokenStatus.user.remainingSeconds)}`}
            </span>
            {tokenStatus?.user?.hasToken && (
              <button className="ltm-remove" onClick={removeToken} title="Remove">✕</button>
            )}
          </div>
        </div>

        <div className="ltm-info-row">
          <span>Provider: {tokenStatus?.provider || '—'}</span>
          <span>Model: {tokenStatus?.model?.split('/').pop()?.split(':')[0] || '—'}</span>
        </div>

        <div className="ltm-input-section">
          <textarea
            className="ltm-input"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder="Paste your AWS Bedrock bearer token here..."
            rows={3}
          />
          <button className="ltm-save-btn" onClick={saveToken} disabled={saving || !tokenInput.trim()}>
            {saving ? '⏳ Saving...' : '💾 Save Token'}
          </button>
        </div>

        {message && (
          <div className={`ltm-message ${message.type}`}>{message.text}</div>
        )}
      </div>
    </div>
  );
}

export default LLMTokenManager;
