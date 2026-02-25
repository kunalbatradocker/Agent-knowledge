import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import './GraphVisualization.css';

const GraphVisualization = ({ graphData }) => {
  const cyRef = useRef(null);
  const [layoutKey, setLayoutKey] = useState(0);
  const [error, setError] = useState(null);

  // Memoize layout configuration - use 'cose' with better parameters
  const layout = useMemo(() => ({
    name: 'cose',
    animate: true,
    animationDuration: 1000,
    fit: true,
    padding: 50,
    nodeRepulsion: function(node) { return 400000; },
    nodeOverlap: 10,
    idealEdgeLength: function(edge) { return 100; },
    edgeElasticity: function(edge) { return 100; },
    nestingFactor: 1.2,
    gravity: 1,
    numIter: 1000,
    initialTemp: 1000,
    coolingFactor: 0.99,
    minTemp: 1.0,
    randomize: true
  }), []);

  // Transform Neo4j data to Cytoscape format
  const elements = useMemo(() => {
    try {
      if (!graphData || !graphData.nodes || !Array.isArray(graphData.nodes)) {
        return [];
      }

      const els = [];
      const nodeIds = new Set();

      // Add nodes with better label extraction
      graphData.nodes.forEach((node) => {
        if (!node || !node.id) return;
        
        const nodeId = String(node.id);
        if (nodeIds.has(nodeId)) return; // Skip duplicates
        nodeIds.add(nodeId);

        // Try multiple property names for label
        const label = node.properties?.label || 
                     node.properties?.name || 
                     node.properties?.title ||
                     node.properties?.uri?.split('/').pop()?.split(':').pop() ||
                     node.properties?.uri?.split('#').pop() ||
                     (node.labels && node.labels[0]) ||
                     `Node ${node.id}`;
        
        // Get node type from labels
        const nodeType = node.labels?.find(l => !['Entity', 'Concept'].includes(l)) || 
                        node.labels?.[0] || 
                        'Entity';
        
        els.push({
          data: {
            id: nodeId,
            label: label.length > 30 ? label.substring(0, 27) + '...' : label,
            fullLabel: label,
            type: nodeType,
            ...node.properties
          },
          classes: node.labels ? node.labels.map(l => l.toLowerCase()).join(' ') : ''
        });
      });

      // Add edges - only if both source and target nodes exist
      if (graphData.relationships && Array.isArray(graphData.relationships)) {
        graphData.relationships.forEach((rel) => {
          if (!rel || !rel.id) return;
          
          const sourceId = String(rel.start || rel.source || rel.startNode);
          const targetId = String(rel.end || rel.target || rel.endNode);
          
          // Only add edge if both nodes exist
          if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
            const edgeLabel = rel.predicate || rel.type || '';
            els.push({
              data: {
                id: `edge_${rel.id}`,
                source: sourceId,
                target: targetId,
                label: edgeLabel,
                ...rel.properties
              }
            });
          }
        });
      }

      return els;
    } catch (err) {
      console.error('Error transforming graph data:', err);
      setError('Failed to process graph data');
      return [];
    }
  }, [graphData]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cyRef.current) {
        try {
          cyRef.current.destroy();
        } catch (e) {
          // Ignore errors during cleanup
        }
        cyRef.current = null;
      }
    };
  }, []);

  // Handle cytoscape instance
  const handleCy = useCallback((cy) => {
    if (cy) {
      cyRef.current = cy;
      
      // Add event handlers
      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        console.log('Node clicked:', node.data());
      });
    }
  }, []);

  // Refresh layout
  const refreshLayout = useCallback(() => {
    setLayoutKey(prev => prev + 1);
  }, []);

  // Error state
  if (error) {
    return (
      <div className="graph-visualization">
        <div className="no-graph">
          <p>⚠️ {error}</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!graphData || !graphData.nodes || graphData.nodes.length === 0 || elements.length === 0) {
    return (
      <div className="graph-visualization">
        <div className="no-graph">
          <p>No graph data available.</p>
          <p>Upload documents and generate knowledge graphs to visualize.</p>
        </div>
      </div>
    );
  }

  const stylesheet = [
    {
      selector: 'node',
      style: {
        'background-color': '#667eea',
        'label': 'data(label)',
        'width': 40,
        'height': 40,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'color': '#333',
        'font-size': '11px',
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        'text-margin-y': 5,
        'border-width': 3,
        'border-color': '#5a67d8'
      }
    },
    // Document nodes
    {
      selector: 'node.document',
      style: {
        'background-color': '#f59e0b',
        'border-color': '#d97706',
        'width': 50,
        'height': 50,
        'shape': 'rectangle'
      }
    },
    // Chunk nodes
    {
      selector: 'node.chunk',
      style: {
        'background-color': '#10b981',
        'border-color': '#059669',
        'width': 30,
        'height': 30,
        'shape': 'ellipse'
      }
    },
    // Person nodes
    {
      selector: 'node.person',
      style: {
        'background-color': '#ec4899',
        'border-color': '#db2777'
      }
    },
    // Organization nodes
    {
      selector: 'node.organization',
      style: {
        'background-color': '#f97316',
        'border-color': '#ea580c',
        'shape': 'rectangle'
      }
    },
    // Location nodes
    {
      selector: 'node.location',
      style: {
        'background-color': '#3b82f6',
        'border-color': '#2563eb',
        'shape': 'diamond'
      }
    },
    // Technology nodes
    {
      selector: 'node.technology',
      style: {
        'background-color': '#8b5cf6',
        'border-color': '#7c3aed'
      }
    },
    // Product nodes
    {
      selector: 'node.product',
      style: {
        'background-color': '#06b6d4',
        'border-color': '#0891b2'
      }
    },
    // Event nodes
    {
      selector: 'node.event',
      style: {
        'background-color': '#f43f5e',
        'border-color': '#e11d48',
        'shape': 'star'
      }
    },
    // Edges
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
        'text-margin-y': -10,
        'text-background-color': '#fff',
        'text-background-opacity': 0.9,
        'text-background-padding': '3px',
        'color': '#475569'
      }
    },
    // Semantic relationship edges (with predicate)
    {
      selector: 'edge[label]',
      style: {
        'width': 2.5,
        'line-color': '#667eea',
        'target-arrow-color': '#667eea'
      }
    },
    // PART_OF edges
    {
      selector: 'edge[label = "PART_OF"]',
      style: {
        'line-color': '#10b981',
        'target-arrow-color': '#10b981',
        'line-style': 'dashed',
        'width': 1.5
      }
    },
    // MENTIONED_IN edges
    {
      selector: 'edge[label = "MENTIONED_IN"]',
      style: {
        'line-color': '#f59e0b',
        'target-arrow-color': '#f59e0b',
        'line-style': 'dotted',
        'width': 1.5
      }
    },
    // RELATED_TO edges
    {
      selector: 'edge[label = "RELATED_TO"]',
      style: {
        'line-color': '#8b5cf6',
        'target-arrow-color': '#8b5cf6'
      }
    }
  ];

  return (
    <div className="graph-visualization">
      <div className="graph-toolbar">
        <div className="graph-legend">
          <span className="legend-item"><span className="legend-dot document"></span> Document</span>
          <span className="legend-item"><span className="legend-dot chunk"></span> Chunk</span>
          <span className="legend-item"><span className="legend-dot person"></span> Person</span>
          <span className="legend-item"><span className="legend-dot organization"></span> Organization</span>
          <span className="legend-item"><span className="legend-dot location"></span> Location</span>
          <span className="legend-item"><span className="legend-dot technology"></span> Technology</span>
          <span className="legend-item"><span className="legend-dot entity"></span> Other</span>
        </div>
        <button className="layout-btn" onClick={refreshLayout} title="Re-layout graph">
          🔄 Re-layout
        </button>
      </div>
      <div className="cytoscape-container">
        <CytoscapeComponent
          key={`graph-${layoutKey}-${elements.length}`}
          elements={elements}
          style={{ width: '100%', height: '65vh', minHeight: '500px' }}
          layout={layout}
          stylesheet={stylesheet}
          cy={handleCy}
          wheelSensitivity={0.2}
          minZoom={0.1}
          maxZoom={4}
        />
      </div>
      <div className="graph-tips">
        💡 Click and drag to pan • Scroll to zoom • Click nodes to see details
      </div>
    </div>
  );
};

export default GraphVisualization;
