import React, { useState, useEffect } from 'react';
import './ConnectionStatus.css';
import axios from 'axios';

// Use relative URL - the proxy (setupProxy.js) forwards /api to the server
const API_BASE_URL = '/api';

const ConnectionStatus = ({ compact = false }) => {
  const [connectionStatus, setConnectionStatus] = useState({
    neo4j: { connected: null, message: 'Checking...' },
    redis: { connected: null, message: 'Checking...' },
    loading: true
  });
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);

  const checkConnection = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/graph/connection`);
      setConsecutiveErrors(0);
      setConnectionStatus({
        neo4j: {
          connected: response.data.connected,
          message: response.data.message,
          uri: response.data.uri,
          user: response.data.user,
          database: response.data.database,
          error: response.data.error
        },
        redis: response.data.redis || { connected: false, message: 'No Redis info' },
        loading: false
      });
    } catch (error) {
      setConsecutiveErrors(prev => prev + 1);
      setConnectionStatus({
        neo4j: {
          connected: false,
          message: 'Failed to check connection',
          error: error.message
        },
        redis: { connected: false, message: 'Failed to check' },
        loading: false
      });
    }
  };

  useEffect(() => {
    checkConnection();
    // Poll every 60s normally, back off to 5min after 3 consecutive errors
    const intervalMs = consecutiveErrors >= 3 ? 300000 : 60000;
    const interval = setInterval(checkConnection, intervalMs);
    return () => clearInterval(interval);
  }, [consecutiveErrors]);

  const getStatusClass = (connected) => {
    if (connected === null) return 'checking';
    return connected ? 'connected' : 'disconnected';
  };

  // Compact mode for sidebar
  if (compact) {
    return (
      <div className="connection-status-compact" onClick={checkConnection} title="Click to refresh">
        <div className={`compact-dot ${getStatusClass(connectionStatus.neo4j.connected)}`}></div>
        <div className={`compact-dot ${getStatusClass(connectionStatus.redis.connected)}`}></div>
      </div>
    );
  }

  return (
    <div className="connection-status-container">
      {/* Neo4j Status */}
      <div className={`connection-status ${getStatusClass(connectionStatus.neo4j.connected)}`}>
        <div className="status-indicator">
          <span className={`status-dot ${getStatusClass(connectionStatus.neo4j.connected)}`}>●</span>
          <span className="status-text">
            {connectionStatus.loading 
              ? 'Checking...' 
              : connectionStatus.neo4j.connected 
                ? 'Neo4j' 
                : 'Neo4j Offline'}
          </span>
        </div>
      </div>

      {/* Redis Status */}
      <div className={`connection-status ${getStatusClass(connectionStatus.redis.connected)}`}>
        <div className="status-indicator">
          <span className={`status-dot ${getStatusClass(connectionStatus.redis.connected)}`}>●</span>
          <span className="status-text">
            {connectionStatus.loading 
              ? 'Checking...' 
              : connectionStatus.redis.connected 
                ? 'Redis' 
                : 'Redis Offline'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default ConnectionStatus;
