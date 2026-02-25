/**
 * OntologyBuilder Component
 * Step-by-step wizard for creating ontologies manually
 */
import { useState } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import './OntologyBuilder.css';

const STEPS = ['Basic Info', 'Classes', 'Properties', 'Relationships', 'Review'];

const OntologyBuilder = ({ onClose, onCreated }) => {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Ontology data
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [industry, setIndustry] = useState('');
  const [classes, setClasses] = useState([]);
  const [properties, setProperties] = useState([]);
  const [relationships, setRelationships] = useState([]);

  // Temp inputs
  const [newClass, setNewClass] = useState({ name: '', description: '' });
  const [newProp, setNewProp] = useState({ name: '', dataType: 'string', domain: '' });
  const [newRel, setNewRel] = useState({ name: '', source: '', target: '' });

  const tenantId = currentWorkspace?.tenant_id || 'default';
  const workspaceId = currentWorkspace?.workspace_id || 'default';

  const canProceed = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return classes.length > 0;
    return true;
  };

  const addClass = () => {
    if (!newClass.name.trim()) return;
    setClasses([...classes, { ...newClass, id: Date.now() }]);
    setNewClass({ name: '', description: '' });
  };

  const removeClass = (id) => {
    setClasses(classes.filter(c => c.id !== id));
    setProperties(properties.filter(p => p.domain !== id));
    setRelationships(relationships.filter(r => r.source !== id && r.target !== id));
  };

  const addProperty = () => {
    if (!newProp.name.trim() || !newProp.domain) return;
    setProperties([...properties, { ...newProp, id: Date.now() }]);
    setNewProp({ name: '', dataType: 'string', domain: '' });
  };

  const addRelationship = () => {
    if (!newRel.name.trim() || !newRel.source || !newRel.target) return;
    setRelationships([...relationships, { ...newRel, id: Date.now() }]);
    setNewRel({ name: '', source: '', target: '' });
  };

  const generateTurtle = () => {
    const ontologyId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const baseUri = `http://purplefabric.ai/ontology/${ontologyId}#`;
    
    let turtle = `@prefix : <${baseUri}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${baseUri.slice(0, -1)}> a owl:Ontology ;
    rdfs:label "${name}" ;
    rdfs:comment "${description || ''}" .

`;
    // Classes
    for (const cls of classes) {
      const clsName = cls.name.replace(/\s+/g, '');
      turtle += `:${clsName} a owl:Class ;
    rdfs:label "${cls.name}"${cls.description ? ` ;
    rdfs:comment "${cls.description}"` : ''} .

`;
    }

    // Data Properties
    for (const prop of properties) {
      const propName = prop.name.replace(/\s+/g, '_');
      const domainCls = classes.find(c => c.id === prop.domain);
      const xsdType = prop.dataType === 'number' ? 'xsd:decimal' : 
                      prop.dataType === 'date' ? 'xsd:dateTime' : 
                      prop.dataType === 'boolean' ? 'xsd:boolean' : 'xsd:string';
      turtle += `:${propName} a owl:DatatypeProperty ;
    rdfs:label "${prop.name}" ;
    rdfs:domain :${domainCls?.name.replace(/\s+/g, '')} ;
    rdfs:range ${xsdType} .

`;
    }

    // Object Properties (Relationships)
    for (const rel of relationships) {
      const relName = rel.name.replace(/\s+/g, '_').toUpperCase();
      const sourceCls = classes.find(c => c.id === rel.source);
      const targetCls = classes.find(c => c.id === rel.target);
      turtle += `:${relName} a owl:ObjectProperty ;
    rdfs:label "${rel.name}" ;
    rdfs:domain :${sourceCls?.name.replace(/\s+/g, '')} ;
    rdfs:range :${targetCls?.name.replace(/\s+/g, '')} .

`;
    }

    return turtle;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const ontologyId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const turtle = generateTurtle();

      const res = await fetch('/api/owl/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId,
          workspaceId,
          turtleContent: turtle,
          ontologyId,
          scope: 'workspace'
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to create ontology');

      onCreated?.({ ontologyId, name });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 0: // Basic Info
        return (
          <div className="ob-step">
            <h3>📋 Basic Information</h3>
            <div className="ob-field">
              <label>Ontology Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Customer Support Ontology"
              />
            </div>
            <div className="ob-field">
              <label>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this ontology models..."
                rows={3}
              />
            </div>
            <div className="ob-field">
              <label>Industry</label>
              <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
                <option value="">Select industry...</option>
                <option value="finance">Finance</option>
                <option value="healthcare">Healthcare</option>
                <option value="legal">Legal</option>
                <option value="hr">Human Resources</option>
                <option value="retail">Retail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
        );

      case 1: // Classes
        return (
          <div className="ob-step">
            <h3>🏷️ Define Classes (Entity Types)</h3>
            <p className="ob-hint">Classes represent the types of things in your domain (e.g., Person, Company, Product)</p>
            
            <div className="ob-add-row">
              <input
                value={newClass.name}
                onChange={(e) => setNewClass({ ...newClass, name: e.target.value })}
                placeholder="Class name"
                onKeyDown={(e) => e.key === 'Enter' && addClass()}
              />
              <input
                value={newClass.description}
                onChange={(e) => setNewClass({ ...newClass, description: e.target.value })}
                placeholder="Description (optional)"
              />
              <button onClick={addClass}>Add</button>
            </div>

            <div className="ob-list">
              {classes.map(cls => (
                <div key={cls.id} className="ob-item">
                  <span className="ob-item-name">{cls.name}</span>
                  {cls.description && <span className="ob-item-desc">{cls.description}</span>}
                  <button onClick={() => removeClass(cls.id)}>×</button>
                </div>
              ))}
              {classes.length === 0 && <div className="ob-empty">No classes added yet</div>}
            </div>
          </div>
        );

      case 2: // Properties
        return (
          <div className="ob-step">
            <h3>📝 Define Properties (Attributes)</h3>
            <p className="ob-hint">Properties are attributes of classes (e.g., Person has name, email, age)</p>
            
            <div className="ob-add-row">
              <input
                value={newProp.name}
                onChange={(e) => setNewProp({ ...newProp, name: e.target.value })}
                placeholder="Property name"
              />
              <select
                value={newProp.dataType}
                onChange={(e) => setNewProp({ ...newProp, dataType: e.target.value })}
              >
                <option value="string">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="boolean">Yes/No</option>
              </select>
              <select
                value={newProp.domain}
                onChange={(e) => setNewProp({ ...newProp, domain: Number(e.target.value) })}
              >
                <option value="">For class...</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={addProperty}>Add</button>
            </div>

            <div className="ob-list">
              {properties.map(prop => (
                <div key={prop.id} className="ob-item">
                  <span className="ob-item-name">{prop.name}</span>
                  <span className="ob-item-type">{prop.dataType}</span>
                  <span className="ob-item-domain">→ {classes.find(c => c.id === prop.domain)?.name}</span>
                  <button onClick={() => setProperties(properties.filter(p => p.id !== prop.id))}>×</button>
                </div>
              ))}
              {properties.length === 0 && <div className="ob-empty">No properties added yet (optional)</div>}
            </div>
          </div>
        );

      case 3: // Relationships
        return (
          <div className="ob-step">
            <h3>🔗 Define Relationships</h3>
            <p className="ob-hint">Relationships connect classes (e.g., Person WORKS_AT Company)</p>
            
            <div className="ob-add-row">
              <select
                value={newRel.source}
                onChange={(e) => setNewRel({ ...newRel, source: Number(e.target.value) })}
              >
                <option value="">From class...</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input
                value={newRel.name}
                onChange={(e) => setNewRel({ ...newRel, name: e.target.value })}
                placeholder="Relationship name"
              />
              <select
                value={newRel.target}
                onChange={(e) => setNewRel({ ...newRel, target: Number(e.target.value) })}
              >
                <option value="">To class...</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={addRelationship}>Add</button>
            </div>

            <div className="ob-list">
              {relationships.map(rel => (
                <div key={rel.id} className="ob-item ob-rel-item">
                  <span>{classes.find(c => c.id === rel.source)?.name}</span>
                  <span className="ob-rel-name">{rel.name}</span>
                  <span>{classes.find(c => c.id === rel.target)?.name}</span>
                  <button onClick={() => setRelationships(relationships.filter(r => r.id !== rel.id))}>×</button>
                </div>
              ))}
              {relationships.length === 0 && <div className="ob-empty">No relationships added yet (optional)</div>}
            </div>
          </div>
        );

      case 4: // Review
        return (
          <div className="ob-step">
            <h3>✅ Review Your Ontology</h3>
            <div className="ob-review">
              <div className="ob-review-section">
                <h4>{name}</h4>
                {description && <p>{description}</p>}
                {industry && <span className="ob-tag">{industry}</span>}
              </div>
              <div className="ob-review-section">
                <h4>Classes ({classes.length})</h4>
                <div className="ob-review-list">
                  {classes.map(c => <span key={c.id} className="ob-tag">{c.name}</span>)}
                </div>
              </div>
              <div className="ob-review-section">
                <h4>Properties ({properties.length})</h4>
                <div className="ob-review-list">
                  {properties.map(p => (
                    <span key={p.id} className="ob-tag">
                      {classes.find(c => c.id === p.domain)?.name}.{p.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="ob-review-section">
                <h4>Relationships ({relationships.length})</h4>
                <div className="ob-review-list">
                  {relationships.map(r => (
                    <span key={r.id} className="ob-tag">
                      {classes.find(c => c.id === r.source)?.name} → {r.name} → {classes.find(c => c.id === r.target)?.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="ob-overlay">
      <div className="ob-modal">
        <div className="ob-header">
          <h2>🛠️ Ontology Builder</h2>
          <div className="ob-steps">
            {STEPS.map((s, i) => (
              <span key={i} className={i === step ? 'active' : i < step ? 'done' : ''}>
                {i < step ? '✓' : i + 1}. {s}
              </span>
            ))}
          </div>
          <button className="ob-close" onClick={onClose}>×</button>
        </div>

        {error && <div className="ob-error">{error}</div>}

        <div className="ob-content">
          {renderStep()}
        </div>

        <div className="ob-footer">
          <button 
            className="ob-btn-back" 
            onClick={() => setStep(step - 1)}
            disabled={step === 0}
          >
            ← Back
          </button>
          <div className="ob-footer-right">
            <button className="ob-btn-cancel" onClick={onClose}>Cancel</button>
            {step < STEPS.length - 1 ? (
              <button 
                className="ob-btn-next" 
                onClick={() => setStep(step + 1)}
                disabled={!canProceed()}
              >
                Next →
              </button>
            ) : (
              <button 
                className="ob-btn-save" 
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Creating...' : 'Create Ontology'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OntologyBuilder;
