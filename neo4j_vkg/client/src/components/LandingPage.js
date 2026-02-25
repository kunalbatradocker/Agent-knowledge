/**
 * Landing Page - Purple Fabric Theme
 * Shows workspace cards. Clicking a card enters the main app for that workspace.
 */

import React, { useMemo } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';
import './LandingPage.css';

const WORKSPACE_ICONS = ['📊', '🔐', '🏦', '📋', '🏠', '⚖️', '🧬', '📦', '🔍', '💼'];

function getWorkspaceIcon(index, name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('pii') || lower.includes('personal')) return '🔒';
  if (lower.includes('ekg') || lower.includes('knowledge') || lower.includes('metadata')) return '📊';
  if (lower.includes('mortgage') || lower.includes('retail')) return '🏠';
  if (lower.includes('bank') || lower.includes('finance')) return '🏦';
  if (lower.includes('legal') || lower.includes('contract')) return '⚖️';
  if (lower.includes('aml') || lower.includes('compliance')) return '🔍';
  if (lower.includes('resume') || lower.includes('hr')) return '💼';
  return WORKSPACE_ICONS[index % WORKSPACE_ICONS.length];
}

function LandingPage({ onSelectWorkspace }) {
  const {
    tenants,
    workspaces,
    currentTenant,
    loading,
    initialized,
    switchTenant,
  } = useTenant();
  const { user } = useAuth();

  // Filter workspaces by user's allowed workspaces (defense-in-depth — backend also filters)
  const filteredWorkspaces = useMemo(() => {
    if (!user || user.role === 'admin') return workspaces;
    const userWorkspaces = user.workspaces || [];
    if (userWorkspaces.length === 0) return workspaces; // empty = all access (backward compat)
    return workspaces.filter(w => userWorkspaces.includes(w.workspace_id));
  }, [workspaces, user]);

  if (loading || !initialized) {
    return (
      <div className="landing-page">
        <LandingHeader />
        <div className="landing-content">
          <div className="landing-loading">
            <div className="landing-loading-spinner" />
            <p>Loading workspaces...</p>
          </div>
        </div>
        <LandingFooter />
      </div>
    );
  }

  return (
    <div className="landing-page">
      <LandingHeader />

      <div className="landing-content">
        {/* Tenant selector if multiple tenants */}
        {tenants.length > 1 && (
          <div style={{ marginBottom: 24, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#6B7280' }}>Tenant:</span>
            <select
              value={currentTenant?.tenant_id || ''}
              onChange={e => switchTenant(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid #E5E7EB',
                fontSize: 13,
                color: '#1F2937',
                background: '#fff',
              }}
            >
              {tenants.map(t => (
                <option key={t.tenant_id} value={t.tenant_id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        {filteredWorkspaces.length === 0 ? (
          <div className="landing-empty">
            <div className="landing-empty-icon">📂</div>
            <h2>No workspaces yet</h2>
            <p>Create a workspace in the Administration panel to get started.</p>
          </div>
        ) : (
          <div className="workspace-cards">
            {filteredWorkspaces.map((workspace, idx) => (
              <div
                key={workspace.workspace_id}
                className="workspace-card"
                onClick={() => onSelectWorkspace(workspace)}
                role="button"
                tabIndex={0}
                aria-label={`Open ${workspace.name} workspace`}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelectWorkspace(workspace); }}
              >
                <div className="workspace-card-icon">
                  {getWorkspaceIcon(idx, workspace.name)}
                </div>
                <div className="workspace-card-title">{workspace.name}</div>
                <div className="workspace-card-desc">
                  {workspace.description || `${workspace.name} workspace`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <LandingFooter />
    </div>
  );
}

function LandingHeader() {
  return (
    <header className="landing-header">
      <div className="landing-logo">
        <img src="/logo_pf.svg" alt="Purple Fabric" className="landing-logo-img" />
      </div>

      <div className="landing-tagline">Agentic Intelligence, Powered by Purple Fabric</div>

      {/* Right side intentionally empty for now */}
      <div className="landing-header-spacer" />
    </header>
  );
}

function LandingFooter() {
  return (
    <footer className="landing-footer">
      AI-powered document processing with semantic web technologies
    </footer>
  );
}

export default LandingPage;
