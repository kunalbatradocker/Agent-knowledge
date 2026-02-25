/**
 * useApi Hook
 * Centralized API call handling with loading/error states
 * Auto-injects tenant/workspace headers from TenantContext
 */

import { useState, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';

const API_BASE_URL = '/api';

/**
 * Custom hook for making API calls with consistent error handling
 * Automatically injects X-Tenant-Id and X-Workspace-Id headers
 * @param {string} baseUrl - Base URL for API calls (default: /api)
 */
export function useApi(baseUrl = API_BASE_URL) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { getTenantHeaders } = useTenant();

  /**
   * Merge tenant headers with any custom headers
   */
  const mergeHeaders = useCallback((customHeaders = {}) => {
    return {
      ...getTenantHeaders(),
      ...customHeaders
    };
  }, [getTenantHeaders]);

  /**
   * Make a GET request
   */
  const get = useCallback(async (endpoint, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const url = new URL(`${baseUrl}${endpoint}`, window.location.origin);
      
      // Add query params if provided
      if (options.params) {
        Object.entries(options.params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            url.searchParams.append(key, value);
          }
        });
      }
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...mergeHeaders(options.headers)
        },
        credentials: 'same-origin'
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mergeHeaders]);

  /**
   * Make a POST request
   */
  const post = useCallback(async (endpoint, body, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...mergeHeaders(options.headers)
        },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mergeHeaders]);

  /**
   * Make a PUT request
   */
  const put = useCallback(async (endpoint, body, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...mergeHeaders(options.headers)
        },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mergeHeaders]);

  /**
   * Make a DELETE request
   */
  const del = useCallback(async (endpoint, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...mergeHeaders(options.headers)
        },
        credentials: 'same-origin',
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mergeHeaders]);

  /**
   * Upload a file
   */
  const upload = useCallback(async (endpoint, file, additionalData = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      // Add additional form data
      Object.entries(additionalData).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          formData.append(key, value);
        }
      });
      
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: mergeHeaders(),
        credentials: 'same-origin',
        body: formData
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mergeHeaders]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    get,
    post,
    put,
    del,
    upload,
    clearError
  };
}

export default useApi;
