import { useState, useCallback } from 'react';
import './App.css';
import ConnectionStatus from './components/ConnectionStatus';
import Chat from './components/Chat';
import FileManager from './components/FileManager';
import OntologiesPage from './components/OntologiesPage';
import OntologyJobs from './components/OntologyJobs';
import AdminPanel from './components/AdminPanel';
import LandingPage from './components/LandingPage';
import LoginPage from './components/LoginPage';
import LLMTokenManager from './components/LLMTokenManager';
import EntitiesPage from './components/EntitiesPage';
import VKGQuery from './components/VKGQuery';
import AgentsPage from './components/AgentsPage';
import { TenantProvider, useTenant } from './contexts/TenantContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';

const ALL_MENU_ITEMS = [
  { id: 'chat', icon: '💬', label: 'Knowledge Assistant', minRole: 'viewer' },
  { id: 'files', icon: '📁', label: 'Data Management', minRole: 'viewer' },
  { id: 'ontologies', icon: '📚', label: 'Ontologies', minRole: 'viewer' },
  { id: 'jobs', icon: '⚙️', label: 'Jobs', minRole: 'viewer' },
  { id: 'admin', icon: '🔧', label: 'Administration', minRole: 'manager' },
  { id: 'vkg', icon: '🔗', label: 'Federated Query', minRole: 'viewer' },
  { id: 'agents', icon: '🤖', label: 'Agents', minRole: 'viewer' },
];

const ROLE_HIERARCHY = ['viewer', 'member', 'manager', 'admin'];

function isAtLeastRole(userRole, minRole) {
  return ROLE_HIERARCHY.indexOf(userRole || 'viewer') >= ROLE_HIERARCHY.indexOf(minRole);
}

function AppContent() {
  const [activeSection, setActiveSection] = useState('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [showTokenManager, setShowTokenManager] = useState(false);
  const [dataSubTab, setDataSubTab] = useState('files');
  const { user, logout } = useAuth();
  const userRole = user?.role || 'viewer';

  const { switchWorkspace } = useTenant();

  const handleSelectWorkspace = useCallback((workspace) => {
    switchWorkspace(workspace.workspace_id);
    setSelectedWorkspace(workspace);
  }, [switchWorkspace]);

  const handleBackToLanding = useCallback(() => {
    setSelectedWorkspace(null);
    setActiveSection('chat');
  }, []);

  const menuItems = ALL_MENU_ITEMS.filter(i => isAtLeastRole(userRole, i.minRole));

  // Show landing page if no workspace selected
  if (!selectedWorkspace) {
    return <LandingPage onSelectWorkspace={handleSelectWorkspace} />;
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <img
              src="/logo_pf.svg"
              alt="Purple Fabric"
              className="logo-icon pf-logo-icon"
              onClick={handleBackToLanding}
              title="Back to workspaces"
              role="button"
              tabIndex={0}
            />
            {!sidebarCollapsed && (
              <span className="logo-text pf-logo-text" onClick={handleBackToLanding} title="Back to workspaces" role="button" tabIndex={0}>
                Purple Fabric
              </span>
            )}
          </div>
          <button
            className="collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? '→' : '←'}
          </button>
        </div>

        {/* Current Workspace Indicator */}
        <div className="ws-indicator" style={{ padding: sidebarCollapsed ? '8px 4px' : '8px 12px', borderBottom: '1px solid var(--border-color)' }}>
          <button
            className="ws-indicator-btn"
            onClick={handleBackToLanding}
            title="Switch workspace"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 12px', border: '1px solid var(--pf-purple-border, #A78BFA)',
              borderRadius: 6, background: 'var(--pf-purple-lighter, #EDE9FE)',
              cursor: 'pointer', fontSize: 13, color: 'var(--pf-purple, #6B21A8)',
              fontWeight: 500, justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            }}
          >
            <span>📂</span>
            {!sidebarCollapsed && <span>{selectedWorkspace.name}</span>}
          </button>
        </div>

        {/* Role indicator */}
        <div className="mode-toggle-container" style={{ padding: sidebarCollapsed ? '8px 4px' : '8px 12px' }}>
          <div className="mode-toggle-btn" title={`Role: ${userRole}`} style={{ cursor: 'default' }}>
            <span className="mode-icon">{userRole === 'admin' ? '🛡️' : userRole === 'manager' ? '👔' : userRole === 'member' ? '👤' : '👁️'}</span>
            {!sidebarCollapsed && (
              <span className="mode-label" style={{ textTransform: 'capitalize' }}>{userRole}</span>
            )}
          </div>
        </div>

        <nav className="sidebar-nav">
          {menuItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${activeSection === item.id ? 'active' : ''}`}
              onClick={() => setActiveSection(item.id)}
              title={item.label}
            >
              <span className="nav-icon">{item.icon}</span>
              {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <ConnectionStatus compact={sidebarCollapsed} />
          <button
            onClick={() => setShowTokenManager(true)}
            title="Manage LLM Token"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 12px', border: 'none', borderRadius: 6,
              background: 'transparent', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-secondary, #666)', justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            }}
          >
            <span>🔑</span>
            {!sidebarCollapsed && <span>LLM Token</span>}
          </button>
          <button
            onClick={logout}
            title={`Signed in as ${user?.name || user?.email}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 12px', border: 'none', borderRadius: 6,
              background: 'transparent', cursor: 'pointer', fontSize: 13,
              color: 'var(--text-secondary, #666)', justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            }}
          >
            <span>🚪</span>
            {!sidebarCollapsed && <span>Logout ({user?.name || user?.email})</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {activeSection === 'chat' && (
          <div className="section chat-section">
            <div className="section-header">
              <h1 className="welcome-title">
                Welcome to <span className="highlight">{selectedWorkspace.name}</span>
              </h1>
              <p className="welcome-subtitle">AI-powered document processing with semantic web technologies</p>
            </div>

            <Chat appMode={isAtLeastRole(userRole, 'manager') ? 'admin' : 'user'} />
          </div>
        )}

        {activeSection === 'files' && (
          <div className="section files-section">
            <div className="data-subtabs">
              <button
                className={`data-subtab ${dataSubTab === 'files' ? 'active' : ''}`}
                onClick={() => setDataSubTab('files')}
              >
                📁 Documents
              </button>
              <button
                className={`data-subtab ${dataSubTab === 'entities' ? 'active' : ''}`}
                onClick={() => setDataSubTab('entities')}
              >
                📋 Entities
              </button>
            </div>
            {dataSubTab === 'files' && <FileManager />}
            {dataSubTab === 'entities' && <EntitiesPage />}
          </div>
        )}

        {activeSection === 'ontologies' && (
          <div className="section ontologies-section">
            <OntologiesPage />
          </div>
        )}

        {activeSection === 'jobs' && (
          <div className="section jobs-section">
            <OntologyJobs />
          </div>
        )}

        {activeSection === 'admin' && (
          <div className="section admin-section">
            <AdminPanel />
          </div>
        )}

        {activeSection === 'vkg' && (
          <div className="section vkg-section">
            <VKGQuery />
          </div>
        )}

        {activeSection === 'agents' && (
          <div className="section agents-section">
            <AgentsPage />
          </div>
        )}
      </main>

      {showTokenManager && <LLMTokenManager onClose={() => setShowTokenManager(false)} />}
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>Loading...</div>;
  if (!user) return <LoginPage />;
  return (
    <TenantProvider>
      <AppContent />
    </TenantProvider>
  );
}

export default App;
