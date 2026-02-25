import React, { useState, useEffect, useRef } from 'react';
import './AgentsPage.css';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTenant } from '../contexts/TenantContext';

const API_BASE_URL = '/api';

function AgentsPage() {
  const { currentTenant, currentWorkspace, getTenantHeaders } = useTenant();
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [view, setView] = useState('list'); // list | edit | chat
  const [loading, setLoading] = useState(false);
  const [availableGraphs, setAvailableGraphs] = useState([]);
  const [availableFolders, setAvailableFolders] = useState([]);
  const [availableDatabases, setAvailableDatabases] = useState([]);

  // Form state
  const [form, setForm] = useState({ name: '', description: '', perspective: '', knowledge_graphs: [], folders: [], vkg_databases: [], search_mode: 'hybrid', settings: { topK: 8, graphDepth: 2 } });

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => { loadAgents(); loadGraphs(); loadFolders(); }, [currentWorkspace?.workspace_id]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const loadAgents = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents`, { headers: getTenantHeaders() });
      setAgents(res.data.agents || []);
    } catch (e) { console.error('Failed to load agents:', e); }
  };

  const loadGraphs = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/owl/list`, {
        params: { tenantId: currentTenant?.tenant_id || 'default', workspaceId: currentWorkspace?.workspace_id || 'default', scope: 'all' },
        headers: getTenantHeaders()
      });
      const graphs = [
        { id: 'all', name: 'All workspace data', type: 'data' },
        ...(res.data.ontologies || []).map(o => ({ id: o.ontologyId, name: o.label, type: 'ontology', graphIRI: o.graphIRI }))
      ];
      setAvailableGraphs(graphs);
    } catch (e) { console.error('Failed to load graphs:', e); }
  };

  const loadFolders = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/folders`, { headers: getTenantHeaders() });
      setAvailableFolders(res.data.folders || []);
    } catch (e) { console.error('Failed to load folders:', e); }
  };

  const loadDatabases = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/trino/catalogs`, { headers: getTenantHeaders() });
      const catalogs = res.data.catalogs || [];
      const dbs = [];
      for (const cat of catalogs) {
        try {
          const schemaRes = await axios.get(`${API_BASE_URL}/trino/catalogs/${cat.catalogName}/introspect`, { headers: getTenantHeaders() });
          const schemas = schemaRes.data.schemas || [];
          for (const s of schemas) {
            dbs.push({ id: `${cat.catalogName}.${s.name}`, catalog: cat.catalogName, schema: s.name, tables: s.tables || [] });
          }
        } catch (e) {
          dbs.push({ id: cat.catalogName, catalog: cat.catalogName, schema: '', tables: [] });
        }
      }
      setAvailableDatabases(dbs);
    } catch (e) { console.error('Failed to load databases:', e); }
  };

  const openCreate = () => {
    setForm({ name: '', description: '', perspective: '', knowledge_graphs: [], folders: [], vkg_databases: [], search_mode: 'hybrid', settings: { topK: 8, graphDepth: 2 } });
    setSelectedAgent(null);
    setView('edit');
  };

  const openEdit = (agent) => {
    setForm({
      name: agent.name,
      description: agent.description || '',
      perspective: agent.perspective || '',
      knowledge_graphs: agent.knowledge_graphs || [],
      folders: agent.folders || [],
      vkg_databases: agent.vkg_databases || [],
      search_mode: agent.search_mode || 'hybrid',
      settings: agent.settings || { topK: 8, graphDepth: 2 }
    });
    setSelectedAgent(agent);
    setView('edit');
    // Load VKG databases if in VKG mode
    if ((agent.search_mode || 'hybrid') === 'vkg') loadDatabases();
  };

  const openChat = (agent) => {
    setSelectedAgent(agent);
    setChatMessages([]);
    setChatInput('');
    setView('chat');
  };

  const saveAgent = async () => {
    if (!form.name.trim()) return;
    setLoading(true);
    try {
      if (selectedAgent) {
        await axios.put(`${API_BASE_URL}/agents/${selectedAgent.agent_id}`, {
          name: form.name, description: form.description, perspective: form.perspective,
          knowledgeGraphs: form.knowledge_graphs, folders: form.folders, vkgDatabases: form.vkg_databases,
          searchMode: form.search_mode, settings: form.settings
        }, { headers: getTenantHeaders() });
      } else {
        await axios.post(`${API_BASE_URL}/agents`, {
          name: form.name, description: form.description, perspective: form.perspective,
          knowledgeGraphs: form.knowledge_graphs, folders: form.folders, vkgDatabases: form.vkg_databases,
          searchMode: form.search_mode, settings: form.settings
        }, { headers: getTenantHeaders() });
      }
      await loadAgents();
      setView('list');
    } catch (e) { console.error('Save agent failed:', e); }
    setLoading(false);
  };

  const deleteAgent = async (agentId) => {
    if (!window.confirm('Delete this agent? This cannot be undone.')) return;
    try {
      await axios.delete(`${API_BASE_URL}/agents/${agentId}`, { headers: getTenantHeaders() });
      await loadAgents();
      if (selectedAgent?.agent_id === agentId) { setSelectedAgent(null); setView('list'); }
    } catch (e) { console.error('Delete agent failed:', e); }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading || !selectedAgent) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatLoading(true);
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    try {
      const res = await axios.post(`${API_BASE_URL}/agents/${selectedAgent.agent_id}/chat`, {
        message: userMsg,
        history: chatMessages.slice(-6)
      }, { headers: getTenantHeaders() });
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: res.data.message?.content || 'No response',
        sources: res.data.message?.sources
      }]);
    } catch (e) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.response?.data?.error || e.message}` }]);
    }
    setChatLoading(false);
  };

  const toggleGraph = (graphId) => {
    setForm(prev => {
      const current = prev.knowledge_graphs.map(g => g.id);
      if (current.includes(graphId)) {
        return { ...prev, knowledge_graphs: prev.knowledge_graphs.filter(g => g.id !== graphId) };
      }
      const graph = availableGraphs.find(g => g.id === graphId);
      return { ...prev, knowledge_graphs: [...prev.knowledge_graphs, { id: graph.id, name: graph.name, type: graph.type }] };
    });
  };

  const toggleFolder = (folderId) => {
    setForm(prev => {
      const current = prev.folders.map(f => f.id);
      if (current.includes(folderId)) {
        return { ...prev, folders: prev.folders.filter(f => f.id !== folderId) };
      }
      const folder = availableFolders.find(f => (f.folder_id || f.id) === folderId);
      return { ...prev, folders: [...prev.folders, { id: folderId, name: folder?.name || folderId }] };
    });
  };

  const toggleDatabase = (dbId) => {
    setForm(prev => {
      if (prev.vkg_databases.includes(dbId)) {
        return { ...prev, vkg_databases: prev.vkg_databases.filter(d => d !== dbId) };
      }
      return { ...prev, vkg_databases: [...prev.vkg_databases, dbId] };
    });
  };

  const handleSearchModeChange = (mode) => {
    setForm(p => ({ ...p, search_mode: mode }));
    if (mode === 'vkg') loadDatabases();
  };

  // ── List View ──
  if (view === 'list') {
    return (
      <div className="agents-page">
        <div className="agents-header">
          <div>
            <h2>🤖 Agents</h2>
            <p className="agents-subtitle">Build AI agents with custom perspectives and attached knowledge graphs</p>
          </div>
          <button className="btn-primary" onClick={openCreate}>+ New Agent</button>
        </div>

        {agents.length === 0 ? (
          <div className="agents-empty">
            <div className="empty-icon">🤖</div>
            <h3>No agents yet</h3>
            <p>Create your first agent to start querying your knowledge graphs with a custom perspective.</p>
            <button className="btn-primary" onClick={openCreate}>Create Agent</button>
          </div>
        ) : (
          <div className="agents-grid">
            {agents.map(agent => (
              <div key={agent.agent_id} className="agent-card">
                <div className="agent-card-header">
                  <h3>{agent.name}</h3>
                  <div className="agent-card-actions">
                    <button className="btn-icon" onClick={() => openChat(agent)} title="Chat">💬</button>
                    <button className="btn-icon" onClick={() => openEdit(agent)} title="Edit">✏️</button>
                    <button className="btn-icon danger" onClick={() => deleteAgent(agent.agent_id)} title="Delete">🗑️</button>
                  </div>
                </div>
                {agent.description && <p className="agent-card-desc">{agent.description}</p>}
                <div className="agent-card-meta">
                  {agent.folders?.length > 0 && (
                    <span className="agent-tag">📁 {agent.folders.length} folder{agent.folders.length !== 1 ? 's' : ''}</span>
                  )}
                  {agent.knowledge_graphs?.length > 0 && (
                    <span className="agent-tag">📊 {agent.knowledge_graphs.length} graph{agent.knowledge_graphs.length !== 1 ? 's' : ''}</span>
                  )}
                  {agent.vkg_databases?.length > 0 && (
                    <span className="agent-tag">🗄️ {agent.vkg_databases.length} database{agent.vkg_databases.length !== 1 ? 's' : ''}</span>
                  )}
                  <span className="agent-tag">🔍 {
                    { hybrid: 'Hybrid', rag: 'RAG', graph: 'Neo4j', graphdb: 'SPARQL', vkg: 'Federated' }[agent.search_mode] || agent.search_mode
                  }</span>
                </div>
                {agent.perspective && (
                  <div className="agent-card-perspective">
                    <span className="perspective-label">Perspective:</span> {agent.perspective.substring(0, 120)}{agent.perspective.length > 120 ? '...' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Edit View ──
  if (view === 'edit') {
    const selectedIds = new Set(form.knowledge_graphs.map(g => g.id));
    const selectedFolderIds = new Set(form.folders.map(f => f.id));
    const selectedDbIds = new Set(form.vkg_databases);
    return (
      <div className="agents-page">
        <div className="agents-header">
          <button className="btn-back" onClick={() => setView('list')}>← Back</button>
          <h2>{selectedAgent ? 'Edit Agent' : 'New Agent'}</h2>
        </div>

        <div className="agent-form">
          <div className="form-group">
            <label>Name</label>
            <input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Healthcare Analyst" />
          </div>

          <div className="form-group">
            <label>Description</label>
            <input type="text" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Brief description of what this agent does" />
          </div>

          <div className="form-group">
            <label>Perspective / System Prompt</label>
            <textarea rows={6} value={form.perspective} onChange={e => setForm(p => ({ ...p, perspective: e.target.value }))}
              placeholder="You are a healthcare data analyst specializing in patient referral patterns. When answering questions, focus on clinical workflows, referral volumes, and provider relationships..." />
            <small>This defines the agent's personality, expertise, and how it should interpret and respond to queries.</small>
          </div>

          <div className="form-group">
            <label>📁 Document Folders</label>
            <p className="form-hint">Select folders to scope this agent's queries. Only documents in these folders will be searched.</p>
            <div className="graph-picker">
              {availableFolders.map(f => {
                const fId = f.folder_id || f.id;
                return (
                  <label key={fId} className={`graph-option ${selectedFolderIds.has(fId) ? 'selected' : ''}`}>
                    <input type="checkbox" checked={selectedFolderIds.has(fId)} onChange={() => toggleFolder(fId)} />
                    <span className="graph-option-icon">📁</span>
                    <span className="graph-option-name">{f.name}</span>
                    {f.document_count != null && <span className="folder-doc-count">{f.document_count} docs</span>}
                  </label>
                );
              })}
              {availableFolders.length === 0 && <p className="form-hint">No folders available. Create folders in File Manager first.</p>}
            </div>
            {form.folders.length === 0 && <small className="form-warning">⚠️ No folders selected — agent will search all workspace documents.</small>}
          </div>

          <div className="form-group">
            <label>Knowledge Graphs</label>
            <p className="form-hint">Select which knowledge graphs this agent can query</p>
            <div className="graph-picker">
              {availableGraphs.map(g => (
                <label key={g.id} className={`graph-option ${selectedIds.has(g.id) ? 'selected' : ''}`}>
                  <input type="checkbox" checked={selectedIds.has(g.id)} onChange={() => toggleGraph(g.id)} />
                  <span className="graph-option-icon">{g.type === 'data' ? '📊' : '🏷️'}</span>
                  <span className="graph-option-name">{g.name}</span>
                </label>
              ))}
              {availableGraphs.length === 0 && <p className="form-hint">No knowledge graphs available. Upload documents and create ontologies first.</p>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Search Mode</label>
              <select value={form.search_mode} onChange={e => handleSearchModeChange(e.target.value)}>
                <option value="hybrid">🔀 Hybrid (Vector + Knowledge Graph)</option>
                <option value="rag">📊 RAG Only (Vector Search)</option>
                <option value="graph">🔗 Neo4j Graph (Cypher Queries)</option>
                <option value="graphdb">🔷 GraphDB Direct (SPARQL)</option>
                <option value="vkg">🌐 Federated (Trino / VKG)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Top K Results</label>
              <input type="number" min={1} max={20} value={form.settings.topK} onChange={e => setForm(p => ({ ...p, settings: { ...p.settings, topK: parseInt(e.target.value) || 8 } }))} />
            </div>
          </div>

          {form.search_mode === 'vkg' && (
            <div className="form-group">
              <label>🗄️ VKG Databases</label>
              <p className="form-hint">Select which databases this agent can query via Trino/VKG</p>
              <div className="graph-picker">
                {availableDatabases.map(db => (
                  <label key={db.id} className={`graph-option ${selectedDbIds.has(db.id) ? 'selected' : ''}`}>
                    <input type="checkbox" checked={selectedDbIds.has(db.id)} onChange={() => toggleDatabase(db.id)} />
                    <span className="graph-option-icon">🗄️</span>
                    <span className="graph-option-name">{db.id}</span>
                    {db.tables?.length > 0 && <span className="folder-doc-count">{db.tables.length} tables</span>}
                  </label>
                ))}
                {availableDatabases.length === 0 && <p className="form-hint">No databases found. Add a Trino connection in Data Sources first.</p>}
              </div>
            </div>
          )}

          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setView('list')}>Cancel</button>
            <button className="btn-primary" onClick={saveAgent} disabled={loading || !form.name.trim()}>
              {loading ? 'Saving...' : selectedAgent ? 'Update Agent' : 'Create Agent'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Chat View ──
  if (view === 'chat') {
    return (
      <div className="agents-page agent-chat-view">
        <div className="agents-header">
          <button className="btn-back" onClick={() => setView('list')}>← Back</button>
          <div className="chat-agent-info">
            <h2>💬 {selectedAgent?.name}</h2>
            {selectedAgent?.description && <p className="agents-subtitle">{selectedAgent.description}</p>}
          </div>
          <button className="btn-icon" onClick={() => openEdit(selectedAgent)} title="Edit agent">✏️</button>
        </div>

        <div className="agent-chat-container">
          <div className="agent-chat-messages">
            {chatMessages.length === 0 && (
              <div className="chat-welcome">
                <div className="chat-welcome-icon">🤖</div>
                <h3>{selectedAgent?.name}</h3>
                <p>{selectedAgent?.perspective?.substring(0, 200) || 'Ask me anything about the attached knowledge graphs.'}</p>
                {selectedAgent?.knowledge_graphs?.length > 0 && (
                  <div className="chat-welcome-graphs">
                    {selectedAgent.knowledge_graphs.map(g => (
                      <span key={g.id} className="agent-tag">{g.type === 'data' ? '📊' : '🏷️'} {g.name}</span>
                    ))}
                  </div>
                )}
                {selectedAgent?.folders?.length > 0 && (
                  <div className="chat-welcome-graphs">
                    {selectedAgent.folders.map(f => (
                      <span key={f.id} className="agent-tag">📁 {f.name}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                <div className="chat-message-avatar">{msg.role === 'user' ? '👤' : '🤖'}</div>
                <div className="chat-message-content">
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  ) : (
                    <p>{msg.content}</p>
                  )}
                  {msg.sources?.length > 0 && (
                    <div className="chat-sources">
                      <span className="sources-label">Sources:</span>
                      {msg.sources.map((s, j) => (
                        <span key={j} className="source-chip" title={s.text}>{s.documentName || s.documentId} ({(s.similarity * 100).toFixed(0)}%)</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="chat-message assistant">
                <div className="chat-message-avatar">🤖</div>
                <div className="chat-message-content"><p className="typing">Thinking...</p></div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="agent-chat-input" onSubmit={sendMessage}>
            <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)}
              placeholder={`Ask ${selectedAgent?.name}...`} disabled={chatLoading} autoFocus />
            <button type="submit" disabled={chatLoading || !chatInput.trim()}>Send</button>
          </form>
        </div>
      </div>
    );
  }

  return null;
}

export default AgentsPage;
