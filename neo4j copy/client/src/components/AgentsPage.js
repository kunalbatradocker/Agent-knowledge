import React, { useState, useEffect, useRef } from 'react';
import './AgentsPage.css';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';

const API_BASE_URL = '/api';

function AgentsPage() {
  const { currentTenant, currentWorkspace, getTenantHeaders } = useTenant();
  const { user } = useAuth();
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [view, setView] = useState('list'); // list | edit | chat
  const [loading, setLoading] = useState(false);
  const [availableFolders, setAvailableFolders] = useState([]);
  const [availableOntologies, setAvailableOntologies] = useState([]);
  const [availableDatabases, setAvailableDatabases] = useState([]);

  // Form state
  const [form, setForm] = useState({ name: '', description: '', perspective: '', folders: [], ontologies: [], vkg_databases: [], settings: { topK: 8, graphDepth: 2 } });

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const messagesEndRef = useRef(null);

  // Dropdown open state
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [ontologyDropdownOpen, setOntologyDropdownOpen] = useState(false);
  const [dbDropdownOpen, setDbDropdownOpen] = useState(false);
  const folderDropdownRef = useRef(null);
  const ontologyDropdownRef = useRef(null);
  const dbDropdownRef = useRef(null);

  // Memory state
  const [memories, setMemories] = useState([]);
  const [memoryStats, setMemoryStats] = useState({});
  const [coreMemory, setCoreMemory] = useState('');
  const [sessions, setSessions] = useState([]);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [editingCoreMemory, setEditingCoreMemory] = useState(false);
  const [coreMemoryDraft, setCoreMemoryDraft] = useState('');

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAgents(); loadFolders(); loadOntologies(); loadDatabases(); }, [currentTenant?.tenant_id, currentWorkspace?.workspace_id]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(e.target)) setFolderDropdownOpen(false);
      if (ontologyDropdownRef.current && !ontologyDropdownRef.current.contains(e.target)) setOntologyDropdownOpen(false);
      if (dbDropdownRef.current && !dbDropdownRef.current.contains(e.target)) setDbDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadAgents = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents`, { headers: getTenantHeaders() });
      setAgents(res.data.agents || []);
    } catch (e) { console.error('Failed to load agents:', e); }
  };

  const loadFolders = async () => {
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) params.append('workspace_id', currentWorkspace.workspace_id);
      const res = await axios.get(`${API_BASE_URL}/ontology/folders?${params}`, { headers: getTenantHeaders() });
      setAvailableFolders(res.data.folders || []);
    } catch (e) { console.error('Failed to load folders:', e); }
  };

  const loadOntologies = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/owl/list`, {
        params: { tenantId: currentTenant?.tenant_id || 'default', workspaceId: currentWorkspace?.workspace_id || 'default', scope: 'all' },
        headers: getTenantHeaders()
      });
      setAvailableOntologies((res.data.ontologies || []).map(o => ({
        id: o.ontologyId, name: o.label, graphIRI: o.graphIRI, classCount: o.classCount
      })));
    } catch (e) { console.error('Failed to load ontologies:', e); }
  };

  const loadDatabases = async () => {
    if (!currentWorkspace?.workspace_id) { setAvailableDatabases([]); return; }
    const dbs = [];
    const wsId = currentWorkspace.workspace_id;
    const tId = currentTenant?.tenant_id || 'default';
    const headers = getTenantHeaders();
    // Load Trino catalogs (workspace-scoped)
    try {
      const res = await axios.get(`${API_BASE_URL}/trino/catalogs`, {
        params: { tenantId: tId, workspaceId: wsId }, headers
      });
      const catalogs = res.data.catalogs || [];
      for (const cat of catalogs) {
        try {
          const schemaRes = await axios.get(`${API_BASE_URL}/trino/catalogs/${cat.catalogName}/introspect`, {
            params: { tenantId: tId, workspaceId: wsId }, headers
          });
          // introspect returns { catalog, schema, tables, relationships } for a single schema
          const data = schemaRes.data;
          const schemaName = data.schema || cat.schema || 'public';
          const tables = data.tables || [];
          dbs.push({ id: `${cat.catalogName}.${schemaName}`, catalog: cat.catalogName, schema: schemaName, tables, source: 'trino' });
        } catch (e) {
          // Introspect failed — still show catalog with stored schema
          const schemaName = cat.schema || cat.database || '';
          const dbId = schemaName ? `${cat.catalogName}.${schemaName}` : cat.catalogName;
          dbs.push({ id: dbId, catalog: cat.catalogName, schema: schemaName, tables: [], source: 'trino' });
        }
      }
    } catch (e) { console.error('Failed to load Trino catalogs:', e); }
    // Load JDBC direct connections (workspace-scoped)
    try {
      const res = await axios.get(`${API_BASE_URL}/jdbc/connections`, {
        params: { workspaceId: wsId }, headers
      });
      const connections = res.data.connections || [];
      for (const conn of connections) {
        dbs.push({
          id: `jdbc:${conn.id}`,
          catalog: conn.name || conn.id,
          schema: conn.database || '',
          tables: [],
          source: 'jdbc',
          dbType: conn.type,
          status: conn.status
        });
      }
    } catch (e) { console.error('Failed to load JDBC connections:', e); }
    setAvailableDatabases(dbs);
  };

  const openCreate = () => {
    setForm({ name: '', description: '', perspective: '', folders: [], ontologies: [], vkg_databases: [], settings: { topK: 8, graphDepth: 2 } });
    setSelectedAgent(null);
    setView('edit');
  };

  const openEdit = (agent) => {
    setForm({
      name: agent.name,
      description: agent.description || '',
      perspective: agent.perspective || '',
      folders: agent.folders || [],
      ontologies: agent.ontologies || [],
      vkg_databases: agent.vkg_databases || [],
      settings: agent.settings || { topK: 8, graphDepth: 2 }
    });
    setSelectedAgent(agent);
    setView('edit');
  };

  const openChat = async (agent) => {
    setSelectedAgent(agent);
    setChatMessages([]);
    setChatInput('');
    setView('chat');
    setShowMemoryPanel(false);
    // Generate a local session ID — session is only persisted server-side on first message
    setSessionId(crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // Load memory stats
    loadMemoryData(agent.agent_id);
  };

  const loadMemoryData = async (agentId) => {
    try {
      const [statsRes, memoriesRes, coreRes, sessionsRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/agents/${agentId}/memories/stats`, { headers: getTenantHeaders() }),
        axios.get(`${API_BASE_URL}/agents/${agentId}/memories?limit=30`, { headers: getTenantHeaders() }),
        axios.get(`${API_BASE_URL}/agents/${agentId}/memories/core`, { headers: getTenantHeaders() }),
        axios.get(`${API_BASE_URL}/agents/${agentId}/memories/sessions?limit=10`, { headers: getTenantHeaders() })
      ]);
      setMemoryStats(statsRes.data.stats || {});
      setMemories(memoriesRes.data.memories || []);
      setCoreMemory(coreRes.data.core?.content || '');
      setSessions(sessionsRes.data.sessions || []);
    } catch (e) { console.error('Failed to load memory data:', e); }
  };

  const loadSession = async (agent, sid) => {
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${agent.agent_id}/memories/sessions/${sid}`, { headers: getTenantHeaders() });
      const session = res.data.session;
      if (session?.messages) {
        setChatMessages(session.messages.map(m => ({ role: m.role, content: m.content })));
        setSessionId(sid);
      }
    } catch (e) { console.error('Failed to load session:', e); }
  };

  const startNewSession = () => {
    setChatMessages([]);
    setChatInput('');
    setSessionId(crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  };

  const deleteSession = async (agentId, sid) => {
    try {
      await axios.delete(`${API_BASE_URL}/agents/${agentId}/memories/sessions/${sid}`, { headers: getTenantHeaders() });
      setSessions(prev => prev.filter(s => s.session_id !== sid));
      // If we just deleted the active session, start a new one
      if (sessionId === sid) startNewSession();
    } catch (e) { console.error('Failed to delete session:', e); }
  };

  const clearAllSessions = async (agentId) => {
    if (!window.confirm('Clear all conversation sessions? This cannot be undone.')) return;
    try {
      await axios.delete(`${API_BASE_URL}/agents/${agentId}/memories/sessions`, { headers: getTenantHeaders() });
      setSessions([]);
      startNewSession();
    } catch (e) { console.error('Failed to clear sessions:', e); }
  };

  const deleteMemory = async (agentId, memoryId) => {
    try {
      await axios.delete(`${API_BASE_URL}/agents/${agentId}/memories/${memoryId}`, { headers: getTenantHeaders() });
      setMemories(prev => prev.filter(m => m.memory_id !== memoryId));
      setMemoryStats(prev => ({ ...prev, total_memories: (prev.total_memories || 1) - 1 }));
    } catch (e) { console.error('Failed to delete memory:', e); }
  };

  const clearAllMemories = async (agentId) => {
    if (!window.confirm('Clear all memories for this agent? This cannot be undone.')) return;
    try {
      await axios.post(`${API_BASE_URL}/agents/${agentId}/memories/clear`, {}, { headers: getTenantHeaders() });
      setMemories([]);
      setCoreMemory('');
      setMemoryStats({ total_memories: 0, by_type: {}, total_sessions: 0, has_core_memory: false });
    } catch (e) { console.error('Failed to clear memories:', e); }
  };

  const saveCoreMemory = async (agentId) => {
    try {
      await axios.put(`${API_BASE_URL}/agents/${agentId}/memories/core`, { content: coreMemoryDraft }, { headers: getTenantHeaders() });
      setCoreMemory(coreMemoryDraft);
      setEditingCoreMemory(false);
    } catch (e) { console.error('Failed to save core memory:', e); }
  };

  const saveAgent = async () => {
    if (!form.name.trim()) return;
    setLoading(true);
    try {
      if (selectedAgent) {
        await axios.put(`${API_BASE_URL}/agents/${selectedAgent.agent_id}`, {
          name: form.name, description: form.description, perspective: form.perspective,
          folders: form.folders, ontologies: form.ontologies, vkgDatabases: form.vkg_databases,
          settings: form.settings
        }, { headers: getTenantHeaders() });
      } else {
        await axios.post(`${API_BASE_URL}/agents`, {
          name: form.name, description: form.description, perspective: form.perspective,
          folders: form.folders, ontologies: form.ontologies, vkgDatabases: form.vkg_databases,
          settings: form.settings
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
        history: chatMessages.slice(-6),
        sessionId
      }, { headers: getTenantHeaders() });
      const msg = res.data.message || {};
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: msg.content || 'No response',
        sources: msg.sources,
        metadata: msg.metadata
      }]);
    } catch (e) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.response?.data?.error || e.message}` }]);
    }
    setChatLoading(false);
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

  const toggleOntology = (ontologyId) => {
    setForm(prev => {
      const current = prev.ontologies.map(o => o.id);
      if (current.includes(ontologyId)) {
        return { ...prev, ontologies: prev.ontologies.filter(o => o.id !== ontologyId) };
      }
      const ont = availableOntologies.find(o => o.id === ontologyId);
      return { ...prev, ontologies: [...prev.ontologies, { id: ont.id, name: ont.name, graphIRI: ont.graphIRI }] };
    });
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
                  {agent.ontologies?.length > 0 && (
                    <span className="agent-tag">🏷️ {agent.ontologies.length} ontolog{agent.ontologies.length !== 1 ? 'ies' : 'y'}</span>
                  )}
                  {agent.vkg_databases?.length > 0 && (
                    <span className="agent-tag">🗄️ {agent.vkg_databases.length} database{agent.vkg_databases.length !== 1 ? 's' : ''}</span>
                  )}
                  {agent.settings?.memoryEnabled !== false && (
                    <span className="agent-tag memory-tag">🧠 Memory</span>
                  )}
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
    const selectedFolderIds = new Set(form.folders.map(f => f.id));
    const selectedOntologyIds = new Set(form.ontologies.map(o => o.id));
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

          <div className="form-section-label">📦 Data Sources</div>
          <p className="form-hint" style={{ marginBottom: 16 }}>Select the data sources this agent can access. The query planner will automatically decide which sources to consult based on the question.</p>

          <div className="form-group">
            <label>📁 Document Folders</label>
            <p className="form-hint">Documents in these folders will be available for vector search and graph traversal.</p>
            <div className="multi-select-dropdown" ref={folderDropdownRef}>
              <div className="multi-select-trigger" onClick={() => setFolderDropdownOpen(!folderDropdownOpen)}>
                {form.folders.length === 0 ? (
                  <span className="multi-select-placeholder">Select folders...</span>
                ) : (
                  <div className="multi-select-tags">
                    {form.folders.map(f => (
                      <span key={f.id} className="multi-select-tag">📁 {f.name}
                        <button type="button" className="multi-select-tag-remove" onClick={e => { e.stopPropagation(); toggleFolder(f.id); }}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <span className="multi-select-arrow">{folderDropdownOpen ? '▲' : '▼'}</span>
              </div>
              {folderDropdownOpen && (
                <div className="multi-select-menu">
                  {availableFolders.length === 0 ? (
                    <div className="multi-select-empty">No folders available. Create folders in File Manager first.</div>
                  ) : availableFolders.map(f => {
                    const fId = f.folder_id || f.id;
                    return (
                      <label key={fId} className={`multi-select-option ${selectedFolderIds.has(fId) ? 'selected' : ''}`}>
                        <input type="checkbox" checked={selectedFolderIds.has(fId)} onChange={() => toggleFolder(fId)} />
                        <span>📁 {f.name}</span>
                        {(f.docCount != null || f.document_count != null) && <span className="multi-select-meta">{f.docCount ?? f.document_count} docs</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            {form.folders.length === 0 && <small className="form-warning">⚠️ No folders selected — agent will search all workspace documents.</small>}
          </div>

          <div className="form-group">
            <label>🏷️ Ontologies</label>
            <p className="form-hint">Ontologies guide schema-aware queries against Neo4j and VKG databases.</p>
            <div className="multi-select-dropdown" ref={ontologyDropdownRef}>
              <div className="multi-select-trigger" onClick={() => setOntologyDropdownOpen(!ontologyDropdownOpen)}>
                {form.ontologies.length === 0 ? (
                  <span className="multi-select-placeholder">Select ontologies...</span>
                ) : (
                  <div className="multi-select-tags">
                    {form.ontologies.map(o => (
                      <span key={o.id} className="multi-select-tag">🏷️ {o.name}
                        <button type="button" className="multi-select-tag-remove" onClick={e => { e.stopPropagation(); toggleOntology(o.id); }}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <span className="multi-select-arrow">{ontologyDropdownOpen ? '▲' : '▼'}</span>
              </div>
              {ontologyDropdownOpen && (
                <div className="multi-select-menu">
                  {availableOntologies.length === 0 ? (
                    <div className="multi-select-empty">No ontologies available. Upload ontologies in the Ontology Manager first.</div>
                  ) : availableOntologies.map(o => (
                    <label key={o.id} className={`multi-select-option ${selectedOntologyIds.has(o.id) ? 'selected' : ''}`}>
                      <input type="checkbox" checked={selectedOntologyIds.has(o.id)} onChange={() => toggleOntology(o.id)} />
                      <span>🏷️ {o.name}</span>
                      {o.classCount != null && <span className="multi-select-meta">{o.classCount} classes</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="form-group">
            <label>🗄️ Federated Databases</label>
            <p className="form-hint">External databases (Trino catalogs, PostgreSQL, MySQL, etc.) accessible for structured data queries via VKG.</p>
            <div className="multi-select-dropdown" ref={dbDropdownRef}>
              <div className="multi-select-trigger" onClick={() => setDbDropdownOpen(!dbDropdownOpen)}>
                {form.vkg_databases.length === 0 ? (
                  <span className="multi-select-placeholder">Select databases...</span>
                ) : (
                  <div className="multi-select-tags">
                    {form.vkg_databases.map(dbId => {
                      const db = availableDatabases.find(d => d.id === dbId);
                      const icon = db?.source === 'jdbc' ? '🔗' : '🗄️';
                      return (
                        <span key={dbId} className="multi-select-tag">{icon} {dbId}
                          <button type="button" className="multi-select-tag-remove" onClick={e => { e.stopPropagation(); toggleDatabase(dbId); }}>×</button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <span className="multi-select-arrow">{dbDropdownOpen ? '▲' : '▼'}</span>
              </div>
              {dbDropdownOpen && (
                <div className="multi-select-menu">
                  {availableDatabases.length === 0 ? (
                    <div className="multi-select-empty">No databases available. Add Trino catalogs or JDBC connections first.</div>
                  ) : availableDatabases.map(db => {
                    const icon = db.source === 'jdbc' ? '🔗' : '🗄️';
                    const typeLabel = db.source === 'jdbc' ? (db.dbType || 'jdbc').toUpperCase() : 'Trino';
                    return (
                      <label key={db.id} className={`multi-select-option ${selectedDbIds.has(db.id) ? 'selected' : ''}`}>
                        <input type="checkbox" checked={selectedDbIds.has(db.id)} onChange={() => toggleDatabase(db.id)} />
                        <span>{icon} {db.catalog}{db.schema ? `.${db.schema}` : ''}</span>
                        <span className="multi-select-meta">{typeLabel}{db.tables?.length > 0 ? ` · ${db.tables.length} tables` : ''}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="form-section-label">⚙️ Settings</div>

          <div className="form-group">
            <label className="memory-toggle-label">
              <input type="checkbox" checked={form.settings.memoryEnabled !== false}
                onChange={e => setForm(p => ({ ...p, settings: { ...p.settings, memoryEnabled: e.target.checked } }))} />
              <span>🧠 Long-Term Memory</span>
            </label>
            <small>When enabled, the agent remembers facts, preferences, and decisions across conversations.</small>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Top K Results</label>
              <input type="number" min={1} max={20} value={form.settings.topK} onChange={e => setForm(p => ({ ...p, settings: { ...p.settings, topK: parseInt(e.target.value) || 8 } }))} />
              <small>Number of document chunks to retrieve per query.</small>
            </div>
            <div className="form-group">
              <label>Graph Depth</label>
              <input type="number" min={1} max={5} value={form.settings.graphDepth || 2} onChange={e => setForm(p => ({ ...p, settings: { ...p.settings, graphDepth: parseInt(e.target.value) || 2 } }))} />
              <small>Max hops for knowledge graph traversal.</small>
            </div>
          </div>

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
    const memoryEnabled = selectedAgent?.settings?.memoryEnabled !== false;
    return (
      <div className="agents-page agent-chat-view">
        <div className="agents-header">
          <button className="btn-back" onClick={() => setView('list')}>← Back</button>
          <div className="chat-agent-info">
            <h2>💬 {selectedAgent?.name}</h2>
            {selectedAgent?.description && <p className="agents-subtitle">{selectedAgent.description}</p>}
          </div>
          <div className="chat-header-actions">
            <button className="btn-icon" onClick={startNewSession} title="New session">➕</button>
            {memoryEnabled && (
              <button className={`btn-icon ${showMemoryPanel ? 'active' : ''}`}
                onClick={() => { setShowMemoryPanel(!showMemoryPanel); if (!showMemoryPanel) loadMemoryData(selectedAgent.agent_id); }}
                title="Memory">🧠</button>
            )}
            <button className="btn-icon" onClick={() => openEdit(selectedAgent)} title="Edit agent">✏️</button>
          </div>
        </div>

        <div className={`agent-chat-layout ${showMemoryPanel ? 'with-panel' : ''}`}>
          <div className="agent-chat-container">
            <div className="agent-chat-messages">
              {chatMessages.length === 0 && (
                <div className="chat-welcome">
                  <div className="chat-welcome-icon">🤖</div>
                  <h3>{selectedAgent?.name}</h3>
                  <p>{selectedAgent?.perspective?.substring(0, 200) || 'Ask me anything — I\'ll search documents, knowledge graphs, and memory to find the answer.'}</p>
                  {(selectedAgent?.folders?.length > 0 || selectedAgent?.ontologies?.length > 0 || selectedAgent?.vkg_databases?.length > 0) && (
                    <div className="chat-welcome-graphs">
                      {selectedAgent.folders?.map(f => (
                        <span key={f.id} className="agent-tag">📁 {f.name}</span>
                      ))}
                      {selectedAgent.ontologies?.map(o => (
                        <span key={o.id} className="agent-tag">🏷️ {o.name}</span>
                      ))}
                      {selectedAgent.vkg_databases?.map(db => (
                        <span key={db} className="agent-tag">🗄️ {db}</span>
                      ))}
                    </div>
                  )}
                  {memoryEnabled && memoryStats.total_memories > 0 && (
                    <div className="chat-welcome-memory">
                      <span className="agent-tag memory-tag">🧠 {memoryStats.total_memories} memories</span>
                    </div>
                  )}
                  {sessions.length > 0 && (
                    <div className="chat-sessions-hint">
                      <p>Previous sessions available — click 🧠 to browse</p>
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
                    {/* Document chunk sources */}
                    {msg.sources?.chunks?.length > 0 && (
                      <div className="chat-sources">
                        <span className="sources-label">📄 Documents:</span>
                        {msg.sources.chunks.map((s, j) => (
                          <span key={j} className="source-chip" title={s.text}>{s.documentName || 'Document'} ({(parseFloat(s.similarity) * 100).toFixed(0)}%)</span>
                        ))}
                      </div>
                    )}
                    {/* Graph entity sources */}
                    {msg.sources?.graphEntities?.length > 0 && (
                      <div className="chat-sources">
                        <span className="sources-label">🔗 Entities:</span>
                        {msg.sources.graphEntities.slice(0, 6).map((e, j) => (
                          <span key={j} className={`source-chip entity-chip${e.boosted ? ' boosted' : ''}`} title={e.description}>
                            {e.label} ({e.type}){e.boosted ? ' ⭐' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* VKG sources */}
                    {msg.sources?.vkg?.sql && (
                      <div className="chat-sources">
                        <span className="sources-label">🌐 Database:</span>
                        <span className="source-chip vkg-chip">{msg.sources.vkg.databases?.join(', ') || 'Trino'} ({msg.sources.vkg.rowCount} rows)</span>
                      </div>
                    )}
                    {/* Legacy flat array sources (backward compat) */}
                    {Array.isArray(msg.sources) && msg.sources.length > 0 && (
                      <div className="chat-sources">
                        <span className="sources-label">Sources:</span>
                        {msg.sources.map((s, j) => (
                          <span key={j} className="source-chip" title={s.text}>{s.documentName || s.documentId} ({(s.similarity * 100).toFixed(0)}%)</span>
                        ))}
                      </div>
                    )}
                    {/* Pipeline metadata */}
                    {msg.metadata?.searchMode === 'unified' && msg.metadata?.sourcesUsed?.length > 0 && (
                      <div className="chat-pipeline-info">
                        <span className="pipeline-label">Pipeline:</span>
                        {msg.metadata.sourcesUsed.map((s, j) => (
                          <span key={j} className={`pipeline-tag pipeline-${s}`}>
                            {s === 'vector' ? '📊' : s === 'graph' ? '🔗' : s === 'vkg' ? '🌐' : s === 'memory' ? '🧠' : '📋'} {s}
                          </span>
                        ))}
                        {msg.metadata.rewrittenQuery && (
                          <span className="pipeline-rewrite" title={msg.metadata.rewrittenQuery}>✏️ query rewritten</span>
                        )}
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

          {showMemoryPanel && memoryEnabled && (
            <MemoryPanel
              agentId={selectedAgent.agent_id}
              memories={memories}
              coreMemory={coreMemory}
              sessions={sessions}
              stats={memoryStats}
              editingCoreMemory={editingCoreMemory}
              coreMemoryDraft={coreMemoryDraft}
              currentSessionId={sessionId}
              onDeleteMemory={(mid) => deleteMemory(selectedAgent.agent_id, mid)}
              onClearAll={() => clearAllMemories(selectedAgent.agent_id)}
              onEditCoreMemory={() => { setCoreMemoryDraft(coreMemory); setEditingCoreMemory(true); }}
              onSaveCoreMemory={() => saveCoreMemory(selectedAgent.agent_id)}
              onCancelCoreMemory={() => setEditingCoreMemory(false)}
              onCoreMemoryDraftChange={setCoreMemoryDraft}
              onLoadSession={(sid) => loadSession(selectedAgent, sid)}
              onDeleteSession={(sid) => deleteSession(selectedAgent.agent_id, sid)}
              onClearSessions={() => clearAllSessions(selectedAgent.agent_id)}
              onNewSession={startNewSession}
              onRefresh={() => loadMemoryData(selectedAgent.agent_id)}
              getTenantHeaders={getTenantHeaders}
              userName={user?.email || user?.name}
            />
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ── Memory Side Panel Component ──
function MemoryPanel({ agentId, memories, coreMemory, sessions, stats, editingCoreMemory, coreMemoryDraft,
  onDeleteMemory, onClearAll, onEditCoreMemory, onSaveCoreMemory, onCancelCoreMemory, onCoreMemoryDraftChange,
  onLoadSession, onDeleteSession, onClearSessions, onNewSession, onRefresh, getTenantHeaders, userName, currentSessionId }) {

  const [tab, setTab] = useState('memories'); // memories | core | sessions | graph
  const [graphData, setGraphData] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphExpanded, setGraphExpanded] = useState(false);

  const typeColors = {
    semantic: '#2563EB', preference: '#7C3AED', decision: '#059669', event: '#D97706'
  };

  const loadGraph = async (refresh = false) => {
    setGraphLoading(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/agents/${agentId}/memories/graph${refresh ? '?refresh=true' : ''}`,
        { headers: getTenantHeaders?.() || {} });
      setGraphData(res.data.graph || { nodes: [], edges: [] });
    } catch (e) { console.error('Failed to load memory graph:', e); }
    setGraphLoading(false);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'graph' && !graphData && !graphLoading) loadGraph();
  }, [tab]);

  return (
    <div className="memory-panel">
      <div className="memory-panel-header">
        <h3>🧠 Memory</h3>
        <div className="memory-panel-actions">
          <button className="btn-icon" onClick={onRefresh} title="Refresh">🔄</button>
        </div>
      </div>

      <div className="memory-stats-bar">
        <span title="Agent-scoped memories (semantic, events)">🤖 {stats.agent_memories || 0}</span>
        <span title="User-scoped memories (preferences, decisions)">👤 {stats.user_memories || 0}</span>
        <span>{stats.total_sessions || 0} sessions</span>
        {stats.has_core_memory && <span>📌 Core</span>}
        {userName && <span title={`Memories for ${userName}`}>{userName.split('@')[0]}</span>}
      </div>

      <div className="memory-tabs">
        <button className={`memory-tab ${tab === 'memories' ? 'active' : ''}`} onClick={() => setTab('memories')}>Memories</button>
        <button className={`memory-tab ${tab === 'core' ? 'active' : ''}`} onClick={() => setTab('core')}>Core</button>
        <button className={`memory-tab ${tab === 'graph' ? 'active' : ''}`} onClick={() => setTab('graph')}>Graph</button>
        <button className={`memory-tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>Sessions</button>
      </div>

      <div className="memory-panel-content">
        {tab === 'memories' && (
          <div className="memory-list">
            {memories.length === 0 ? (
              <div className="memory-empty">
                <p>No memories yet. Start chatting and the agent will learn.</p>
              </div>
            ) : (
              <>
                {memories.map(m => (
                  <div key={m.memory_id} className="memory-item">
                    <div className="memory-item-header">
                      <span className="memory-type-badge" style={{ background: typeColors[m.type] || '#6B7280' }}>{m.type}</span>
                      <span className="memory-pool-badge" title={m.pool === 'user' ? 'User memory — survives agent deletion' : 'Agent memory — deleted with agent'}>
                        {m.pool === 'user' ? '👤' : '🤖'}
                      </span>
                      <span className="memory-importance" title={`Importance: ${((m.importance || 0) * 100).toFixed(0)}%`}>
                        {'●'.repeat(Math.ceil((m.importance || 0.5) * 5))}{'○'.repeat(5 - Math.ceil((m.importance || 0.5) * 5))}
                      </span>
                      <button className="btn-icon danger memory-delete" onClick={() => onDeleteMemory(m.memory_id)} title="Delete">×</button>
                    </div>
                    <p className="memory-content">{m.content}</p>
                    <span className="memory-date">{new Date(m.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
                <button className="btn-clear-memories" onClick={onClearAll}>Clear All Memories</button>
              </>
            )}
          </div>
        )}

        {tab === 'core' && (
          <div className="core-memory-section">
            <p className="core-memory-hint">Core memory is always included in the agent's context. High-importance facts are promoted here automatically.</p>
            {editingCoreMemory ? (
              <div className="core-memory-editor">
                <textarea value={coreMemoryDraft} onChange={e => onCoreMemoryDraftChange(e.target.value)}
                  rows={10} placeholder="Enter core memory content..." maxLength={2000} />
                <div className="core-memory-editor-actions">
                  <span className="char-count">{coreMemoryDraft.length}/2000</span>
                  <button className="btn-secondary" onClick={onCancelCoreMemory}>Cancel</button>
                  <button className="btn-primary" onClick={onSaveCoreMemory}>Save</button>
                </div>
              </div>
            ) : (
              <div className="core-memory-display">
                {coreMemory ? (
                  <pre className="core-memory-text">{coreMemory}</pre>
                ) : (
                  <p className="core-memory-empty">No core memory yet. It will be populated automatically as the agent learns high-importance facts.</p>
                )}
                <button className="btn-secondary" onClick={onEditCoreMemory}>✏️ Edit Core Memory</button>
              </div>
            )}
          </div>
        )}

        {tab === 'graph' && (
          <div className="memory-graph-section">
            <div className="memory-graph-toolbar">
              <span className="memory-graph-info">
                {graphData ? `${graphData.nodes?.length || 0} entities, ${graphData.edges?.length || 0} relationships` : 'Loading...'}
              </span>
              <div style={{ display: 'flex', gap: '2px' }}>
                <button className="btn-icon" onClick={() => setGraphExpanded(true)} title="Expand graph">⛶</button>
                <button className="btn-icon" onClick={() => loadGraph(true)} title="Rebuild graph" disabled={graphLoading}>
                  {graphLoading ? '⏳' : '🔄'}
                </button>
              </div>
            </div>
            {graphLoading ? (
              <div className="memory-empty"><p>Building memory graph...</p></div>
            ) : graphData && graphData.nodes?.length > 0 ? (
              <MemoryGraphView nodes={graphData.nodes} edges={graphData.edges} />
            ) : (
              <div className="memory-empty"><p>No graph data yet. Chat with the agent to build memories, then refresh.</p></div>
            )}
          </div>
        )}

        {/* Expanded graph overlay */}
        {graphExpanded && graphData && graphData.nodes?.length > 0 && (
          <div className="memory-graph-overlay" onClick={(e) => { if (e.target === e.currentTarget) setGraphExpanded(false); }}>
            <div className="memory-graph-expanded">
              <div className="memory-graph-expanded-header">
                <h3>🧠 Memory Graph</h3>
                <span className="memory-graph-info">
                  {graphData.nodes.length} entities, {graphData.edges.length} relationships
                </span>
                <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                  <button className="btn-icon" onClick={() => loadGraph(true)} title="Rebuild graph" disabled={graphLoading}>
                    {graphLoading ? '⏳' : '🔄'}
                  </button>
                  <button className="btn-icon" onClick={() => setGraphExpanded(false)} title="Close">✕</button>
                </div>
              </div>
              <MemoryGraphView nodes={graphData.nodes} edges={graphData.edges} expanded />
            </div>
          </div>
        )}

        {tab === 'sessions' && (
          <div className="sessions-list">
            <div className="sessions-actions">
              <button className="btn-sm btn-primary" onClick={onNewSession}>➕ New Session</button>
              {sessions.length > 0 && (
                <button className="btn-sm btn-danger" onClick={onClearSessions}>🗑️ Clear All</button>
              )}
            </div>
            {sessions.length === 0 ? (
              <p className="memory-empty">No past sessions.</p>
            ) : (
              sessions.map(s => (
                <div key={s.session_id} className={`session-item${currentSessionId === s.session_id ? ' session-active' : ''}`}>
                  <div className="session-item-body" onClick={() => onLoadSession(s.session_id)}>
                    <div className="session-item-header">
                      <span className="session-date">{new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="session-count">{s.message_count} msgs</span>
                    </div>
                    <div className="session-item-meta">
                      {s.updated_at && s.updated_at !== s.created_at && (
                        <span className="session-updated">updated {new Date(s.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      <span className="session-stored-badge">💾 stored</span>
                      {currentSessionId === s.session_id && <span className="session-active-badge">● active</span>}
                    </div>
                    {s.preview && <p className="session-preview">{s.preview}</p>}
                  </div>
                  <button className="session-delete-btn" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.session_id); }} title="Delete session">✕</button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memory Graph Visualization (SVG force-directed) ──
function MemoryGraphView({ nodes, edges, expanded = false }) {
  const svgRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const W = expanded ? 1000 : 600;
  const H = expanded ? 700 : 500;
  const svgH = expanded ? '100%' : '400';

  const nodeTypeColors = {
    person: '#e06090', concept: '#3b82f6', data: '#d97706', preference: '#7c3aed',
    system: '#6b7280', event: '#059669', location: '#0891b2', organization: '#16a34a',
    agent: '#7C3AED'
  };

  // Simple force-directed layout (computed once)
  const positions = React.useMemo(() => {
    if (!nodes.length) return {};
    const pos = {};
    const CX = W / 2, CY = H / 2;

    // Place nodes in a circle initially
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length;
      const r = Math.min(W, H) * 0.35;
      pos[n.id] = { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
    });

    // Simple force simulation (50 iterations)
    const edgeMap = {};
    edges.forEach(e => {
      if (!edgeMap[e.source]) edgeMap[e.source] = [];
      if (!edgeMap[e.target]) edgeMap[e.target] = [];
      edgeMap[e.source].push(e.target);
      edgeMap[e.target].push(e.source);
    });

    for (let iter = 0; iter < 60; iter++) {
      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = pos[nodes[i].id], b = pos[nodes[j].id];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 800 / (dist * dist);
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.x -= fx; a.y -= fy;
          b.x += fx; b.y += fy;
        }
      }
      // Attraction along edges
      edges.forEach(e => {
        const a = pos[e.source], b = pos[e.target];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 100) * 0.02;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.x += fx; a.y += fy;
        b.x -= fx; b.y -= fy;
      });
      // Center gravity
      nodes.forEach(n => {
        pos[n.id].x += (CX - pos[n.id].x) * 0.01;
        pos[n.id].y += (CY - pos[n.id].y) * 0.01;
      });
    }

    // Normalize to fit viewport
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      minX = Math.min(minX, pos[n.id].x); maxX = Math.max(maxX, pos[n.id].x);
      minY = Math.min(minY, pos[n.id].y); maxY = Math.max(maxY, pos[n.id].y);
    });
    const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
    const padding = 60;
    nodes.forEach(n => {
      pos[n.id].x = padding + ((pos[n.id].x - minX) / rangeX) * (W - 2 * padding);
      pos[n.id].y = padding + ((pos[n.id].y - minY) / rangeY) * (H - 2 * padding);
    });

    return pos;
  }, [nodes, edges, W, H]);

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(prev => ({ ...prev, scale: Math.max(0.3, Math.min(3, prev.scale * delta)) }));
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.graph-node')) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  };

  const handleMouseMove = (e) => {
    if (!isPanning) return;
    setTransform(prev => ({
      ...prev,
      x: panStart.current.tx + (e.clientX - panStart.current.x),
      y: panStart.current.ty + (e.clientY - panStart.current.y)
    }));
  };

  const handleMouseUp = () => setIsPanning(false);

  const R = 24; // node radius

  return (
    <div className="memory-graph-container"
      onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <svg ref={svgRef} width="100%" height={svgH} viewBox={`0 0 ${W} ${H}`}
        onWheel={handleWheel} style={{ cursor: isPanning ? 'grabbing' : 'grab' }}>
        <defs>
          <marker id="mem-arrow" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#9CA3AF" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          {/* Edges */}
          {edges.map((e, i) => {
            const s = positions[e.source], t = positions[e.target];
            if (!s || !t) return null;
            const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
            return (
              <g key={`edge-${i}`}>
                <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                  stroke={hoveredNode && (hoveredNode === e.source || hoveredNode === e.target) ? '#7C3AED' : '#D1D5DB'}
                  strokeWidth={hoveredNode && (hoveredNode === e.source || hoveredNode === e.target) ? 2 : 1}
                  markerEnd="url(#mem-arrow)" />
                {e.label && (
                  <text x={mx} y={my - 4} textAnchor="middle" fontSize="7" fill="#9CA3AF" fontFamily="inherit">{e.label}</text>
                )}
              </g>
            );
          })}
          {/* Nodes */}
          {nodes.map(n => {
            const p = positions[n.id];
            if (!p) return null;
            const color = nodeTypeColors[n.type] || '#6b7280';
            const isHovered = hoveredNode === n.id;
            return (
              <g key={n.id} className="graph-node"
                onMouseEnter={() => setHoveredNode(n.id)} onMouseLeave={() => setHoveredNode(null)}>
                <circle cx={p.x} cy={p.y} r={isHovered ? R + 3 : R}
                  fill={color} opacity={hoveredNode && !isHovered ? 0.4 : 0.9}
                  stroke={isHovered ? '#fff' : 'none'} strokeWidth={2} style={{ cursor: 'pointer', transition: 'all 0.15s' }} />
                <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle"
                  fontSize="7" fill="#fff" fontWeight="600" fontFamily="inherit"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {n.label.length > 10 ? n.label.substring(0, 9) + '…' : n.label}
                </text>
                <text x={p.x} y={p.y + R + 12} textAnchor="middle"
                  fontSize="6.5" fill="#6B7280" fontFamily="inherit"
                  style={{ pointerEvents: 'none' }}>
                  {n.type}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {hoveredNode && (
        <div className="memory-graph-tooltip">
          {nodes.find(n => n.id === hoveredNode)?.label}
        </div>
      )}
    </div>
  );
}

export default AgentsPage;
