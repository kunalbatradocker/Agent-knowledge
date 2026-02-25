import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

// --- Axios defaults: attach CSRF header to all state-changing requests ---
axios.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';

// Patch global fetch to attach auth token + CSRF header to /api requests
// Also handles 401 retry via refresh token (mirrors the axios interceptor)
// Uses a shared refresh promise so fetch and axios don't race each other
let _sharedRefreshPromise = null;

function getSharedRefreshPromise() { return _sharedRefreshPromise; }
function setSharedRefreshPromise(p) { _sharedRefreshPromise = p; }

const _origFetch = window.fetch;
window.fetch = async (url, options = {}) => {
  if (typeof url === 'string' && url.startsWith('/api')) {
    const token = localStorage.getItem('token');
    options.headers = {
      ...options.headers,
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const response = await _origFetch(url, options);

    // Auto-retry on 401 (token expired) — skip for auth endpoints
    if (response.status === 401 && !url.includes('/auth/refresh') && !url.includes('/auth/login')) {
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) {
        // Deduplicate: share the same promise across fetch and axios
        if (!_sharedRefreshPromise) {
          _sharedRefreshPromise = _origFetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ refreshToken })
          })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (data?.token) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('refreshToken', data.refreshToken);
              }
              return data;
            })
            .catch(() => null)
            .finally(() => { _sharedRefreshPromise = null; });
        }
        const refreshed = await _sharedRefreshPromise;
        if (refreshed?.token) {
          // Retry original request with new token
          options.headers = { ...options.headers, Authorization: `Bearer ${refreshed.token}` };
          return _origFetch(url, options);
        }
      }
    }

    return response;
  }
  return _origFetch(url, options);
};

// Attach token to every axios request
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Try to refresh the access token using the stored refresh token
  const refreshAccessToken = useCallback(async () => {
    // Use the shared refresh promise to avoid racing with the fetch wrapper
    if (_sharedRefreshPromise) return _sharedRefreshPromise;

    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return null;

    const promise = axios.post('/api/auth/refresh', { refreshToken })
      .then(({ data }) => {
        localStorage.setItem('token', data.token);
        localStorage.setItem('refreshToken', data.refreshToken);
        setUser(data.user);
        return data;
      })
      .catch(() => {
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        setUser(null);
        return null;
      })
      .finally(() => { setSharedRefreshPromise(null); });

    setSharedRefreshPromise(promise);
    return promise;
  }, []);

  // Auto-refresh on 401: try refresh token before logging out
  useEffect(() => {
    const id = axios.interceptors.response.use(
      (res) => res,
      async (err) => {
        const originalRequest = err.config;
        if (
          err.response?.status === 401 &&
          !originalRequest._retry &&
          !originalRequest.url?.includes('/auth/refresh') &&
          !originalRequest.url?.includes('/auth/login')
        ) {
          originalRequest._retry = true;
          const refreshed = await refreshAccessToken();
          if (refreshed) {
            originalRequest.headers.Authorization = `Bearer ${refreshed.token}`;
            return axios(originalRequest);
          }
        }
        // If refresh also failed, clear everything
        if (err.response?.status === 401 && localStorage.getItem('token')) {
          localStorage.removeItem('token');
          localStorage.removeItem('refreshToken');
          setUser(null);
        }
        return Promise.reject(err);
      }
    );
    return () => axios.interceptors.response.eject(id);
  }, [refreshAccessToken]);

  // Check existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    axios.get('/api/auth/me')
      .then(res => setUser(res.data))
      .catch(async () => {
        // Token expired — try refresh
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
          localStorage.removeItem('token');
          localStorage.removeItem('refreshToken');
        }
      })
      .finally(() => setLoading(false));
  }, [refreshAccessToken]);

  const login = useCallback(async (email, password) => {
    const { data } = await axios.post('/api/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('refreshToken', data.refreshToken);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    // Best-effort server-side revocation
    try { await axios.post('/api/auth/logout', { refreshToken }); } catch {}
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    setUser(null);
  }, []);

  const changePassword = useCallback(async (password) => {
    await axios.put('/api/auth/me/password', { password });
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
