import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './EntityGraphView.css';

const API_BASE_URL = '/api';

/**
 * EntityGraphView Component
 * Contextual graph visualization starting from ONE entity
 * Limited traversal depth (1-2 hops)
 * 
 * This answers: "How is THIS entity connected?"
 * NOT: "What exists in the system?"
 */
const EntityGraphView = ({ entity, onClose, onSelectEntity }) => {
  const { currentTenant, currentWorkspace } = useTenant();
  const canvasRef = useRef(null);
  
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Graph settings
  const [depth, setDepth] = useState(1);
  const [selectedRelTypes, setSelectedRelTypes] = useState([]);
  const [availableRelTypes, setAvailableRelTypes] = useState([]);
  
  // Visualization state
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodePositions, setNodePositions] = useState({});

  // Fetch graph data
  const fetchGraph = useCallback(async () => {
    if (!entity?.entityId || !currentTenant?.tenant_id || !currentWorkspace?.workspace_id) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id,
        depth: depth.toString(),
        limit: '50'
      });

      if (selectedRelTypes.length > 0) {
        params.append('relationshipTypes', selectedRelTypes.join(','));
      }

      const response = await fetch(
        `${API_BASE_URL}/entities/${encodeURIComponent(entity.entityId)}/graph?${params}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setGraphData(data);
      
      // Extract available relationship types
      const relTypes = [...new Set(data.edges?.map(e => e.type) || [])];
      setAvailableRelTypes(relTypes);
      
      // Calculate node positions
      calculatePositions(data.nodes || [], entity.entityId);

    } catch (err) {
      console.error('Failed to fetch graph:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [entity, currentTenant, currentWorkspace, depth, selectedRelTypes]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // Calculate node positions using force-directed layout simulation
  const calculatePositions = (nodes, centerId) => {
    if (nodes.length === 0) return;

    const width = 800;
    const height = 600;
    const centerX = width / 2;
    const centerY = height / 2;

    const positions = {};
    
    // Find center node
    const centerNode = nodes.find(n => n.id === centerId || n.id?.includes(centerId.split('::')[1]));
    
    if (centerNode) {
      positions[centerNode.id] = { x: centerX, y: centerY };
    }

    // Position other nodes in a circle around center
    const otherNodes = nodes.filter(n => n.id !== centerNode?.id);
    const radius = Math.min(width, height) * 0.35;
    
    otherNodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / otherNodes.length;
      positions[node.id] = {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle)
      };
    });

    setNodePositions(positions);
  };

  // Get color for node class
  const getNodeColor = (nodeClass) => {
    const colors = {
      'Person': '#3b82f6',
      'Organization': '#22c55e',
      'Document': '#f59e0b',
      'Product': '#ec4899',
      'Location': '#8b5cf6',
      'Event': '#06b6d4',
      'Account': '#10b981',
      'Transaction': '#f97316',
      'Case': '#ef4444',
      'default': '#9333ea'
    };
    return colors[nodeClass] || colors.default;
  };

  // Humanize relationship type names
  const humanizeRelType = (type) => {
    if (!type) return type;
    return type
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  // Handle node click
  const handleNodeClick = (node) => {
    setSelectedNode(node);
  };

  // Navigate to entity
  const navigateToEntity = (node) => {
    if (onSelectEntity) {
      onSelectEntity({
        entityId: `${node.class}::${node.id}`,
        class: node.class,
        displayName: node.label
      });
    }
  };

  // Toggle relationship type filter
  const toggleRelType = (relType) => {
    setSelectedRelTypes(prev => {
      if (prev.includes(relType)) {
        return prev.filter(t => t !== relType);
      }
      return [...prev, relType];
    });
  };

  if (loading) {
    return (
      <div className="entity-graph-view">
        <div className="graph-loading">
          <div className="loading-spinner"></div>
          <span>Loading graph...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="entity-graph-view">
        <div className="graph-error">
          <span className="error-icon">⚠️</span>
          <p>{error}</p>
          <button onClick={fetchGraph}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="entity-graph-view">
      {/* Header */}
      <div className="graph-header">
        <button className="back-btn" onClick={onClose}>
          ← Back to Detail
        </button>
        
        <div className="graph-title">
          <h2>🔗 Connection Map</h2>
          <span className="center-entity">
            Showing connections for: <strong>{entity?.displayName}</strong>
          </span>
        </div>
        
        <div className="graph-controls">
          <label>
            Show connections:
            <select value={depth} onChange={(e) => setDepth(parseInt(e.target.value))}>
              <option value={1}>Direct only</option>
              <option value={2}>Extended (2 levels)</option>
            </select>
          </label>
        </div>
      </div>

      {/* Filters */}
      {availableRelTypes.length > 0 && (
        <div className="graph-filters">
          <span className="filter-label">Filter by connection type:</span>
          <div className="rel-type-filters">
            {availableRelTypes.map(relType => (
              <button
                key={relType}
                className={`rel-type-btn ${selectedRelTypes.length === 0 || selectedRelTypes.includes(relType) ? 'active' : ''}`}
                onClick={() => toggleRelType(relType)}
              >
                {humanizeRelType(relType)}
              </button>
            ))}
            {selectedRelTypes.length > 0 && (
              <button 
                className="clear-filters-btn"
                onClick={() => setSelectedRelTypes([])}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Graph Canvas */}
      <div className="graph-container">
        {graphData.nodes.length === 0 ? (
          <div className="graph-empty">
            <span className="empty-icon">🔍</span>
            <p>No connected entities found</p>
          </div>
        ) : (
          <svg 
            ref={canvasRef}
            className="graph-svg"
            viewBox="0 0 800 600"
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Edges */}
            <g className="edges">
              {graphData.edges.map((edge, idx) => {
                const sourcePos = nodePositions[edge.source];
                const targetPos = nodePositions[edge.target];
                
                if (!sourcePos || !targetPos) return null;
                
                // Calculate midpoint for label
                const midX = (sourcePos.x + targetPos.x) / 2;
                const midY = (sourcePos.y + targetPos.y) / 2;
                
                return (
                  <g key={idx} className="edge">
                    <line
                      x1={sourcePos.x}
                      y1={sourcePos.y}
                      x2={targetPos.x}
                      y2={targetPos.y}
                      stroke="#3f3f46"
                      strokeWidth="2"
                      markerEnd="url(#arrowhead)"
                    />
                    <text
                      x={midX}
                      y={midY - 8}
                      className="edge-label"
                      textAnchor="middle"
                    >
                      {humanizeRelType(edge.type)}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* Arrow marker definition */}
            <defs>
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill="#3f3f46"
                />
              </marker>
            </defs>

            {/* Nodes */}
            <g className="nodes">
              {graphData.nodes.map((node) => {
                const pos = nodePositions[node.id];
                if (!pos) return null;
                
                const isCenter = node.id === entity?.entityId?.split('::')[1] || 
                                 entity?.entityId?.includes(node.id);
                const isSelected = selectedNode?.id === node.id;
                const color = getNodeColor(node.class);
                
                return (
                  <g 
                    key={node.id}
                    className={`node ${isCenter ? 'center' : ''} ${isSelected ? 'selected' : ''}`}
                    transform={`translate(${pos.x}, ${pos.y})`}
                    onClick={() => handleNodeClick(node)}
                    onDoubleClick={() => navigateToEntity(node)}
                  >
                    <circle
                      r={isCenter ? 30 : 24}
                      fill={color}
                      stroke={isSelected ? '#fafafa' : 'transparent'}
                      strokeWidth="3"
                    />
                    <text
                      y={isCenter ? 45 : 40}
                      className="node-label"
                      textAnchor="middle"
                    >
                      {node.label?.substring(0, 20) || node.id}
                    </text>
                    <text
                      y={isCenter ? 58 : 53}
                      className="node-class"
                      textAnchor="middle"
                    >
                      {node.class}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>

      {/* Selected Node Info */}
      {selectedNode && (
        <div className="selected-node-panel">
          <div className="panel-header">
            <h4>{selectedNode.label}</h4>
            <button onClick={() => setSelectedNode(null)}>×</button>
          </div>
          <div className="panel-content">
            <div className="panel-row">
              <span className="label">Type:</span>
              <span className="value">{selectedNode.class}</span>
            </div>
            <button 
              className="view-entity-btn"
              onClick={() => navigateToEntity(selectedNode)}
            >
              View Entity Details →
            </button>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="graph-legend">
        <span className="legend-title">Legend:</span>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-dot center"></span>
            <span>This Entity</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot connected"></span>
            <span>Related Entity</span>
          </div>
        </div>
        <span className="legend-hint">Double-click any circle to see its details</span>
      </div>
    </div>
  );
};

export default EntityGraphView;
