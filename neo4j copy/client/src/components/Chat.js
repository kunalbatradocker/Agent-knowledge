import React, { useState, useRef, useEffect } from 'react';
import './Chat.css';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTenant } from '../contexts/TenantContext';

// Use relative URL - the proxy (setupProxy.js) forwards /api to the server
const API_BASE_URL = '/api';

const SEARCH_MODES = [
  { id: 'hybrid', name: 'Hybrid', icon: '🔀', description: 'Vector search + Knowledge Graph (recommended)', admin: true },
  { id: 'rag', name: 'RAG Only', icon: '📊', description: 'Vector/semantic search only (Redis)', admin: false },
  { id: 'graph', name: 'Graph Only', icon: '🔗', description: 'Knowledge graph traversal only (Neo4j concepts)', admin: true },
  { id: 'graphdb', name: 'GraphDB Direct', icon: '🔷', description: 'Natural language → SPARQL (RDF/ontology data)', admin: false },
  { id: 'compare', name: 'Compare', icon: '⚖️', description: 'RAG vs Neo4j Graph side-by-side comparison', admin: false },
  { id: 'vkg', name: 'Federated', icon: '🌐', description: 'Query live databases via Trino (VKG)', admin: false }
];

const Chat = ({ appMode = 'admin' }) => {
  const visibleModes = appMode === 'admin' ? SEARCH_MODES : SEARCH_MODES.filter(m => !m.admin);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [showSources, setShowSources] = useState({});
  const [searchMode, setSearchMode] = useState(appMode === 'user' ? 'rag' : 'hybrid');
  const [showSettings, setShowSettings] = useState(false);

  // Reset search mode when app mode changes
  useEffect(() => {
    const allowed = appMode === 'admin' ? SEARCH_MODES : SEARCH_MODES.filter(m => !m.admin);
    if (!allowed.find(m => m.id === searchMode)) setSearchMode(allowed[0].id);
  }, [appMode]);
  
  // GraphDB mode - graph selection
  const [availableGraphs, setAvailableGraphs] = useState([]);
  const [selectedGraph, setSelectedGraph] = useState('');
  const [graphSchema, setGraphSchema] = useState(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  
  // Get tenant context (may be null during initial load)
  const tenantContext = useTenant();
  const currentTenant = tenantContext?.currentTenant;
  const currentWorkspace = tenantContext?.currentWorkspace;
  const getTenantHeaders = tenantContext?.getTenantHeaders || (() => ({}));
  
  // Configurable settings
  const [settings, setSettings] = useState({
    topK: 8,              // Number of chunks to retrieve
    graphDepth: 2,        // Relationship traversal depth (1-3)
    historyCount: 3       // Number of previous messages for context
  });
  
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Reset conversation when workspace changes
  useEffect(() => {
    if (currentWorkspace?.workspace_id) {
      setMessages([]);
      setConversationId(null);
      setShowSources({});
    }
  }, [currentWorkspace?.workspace_id]);

  // Load available graphs when GraphDB mode is selected
  useEffect(() => {
    if (searchMode === 'graphdb') {
      loadAvailableGraphs();
    }
  }, [searchMode, currentWorkspace?.workspace_id]);

  // Load schema when graph is selected
  useEffect(() => {
    if (selectedGraph && searchMode === 'graphdb') {
      loadGraphSchema(selectedGraph);
    }
  }, [selectedGraph, searchMode]);

  const loadAvailableGraphs = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/owl/list`, {
        params: { 
          tenantId: currentTenant?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          scope: 'all'
        },
        headers: getTenantHeaders()
      });
      const graphs = [
        { id: 'data', name: '📊 Workspace Data', type: 'data' },
        ...(res.data.ontologies || []).map(o => ({
          id: o.ontologyId,
          name: `${o.scope === 'global' ? '🌐' : '📁'} ${o.label}`,
          type: 'ontology',
          graphIRI: o.graphIRI
        }))
      ];
      setAvailableGraphs(graphs);
      if (!selectedGraph && graphs.length > 0) {
        setSelectedGraph('data');
      }
    } catch (e) {
      console.error('Failed to load graphs:', e);
    }
  };

  const loadGraphSchema = async (graphId) => {
    setLoadingSchema(true);
    try {
      let schema = { classes: [], properties: [] };
      if (graphId === 'data') {
        // Get schema from workspace data
        const res = await axios.get(`${API_BASE_URL}/admin/graphdb/discover-schema`, {
          params: { 
            tenantId: currentTenant?.tenant_id || 'default',
            workspaceId: currentWorkspace?.workspace_id || 'default'
          },
          headers: getTenantHeaders()
        });
        // Map discover-schema response (classes, predicates) to expected format
        schema = {
          classes: res.data.classes || [],
          properties: (res.data.predicates || []).map(p => ({ ...p, name: p.label }))
        };
      } else {
        // Get ontology structure
        const res = await axios.get(`${API_BASE_URL}/owl/structure/${graphId}`, {
          params: {
            tenantId: currentTenant?.tenant_id || 'default',
            workspaceId: currentWorkspace?.workspace_id || 'default'
          },
          headers: getTenantHeaders()
        });
        schema = {
          classes: res.data.classes || [],
          properties: res.data.properties || []
        };
      }
      console.log('Loaded schema:', schema.classes?.length, 'classes,', schema.properties?.length, 'properties');
      setGraphSchema(schema);
    } catch (e) {
      console.error('Failed to load schema:', e);
      setGraphSchema(null);
    } finally {
      setLoadingSchema(false);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    setLoading(true);

    // Add user message to chat
    setMessages(prev => [...prev, {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    }]);

    try {
      // Build conversation history for context
      const recentHistory = messages
        .slice(-settings.historyCount * 2) // Get last N exchanges (user + assistant pairs)
        .map(m => ({ role: m.role, content: m.content }));
      
      // Build options with schema context for GraphDB mode
      const options = {
        searchMode: searchMode,
        topK: settings.topK,
        graphDepth: settings.graphDepth,
        tenant_id: currentTenant?.tenant_id,
        workspace_id: currentWorkspace?.workspace_id
      };
      
      // Add schema context for GraphDB mode
      if (searchMode === 'graphdb' && graphSchema) {
        options.graphId = selectedGraph;
        // Send the actual graph IRI for the selected ontology
        const selectedGraphObj = availableGraphs.find(g => g.id === selectedGraph);
        if (selectedGraphObj?.graphIRI) {
          options.graphIRI = selectedGraphObj.graphIRI;
        }
        options.schema = {
          classes: graphSchema.classes?.slice(0, 30).map(c => ({
            label: c.label || c.localName || c.name || c.iri?.split(/[#/]/).pop(),
            iri: c.iri
          })),
          properties: graphSchema.properties?.slice(0, 50).map(p => ({
            name: p.name || p.label || p.localName || p.iri?.split(/[#/]/).pop(),
            iri: p.iri,
            type: p.type,
            domain: p.domain
          }))
        };
        console.log('Sending schema to backend:', options.schema.classes?.length, 'classes');
      }
      
      // VKG mode uses a different endpoint
      let response;
      if (searchMode === 'vkg') {
        response = await axios.post(`${API_BASE_URL}/vkg/query`, {
          question: userMessage,
          workspaceId: currentWorkspace?.workspace_id || 'default'
        }, {
          headers: getTenantHeaders()
        });

        setMessages(prev => [...prev, {
          role: 'assistant',
          content: response.data.answer,
          sources: response.data.citations ? { sql: response.data.citations.sql, databases: response.data.citations.databases } : null,
          contextGraph: response.data.context_graph,
          reasoningTrace: response.data.reasoning_trace,
          executionStats: response.data.execution_stats,
          executionPipeline: response.data.execution_pipeline,
          searchMode: 'vkg',
          timestamp: new Date().toISOString()
        }]);
      } else {
        response = await axios.post(`${API_BASE_URL}/chat/message`, {
          message: userMessage,
          conversationId: conversationId,
          history: recentHistory,
          options
        }, {
          headers: getTenantHeaders()
        });

        setConversationId(response.data.conversationId);

        // Add assistant message to chat
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: response.data.message.compare 
            ? `RAG: ${response.data.message.compare.rag?.answer?.substring(0, 200) || 'No answer'}\n\nGraphDB: ${response.data.message.compare.graphdb?.answer?.substring(0, 200) || 'No answer'}`
            : response.data.message.content,
          sources: response.data.message.sources,
          compare: response.data.message.compare || null,
          metadata: response.data.message.metadata,
          searchMode: response.data.message.metadata?.searchMode || searchMode,
          timestamp: new Date().toISOString()
        }]);
      }
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, {
        role: 'error',
        content: error.response?.data?.message || 'Failed to get response. Please try again.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      setLoading(false);
    }
  };

  const toggleSources = (index) => {
    setShowSources(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setShowSources({});
  };

  // Count sources for display
  const getSourceCounts = (sources) => {
    if (!sources) return { chunks: 0, entities: 0, relations: 0, documents: 0 };
    return {
      chunks: sources.chunks?.length || 0,
      entities: sources.graphEntities?.length || 0,
      relations: sources.relations?.length || 0,
      documents: sources.documents?.length || 0
    };
  };

  const getSearchModeIcon = (mode) => {
    const modeInfo = SEARCH_MODES.find(m => m.id === mode);
    return modeInfo ? modeInfo.icon : '🔀';
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        {/* Search Mode Selector */}
        <div className="search-mode-selector">
          <div className="search-mode-row">
            <span className="search-mode-label">Search Mode:</span>
            <div className="search-mode-buttons">
              {visibleModes.map(mode => (
                <button
                  key={mode.id}
                  className={`search-mode-btn ${searchMode === mode.id ? 'active' : ''}`}
                  onClick={() => setSearchMode(mode.id)}
                  title={mode.description}
                  disabled={loading}
                >
                  <span className="mode-icon">{mode.icon}</span>
                  <span className="mode-name">{mode.name}</span>
                </button>
              ))}
            </div>
            
            {/* GraphDB Mode - Graph Selector (inline) */}
            {searchMode === 'graphdb' && (
              <div className="graph-selector-inline">
                <select 
                  value={selectedGraph} 
                  onChange={e => setSelectedGraph(e.target.value)}
                  disabled={loading}
                >
                  {availableGraphs.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                {loadingSchema && <span className="loading-schema">Loading...</span>}
                {graphSchema && !loadingSchema && (
                  <span className="schema-badge">
                    {graphSchema.classes?.length || 0} classes, {graphSchema.properties?.length || 0} properties
                  </span>
                )}
              </div>
            )}

            <button className="new-chat-btn" onClick={startNewConversation}>
              + New Conversation
            </button>
          </div>
          <p className="search-mode-description">
            {visibleModes.find(m => m.id === searchMode)?.description}
          </p>
        </div>
        
        {/* Settings Toggle & Panel */}
        <div className="chat-settings">
          <button 
            className={`settings-toggle ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
            disabled={loading}
          >
            ⚙️ Settings {showSettings ? '▲' : '▼'}
          </button>
          
          {showSettings && (
            <div className="settings-panel">
              <div className="setting-item">
                <label>
                  <span className="setting-label">📄 Chunks to retrieve</span>
                  <span className="setting-value">{settings.topK}</span>
                </label>
                <input 
                  type="range" 
                  min="3" 
                  max="15" 
                  value={settings.topK}
                  onChange={e => setSettings(s => ({ ...s, topK: parseInt(e.target.value) }))}
                  disabled={loading}
                />
                <span className="setting-hint">More chunks = more context but slower</span>
              </div>
              
              <div className="setting-item">
                <label>
                  <span className="setting-label">🔗 Relationship depth</span>
                  <span className="setting-value">{settings.graphDepth} level{settings.graphDepth > 1 ? 's' : ''}</span>
                </label>
                <input 
                  type="range" 
                  min="1" 
                  max="3" 
                  value={settings.graphDepth}
                  onChange={e => setSettings(s => ({ ...s, graphDepth: parseInt(e.target.value) }))}
                  disabled={loading || searchMode === 'rag'}
                />
                <span className="setting-hint">
                  {settings.graphDepth === 1 && 'Direct relationships only'}
                  {settings.graphDepth === 2 && 'Include 2nd-degree connections'}
                  {settings.graphDepth === 3 && 'Deep traversal (may be slow)'}
                </span>
              </div>
              
              <div className="setting-item">
                <label>
                  <span className="setting-label">💬 Conversation history</span>
                  <span className="setting-value">{settings.historyCount} message{settings.historyCount > 1 ? 's' : ''}</span>
                </label>
                <input 
                  type="range" 
                  min="0" 
                  max="10" 
                  value={settings.historyCount}
                  onChange={e => setSettings(s => ({ ...s, historyCount: parseInt(e.target.value) }))}
                  disabled={loading}
                />
                <span className="setting-hint">
                  {settings.historyCount === 0 && 'No history (each query is independent)'}
                  {settings.historyCount > 0 && `Last ${settings.historyCount} exchanges for follow-ups`}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="empty-chat">
            <div className="empty-icon">💬</div>
            <h3>Start a conversation</h3>
            <p>Ask questions about your uploaded documents. The assistant will use both semantic search and knowledge graph to find relevant information.</p>
          </div>
        )}

        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👤' : msg.role === 'error' ? '❌' : '🤖'}
            </div>
            <div className="message-content">
              {/* Compare mode: side-by-side */}
              {msg.compare ? (
                <div className="compare-container">
                  <div className="compare-panel">
                    <div className="compare-panel-header">📊 RAG (Vector Search)</div>
                    <div className="message-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.compare.rag.answer}</ReactMarkdown></div>
                    {msg.compare.rag.sources?.chunks?.length > 0 && (
                      <div className="compare-sources">
                        <small>{msg.compare.rag.sources.chunks.length} chunks used</small>
                      </div>
                    )}
                  </div>
                  <div className="compare-divider" />
                  <div className="compare-panel">
                    <div className="compare-panel-header">🔗 Neo4j Graph (Cypher)</div>
                    <div className="message-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.compare.graphdb.answer}</ReactMarkdown></div>
                    {msg.compare.graphdb.metadata?.cypher && (
                      <details className="compare-sparql">
                        <summary>View Cypher</summary>
                        <pre>{msg.compare.graphdb.metadata.cypher}</pre>
                      </details>
                    )}
                    {msg.compare.graphdb.metadata?.sparql && (
                      <details className="compare-sparql">
                        <summary>View SPARQL</summary>
                        <pre>{msg.compare.graphdb.metadata.sparql}</pre>
                      </details>
                    )}
                    {(msg.compare.graphdb.sources?.graphEntities?.length > 0 || msg.compare.graphdb.sources?.documents?.length > 0) && (
                      <div className="compare-sources">
                        <small>
                          {[
                            msg.compare.graphdb.sources.graphEntities?.length > 0 && `${msg.compare.graphdb.sources.graphEntities.length} entities`,
                            msg.compare.graphdb.sources.documents?.length > 0 && `${msg.compare.graphdb.sources.documents.length} source docs`
                          ].filter(Boolean).join(', ')}
                        </small>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
              <>
              <div className="message-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>

              {/* VKG Evidence Panels */}
              {msg.searchMode === 'vkg' && (
                <div className="vkg-evidence-panels">
                  {/* SQL Citation */}
                  {msg.sources?.sql && (
                    <details className="vkg-sql-citation">
                      <summary>🔍 SQL Query</summary>
                      <pre className="vkg-sql-code">{msg.sources.sql}</pre>
                    </details>
                  )}

                  {/* Database Badges */}
                  {msg.sources?.databases?.length > 0 && (
                    <div className="vkg-db-badges">
                      {msg.sources.databases.map((db, i) => (
                        <span key={i} className="vkg-db-badge">🗄️ {db}</span>
                      ))}
                    </div>
                  )}

                  {/* Context Graph Summary */}
                  {msg.contextGraph && msg.contextGraph.statistics?.nodeCount > 0 && (
                    <details className="vkg-context-graph-summary">
                      <summary>🕸️ Context Graph ({msg.contextGraph.statistics.nodeCount} nodes, {msg.contextGraph.statistics.edgeCount} edges)</summary>
                      <div className="vkg-graph-stats">
                        {Object.entries(msg.contextGraph.statistics.cardinality || {}).map(([type, count]) => (
                          <span key={type} className="vkg-type-badge">{type}: {count}</span>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Reasoning Trace */}
                  {msg.reasoningTrace?.length > 0 && (
                    <details className="vkg-reasoning-trace">
                      <summary>🧠 Reasoning ({msg.reasoningTrace.length} steps)</summary>
                      <ol className="vkg-trace-steps">
                        {msg.reasoningTrace.map((step, i) => (
                          <li key={i} className="vkg-trace-step">
                            <span className="vkg-step-text">{step.step || step.description}</span>
                            {step.sources && <span className="vkg-step-sources">({step.sources.join(', ')})</span>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}

                  {/* Execution Stats */}
                  {msg.executionStats && (
                    <details className="vkg-execution-stats">
                      <summary>⏱️ Execution ({msg.executionStats.total_ms || msg.executionStats.totalMs}ms)</summary>
                      <div className="vkg-stats-grid">
                        {Object.entries(msg.executionStats).map(([key, val]) => (
                          <div key={key} className="vkg-stat-item">
                            <span className="vkg-stat-key">{key.replace(/_/g, ' ')}</span>
                            <span className="vkg-stat-value">{typeof val === 'number' ? val.toLocaleString() : val}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              
              {msg.sources && !Array.isArray(msg.sources) && (
                <div className="message-sources">
                  {(() => {
                    const counts = getSourceCounts(msg.sources);
                    const total = counts.chunks + counts.entities + counts.relations + counts.documents;
                    if (total === 0 && !msg.metadata?.sparql && !msg.metadata?.cypher) return null;
                    return (
                      <button 
                        className="sources-toggle"
                        onClick={() => toggleSources(index)}
                      >
                        {showSources[index] ? '▼ Hide Sources' : '▶ Show Sources'} 
                        ({[
                          counts.chunks > 0 && `${counts.chunks} chunks`,
                          counts.entities > 0 && `${counts.entities} entities`,
                          counts.relations > 0 && `${counts.relations} relations`,
                          counts.documents > 0 && `${counts.documents} docs`
                        ].filter(Boolean).join(', ') || (msg.metadata?.sparql ? 'query' : msg.metadata?.cypher ? 'query' : 'none')})
                      </button>
                    );
                  })()}
                  
                  {showSources[index] && (
                    <div className="sources-details">
                      {/* Document Chunks */}
                      {msg.sources.chunks?.length > 0 && (
                        <div className="sources-section">
                          <h4>📄 Document Chunks</h4>
                          {msg.sources.chunks.map((chunk, i) => (
                            <div key={i} className="source-item chunk-item">
                              <div className="source-header">
                                <span className="source-name">{chunk.documentName}</span>
                                {(chunk.startPage || chunk.endPage) && (
                                  <span className="source-page">
                                    📄 {chunk.startPage === chunk.endPage 
                                      ? `Page ${chunk.startPage}` 
                                      : `Pages ${chunk.startPage}-${chunk.endPage}`}
                                  </span>
                                )}
                                <span className="source-similarity">
                                  Relevance: {(parseFloat(chunk.similarity) * 100).toFixed(1)}%
                                </span>
                              </div>
                              <p className="source-text">{chunk.text}</p>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {/* Knowledge Graph Entities */}
                      {msg.sources.graphEntities?.length > 0 && (
                        <div className="sources-section">
                          <h4>💡 Knowledge Graph Concepts</h4>
                          <div className="entities-grid">
                            {msg.sources.graphEntities.map((entity, i) => (
                              <div key={i} className="source-item entity-item">
                                <div className="entity-header">
                                  <span className="entity-label">{entity.label}</span>
                                  <span className="entity-type">{entity.type}</span>
                                </div>
                                {entity.description && (
                                  <p className="entity-description">{entity.description}</p>
                                )}
                                {entity.relationships > 0 && (
                                  <span className="entity-rels">🔗 {entity.relationships} relationships</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Knowledge Graph Relations */}
                      {msg.sources.relations?.length > 0 && (
                        <div className="sources-section">
                          <h4>🔗 Relationships Found</h4>
                          <div className="relations-list">
                            {msg.sources.relations.map((rel, i) => (
                              <div key={i} className="relation-item">
                                <span className="rel-source">{rel.source}</span>
                                <span className="rel-predicate">—[{rel.predicate}]→</span>
                                <span className="rel-target">{rel.target}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Graph-sourced Chunks */}
                      {msg.sources.graphChunks?.length > 0 && msg.sources.graphChunks.some(c => c.text) && (
                        <div className="sources-section">
                          <h4>🕸️ Graph-Related Content</h4>
                          {msg.sources.graphChunks.filter(c => c.text).map((chunk, i) => (
                            <div key={i} className="source-item">
                              <div className="source-header">
                                <span className="source-name">{chunk.docTitle}</span>
                                {(chunk.startPage || chunk.endPage) && (
                                  <span className="source-page">
                                    📄 {chunk.startPage === chunk.endPage 
                                      ? `Page ${chunk.startPage}` 
                                      : `Pages ${chunk.startPage}-${chunk.endPage}`}
                                  </span>
                                )}
                                {chunk.concepts && (
                                  <span className="source-concepts">Concepts: {chunk.concepts}</span>
                                )}
                              </div>
                              <p className="source-text">{chunk.text}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Source Documents */}
                      {msg.sources.documents?.length > 0 && (
                        <div className="sources-section">
                          <h4>📁 Source Documents</h4>
                          <div className="documents-list">
                            {msg.sources.documents.map((doc, i) => (
                              <div key={i} className="source-item document-item">
                                <div className="source-header">
                                  <span className="source-name">{doc.title}</span>
                                  <span className="doc-type-badge">{doc.docType}</span>
                                </div>
                                {doc.entityCount > 0 && (
                                  <span className="doc-entity-count">{doc.entityCount} entities</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Query Used (SPARQL/Cypher) */}
                      {msg.metadata?.sparql && (
                        <details className="query-details">
                          <summary>View SPARQL Query</summary>
                          <pre>{msg.metadata.sparql}</pre>
                        </details>
                      )}
                      {msg.metadata?.cypher && (
                        <details className="query-details">
                          <summary>View Cypher Query</summary>
                          <pre>{msg.metadata.cypher}</pre>
                        </details>
                      )}

                      {/* Metadata */}
                      {msg.metadata && (
                        <div className="sources-metadata">
                          <span className="search-mode-badge">
                            {getSearchModeIcon(msg.searchMode)} {msg.searchMode?.toUpperCase() || 'HYBRID'}
                          </span>
                          {msg.metadata.totalContextLength > 0 && (
                            <span>📊 Context: {msg.metadata.totalContextLength?.toLocaleString()} chars</span>
                          )}
                          {msg.metadata.resultCount > 0 && (
                            <span>📊 {msg.metadata.resultCount} results</span>
                          )}
                          {msg.metadata.vectorChunksUsed > 0 && (
                            <span>📄 {msg.metadata.vectorChunksUsed} vector chunks</span>
                          )}
                          {msg.metadata.graphConceptsUsed > 0 && (
                            <span>💡 {msg.metadata.graphConceptsUsed} concepts</span>
                          )}
                          {msg.metadata.relationsFound > 0 && (
                            <span>🔗 {msg.metadata.relationsFound} relations</span>
                          )}
                          {msg.metadata.graphDepth && (
                            <span>🌳 Depth: {msg.metadata.graphDepth}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              </>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="message assistant loading">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-form" onSubmit={sendMessage}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your documents..."
          disabled={loading}
        />
        <button type="submit" disabled={!input.trim() || loading}>
          {loading ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
};

export default Chat;
