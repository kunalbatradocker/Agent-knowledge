import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './HealthDashboard.css';

const API_BASE_URL = '/api';

function HealthDashboard() {
  const { currentWorkspace } = useTenant();
  const [metrics, setMetrics] = useState(null);
  const [timeseries, setTimeseries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedMetric, setSelectedMetric] = useState('extraction_success');

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      
      const response = await fetch(`${API_BASE_URL}/metrics/health?${params}`);
      const data = await response.json();
      
      if (data.success) {
        setMetrics(data.metrics);
      } else {
        setError(data.error || 'Failed to load metrics');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace]);

  const fetchTimeseries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.append('metric', selectedMetric);
      params.append('days', '30');
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      
      const response = await fetch(`${API_BASE_URL}/metrics/timeseries?${params}`);
      const data = await response.json();
      
      if (data.success) {
        setTimeseries(data.data);
      }
    } catch (err) {
      console.error('Error fetching timeseries:', err);
    }
  }, [currentWorkspace, selectedMetric]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    fetchTimeseries();
  }, [fetchTimeseries]);

  const formatNumber = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num?.toString() || '0';
  };

  const formatPercent = (num) => {
    return (num * 100).toFixed(1) + '%';
  };

  const getSuccessRateColor = (rate) => {
    if (rate >= 0.9) return 'excellent';
    if (rate >= 0.7) return 'good';
    if (rate >= 0.5) return 'warning';
    return 'critical';
  };

  const getCoverageColor = (percent) => {
    if (percent >= 80) return 'excellent';
    if (percent >= 60) return 'good';
    if (percent >= 40) return 'warning';
    return 'critical';
  };

  if (loading) {
    return (
      <div className="health-dashboard loading">
        <div className="spinner"></div>
        <p>Loading health metrics...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="health-dashboard error">
        <span className="error-icon">⚠️</span>
        <p>{error}</p>
        <button onClick={fetchMetrics}>Retry</button>
      </div>
    );
  }

  return (
    <div className="health-dashboard">
      <div className="dashboard-header">
        <div className="header-content">
          <h1>Health Dashboard</h1>
          <p>Monitor extraction performance and graph health</p>
        </div>
        <button className="refresh-btn" onClick={fetchMetrics}>
          🔄 Refresh
        </button>
      </div>

      <div className="metrics-grid">
        {/* Extraction Success Rate */}
        <div className="metric-card primary">
          <div className="metric-header">
            <span className="metric-icon">📊</span>
            <span className="metric-title">Extraction Success Rate</span>
          </div>
          <div className={`metric-value ${getSuccessRateColor(metrics?.extraction?.success_rate || 0)}`}>
            {formatPercent(metrics?.extraction?.success_rate || 0)}
          </div>
          <div className="metric-details">
            <span>{metrics?.extraction?.successful || 0} successful</span>
            <span>{metrics?.extraction?.failed || 0} failed</span>
          </div>
        </div>

        {/* Total Entities */}
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-icon">🏷️</span>
            <span className="metric-title">Total Entities</span>
          </div>
          <div className="metric-value">
            {formatNumber(metrics?.entities?.current_count || 0)}
          </div>
          <div className="metric-details">
            <span>{formatNumber(metrics?.entities?.total_created || 0)} created total</span>
          </div>
        </div>

        {/* Relationships */}
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-icon">🔗</span>
            <span className="metric-title">Relationships</span>
          </div>
          <div className="metric-value">
            {formatNumber(metrics?.relationships?.current_count || 0)}
          </div>
          <div className="metric-details">
            <span>{formatNumber(metrics?.relationships?.total_created || 0)} created total</span>
          </div>
        </div>

        {/* Documents Processed */}
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-icon">📄</span>
            <span className="metric-title">Documents</span>
          </div>
          <div className="metric-value">
            {formatNumber(metrics?.graph?.documents || 0)}
          </div>
          <div className="metric-details">
            <span>{formatNumber(metrics?.graph?.chunks || 0)} chunks</span>
          </div>
        </div>

        {/* Average Confidence */}
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-icon">🎯</span>
            <span className="metric-title">Avg Confidence</span>
          </div>
          <div className="metric-value">
            {formatPercent(metrics?.entities?.avg_confidence || 0)}
          </div>
          <div className="metric-details">
            <span>Across all extractions</span>
          </div>
        </div>

        {/* Ontology Coverage */}
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-icon">📚</span>
            <span className="metric-title">Ontology Coverage</span>
          </div>
          <div className={`metric-value ${getCoverageColor(metrics?.ontology_coverage?.coverage_percent || 0)}`}>
            {(metrics?.ontology_coverage?.coverage_percent || 0).toFixed(1)}%
          </div>
          <div className="metric-details">
            <span>{metrics?.ontology_coverage?.used_classes || 0} of {metrics?.ontology_coverage?.total_classes || 0} classes used</span>
          </div>
        </div>
      </div>

      {/* Unused Classes Section */}
      {metrics?.ontology_coverage?.unused_classes?.length > 0 && (
        <div className="unused-classes-section">
          <h3>Unused Ontology Classes</h3>
          <p>These classes are defined but have no instances in the graph:</p>
          <div className="unused-classes-list">
            {metrics.ontology_coverage.unused_classes.slice(0, 10).map((cls, i) => (
              <span key={i} className="unused-class-tag">{cls}</span>
            ))}
            {metrics.ontology_coverage.unused_classes.length > 10 && (
              <span className="more-tag">+{metrics.ontology_coverage.unused_classes.length - 10} more</span>
            )}
          </div>
        </div>
      )}

      {/* Timeseries Chart */}
      <div className="timeseries-section">
        <div className="timeseries-header">
          <h3>Activity Over Time</h3>
          <select 
            value={selectedMetric} 
            onChange={(e) => setSelectedMetric(e.target.value)}
            className="metric-selector"
          >
            <option value="extraction_success">Successful Extractions</option>
            <option value="extraction_failure">Failed Extractions</option>
            <option value="entities_created">Entities Created</option>
          </select>
        </div>
        
        {timeseries && timeseries.length > 0 ? (
          <div className="timeseries-chart">
            <div className="chart-bars">
              {timeseries.map((point, i) => {
                const maxValue = Math.max(...timeseries.map(p => p.value), 1);
                const height = (point.value / maxValue) * 100;
                return (
                  <div key={i} className="chart-bar-container" title={`${point.date}: ${point.value}`}>
                    <div 
                      className="chart-bar" 
                      style={{ height: `${Math.max(height, 2)}%` }}
                    />
                    {i % 7 === 0 && (
                      <span className="chart-label">{point.date.slice(5)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="no-timeseries">
            <p>No activity data available for the selected period.</p>
          </div>
        )}
      </div>

      {/* Last Updated */}
      <div className="dashboard-footer">
        <span>Last updated: {metrics?.timestamp ? new Date(metrics.timestamp).toLocaleString() : 'N/A'}</span>
      </div>
    </div>
  );
}

export default HealthDashboard;
