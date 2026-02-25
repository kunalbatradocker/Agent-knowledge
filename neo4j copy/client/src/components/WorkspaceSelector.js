/**
 * Workspace Selector Component
 * Displays current tenant/workspace and allows switching
 * Creation is handled in Administration panel
 */

import React, { useState, useMemo } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';
import './WorkspaceSelector.css';

function WorkspaceSelector({ compact = false }) {
  const {
    tenants,
    workspaces,
    currentTenant,
    currentWorkspace,
    loading,
    initialized,
    switchTenant,
    switchWorkspace
  } = useTenant();
  const { user } = useAuth();

  const [showDropdown, setShowDropdown] = useState(false);

  // Filter workspaces by user's allowed workspaces (defense-in-depth)
  const filteredWorkspaces = useMemo(() => {
    if (!user || user.role === 'admin') return workspaces;
    const userWorkspaces = user.workspaces || [];
    if (userWorkspaces.length === 0) return workspaces;
    return workspaces.filter(w => userWorkspaces.includes(w.workspace_id));
  }, [workspaces, user]);

  if (loading || !initialized) {
    return (
      <div className={`workspace-selector ${compact ? 'compact' : ''}`}>
        <div className="ws-loading">Loading...</div>
      </div>
    );
  }

  // No tenants exist yet - show hint to go to admin
  if (!tenants || tenants.length === 0) {
    return (
      <div className={`workspace-selector ${compact ? 'compact' : ''} ws-warning`}>
        <div className="ws-no-tenant" title="Go to Administration to create a tenant">
          {compact ? '⚠️' : '⚠️ No tenant configured'}
        </div>
      </div>
    );
  }

  // Tenant exists but no workspace selected
  const hasWorkspaceIssue = !currentWorkspace;

  return (
    <div className={`workspace-selector ${compact ? 'compact' : ''} ${hasWorkspaceIssue ? 'ws-warning' : ''}`}>
      <button 
        className={`ws-current ${hasWorkspaceIssue ? 'warning' : ''}`}
        onClick={() => setShowDropdown(!showDropdown)}
        title={hasWorkspaceIssue 
          ? 'No workspace selected - select one to enable uploads' 
          : `${currentTenant?.name || 'No tenant'} / ${currentWorkspace?.name || 'No workspace'}`
        }
      >
        <span className="ws-icon">{hasWorkspaceIssue ? '⚠️' : '🏢'}</span>
        {!compact && (
          <div className="ws-info">
            <span className="ws-tenant">{currentTenant?.name || 'Select Tenant'}</span>
            <span className={`ws-workspace ${hasWorkspaceIssue ? 'warning-text' : ''}`}>
              {currentWorkspace?.name || 'Select workspace'}
            </span>
          </div>
        )}
        <span className="ws-arrow">{showDropdown ? '▲' : '▼'}</span>
      </button>

      {showDropdown && (
        <div className="ws-dropdown">
          {/* Tenant Section */}
          <div className="ws-section">
            <div className="ws-section-header">
              <span>🏢 Tenant</span>
            </div>
            <div className="ws-list">
              {tenants.map(tenant => (
                <button
                  key={tenant.tenant_id}
                  className={`ws-item ${currentTenant?.tenant_id === tenant.tenant_id ? 'active' : ''}`}
                  onClick={() => { switchTenant(tenant.tenant_id); }}
                >
                  <span className="ws-item-name">{tenant.name}</span>
                  <span className="ws-item-count">{tenant.workspaceCount || 0} workspaces</span>
                </button>
              ))}
            </div>
          </div>

          {/* Workspace Section */}
          {currentTenant && (
            <div className="ws-section">
              <div className="ws-section-header">
                <span>📁 Workspace</span>
              </div>
              {filteredWorkspaces.length === 0 ? (
                <div className="ws-empty">
                  No workspaces. Create one in Administration.
                </div>
              ) : (
                <div className="ws-list">
                  {filteredWorkspaces.map(workspace => (
                    <button
                      key={workspace.workspace_id}
                      className={`ws-item ${currentWorkspace?.workspace_id === workspace.workspace_id ? 'active' : ''}`}
                      onClick={() => { switchWorkspace(workspace.workspace_id); setShowDropdown(false); }}
                    >
                      <span className="ws-item-name">{workspace.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          
          <div className="ws-footer">
            <span className="ws-footer-hint">Manage in Administration → Tenants</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceSelector;
