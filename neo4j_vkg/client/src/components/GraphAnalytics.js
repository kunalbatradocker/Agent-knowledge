import { useState, useEffect, useCallback } from 'react';
import './GraphAnalytics.css';

const API_BASE_URL = '/api';

function GraphAnalytics() {
  const [activeAlgorithm, setActiveAlgorithm] = useState('pagerank');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [params, setParams] = useState({
    iterations: 20,
    dampingFactor: 0.85,
    limit: 50,
    sampleSize: 50,
    minSize: 2,
    sourceUri: '',
    targetUri: ''
  });

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/enterprise/graph-algorithms/statistics`);
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.error('Server returned non-JSON response for statistics');
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const runAlgorithm = async () => {
    setLoading(true);
    setResults(null);
    
    try {
      let endpoint = '';
      let body = {};

      switch (activeAlgorithm) {
        case 'pagerank':
          endpoint = '/enterprise/graph-algorithms/pagerank';
          body = { iterations: params.iterations, dampingFactor: params.dampingFactor, limit: params.limit };
          break;
        case 'degree':
          endpoint = '/enterprise/graph-algorithms/degree-centrality';
          body = { limit: params.limit };
          break;
        case 'betweenness':
          endpoint = '/enterprise/graph-algorithms/betweenness-centrality';
          body = { sampleSize: params.sampleSize, limit: params.limit };
          break;
        case 'communities':
          endpoint = '/enterprise/graph-algorithms/communities';
          body = { iterations: params.iterations };
          break;
        case 'components':
          endpoint = '/enterprise/graph-algorithms/connected-components';
          body = { minSize: params.minSize };
          break;
        case 'shortest-path':
          endpoint = '/enterprise/graph-algorithms/shortest-path';
          body = { sourceUri: params.sourceUri, targetUri: params.targetUri };
          break;
        default:
          return;
      }

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server returned non-JSON response. Make sure the server is running on port 5002.');
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setResults(data);
    } catch (error) {
      console.error('Algorithm error:', error);
      setResults({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  const algorithms = [
    { id: 'pagerank', name: 'PageRank', icon: '📈', desc: 'Find most influential entities' },
    { id: 'degree', name: 'Degree Centrality', icon: '🔗', desc: 'Most connected entities' },
    { id: 'betweenness', name: 'Betweenness', icon: '🌉', desc: 'Bridge entities between groups' },
    { id: 'communities', name: 'Communities', icon: '👥', desc: 'Detect entity clusters' },
    { id: 'components', name: 'Components', icon: '🧩', desc: 'Find connected subgraphs' },
    { id: 'shortest-path', name: 'Shortest Path', icon: '🛤️', desc: 'Path between two entities' },
  ];

  const renderParams = () => {
    switch (activeAlgorithm) {
      case 'pagerank':
        return (
          <>
            <div className="param-group">
              <label>Iterations</label>
              <input type="number" value={params.iterations} min={1} max={100}
                onChange={e => setParams({...params, iterations: parseInt(e.target.value) || 20})} />
            </div>
            <div className="param-group">
              <label>Damping Factor</label>
              <input type="number" value={params.dampingFactor} min={0} max={1} step={0.05}
                onChange={e => setParams({...params, dampingFactor: parseFloat(e.target.value) || 0.85})} />
            </div>
            <div className="param-group">
              <label>Result Limit</label>
              <input type="number" value={params.limit} min={10} max={500}
                onChange={e => setParams({...params, limit: parseInt(e.target.value) || 50})} />
            </div>
          </>
        );
      case 'degree':
        return (
          <div className="param-group">
            <label>Result Limit</label>
            <input type="number" value={params.limit} min={10} max={500}
              onChange={e => setParams({...params, limit: parseInt(e.target.value) || 50})} />
          </div>
        );
      case 'betweenness':
        return (
          <>
            <div className="param-group">
              <label>Sample Size</label>
              <input type="number" value={params.sampleSize} min={10} max={200}
                onChange={e => setParams({...params, sampleSize: parseInt(e.target.value) || 50})} />
            </div>
            <div className="param-group">
              <label>Result Limit</label>
              <input type="number" value={params.limit} min={10} max={500}
                onChange={e => setParams({...params, limit: parseInt(e.target.value) || 50})} />
            </div>
          </>
        );
      case 'communities':
        return (
          <div className="param-group">
            <label>Iterations</label>
            <input type="number" value={params.iterations} min={1} max={50}
              onChange={e => setParams({...params, iterations: parseInt(e.target.value) || 10})} />
          </div>
        );
      case 'components':
        return (
          <div className="param-group">
            <label>Min Component Size</label>
            <input type="number" value={params.minSize} min={1} max={100}
              onChange={e => setParams({...params, minSize: parseInt(e.target.value) || 2})} />
          </div>
        );
      case 'shortest-path':
        return (
          <>
            <div className="param-group">
              <label>Source Entity URI</label>
              <input type="text" value={params.sourceUri} placeholder="entity:..."
                onChange={e => setParams({...params, sourceUri: e.target.value})} />
            </div>
            <div className="param-group">
              <label>Target Entity URI</label>
              <input type="text" value={params.targetUri} placeholder="entity:..."
                onChange={e => setParams({...params, targetUri: e.target.value})} />
            </div>
          </>
        );
      default:
        return null;
    }
  };

  const renderResults = () => {
    if (!results) return null;
    if (results.error) return <div className="error-message">❌ {results.error}</div>;

    switch (activeAlgorithm) {
      case 'pagerank':
      case 'degree':
      case 'betweenness':
        const nodes = results.nodes || results;
        return (
          <div className="results-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Entity</th>
                  <th>Type</th>
                  <th>{activeAlgorithm === 'pagerank' ? 'Score' : activeAlgorithm === 'degree' ? 'Degree' : 'Betweenness'}</th>
                </tr>
              </thead>
              <tbody>
                {nodes.slice(0, 50).map((node, i) => (
                  <tr key={node.uri || i}>
                    <td><span className="rank-badge">{node.rank || i + 1}</span></td>
                    <td className="entity-name">{node.label}</td>
                    <td><span className="type-badge">{node.nodeLabels?.[0] || 'Entity'}</span></td>
                    <td className="score-cell">
                      {activeAlgorithm === 'pagerank' && node.score?.toFixed(4)}
                      {activeAlgorithm === 'degree' && node.totalDegree}
                      {activeAlgorithm === 'betweenness' && node.normalizedBetweenness?.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results.totalNodes && (
              <div className="results-meta">
                Analyzed {results.totalNodes} nodes, {results.totalEdges} edges
              </div>
            )}
          </div>
        );

      case 'communities':
        return (
          <div className="communities-results">
            <div className="communities-stats">
              <div className="comm-stat">
                <span className="num">{results.stats?.communityCount || 0}</span>
                <span className="label">Communities</span>
              </div>
              <div className="comm-stat">
                <span className="num">{results.stats?.largestCommunity || 0}</span>
                <span className="label">Largest Size</span>
              </div>
              <div className="comm-stat">
                <span className="num">{results.stats?.averageCommunitySize?.toFixed(1) || 0}</span>
                <span className="label">Avg Size</span>
              </div>
            </div>
            <div className="communities-list">
              {results.communities?.slice(0, 20).map((comm, i) => (
                <div key={i} className="community-card">
                  <div className="comm-header">
                    <span className="comm-id">Community {comm.communityId + 1}</span>
                    <span className="comm-size">{comm.size} members</span>
                  </div>
                  <div className="comm-members">
                    {comm.members?.slice(0, 8).map((m, j) => (
                      <span key={j} className="member-tag">{m.label}</span>
                    ))}
                    {comm.members?.length > 8 && <span className="more-tag">+{comm.members.length - 8} more</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 'components':
        return (
          <div className="components-results">
            <div className="components-stats">
              <div className="comp-stat">
                <span className="num">{results.stats?.componentCount || 0}</span>
                <span className="label">Components</span>
              </div>
              <div className="comp-stat">
                <span className="num">{results.stats?.totalNodes || 0}</span>
                <span className="label">Total Nodes</span>
              </div>
              <div className="comp-stat">
                <span className="num">{results.stats?.isolatedNodes || 0}</span>
                <span className="label">Isolated</span>
              </div>
            </div>
            <div className="components-list">
              {results.components?.slice(0, 15).map((comp, i) => (
                <div key={i} className="component-card">
                  <span className="comp-id">Component {comp.componentId + 1}</span>
                  <span className="comp-size">{comp.size} nodes</span>
                </div>
              ))}
            </div>
          </div>
        );

      case 'shortest-path':
        if (!results.found) {
          return <div className="no-path">No path found between these entities</div>;
        }
        return (
          <div className="path-results">
            <div className="path-length">Path Length: {results.pathLength} hops</div>
            <div className="path-visualization">
              {results.nodes?.map((node, i) => (
                <div key={i} className="path-step">
                  <div className="path-node">
                    <span className="node-label">{node.label}</span>
                    <span className="node-type">{node.labels?.[0]}</span>
                  </div>
                  {i < results.relationships?.length && (
                    <div className="path-edge">
                      <span className="edge-arrow">→</span>
                      <span className="edge-type">{results.relationships[i]?.type}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );

      default:
        return <pre>{JSON.stringify(results, null, 2)}</pre>;
    }
  };

  return (
    <div className="graph-analytics">
      {/* Stats Overview */}
      {statsLoading ? (
        <div className="analytics-overview loading">
          <div className="loading-placeholder">Loading statistics...</div>
        </div>
      ) : stats && (
        <div className="analytics-overview">
          <div className="overview-card">
            <span className="card-icon">📊</span>
            <div className="card-content">
              <span className="card-value">{stats.nodeCount?.toLocaleString() || 0}</span>
              <span className="card-label">Total Entities</span>
            </div>
          </div>
          <div className="overview-card">
            <span className="card-icon">🔗</span>
            <div className="card-content">
              <span className="card-value">{stats.edgeCount?.toLocaleString() || 0}</span>
              <span className="card-label">Relationships</span>
            </div>
          </div>
          <div className="overview-card">
            <span className="card-icon">📈</span>
            <div className="card-content">
              <span className="card-value">{stats.avgDegree?.toFixed(2) || 0}</span>
              <span className="card-label">Avg Degree</span>
            </div>
          </div>
          <div className="overview-card">
            <span className="card-icon">🏷️</span>
            <div className="card-content">
              <span className="card-value">{stats.labelDistribution?.length || 0}</span>
              <span className="card-label">Entity Types</span>
            </div>
          </div>
        </div>
      )}

      {/* Algorithm Selection */}
      <div className="algorithm-selector">
        <h4>Select Algorithm</h4>
        <div className="algorithm-cards">
          {algorithms.map(alg => (
            <div
              key={alg.id}
              className={`algorithm-card ${activeAlgorithm === alg.id ? 'active' : ''}`}
              onClick={() => { setActiveAlgorithm(alg.id); setResults(null); }}
            >
              <span className="alg-icon">{alg.icon}</span>
              <span className="alg-name">{alg.name}</span>
              <span className="alg-desc">{alg.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Parameters */}
      <div className="algorithm-params">
        <h4>Parameters</h4>
        <div className="params-form">
          {renderParams()}
          <button className="btn-enterprise" onClick={runAlgorithm} disabled={loading}>
            {loading ? '⏳ Running...' : '▶️ Run Algorithm'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="algorithm-results">
        <h4>Results</h4>
        {loading ? (
          <div className="loading-spinner">Running algorithm...</div>
        ) : results ? (
          renderResults()
        ) : (
          <div className="empty-state">
            <span className="empty-icon">📊</span>
            <p>Select an algorithm and click Run to see results</p>
          </div>
        )}
      </div>

      {/* Label Distribution */}
      {stats?.labelDistribution && (
        <div className="label-distribution">
          <h4>Entity Type Distribution</h4>
          <div className="distribution-bars">
            {stats.labelDistribution.slice(0, 10).map((item, i) => (
              <div key={i} className="dist-item">
                <span className="dist-label">{item.label}</span>
                <div className="dist-bar-container">
                  <div 
                    className="dist-bar" 
                    style={{ width: `${(item.count / stats.labelDistribution[0].count) * 100}%` }}
                  />
                </div>
                <span className="dist-count">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default GraphAnalytics;
