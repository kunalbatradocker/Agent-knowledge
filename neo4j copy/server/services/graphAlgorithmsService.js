/**
 * Graph Algorithms Service
 * PageRank, community detection, centrality, and path analysis
 * Enterprise-grade graph analytics without APOC dependency
 */

const neo4jService = require('./neo4jService');
const driver = require('../config/neo4j');
const neo4j = require('neo4j-driver');

class GraphAlgorithmsService {
  constructor() {
    this.defaultIterations = 20;
    this.defaultDampingFactor = 0.85;
  }

  /**
   * Calculate PageRank scores for entities
   * Pure Cypher implementation (no APOC required)
   */
  async calculatePageRank(options = {}) {
    const {
      iterations = this.defaultIterations,
      dampingFactor = this.defaultDampingFactor,
      entityTypes = null,
      limit = 100
    } = options;

    const session = neo4jService.getSession();
    
    try {
      // Get all nodes and their relationships
      let typeFilter = '';
      if (entityTypes && entityTypes.length > 0) {
        typeFilter = `AND any(label IN labels(n) WHERE label IN $entityTypes)`;
      }

      // Step 1: Get node count and initialize scores
      const initQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          AND NOT n:Provenance AND NOT n:Source AND NOT n:MergeRecord
          ${typeFilter}
        WITH count(n) as nodeCount
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          AND NOT n:Provenance AND NOT n:Source AND NOT n:MergeRecord
          ${typeFilter}
        RETURN n.uri as uri, n.label as label, labels(n) as nodeLabels,
               1.0 / nodeCount as initialScore,
               nodeCount
      `;

      const initResult = await session.run(initQuery, { entityTypes });
      
      if (initResult.records.length === 0) {
        return { nodes: [], iterations: 0 };
      }

      const nodeCount = neo4jService.toNumber(initResult.records[0].get('nodeCount'));
      const nodes = new Map();
      
      for (const record of initResult.records) {
        const uri = record.get('uri');
        nodes.set(uri, {
          uri,
          label: record.get('label'),
          nodeLabels: record.get('nodeLabels'),
          score: 1.0 / nodeCount,
          outDegree: 0,
          inDegree: 0
        });
      }

      // Step 2: Get relationships and calculate degrees
      const relQuery = `
        MATCH (source)-[r]->(target)
        WHERE source.uri IN $uris AND target.uri IN $uris
          AND NOT type(r) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        RETURN source.uri as sourceUri, target.uri as targetUri, type(r) as relType
      `;

      const uris = Array.from(nodes.keys());
      const relResult = await session.run(relQuery, { uris });
      
      const edges = [];
      for (const record of relResult.records) {
        const sourceUri = record.get('sourceUri');
        const targetUri = record.get('targetUri');
        
        edges.push({ source: sourceUri, target: targetUri });
        
        if (nodes.has(sourceUri)) {
          nodes.get(sourceUri).outDegree++;
        }
        if (nodes.has(targetUri)) {
          nodes.get(targetUri).inDegree++;
        }
      }

      // Step 3: Iterative PageRank calculation
      const baseScore = (1 - dampingFactor) / nodeCount;
      
      for (let i = 0; i < iterations; i++) {
        const newScores = new Map();
        
        // Initialize with base score
        for (const [uri, node] of nodes) {
          newScores.set(uri, baseScore);
        }
        
        // Distribute scores through edges
        for (const edge of edges) {
          const sourceNode = nodes.get(edge.source);
          if (sourceNode && sourceNode.outDegree > 0) {
            const contribution = (dampingFactor * sourceNode.score) / sourceNode.outDegree;
            const currentScore = newScores.get(edge.target) || baseScore;
            newScores.set(edge.target, currentScore + contribution);
          }
        }
        
        // Update scores
        for (const [uri, score] of newScores) {
          if (nodes.has(uri)) {
            nodes.get(uri).score = score;
          }
        }
      }

      // Sort by score and return top results
      const rankedNodes = Array.from(nodes.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((node, index) => ({
          ...node,
          rank: index + 1,
          score: Math.round(node.score * 10000) / 10000
        }));

      return {
        nodes: rankedNodes,
        iterations,
        dampingFactor,
        totalNodes: nodeCount,
        totalEdges: edges.length
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate degree centrality for nodes
   */
  async calculateDegreeCentrality(options = {}) {
    const { entityTypes = null, limit = 100 } = options;
    const session = neo4jService.getSession();
    
    try {
      let typeFilter = '';
      if (entityTypes && entityTypes.length > 0) {
        typeFilter = `AND any(label IN labels(n) WHERE label IN $entityTypes)`;
      }

      const query = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          ${typeFilter}
        OPTIONAL MATCH (n)-[outRel]->()
        WHERE NOT type(outRel) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        OPTIONAL MATCH (n)<-[inRel]-()
        WHERE NOT type(inRel) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        WITH n, 
             count(DISTINCT outRel) as outDegree,
             count(DISTINCT inRel) as inDegree
        RETURN n.uri as uri,
               n.label as label,
               labels(n) as nodeLabels,
               outDegree,
               inDegree,
               outDegree + inDegree as totalDegree
        ORDER BY totalDegree DESC
        LIMIT $limit
      `;

      const result = await session.run(query, { entityTypes, limit: neo4j.int(limit) });
      
      return result.records.map((record, index) => ({
        uri: record.get('uri'),
        label: record.get('label'),
        nodeLabels: record.get('nodeLabels'),
        outDegree: neo4jService.toNumber(record.get('outDegree')),
        inDegree: neo4jService.toNumber(record.get('inDegree')),
        totalDegree: neo4jService.toNumber(record.get('totalDegree')),
        rank: index + 1
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate betweenness centrality (simplified version)
   */
  async calculateBetweennessCentrality(options = {}) {
    const { entityTypes = null, sampleSize = 50, limit = 100 } = options;
    const session = neo4jService.getSession();
    
    try {
      // Get sample of nodes for path calculations
      let typeFilter = '';
      if (entityTypes && entityTypes.length > 0) {
        typeFilter = `AND any(label IN labels(n) WHERE label IN $entityTypes)`;
      }

      const nodesQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          ${typeFilter}
        RETURN n.uri as uri, n.label as label
        LIMIT $sampleSize
      `;

      const nodesResult = await session.run(nodesQuery, { 
        entityTypes, 
        sampleSize: neo4j.int(sampleSize * 2) 
      });
      
      const nodes = nodesResult.records.map(r => ({
        uri: r.get('uri'),
        label: r.get('label'),
        betweenness: 0
      }));

      if (nodes.length < 3) {
        return nodes;
      }

      // Sample pairs and find shortest paths
      const betweennessCount = new Map();
      nodes.forEach(n => betweennessCount.set(n.uri, 0));

      // Sample random pairs
      const pairs = [];
      for (let i = 0; i < Math.min(sampleSize, nodes.length); i++) {
        for (let j = i + 1; j < Math.min(sampleSize, nodes.length); j++) {
          pairs.push([nodes[i].uri, nodes[j].uri]);
        }
      }

      // Find shortest paths and count intermediaries
      for (const [startUri, endUri] of pairs.slice(0, 100)) {
        const pathQuery = `
          MATCH path = shortestPath((start {uri: $startUri})-[*..5]-(end {uri: $endUri}))
          WHERE start <> end
          RETURN [n IN nodes(path) | n.uri] as pathNodes
        `;

        try {
          const pathResult = await session.run(pathQuery, { startUri, endUri });
          
          if (pathResult.records.length > 0) {
            const pathNodes = pathResult.records[0].get('pathNodes');
            // Count intermediate nodes (exclude start and end)
            for (let i = 1; i < pathNodes.length - 1; i++) {
              const nodeUri = pathNodes[i];
              if (betweennessCount.has(nodeUri)) {
                betweennessCount.set(nodeUri, betweennessCount.get(nodeUri) + 1);
              }
            }
          }
        } catch (e) {
          // Path not found, continue
        }
      }

      // Normalize and return results
      const maxBetweenness = Math.max(...betweennessCount.values()) || 1;
      
      return nodes
        .map(n => ({
          ...n,
          betweenness: betweennessCount.get(n.uri) || 0,
          normalizedBetweenness: (betweennessCount.get(n.uri) || 0) / maxBetweenness
        }))
        .sort((a, b) => b.betweenness - a.betweenness)
        .slice(0, limit)
        .map((n, i) => ({ ...n, rank: i + 1 }));
    } finally {
      await session.close();
    }
  }

  /**
   * Detect communities using label propagation (simplified)
   */
  async detectCommunities(options = {}) {
    const { iterations = 10, entityTypes = null } = options;
    const session = neo4jService.getSession();
    
    try {
      let typeFilter = '';
      if (entityTypes && entityTypes.length > 0) {
        typeFilter = `AND any(label IN labels(n) WHERE label IN $entityTypes)`;
      }

      // Get nodes
      const nodesQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          ${typeFilter}
        RETURN n.uri as uri, n.label as label, labels(n) as nodeLabels
      `;

      const nodesResult = await session.run(nodesQuery, { entityTypes });
      
      const nodes = new Map();
      nodesResult.records.forEach((r, i) => {
        nodes.set(r.get('uri'), {
          uri: r.get('uri'),
          label: r.get('label'),
          nodeLabels: r.get('nodeLabels'),
          community: i // Initial community = node index
        });
      });

      if (nodes.size === 0) {
        return { communities: [], stats: { nodeCount: 0, communityCount: 0 } };
      }

      // Get edges
      const edgesQuery = `
        MATCH (source)-[r]-(target)
        WHERE source.uri IN $uris AND target.uri IN $uris
          AND NOT type(r) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        RETURN DISTINCT source.uri as sourceUri, target.uri as targetUri
      `;

      const uris = Array.from(nodes.keys());
      const edgesResult = await session.run(edgesQuery, { uris });
      
      // Build adjacency list
      const adjacency = new Map();
      for (const uri of uris) {
        adjacency.set(uri, []);
      }
      
      for (const record of edgesResult.records) {
        const source = record.get('sourceUri');
        const target = record.get('targetUri');
        if (adjacency.has(source)) adjacency.get(source).push(target);
        if (adjacency.has(target)) adjacency.get(target).push(source);
      }

      // Label propagation
      for (let iter = 0; iter < iterations; iter++) {
        let changed = false;
        
        for (const [uri, node] of nodes) {
          const neighbors = adjacency.get(uri) || [];
          if (neighbors.length === 0) continue;
          
          // Count neighbor communities
          const communityCount = new Map();
          for (const neighborUri of neighbors) {
            const neighborNode = nodes.get(neighborUri);
            if (neighborNode) {
              const comm = neighborNode.community;
              communityCount.set(comm, (communityCount.get(comm) || 0) + 1);
            }
          }
          
          // Find most common community
          let maxCount = 0;
          let maxCommunity = node.community;
          for (const [comm, count] of communityCount) {
            if (count > maxCount) {
              maxCount = count;
              maxCommunity = comm;
            }
          }
          
          if (maxCommunity !== node.community) {
            node.community = maxCommunity;
            changed = true;
          }
        }
        
        if (!changed) break;
      }

      // Group nodes by community
      const communities = new Map();
      for (const node of nodes.values()) {
        if (!communities.has(node.community)) {
          communities.set(node.community, []);
        }
        communities.get(node.community).push(node);
      }

      // Format results
      const result = Array.from(communities.entries())
        .map(([communityId, members], index) => ({
          communityId: index,
          size: members.length,
          members: members.map(m => ({
            uri: m.uri,
            label: m.label,
            nodeLabels: m.nodeLabels
          }))
        }))
        .sort((a, b) => b.size - a.size);

      return {
        communities: result,
        stats: {
          nodeCount: nodes.size,
          communityCount: result.length,
          largestCommunity: result[0]?.size || 0,
          averageCommunitySize: nodes.size / result.length
        }
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Find shortest path between two entities
   */
  async findShortestPath(sourceUri, targetUri, options = {}) {
    const { maxDepth = 6 } = options;
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH path = shortestPath((source {uri: $sourceUri})-[*..${maxDepth}]-(target {uri: $targetUri}))
        RETURN path,
               length(path) as pathLength,
               [n IN nodes(path) | {uri: n.uri, label: n.label, labels: labels(n)}] as pathNodes,
               [r IN relationships(path) | {type: type(r), predicate: r.predicate}] as pathRels
      `;

      const result = await session.run(query, { sourceUri, targetUri });
      
      if (result.records.length === 0) {
        return { found: false, message: 'No path found' };
      }

      const record = result.records[0];
      
      return {
        found: true,
        pathLength: neo4jService.toNumber(record.get('pathLength')),
        nodes: record.get('pathNodes'),
        relationships: record.get('pathRels')
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Find all paths between two entities
   */
  async findAllPaths(sourceUri, targetUri, options = {}) {
    const { maxDepth = 4, limit = 10 } = options;
    const session = neo4jService.getSession();
    
    try {
      const query = `
        MATCH path = (source {uri: $sourceUri})-[*..${maxDepth}]-(target {uri: $targetUri})
        WHERE source <> target
        RETURN path,
               length(path) as pathLength,
               [n IN nodes(path) | {uri: n.uri, label: n.label}] as pathNodes,
               [r IN relationships(path) | {type: type(r), predicate: r.predicate}] as pathRels
        ORDER BY pathLength
        LIMIT $limit
      `;

      const result = await session.run(query, { 
        sourceUri, 
        targetUri, 
        limit: neo4j.int(limit) 
      });
      
      return result.records.map(record => ({
        pathLength: neo4jService.toNumber(record.get('pathLength')),
        nodes: record.get('pathNodes'),
        relationships: record.get('pathRels')
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Find connected components
   */
  async findConnectedComponents(options = {}) {
    const { entityTypes = null, minSize = 2 } = options;
    const session = neo4jService.getSession();
    
    try {
      let typeFilter = '';
      if (entityTypes && entityTypes.length > 0) {
        typeFilter = `AND any(label IN labels(n) WHERE label IN $entityTypes)`;
      }

      // Get all nodes and edges
      const nodesQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
          ${typeFilter}
        RETURN n.uri as uri
      `;

      const nodesResult = await session.run(nodesQuery, { entityTypes });
      const allNodes = new Set(nodesResult.records.map(r => r.get('uri')));

      const edgesQuery = `
        MATCH (source)-[r]-(target)
        WHERE source.uri IN $uris AND target.uri IN $uris
          AND NOT type(r) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        RETURN DISTINCT source.uri as sourceUri, target.uri as targetUri
      `;

      const uris = Array.from(allNodes);
      const edgesResult = await session.run(edgesQuery, { uris });

      // Build adjacency list
      const adjacency = new Map();
      for (const uri of allNodes) {
        adjacency.set(uri, new Set());
      }
      
      for (const record of edgesResult.records) {
        const source = record.get('sourceUri');
        const target = record.get('targetUri');
        if (adjacency.has(source)) adjacency.get(source).add(target);
        if (adjacency.has(target)) adjacency.get(target).add(source);
      }

      // Find connected components using BFS
      const visited = new Set();
      const components = [];

      for (const startNode of allNodes) {
        if (visited.has(startNode)) continue;
        
        const component = [];
        const queue = [startNode];
        
        while (queue.length > 0) {
          const node = queue.shift();
          if (visited.has(node)) continue;
          
          visited.add(node);
          component.push(node);
          
          for (const neighbor of adjacency.get(node) || []) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }
        
        if (component.length >= minSize) {
          components.push(component);
        }
      }

      return {
        components: components
          .sort((a, b) => b.length - a.length)
          .map((comp, i) => ({
            componentId: i,
            size: comp.length,
            nodes: comp
          })),
        stats: {
          totalNodes: allNodes.size,
          componentCount: components.length,
          isolatedNodes: allNodes.size - components.reduce((sum, c) => sum + c.length, 0)
        }
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get graph statistics summary
   */
  async getGraphStatistics() {
    const session = neo4jService.getSession();
    
    try {
      const statsQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
        WITH count(n) as nodeCount
        MATCH ()-[r]->()
        WHERE NOT type(r) IN ['PART_OF', 'MENTIONED_IN', 'HAS_PROVENANCE']
        WITH nodeCount, count(r) as edgeCount
        RETURN nodeCount, edgeCount,
               CASE WHEN nodeCount > 0 THEN toFloat(edgeCount) / nodeCount ELSE 0 END as avgDegree
      `;

      const result = await session.run(statsQuery);
      
      if (result.records.length === 0) {
        return { nodeCount: 0, edgeCount: 0, avgDegree: 0 };
      }

      const record = result.records[0];
      
      // Get label distribution
      const labelQuery = `
        MATCH (n)
        WHERE n.label IS NOT NULL
          AND NOT n:Document AND NOT n:Chunk AND NOT n:Folder
        UNWIND labels(n) as label
        WITH label, count(*) as count
        WHERE NOT label IN ['Entity', 'Concept']
        RETURN label, count
        ORDER BY count DESC
        LIMIT 20
      `;

      const labelResult = await session.run(labelQuery);
      
      return {
        nodeCount: neo4jService.toNumber(record.get('nodeCount')),
        edgeCount: neo4jService.toNumber(record.get('edgeCount')),
        avgDegree: record.get('avgDegree'),
        labelDistribution: labelResult.records.map(r => ({
          label: r.get('label'),
          count: neo4jService.toNumber(r.get('count'))
        }))
      };
    } finally {
      await session.close();
    }
  }
}

module.exports = new GraphAlgorithmsService();
