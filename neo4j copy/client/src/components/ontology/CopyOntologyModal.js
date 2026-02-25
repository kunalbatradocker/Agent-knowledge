import { useState } from 'react';
import './CopyOntologyModal.css';

const CopyOntologyModal = ({ ontology, onClose, onCopy }) => {
  const [workspaceName, setWorkspaceName] = useState('');
  const [customOntologyId, setCustomOntologyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!workspaceName.trim()) {
      setError('Workspace name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await onCopy({
        globalOntologyId: ontology.ontologyId,
        workspaceName: workspaceName.trim(),
        customOntologyId: customOntologyId.trim() || null
      });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to copy ontology');
    } finally {
      setLoading(false);
    }
  };

  const generateSuggestedId = () => {
    const baseName = workspaceName.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return baseName ? `${baseName}-v1` : '';
  };

  return (
    <div className="copy-modal-overlay">
      <div className="copy-modal">
        <div className="copy-modal-header">
          <h3>Copy Global Ontology to Workspace</h3>
          <button className="copy-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="copy-modal-content">
          <div className="copy-source-info">
            <div className="copy-source-icon">🌐</div>
            <div>
              <div className="copy-source-name">{ontology.name || ontology.label}</div>
              <div className="copy-source-description">{ontology.description}</div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="copy-form-group">
              <label htmlFor="workspaceName">Workspace Ontology Name *</label>
              <input
                id="workspaceName"
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="e.g., My Custom Resume Ontology"
                className="copy-form-input"
                required
              />
              <div className="copy-form-help">
                Display name for your workspace ontology
              </div>
            </div>

            <div className="copy-form-group">
              <label htmlFor="customOntologyId">Custom Ontology ID (Optional)</label>
              <input
                id="customOntologyId"
                type="text"
                value={customOntologyId}
                onChange={(e) => setCustomOntologyId(e.target.value)}
                placeholder={generateSuggestedId() || "e.g., my-resume-v1"}
                className="copy-form-input"
                pattern="[a-zA-Z0-9_-]+"
              />
              <div className="copy-form-help">
                Unique identifier (letters, numbers, hyphens, underscores only).
                {generateSuggestedId() && (
                  <button 
                    type="button" 
                    className="copy-suggestion-btn"
                    onClick={() => setCustomOntologyId(generateSuggestedId())}
                  >
                    Use suggested: {generateSuggestedId()}
                  </button>
                )}
              </div>
            </div>

            {error && (
              <div className="copy-error">
                {error}
              </div>
            )}

            <div className="copy-modal-actions">
              <button type="button" className="copy-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="copy-btn-primary" disabled={loading}>
                {loading ? 'Copying...' : 'Copy to Workspace'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default CopyOntologyModal;
