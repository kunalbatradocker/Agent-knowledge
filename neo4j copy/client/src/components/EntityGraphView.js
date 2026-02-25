import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './EntityGraphView.css';

const API_BASE_URL = '/api';

/**
 * EntityGraphView Component
 * Dark-themed contextual graph visualization with labels inside nodes,
 * directed arrows, and force-directed-like layout.
 */
const EntityGraphView = ({ entity, onClose, onSelectEntity }) => {
  const { currentTenant, currentWorkspace } = useTenant();
  const svgRef = useRef(null);
  const containerRef = useRef(null);

  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Graph settings
  const [depth, setDepth] = useState(2);
  const [selectedRelTypes, setSelectedRelTypes] = useState([]);
  const [availableRelTypes, setAvailableRelTypes] = useState([]);
  const [focusMode, setFocusMode] = useState('all');

  // Visualization state
  const [selectedNode, setSelectedNode] = useState(null);

  // Zoom/pan state
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  // ─── Fetch graph data ───
  const fetchGraph = useCallback(async () => {
    if (!entity?.entityId || !currentTenant?.tenant_id || !currentWorkspace?.workspace_id) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tenantId: currentTenant.tenant_id,
        workspaceId: currentWorkspace.workspace_id,
        depth: depth.toString(),
        limit: '150',
        mode: focusMode === 'main' ? 'focused' : 'full'
      });
      if (selectedRelTypes.length > 0) {
        params.append('relationshipTypes', selectedRelTypes.join(','));
      }
      const response = await fetch(
        `${API_BASE_URL}/entities/${encodeURIComponent(entity.entityId)}/graph?${params}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const data = await response.json();
      setGraphData(data);
      const relTypes = [...new Set(data.edges?.map(e => e.type) || [])];
      setAvailableRelTypes(relTypes);
      setSelectedNode(null);
    } catch (err) {
      console.error('Failed to fetch graph:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [entity, currentTenant, currentWorkspace, depth, selectedRelTypes, focusMode]);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  // ─── Identify center node ───
  const centerNodeId = useMemo(() => {
    if (!graphData.nodes.length) return null;
    const eid = entity?.entityId;
    // Node IDs are now class::rawId format (e.g., "Customer::CUST000001")
    // entityId is also class::rawId format
    const found = graphData.nodes.find(n => n.id === eid)
      || graphData.nodes.find(n => {
        // Fallback: match by rawId part
        const nRaw = n.id?.split('::')[1];
        const eRaw = eid?.split('::')[1];
        return nRaw && eRaw && nRaw === eRaw;
      })
      || graphData.nodes[0];
    return found?.id || null;
  }, [graphData.nodes, entity]);

  // ─── Build BFS hop distances ───
  const hopMap = useMemo(() => {
    const adj = {};
    const nodes = graphData.nodes || [];
    const edges = graphData.edges || [];
    nodes.forEach(n => { adj[n.id] = new Set(); });
    edges.forEach(e => {
      if (adj[e.source]) adj[e.source].add(e.target);
      if (adj[e.target]) adj[e.target].add(e.source);
    });
    const hops = {};
    if (centerNodeId) {
      hops[centerNodeId] = 0;
      const queue = [centerNodeId];
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        const neighbors = adj[cur] || new Set();
        for (const nb of neighbors) {
          if (!(nb in hops)) {
            hops[nb] = hops[cur] + 1;
            queue.push(nb);
          }
        }
      }
      nodes.forEach(n => { if (!(n.id in hops)) hops[n.id] = 99; });
    }
    return hops;
  }, [graphData, centerNodeId]);

  // ─── Node radius — larger for labels inside ───
  const NODE_RADIUS = 38;
  const CENTER_RADIUS = 46;

  // ─── Dynamic canvas size ───
  const canvasSize = useMemo(() => {
    const count = (graphData.nodes || []).length;
    if (count <= 10) return { w: 1200, h: 900 };
    if (count <= 25) return { w: 1800, h: 1400 };
    if (count <= 50) return { w: 2600, h: 2000 };
    if (count <= 100) return { w: 3600, h: 3000 };
    return { w: 5000, h: 4000 };
  }, [graphData.nodes]);

  const CX = canvasSize.w / 2;
  const CY = canvasSize.h / 2;

  // ─── Node color palette — saturated colors visible on light bg ───
  const getNodeColor = useCallback((nodeClass) => {
    const colors = {
      'Person': '#e06090',
      'Customer': '#e06090',
      'Organization': '#16a34a',
      'Company': '#16a34a',
      'Document': '#d97706',
      'Product': '#db2777',
      'Location': '#7c3aed',
      'State': '#7c3aed',
      'Country': '#7c3aed',
      'Account': '#a855f7',
      'BankAccount': '#a855f7',
      'AccountOwnership': '#c084fc',
      'Transaction': '#0891b2',
      'Case': '#dc2626',
      'Loan': '#7c3aed',
      'Collateral': '#3b82f6',
      'Branch': '#ea580c',
      'KYCStatus': '#16a34a',
      'RiskTier': '#ca8a04',
      'RiskAssessment': '#ca8a04',
      'Segment': '#d97706',
      'LoanType': '#8b5cf6',
      'PaymentFrequency': '#059669',
      'LoanStatus': '#6366f1',
    };
    return colors[nodeClass] || '#6b7280';
  }, []);

  // ─── Force-directed-like layout with BFS rings ───
  // Uses concentric rings but with organic jitter and variable spacing
  const nodePositions = useMemo(() => {
    const nodes = graphData.nodes || [];
    const edges = graphData.edges || [];
    if (!nodes.length) return {};

    // Build adjacency for layout
    const adj = {};
    nodes.forEach(n => { adj[n.id] = []; });
    edges.forEach(e => {
      if (adj[e.source]) adj[e.source].push(e.target);
      if (adj[e.target]) adj[e.target].push(e.source);
    });

    // Group by hop
    const rings = {};
    nodes.forEach(n => {
      const hop = hopMap[n.id] ?? 99;
      if (!rings[hop]) rings[hop] = [];
      rings[hop].push(n);
    });

    const hopLevels = Object.keys(rings).map(Number).sort((a, b) => a - b);
    const positions = {};

    // Place center node
    hopLevels.forEach((hop, ringIdx) => {
      const nodesInRing = rings[hop];
      if (hop === 0) {
        nodesInRing.forEach(n => { positions[n.id] = { x: CX, y: CY }; });
        return;
      }

      const count = nodesInRing.length;
      // Minimum spacing between node centers on the arc
      const minNodeSpacing = NODE_RADIUS * 2.8;
      const minCircumference = count * minNodeSpacing;
      const minRadiusForSpacing = minCircumference / (2 * Math.PI);

      const baseRadius = 200;
      const ringGap = 200;
      const radiusFromGap = baseRadius + (ringIdx - 1) * ringGap + ringGap;
      const radius = Math.max(radiusFromGap, minRadiusForSpacing);

      // Sort nodes by their connection to parent — try to place connected nodes
      // near their parent for a more organic look
      const sorted = [...nodesInRing];
      sorted.sort((a, b) => {
        // Find parent (neighbor with lower hop)
        const aParent = (adj[a.id] || []).find(nb => (hopMap[nb] ?? 99) < hop);
        const bParent = (adj[b.id] || []).find(nb => (hopMap[nb] ?? 99) < hop);
        const aAngle = aParent && positions[aParent] ?
          Math.atan2(positions[aParent].y - CY, positions[aParent].x - CX) : 0;
        const bAngle = bParent && positions[bParent] ?
          Math.atan2(positions[bParent].y - CY, positions[bParent].x - CX) : 0;
        return aAngle - bAngle;
      });

      const angleStep = (2 * Math.PI) / Math.max(count, 1);
      // Offset so ring 1 starts at top (-PI/2)
      const startAngle = -Math.PI / 2;

      sorted.forEach((n, i) => {
        const angle = startAngle + i * angleStep;
        positions[n.id] = {
          x: CX + radius * Math.cos(angle),
          y: CY + radius * Math.sin(angle)
        };
      });
    });

    return positions;
  }, [graphData, hopMap, CX, CY, NODE_RADIUS]);

  // ─── Text wrapping helper — split label into lines that fit inside circle ───
  const wrapLabel = useCallback((text, maxCharsPerLine) => {
    if (!text) return [''];
    const str = text.length > 24 ? text.substring(0, 22) + '…' : text;
    if (str.length <= maxCharsPerLine) return [str];
    // Try to split at word boundary or mid-word with hyphen
    const words = str.split(/[\s_-]+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && (current + ' ' + word).length > maxCharsPerLine) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
    // Max 3 lines
    if (lines.length > 3) {
      return [lines[0], lines[1], lines.slice(2).join(' ').substring(0, maxCharsPerLine - 1) + '…'];
    }
    return lines;
  }, []);

  const humanizeRelType = (type) => {
    if (!type) return type;
    return type.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()
      .replace(/^./, c => c.toLowerCase());
  };

  // ─── Zoom helpers ───
  const zoomIn = () => setTransform(t => ({ ...t, scale: Math.min(t.scale * 1.3, 5) }));
  const zoomOut = () => setTransform(t => ({ ...t, scale: Math.max(t.scale / 1.3, 0.1) }));
  const zoomReset = () => setTransform({ x: 0, y: 0, scale: 1 });

  const zoomFit = useCallback(() => {
    const positions = Object.values(nodePositions);
    if (!positions.length || !containerRef.current) return;
    const container = containerRef.current;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    positions.forEach(p => {
      minX = Math.min(minX, p.x - CENTER_RADIUS);
      minY = Math.min(minY, p.y - CENTER_RADIUS);
      maxX = Math.max(maxX, p.x + CENTER_RADIUS);
      maxY = Math.max(maxY, p.y + CENTER_RADIUS);
    });
    const pad = 100;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const graphW = maxX - minX;
    const graphH = maxY - minY;
    const scale = Math.min(cw / graphW, ch / graphH, 2);
    const tx = (cw - graphW * scale) / 2 - minX * scale;
    const ty = (ch - graphH * scale) / 2 - minY * scale;
    setTransform({ x: tx, y: ty, scale });
  }, [nodePositions]);

  useEffect(() => {
    if (Object.keys(nodePositions).length > 0) {
      const timer = setTimeout(zoomFit, 100);
      return () => clearTimeout(timer);
    }
  }, [nodePositions, zoomFit]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setTransform(t => {
      const newScale = Math.min(Math.max(t.scale * factor, 0.1), 5);
      const svg = svgRef.current;
      if (!svg) return { ...t, scale: newScale };
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const dx = mx - t.x;
      const dy = my - t.y;
      const scaleChange = newScale / t.scale;
      return { x: mx - dx * scaleChange, y: my - dy * scaleChange, scale: newScale };
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ─── Pan handlers ───
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  }, [transform]);

  const handleMouseMove = useCallback((e) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setTransform(t => ({ ...t, x: panStart.current.tx + dx, y: panStart.current.ty + dy }));
  }, [isPanning]);

  const handleMouseUp = useCallback(() => { setIsPanning(false); }, []);

  useEffect(() => {
    if (isPanning) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isPanning, handleMouseMove, handleMouseUp]);

  // ─── Node interaction ───
  const handleNodeClick = (e, node) => {
    e.stopPropagation();
    setSelectedNode(node);
  };

  const navigateToEntity = (node) => {
    if (onSelectEntity) {
      // node.id is already in class::rawId format
      onSelectEntity({
        entityId: node.id,
        class: node.class,
        displayName: node.label
      });
    }
  };

  const toggleRelType = (relType) => {
    setSelectedRelTypes(prev =>
      prev.includes(relType) ? prev.filter(t => t !== relType) : [...prev, relType]
    );
  };

  // ─── Compute edge paths with curved lines for parallel edges ───
  const edgeData = useMemo(() => {
    const edges = graphData.edges || [];
    // Detect parallel edges (same source-target pair)
    const pairCount = {};
    const pairIndex = {};
    edges.forEach(e => {
      const key = [e.source, e.target].sort().join('|');
      pairCount[key] = (pairCount[key] || 0) + 1;
    });

    return edges.map(e => {
      const key = [e.source, e.target].sort().join('|');
      if (!pairIndex[key]) pairIndex[key] = 0;
      const idx = pairIndex[key]++;
      const total = pairCount[key];
      // Curve offset for parallel edges
      const curveOffset = total > 1 ? (idx - (total - 1) / 2) * 30 : 0;
      return { ...e, curveOffset };
    });
  }, [graphData.edges]);

  // ─── Render ───
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

  const svgTransform = `translate(${transform.x}, ${transform.y}) scale(${transform.scale})`;

  // Helper: compute edge path (straight or curved)
  const getEdgePath = (sp, tp, curveOffset) => {
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    // Normal perpendicular to the edge
    const nx = -dy / dist;
    const ny = dx / dist;

    // Control point for quadratic bezier
    const cpx = (sp.x + tp.x) / 2 + nx * curveOffset;
    const cpy = (sp.y + tp.y) / 2 + ny * curveOffset;

    // Shorten start/end to not overlap circles
    const srcR = sp.isCenter ? CENTER_RADIUS + 2 : NODE_RADIUS + 2;
    const tgtR = tp.isCenter ? CENTER_RADIUS + 8 : NODE_RADIUS + 8;

    // For curved edges, compute tangent at start/end
    if (Math.abs(curveOffset) > 1) {
      // Start point: direction from source to control point
      const dsx = cpx - sp.x;
      const dsy = cpy - sp.y;
      const dsDist = Math.sqrt(dsx * dsx + dsy * dsy) || 1;
      const x1 = sp.x + (dsx / dsDist) * srcR;
      const y1 = sp.y + (dsy / dsDist) * srcR;

      // End point: direction from control point to target
      const dtx = tp.x - cpx;
      const dty = tp.y - cpy;
      const dtDist = Math.sqrt(dtx * dtx + dty * dty) || 1;
      const x2 = tp.x - (dtx / dtDist) * tgtR;
      const y2 = tp.y - (dty / dtDist) * tgtR;

      return {
        path: `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`,
        labelX: cpx,
        labelY: cpy
      };
    }

    // Straight line
    const x1 = sp.x + (dx / dist) * srcR;
    const y1 = sp.y + (dy / dist) * srcR;
    const x2 = tp.x - (dx / dist) * tgtR;
    const y2 = tp.y - (dy / dist) * tgtR;

    return {
      path: `M ${x1} ${y1} L ${x2} ${y2}`,
      labelX: (sp.x + tp.x) / 2,
      labelY: (sp.y + tp.y) / 2
    };
  };

  // Compute label rotation so text reads left-to-right along edge
  const getEdgeLabelTransform = (sp, tp, lx, ly) => {
    let angle = Math.atan2(tp.y - sp.y, tp.x - sp.x) * (180 / Math.PI);
    // Flip if text would be upside down
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return `rotate(${angle}, ${lx}, ${ly})`;
  };

  return (
    <div className="entity-graph-view">
      {/* Header */}
      <div className="graph-header">
        <button className="back-btn" onClick={onClose}>← Back</button>
        <div className="graph-title">
          <h2>🔗 Connection Map</h2>
          <span className="center-entity">
            <strong>{entity?.displayName}</strong>
            {' '}— {graphData.nodes?.length || 0} nodes, {graphData.edges?.length || 0} edges
          </span>
        </div>
        <div className="graph-controls">
          <label>
            Depth:
            <select value={depth} onChange={(e) => setDepth(parseInt(e.target.value))}>
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
              <option value={3}>3 hops</option>
            </select>
          </label>
          <label>
            View:
            <select value={focusMode} onChange={(e) => setFocusMode(e.target.value)}>
              <option value="all">All connections</option>
              <option value="main">Main entity path</option>
            </select>
          </label>
        </div>
      </div>

      {/* Relationship type filters */}
      {availableRelTypes.length > 0 && (
        <div className="graph-filters">
          <span className="filter-label">Filter:</span>
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
              <button className="clear-filters-btn" onClick={() => setSelectedRelTypes([])}>Clear</button>
            )}
          </div>
        </div>
      )}

      {/* Graph Canvas */}
      <div className="graph-container" ref={containerRef}>
        {graphData.nodes.length === 0 ? (
          <div className="graph-empty">
            <span className="empty-icon">🔍</span>
            <p>No connected entities found</p>
          </div>
        ) : (
          <>
            {/* Zoom controls */}
            <div className="zoom-controls">
              <button onClick={zoomIn} title="Zoom in">+</button>
              <button onClick={zoomOut} title="Zoom out">−</button>
              <button onClick={zoomFit} title="Fit to view">⊡</button>
              <button onClick={zoomReset} title="Reset (1:1)">1:1</button>
            </div>

            <svg
              ref={svgRef}
              className="graph-svg"
              onMouseDown={handleMouseDown}
              style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
            >
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
                </marker>
                <marker id="arrowhead-hover" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
                </marker>
              </defs>

              <g transform={svgTransform}>
                {/* Edges */}
                <g className="edges">
                  {edgeData.map((edge, idx) => {
                    const sp = nodePositions[edge.source];
                    const tp = nodePositions[edge.target];
                    if (!sp || !tp) return null;

                    const spData = { ...sp, isCenter: edge.source === centerNodeId };
                    const tpData = { ...tp, isCenter: edge.target === centerNodeId };
                    const { path, labelX, labelY } = getEdgePath(spData, tpData, edge.curveOffset);
                    const labelTransform = getEdgeLabelTransform(sp, tp, labelX, labelY);

                    return (
                      <g key={idx} className="edge">
                        <path d={path} fill="none" stroke="#94a3b8" strokeWidth="1.5"
                          markerEnd="url(#arrowhead)" opacity={0.6} />
                        <text
                          x={labelX} y={labelY - 6}
                          className="edge-label"
                          textAnchor="middle"
                          transform={labelTransform}
                        >
                          {humanizeRelType(edge.type)}
                        </text>
                      </g>
                    );
                  })}
                </g>

                {/* Nodes */}
                <g className="nodes">
                  {graphData.nodes.map((node) => {
                    const pos = nodePositions[node.id];
                    if (!pos) return null;
                    const isCenter = node.id === centerNodeId;
                    const isSelected = selectedNode?.id === node.id;
                    const color = getNodeColor(node.class);
                    const r = isCenter ? CENTER_RADIUS : NODE_RADIUS;
                    const labelText = node.label || node.id || '';
                    const maxChars = isCenter ? 10 : 8;
                    const lines = wrapLabel(labelText, maxChars);

                    return (
                      <g key={node.id}
                        className={`node ${isCenter ? 'center' : ''} ${isSelected ? 'selected' : ''}`}
                        transform={`translate(${pos.x}, ${pos.y})`}
                        onClick={(e) => handleNodeClick(e, node)}
                        onDoubleClick={() => navigateToEntity(node)}
                      >
                        {/* Glow ring for center node */}
                        {isCenter && (
                          <circle r={r + 5} fill="none" stroke="#009688" strokeWidth="2.5" opacity={0.6} />
                        )}
                        {/* Node circle */}
                        <circle r={r} fill={color}
                          stroke={isSelected ? '#333' : isCenter ? '#009688' : 'rgba(255,255,255,0.7)'}
                          strokeWidth={isCenter ? 2.5 : isSelected ? 2.5 : 1.5} />
                        {/* Label inside node */}
                        {lines.map((line, li) => {
                          const totalHeight = lines.length * 13;
                          const yOffset = -totalHeight / 2 + li * 13 + 10;
                          return (
                            <text key={li}
                              y={yOffset}
                              className="node-label-inside"
                              textAnchor="middle"
                              fontSize={isCenter ? '11px' : '9px'}
                            >
                              {line}
                            </text>
                          );
                        })}
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>
          </>
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
            <div className="panel-row">
              <span className="label">ID:</span>
              <span className="value">{selectedNode.id}</span>
            </div>
            <div className="panel-row">
              <span className="label">Hop:</span>
              <span className="value">{hopMap[selectedNode.id] ?? '—'}</span>
            </div>
            <button className="view-entity-btn" onClick={() => navigateToEntity(selectedNode)}>
              View Entity Details →
            </button>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="graph-legend">
        <span className="legend-title">Legend:</span>
        <div className="legend-items">
          {[...new Set((graphData.nodes || []).map(n => n.class))].slice(0, 10).map(cls => (
            <div key={cls} className="legend-item">
              <span className="legend-dot" style={{ background: getNodeColor(cls) }}></span>
              <span>{cls}</span>
            </div>
          ))}
        </div>
        <span className="legend-hint">
          Scroll to zoom · Drag to pan · Double-click to navigate
        </span>
      </div>
    </div>
  );
};

export default EntityGraphView;
