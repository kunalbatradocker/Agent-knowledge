import { useState } from 'react';
import { useTenant } from '../../contexts/TenantContext';

const API_BASE_URL = '/api';

/**
 * OntologyGenerator Component
 * Modal for generating ontologies from prompts or documents
 */
const OntologyGenerator = ({ onClose, onGenerated }) => {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  
  const [mode, setMode] = useState('prompt'); // 'prompt' or 'document'
  const [prompt, setPrompt] = useState('');
  const [documentText, setDocumentText] = useState('');
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [generatedOntology, setGeneratedOntology] = useState(null);
  
  const tenantId = currentWorkspace?.tenant_id || 'default';
  const workspaceId = currentWorkspace?.workspace_id || 'default';

  // Handle file upload
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      setDocumentText(text);
      
      // Auto-suggest name from filename
      if (!name) {
        const baseName = file.name.replace(/\.[^/.]+$/, '');
        setName(baseName + ' Ontology');
      }
    } catch (err) {
      setError('Failed to read file');
    }
  };

  // Generate ontology
  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/ontology/generate`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        },
        body: JSON.stringify({
          mode,
          prompt: mode === 'prompt' ? prompt : undefined,
          documentText: mode === 'document' ? documentText : undefined,
          name: name || undefined,
          industry: industry || undefined
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Generation failed');
      }

      const data = await response.json();
      console.log('[OntologyGenerator] Received:', data);
      console.log('[OntologyGenerator] entityTypes:', data.ontology?.entityTypes?.length);
      setGeneratedOntology(data.ontology);

    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // Use generated ontology - save to workspace first
  const handleUseOntology = async () => {
    if (!generatedOntology) return;
    
    // Validate workspace context
    if (!workspaceId || workspaceId === 'default' || workspaceId === 'undefined') {
      setError('No workspace selected. Please select a workspace before saving.');
      return;
    }
    
    // Validate ontology has content
    if (!generatedOntology.entityTypes?.length) {
      setError('Generated ontology has no entity types. Try regenerating.');
      return;
    }
    
    setSaving(true);
    setError(null);
    
    try {
      // Helper to sanitize names for use in IRIs
      const toIRISafe = (str) => (str || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const toIRISafeUnderscore = (str) => (str || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      
      // Save to GraphDB as workspace ontology
      const ontologyId = (generatedOntology.name || 'generated-ontology')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      
      // Check for duplicate ontology name
      try {
        const listRes = await fetch(`${API_BASE_URL}/owl/list?tenantId=${tenantId}&workspaceId=${workspaceId}&scope=workspace`, {
          headers: getTenantHeaders()
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const existing = (listData.ontologies || []).find(o => o.ontologyId === ontologyId);
          if (existing) {
            const overwrite = window.confirm(
              `An ontology named "${ontologyId}" already exists in this workspace. Overwrite it?`
            );
            if (!overwrite) {
              setSaving(false);
              return;
            }
          }
        }
      } catch (e) {
        // Non-critical — proceed with save
        console.warn('Could not check for duplicates:', e.message);
      }
      
      // Build classes and filter out empty relationship domain/range
      const classes = (generatedOntology.entityTypes || []).map(et => ({
        iri: `http://purplefabric.ai/${ontologyId}#${toIRISafe(et.label || et.name)}`,
        label: et.label || et.name,
        comment: et.description || ''
      }));
      
      // Build a set of valid class names for domain/range validation
      const validClassNames = new Set(
        (generatedOntology.entityTypes || []).map(et => toIRISafe(et.label || et.name))
      );
      
      const objectProperties = (generatedOntology.relationships || []).map(rel => {
        const fromSafe = toIRISafe(rel.from);
        const toSafe = toIRISafe(rel.to);
        return {
          iri: `http://purplefabric.ai/${ontologyId}#${toIRISafeUnderscore(rel.type || rel.predicate)}`,
          label: rel.type || rel.predicate,
          comment: rel.description || '',
          domain: fromSafe && validClassNames.has(fromSafe) 
            ? [`http://purplefabric.ai/${ontologyId}#${fromSafe}`] : [],
          range: toSafe && validClassNames.has(toSafe) 
            ? [`http://purplefabric.ai/${ontologyId}#${toSafe}`] : []
        };
      });
      
      const dataProperties = (generatedOntology.entityTypes || []).flatMap(et => 
        (et.properties || []).map(prop => ({
          iri: `http://purplefabric.ai/${ontologyId}#${toIRISafeUnderscore(prop.name || prop.label)}`,
          label: prop.name || prop.label,
          comment: prop.description || '',
          domain: [`http://purplefabric.ai/${ontologyId}#${toIRISafe(et.label || et.name)}`],
          data_type: prop.data_type || 'string'
        }))
      );
      
      const response = await fetch(`${API_BASE_URL}/owl/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId,
          workspaceId,
          ontology: {
            iri: `http://purplefabric.ai/graphs/tenant/${tenantId}/workspace/${workspaceId}/ontology/${ontologyId}`,
            label: generatedOntology.name,
            comment: generatedOntology.description || '',
            versionInfo: '1.0.0',
            classes,
            objectProperties,
            dataProperties
          }
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || data.error || 'Failed to save ontology');
      }

      // Version is auto-created by the /api/owl/create endpoint

      onGenerated(generatedOntology);
      
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Edit in editor without saving yet
  const handleEditOntology = () => {
    if (generatedOntology) {
      // Pass with a flag indicating it needs editing, not just refresh
      onGenerated({ ...generatedOntology, needsEditing: true });
    }
  };

  return (
    <div className="ontology-generator-overlay" onClick={onClose}>
      <div className="ontology-generator-modal" onClick={e => e.stopPropagation()}>
        <div className="og-header">
          <h2>🧠 Generate Ontology</h2>
          <button className="og-close-btn" onClick={onClose}>×</button>
        </div>

        {!generatedOntology ? (
          <>
            {/* Mode Selection */}
            <div className="og-mode-tabs">
              <button 
                className={`og-mode-tab ${mode === 'prompt' ? 'active' : ''}`}
                onClick={() => setMode('prompt')}
              >
                💬 From Prompt
              </button>
              <button 
                className={`og-mode-tab ${mode === 'document' ? 'active' : ''}`}
                onClick={() => setMode('document')}
              >
                📄 From Document
              </button>
            </div>

            <div className="og-content">
              {/* Name Input */}
              <div className="og-field">
                <label>Ontology Name (optional)</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Healthcare Ontology"
                />
              </div>

              {/* Industry Input */}
              <div className="og-field">
                <label>Industry/Domain (optional)</label>
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g., healthcare, finance, legal"
                />
              </div>

              {mode === 'prompt' ? (
                /* Prompt Mode */
                <div className="og-field">
                  <label>Describe your domain</label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the domain, industry, or use case you want to model. For example:

I need an ontology for a hospital management system that tracks patients, doctors, appointments, medical records, prescriptions, and departments. Patients can have multiple appointments with different doctors, and each appointment can result in prescriptions and updates to medical records."
                    rows={8}
                  />
                  <div className="og-hint">
                    Be specific about the entities, their properties, and how they relate to each other.
                  </div>
                </div>
              ) : (
                /* Document Mode */
                <div className="og-field">
                  <label>Upload or paste document</label>
                  <div className="og-file-upload">
                    <input
                      type="file"
                      accept=".txt,.md,.json,.csv"
                      onChange={handleFileUpload}
                      id="doc-upload"
                    />
                    <label htmlFor="doc-upload" className="og-file-label">
                      📁 Choose File
                    </label>
                    <span className="og-file-hint">or paste text below</span>
                  </div>
                  <textarea
                    value={documentText}
                    onChange={(e) => setDocumentText(e.target.value)}
                    placeholder="Paste document content here..."
                    rows={8}
                  />
                  {documentText && (
                    <div className="og-hint">
                      {(documentText.length / 1000).toFixed(1)}K characters loaded
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="og-error">
                  ⚠️ {error}
                </div>
              )}
            </div>

            <div className="og-footer">
              <button className="og-cancel-btn" onClick={onClose}>
                Cancel
              </button>
              <button 
                className="og-generate-btn"
                onClick={handleGenerate}
                disabled={generating || (mode === 'prompt' ? !prompt : !documentText)}
              >
                {generating ? '🔄 Generating...' : '🧠 Generate Ontology'}
              </button>
            </div>
          </>
        ) : (
          /* Preview Generated Ontology */
          <>
            <div className="og-content">
              <div className="og-preview">
                <div className="og-preview-header">
                  <h3>{generatedOntology.name}</h3>
                  <span className="og-preview-badge">Generated</span>
                </div>
                
                {generatedOntology.description && (
                  <p className="og-preview-desc">{generatedOntology.description}</p>
                )}

                <div className="og-preview-stats">
                  <div className="og-stat">
                    <span className="og-stat-value">{generatedOntology.entityTypes?.length || 0}</span>
                    <span className="og-stat-label">Entity Types</span>
                  </div>
                  <div className="og-stat">
                    <span className="og-stat-value">{generatedOntology.relationships?.length || 0}</span>
                    <span className="og-stat-label">Relationships</span>
                  </div>
                </div>

                <div className="og-preview-section">
                  <h4>Entity Types</h4>
                  <div className="og-preview-list">
                    {generatedOntology.entityTypes?.slice(0, 10).map((et, idx) => (
                      <div key={idx} className="og-preview-item">
                        <span className="og-preview-item-name">{et.label || et.name}</span>
                        {et.description && (
                          <span className="og-preview-item-desc">{et.description}</span>
                        )}
                        {et.properties?.length > 0 && (
                          <span className="og-preview-item-props">
                            {et.properties.length} properties
                          </span>
                        )}
                      </div>
                    ))}
                    {generatedOntology.entityTypes?.length > 10 && (
                      <div className="og-preview-more">
                        +{generatedOntology.entityTypes.length - 10} more...
                      </div>
                    )}
                  </div>
                </div>

                <div className="og-preview-section">
                  <h4>Relationships</h4>
                  <div className="og-preview-list">
                    {generatedOntology.relationships?.slice(0, 8).map((rel, idx) => (
                      <div key={idx} className="og-preview-item og-preview-rel">
                        <span className="og-preview-rel-from">{rel.from || rel.source_types?.[0]}</span>
                        <span className="og-preview-rel-type">{rel.type || rel.predicate}</span>
                        <span className="og-preview-rel-to">{rel.to || rel.target_types?.[0]}</span>
                      </div>
                    ))}
                    {generatedOntology.relationships?.length > 8 && (
                      <div className="og-preview-more">
                        +{generatedOntology.relationships.length - 8} more...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="og-footer">
              <button 
                className="og-back-btn" 
                onClick={() => setGeneratedOntology(null)}
              >
                ← Back
              </button>
              <button 
                className="og-edit-btn"
                onClick={handleEditOntology}
                disabled={saving}
              >
                ✏️ Edit First
              </button>
              <button 
                className="og-use-btn"
                onClick={handleUseOntology}
                disabled={saving}
              >
                {saving ? '⏳ Saving...' : '✓ Save to Workspace'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default OntologyGenerator;
