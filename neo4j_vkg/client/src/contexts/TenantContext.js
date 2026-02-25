/**
 * Tenant Context
 * Manages tenant/workspace state globally across the application
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API_BASE_URL = '/api';

const TenantContext = createContext(null);

export function TenantProvider({ children }) {
  const [tenants, setTenants] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [currentTenant, setCurrentTenant] = useState(null);
  const [currentWorkspace, setCurrentWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [initialized, setInitialized] = useState(false);

  // Load tenants on mount
  const loadTenants = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/tenants`);
      // API returns { success: true, tenants: [...] }
      const tenantList = response.data?.tenants || response.data || [];
      setTenants(tenantList);
      
      // Restore from localStorage or use first tenant
      const savedTenantId = localStorage.getItem('currentTenantId');
      const savedWorkspaceId = localStorage.getItem('currentWorkspaceId');
      
      if (savedTenantId) {
        const tenant = tenantList.find(t => t.tenant_id === savedTenantId);
        if (tenant) {
          setCurrentTenant(tenant);
          await loadWorkspacesForTenant(savedTenantId, savedWorkspaceId);
          setInitialized(true);
          return;
        }
      }
      
      // Default to first tenant if available (this will be the default tenant)
      if (tenantList.length > 0) {
        const defaultTenant = tenantList.find(t => t.is_default) || tenantList[0];
        setCurrentTenant(defaultTenant);
        localStorage.setItem('currentTenantId', defaultTenant.tenant_id);
        await loadWorkspacesForTenant(defaultTenant.tenant_id);
      }
      
      setInitialized(true);
    } catch (err) {
      console.error('Error loading tenants:', err);
      // Don't set error for 404 or empty state - just means no tenants yet
      if (err.response?.status !== 404) {
        setError('Failed to load tenants');
      }
      setInitialized(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWorkspacesForTenant = async (tenantId, preferredWorkspaceId = null) => {
    try {
      const response = await axios.get(`${API_BASE_URL}/tenants/${tenantId}/workspaces`);
      // API returns { success: true, workspaces: [...] }
      const workspaceList = response.data?.workspaces || response.data || [];
      setWorkspaces(workspaceList);
      
      // Select preferred workspace or first one
      if (preferredWorkspaceId) {
        const workspace = workspaceList.find(w => w.workspace_id === preferredWorkspaceId);
        if (workspace) {
          setCurrentWorkspace(workspace);
          localStorage.setItem('currentWorkspaceId', workspace.workspace_id);
          return;
        }
      }
      
      // Auto-select default workspace or first one
      if (workspaceList.length > 0) {
        const defaultWorkspace = workspaceList.find(w => w.is_default) || workspaceList[0];
        setCurrentWorkspace(defaultWorkspace);
        localStorage.setItem('currentWorkspaceId', defaultWorkspace.workspace_id);
      } else {
        setCurrentWorkspace(null);
        localStorage.removeItem('currentWorkspaceId');
      }
    } catch (err) {
      console.error('Error loading workspaces:', err);
      setWorkspaces([]);
      setCurrentWorkspace(null);
    }
  };

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  // Switch tenant
  const switchTenant = async (tenantId) => {
    const tenant = tenants.find(t => t.tenant_id === tenantId);
    if (tenant) {
      setCurrentTenant(tenant);
      localStorage.setItem('currentTenantId', tenantId);
      await loadWorkspacesForTenant(tenantId);
    }
  };

  // Switch workspace
  const switchWorkspace = (workspaceId) => {
    const workspace = workspaces.find(w => w.workspace_id === workspaceId);
    if (workspace) {
      setCurrentWorkspace(workspace);
      localStorage.setItem('currentWorkspaceId', workspaceId);
    }
  };

  // Create tenant
  const createTenant = async (tenantData) => {
    const response = await axios.post(`${API_BASE_URL}/tenants`, tenantData);
    await loadTenants();
    return response.data;
  };

  // Create workspace
  const createWorkspace = async (tenantId, workspaceData) => {
    const response = await axios.post(`${API_BASE_URL}/tenants/${tenantId}/workspaces`, workspaceData);
    await loadWorkspacesForTenant(tenantId);
    return response.data;
  };

  // Delete tenant
  const deleteTenant = async (tenantId, cascade = false) => {
    await axios.delete(`${API_BASE_URL}/tenants/${tenantId}${cascade ? '?cascade=true' : ''}`);
    await loadTenants();
    if (currentTenant?.tenant_id === tenantId) {
      setCurrentTenant(tenants[0] || null);
      setCurrentWorkspace(null);
    }
  };

  // Delete workspace
  const deleteWorkspace = async (tenantId, workspaceId, cascade = false) => {
    await axios.delete(`${API_BASE_URL}/tenants/${tenantId}/workspaces/${workspaceId}${cascade ? '?cascade=true' : ''}`);
    await loadWorkspacesForTenant(tenantId);
    if (currentWorkspace?.workspace_id === workspaceId) {
      setCurrentWorkspace(workspaces[0] || null);
    }
  };

  // Get headers for API requests
  const getTenantHeaders = useCallback(() => {
    const headers = {};
    if (currentTenant?.tenant_id) {
      headers['X-Tenant-Id'] = currentTenant.tenant_id;
    }
    if (currentWorkspace?.workspace_id) {
      headers['X-Workspace-Id'] = currentWorkspace.workspace_id;
    }
    return headers;
  }, [currentTenant?.tenant_id, currentWorkspace?.workspace_id]);

  // Get context for API request body
  const getTenantContext = () => ({
    tenant_id: currentTenant?.tenant_id || null,
    workspace_id: currentWorkspace?.workspace_id || null
  });

  // Check if workspace is selected (for validation before operations)
  const isWorkspaceSelected = () => {
    return !!(currentTenant?.tenant_id && currentWorkspace?.workspace_id);
  };

  // Get a message explaining why workspace is required
  const getWorkspaceRequiredMessage = () => {
    if (!currentTenant) {
      return 'Please select a tenant first. Go to Administration → Tenants to create one.';
    }
    if (!currentWorkspace) {
      return 'Please select a workspace. Go to Administration → Tenants to create one.';
    }
    return null;
  };

  const value = {
    tenants,
    workspaces,
    currentTenant,
    currentWorkspace,
    loading,
    error,
    initialized,
    switchTenant,
    switchWorkspace,
    createTenant,
    createWorkspace,
    deleteTenant,
    deleteWorkspace,
    getTenantHeaders,
    getTenantContext,
    isWorkspaceSelected,
    getWorkspaceRequiredMessage,
    refresh: loadTenants
  };

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant() {
  const context = useContext(TenantContext);
  if (!context) {
    // Return safe defaults if context not available (during initial render)
    return {
      tenants: [],
      workspaces: [],
      currentTenant: null,
      currentWorkspace: null,
      loading: true,
      error: null,
      initialized: false,
      switchTenant: () => {},
      switchWorkspace: () => {},
      createTenant: async () => {},
      createWorkspace: async () => {},
      deleteTenant: async () => {},
      deleteWorkspace: async () => {},
      getTenantHeaders: () => ({}),
      getTenantContext: () => ({ tenant_id: null, workspace_id: null }),
      isWorkspaceSelected: () => false,
      getWorkspaceRequiredMessage: () => 'Tenant context not available',
      refresh: () => {}
    };
  }
  return context;
}

export default TenantContext;
