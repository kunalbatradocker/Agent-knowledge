/**
 * ContextGraphView — Visualizes ephemeral evidence graphs from VKG queries.
 * Uses Cytoscape.js (same as GraphVisualization) with color-coded nodes by ontology class,
 * edge labels, provenance tooltips, and database source legend.
 */
import { useRef, useState, useCallback, useMemo } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import './ContextGraphView.css';

// Color palette for ontology classes
const CLASS_COLORS = [
  { bg: '#667eea', border: '#5a67d8' },
  { bg: '#f59e0b', border: '#d97706' },
  { bg: '#10b981', border: '#059669' },
  { bg: '#ec4899', border: '#db2777' },
  { bg: '#f97316', border: '#ea580c' },
  { bg: '#3b82f6', border: '#2563eb' },
  { bg: '#8b5cf6', border: '#7c3aed' },
  { bg: '#06b6d4', border: '#0891b2' },
  { bg: '#f43f5e', border: '#e11d48' },
  { bg: '#84cc16', border: '#65a30d' },
];

function ContextGraphView({ graph, provenance = {} }) {
  const cyRef = useRef(null);
  const [layoutKey, setLayoutKey] = useState(0);

  // Build class → color mapping
  const classColorMap = useMemo(() => {
    if (!graph?.nodes) return {};
    const types = [...new Set(graph.nodes.map(n => n.type))];
    const map = {};
    types.forEach((t, i) => { map[t] = CLASS_COLORS[i % CLASS_COLORS.length]; });
    return map;
  }, [graph]);

  // Transform context graph to Cytoscape elements
  const elements = useMemo(() => {
    if (!graph?.nodes?.length) return [];
    const els = [];
    const nodeIds = new Set();

    for (const node of graph.nodes) {
      if (nodeIds.has(node.id)) continue;
      nodeIds.add(node.id);
      els.push({
        data: {
          id: node.id,
          label: node.value?.length > 25 ? node.value.substring(0, 22) + '...' : node.value,
          fullLabel: node.value,
          type: node.type,
          source: node.source,
          ...node.properties
        },
        classes: node.type.toLowerCase()
      });
    }

    for (const edge of (graph.edges || [])) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      els.push({
        data: {
          id: `e_${edge.source}_${edge.target}`,
          source: edge.source,
          target: edge.target,
          label: edge.relation || ''
        }
      });
    }

    return els;
  }, [graph]);

  const layout = useMemo(() => ({
    name: 'cose',
    animate: true,
    animationDuration: 800,
    fit: true,
    padding: 40,
    nodeRepulsion: () => 300000,
    idealEdgeLength: () => 120,
    randomize: true
  }), []);

  // Dynamic stylesheet based on class colors
  const stylesheet = useMemo(() => {
    const base = [
      {
        selector: 'node',
        style: {
          'background-color': '#667eea',
          'label': 'data(label)',
          'width': 36,
          'height': 36,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'color': '#333',
          'font-size': '10px',
          'text-wrap': 'wrap',
          'text-max-width': '100px',
          'text-margin-y': 4,
          'border-width': 2,
          'border-color': '#5a67d8'
        }
      },
      {
        selector: 'edge',
        style: {
          'width': 2,
          'line-color': '#94a3b8',
          'target-arrow-color': '#94a3b8',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'label': 'data(label)',
          'font-size': '9px',
          'text-rotation': 'autorotate',
          'text-margin-y': -8,
          'text-background-color': '#fff',
          'text-background-opacity': 0.9,
          'text-background-padding': '2px',
          'color': '#475569'
        }
      }
    ];

    // Add per-class styles
    for (const [type, color] of Object.entries(classColorMap)) {
      base.push({
        selector: `node.${type.toLowerCase()}`,
        style: {
          'background-color': color.bg,
          'border-color': color.border
        }
      });
    }

    return base;
  }, [classColorMap]);

  const handleCy = useCallback((cy) => {
    if (cy) cyRef.current = cy;
  }, []);

  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <div className="cgv-container">
        <div className="cgv-empty">No evidence graph data available.</div>
      </div>
    );
  }

  return (
    <div className="cgv-container">
      <div className="cgv-toolbar">
        <div className="cgv-legend">
          {Object.entries(classColorMap).map(([type, color]) => (
            <span key={type} className="cgv-legend-item">
              <span className="cgv-legend-dot" style={{ background: color.bg }} />
              {type}
              {graph.statistics?.cardinality?.[type] && (
                <span className="cgv-legend-count">({graph.statistics.cardinality[type]})</span>
              )}
            </span>
          ))}
        </div>
        <div className="cgv-actions">
          {provenance?.databases?.length > 0 && (
            <span className="cgv-db-info">
              {provenance.databases.map((db, i) => (
                <span key={i} className="cgv-db-tag">🗄️ {db}</span>
              ))}
            </span>
          )}
          <button className="cgv-relayout-btn" onClick={() => setLayoutKey(k => k + 1)}>🔄 Re-layout</button>
        </div>
      </div>

      <div className="cgv-graph-area">
        <CytoscapeComponent
          key={`ctx-${layoutKey}-${elements.length}`}
          elements={elements}
          style={{ width: '100%', height: '400px' }}
          layout={layout}
          stylesheet={stylesheet}
          cy={handleCy}
          wheelSensitivity={0.2}
          minZoom={0.2}
          maxZoom={3}
        />
      </div>

      <div className="cgv-stats">
        <span>{graph.statistics?.nodeCount || 0} entities</span>
        <span>{graph.statistics?.edgeCount || 0} relationships</span>
        <span>{graph.statistics?.rowCount || 0} rows</span>
      </div>
    </div>
  );
}

export default ContextGraphView;
