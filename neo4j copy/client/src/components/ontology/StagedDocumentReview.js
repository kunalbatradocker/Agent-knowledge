/**
 * StagedDocumentReview - Complete flow for reviewing staged CSV, analyzing schema,
 * creating/selecting ontology, mapping columns, and committing to GraphDB
 */
import { useState, useEffect, useMemo } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import { usePermissions } from '../../hooks/usePermissions';
import './StagedDocumentReview.css';

// Concept explanations for non-technical users
const CONCEPT_EXPLANATIONS = {
  primaryClass: {
    title: "Primary Class",
    simple: "What type of thing does each row represent?",
    detail: "Think of this as a category label. If your CSV has customer complaints, each row is a 'Complaint'. If it's transactions, each row is a 'Transaction'.",
    example: "CSV of orders → Primary Class: 'Order'"
  },
  property: {
    title: "Relationship / Property",
    simple: "What is this connection or attribute called?",
    detail: "For linked columns: the relationship name (e.g., 'hasCustomer'). For literal columns: the data property name (e.g., 'orderDate').",
    example: "customer_id → Relationship: 'hasCustomer' | amount → Property: 'totalAmount'"
  },
  linkedClass: {
    title: "Links To (Creates Node)",
    simple: "Does this column reference another entity?",
    detail: "When you select a class here, each unique value becomes a separate node in the graph. Use for foreign keys and references. Leave as 'Literal' for simple values.",
    example: "customer_id → Links To 'Customer' (creates: Order --hasCustomer--> Customer node)"
  },
  literal: {
    title: "Literal (Data Property)",
    simple: "Store the value directly on the entity",
    detail: "Best for values you want to filter or search: status, amount, date. Stored as data properties with typed values (string, number, date).",
    example: "SPARQL: ?order :totalAmount ?amt FILTER(?amt > 100)"
  },
  linked: {
    title: "Linked Entity (Object Property)",
    simple: "Create a connection to another node",
    detail: "Creates separate nodes that can be traversed. Best for IDs that reference other entities. Enables graph queries like 'Find all orders for customer X'.",
    example: "SPARQL: ?order :hasCustomer ?customer . ?customer :name 'John'"
  }
};

// Inline tooltip component
const ConceptTooltip = ({ concept, children }) => {
  const [show, setShow] = useState(false);
  const info = CONCEPT_EXPLANATIONS[concept];
  if (!info) return children;
  
  return (
    <span className="sdr-concept-tooltip" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      <span className="sdr-tooltip-icon">ⓘ</span>
      {show && (
        <div className="sdr-tooltip-popup">
          <strong>{info.title}</strong>
          <p>{info.simple}</p>
          <p className="sdr-tooltip-detail">{info.detail}</p>
          <code>{info.example}</code>
        </div>
      )}
    </span>
  );
};

// Help content for mapping
const MappingHelpModal = ({ onClose }) => (
  <div className="sdr-help-overlay" onClick={onClose}>
    <div className="sdr-help-modal" onClick={e => e.stopPropagation()}>
      <div className="sdr-help-header">
        <h3>📖 Column Mapping Guide</h3>
        <button onClick={onClose}>×</button>
      </div>
      <div className="sdr-help-content">
        <section>
          <h4>🎯 Property Mapping</h4>
          <p>Maps a CSV column to an ontology property (predicate).</p>
          <table className="sdr-help-table">
            <thead><tr><th>Option</th><th>Result</th><th>Example</th></tr></thead>
            <tbody>
              <tr>
                <td><strong>Select property</strong></td>
                <td>Uses exact ontology property IRI</td>
                <td><code>txn:amount</code></td>
              </tr>
              <tr>
                <td><strong>Auto (empty)</strong></td>
                <td>Auto-generates property from column name</td>
                <td><code>column_name</code> → <code>data:column_name</code></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h4>🔗 Links To (linkedClass)</h4>
          <p>Determines how the value is stored.</p>
          <table className="sdr-help-table">
            <thead><tr><th>Option</th><th>Storage</th><th>Best For</th></tr></thead>
            <tbody>
              <tr>
                <td><strong>Literal (empty)</strong></td>
                <td>Value stored directly: <code>"Failed"</code></td>
                <td>status, type, flags, amounts, dates</td>
              </tr>
              <tr>
                <td><strong>Select class</strong></td>
                <td>Creates linked entity node</td>
                <td>foreign keys (customerId, accountId)</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h4>📊 Examples</h4>
          <div className="sdr-help-examples">
            <div className="sdr-help-example">
              <h5>✅ Status as Literal (Recommended)</h5>
              <pre>{`Column: status = "Failed"
Links To: (empty/Literal)

Result:
<Transaction/0> status "Failed" .

Query: WHERE ?t status "Failed"  ✓`}</pre>
            </div>
            <div className="sdr-help-example">
              <h5>⚠️ Status as Linked Entity</h5>
              <pre>{`Column: status = "Failed"  
Links To: Status (class)

Result:
<Transaction/0> status <Status/Failed> .
<Status/Failed> label "Failed" .

Query: WHERE ?t status "Failed"  ✗
       Must traverse: ?t status ?s . ?s label "Failed"  ✓`}</pre>
            </div>
            <div className="sdr-help-example">
              <h5>✅ CustomerId as Linked Entity (Recommended)</h5>
              <pre>{`Column: customerId = "C123"
Links To: Customer (class)

Result:
<Transaction/0> hasCustomer <Customer/C123> .
<Customer/C123> label "C123" .

Enables: Find all transactions for a customer
         Graph visualization of relationships`}</pre>
            </div>
          </div>
        </section>

        <section>
          <h4>📋 Quick Reference</h4>
          <table className="sdr-help-table sdr-help-ref">
            <thead><tr><th>Column Type</th><th>Links To</th><th>Why</th></tr></thead>
            <tbody>
              <tr><td>status, state, type</td><td className="literal">Literal</td><td>Simple filtering</td></tr>
              <tr><td>isFraud, isActive (boolean)</td><td className="literal">Literal</td><td>Simple filtering</td></tr>
              <tr><td>amount, price, count</td><td className="literal">Literal</td><td>Aggregations</td></tr>
              <tr><td>date, timestamp</td><td className="literal">Literal</td><td>Date queries</td></tr>
              <tr><td>description, notes</td><td className="literal">Literal</td><td>Text search</td></tr>
              <tr><td>customerId, userId</td><td className="linked">→ Customer/User</td><td>Relationships</td></tr>
              <tr><td>accountId, orderId</td><td className="linked">→ Account/Order</td><td>Relationships</td></tr>
              <tr><td>categoryId, productId</td><td className="linked">→ Category/Product</td><td>Relationships</td></tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  </div>
);

const StagedDocumentReview = ({ docId, onClose, onCommit }) => {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const { canUpload } = usePermissions();
  const [staged, setStaged] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ontologies, setOntologies] = useState([]);
  const [selectedOntologyId, setSelectedOntologyId] = useState('');
  const [ontologyStructure, setOntologyStructure] = useState(null);
  const [columnMappings, setColumnMappings] = useState({});
  const [primaryClass, setPrimaryClass] = useState('');
  const [committing, setCommitting] = useState(false);
  const [step, setStep] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  
  // Ontology preview
  const [showOntologyPreview, setShowOntologyPreview] = useState(false);
  
  // Schema analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [suggestedSchema, setSuggestedSchema] = useState(null);
  const [creatingOntology, setCreatingOntology] = useState(false);
  const [newOntologyName, setNewOntologyName] = useState('');
  
  // Data profiling (deterministic, no LLM)
  const [dataProfile, setDataProfile] = useState(null);
  const [profiling, setProfiling] = useState(false);
  
  
  // Preview panel
  const [showPreviewPanel, setShowPreviewPanel] = useState(true);
  
  // Entity extraction for text documents
  const [extracting, setExtracting] = useState(false);
  const [extractedEntities, setExtractedEntities] = useState([]);
  const [extractedRelationships, setExtractedRelationships] = useState([]);
  
  // Custom properties/classes added by user
  const [customProperties, setCustomProperties] = useState([]);
  
  // Sheet selection for multi-sheet Excel
  const [selectedSheets, setSelectedSheets] = useState([]);
  // Per-sheet primary class (sheet name → class IRI)
  const [sheetPrimaryClasses, setSheetPrimaryClasses] = useState({});

  // Compute headers/rows filtered by selected sheets
  const activeHeaders = useMemo(() => {
    if (!staged?.headers) return [];
    const sheets = staged.sheets;
    if (!sheets || sheets.length <= 1 || selectedSheets.length === 0 || selectedSheets.length === sheets.length) return staged.headers.filter(h => h !== '__sheet');
    const set = new Set();
    sheets.filter(s => selectedSheets.includes(s.name)).forEach(s => s.headers.forEach(h => set.add(h)));
    return staged.headers.filter(h => h !== '__sheet' && set.has(h));
  }, [staged, selectedSheets]);

  const activeSampleRows = useMemo(() => {
    if (!staged?.sampleRows) return [];
    const sheets = staged.sheets;
    if (!sheets || sheets.length <= 1 || selectedSheets.length === 0 || selectedSheets.length === sheets.length) return staged.sampleRows;
    return staged.sampleRows.filter(r => selectedSheets.includes(r.__sheet));
  }, [staged, selectedSheets]);
  const [customClasses, setCustomClasses] = useState([]);
  const [showAddProperty, setShowAddProperty] = useState(null); // column name or null
  const [showAddClass, setShowAddClass] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState('');
  const [newClassName, setNewClassName] = useState('');
  const [showSaveOntologyModal, setShowSaveOntologyModal] = useState(false);
  const [saveMode, setSaveMode] = useState('new'); // 'new' or 'version'
  const [savingOntology, setSavingOntology] = useState(false);

  // Check if user has made custom additions
  const hasCustomAdditions = customProperties.length > 0 || customClasses.length > 0;

  // Add custom property
  const addCustomProperty = (forColumn) => {
    const name = newPropertyName.trim();
    if (!name) {
      alert('Property name is required');
      return;
    }
    const baseIri = ontologyStructure?.ontologyIRI || 'http://purplefabric.ai/custom';
    const localName = name.replace(/\s+/g, '');
    if (!localName) {
      alert('Property name must contain valid characters');
      return;
    }
    const propIri = `${baseIri}#${localName}`;
    const newProp = { iri: propIri, label: name, isCustom: true };
    setCustomProperties(prev => [...prev, newProp]);
    if (forColumn) {
      updateMapping(forColumn, 'property', propIri);
      updateMapping(forColumn, 'propertyLabel', name);
    }
    setNewPropertyName('');
    setShowAddProperty(null);
  };

  // Add custom class
  const addCustomClass = () => {
    const name = newClassName.trim();
    if (!name) {
      alert('Class name is required');
      return;
    }
    const baseIri = ontologyStructure?.ontologyIRI || 'http://purplefabric.ai/custom';
    const localName = name.replace(/\s+/g, '');
    if (!localName) {
      alert('Class name must contain valid characters');
      return;
    }
    const classIri = `${baseIri}#${localName}`;
    const newClass = { iri: classIri, label: name, isCustom: true };
    setCustomClasses(prev => [...prev, newClass]);
    setNewClassName('');
    setShowAddClass(false);
  };

  // Get combined properties (ontology + custom)
  const getAllProperties = () => {
    const ontProps = ontologyStructure?.properties || [];
    return [...ontProps, ...customProperties];
  };

  // Get combined classes (ontology + custom)
  const getAllClasses = () => {
    const ontClasses = ontologyStructure?.classes || [];
    return [...ontClasses, ...customClasses];
  };

  // Save custom additions to ontology
  const saveOntologyChanges = async () => {
    // Validate required fields
    if (saveMode === 'new' && !newOntologyName.trim()) {
      alert('Ontology name is required');
      return;
    }

    const allClasses = getAllClasses();
    const allProps = getAllProperties();

    // Validate all classes have iri and label
    for (const c of allClasses) {
      if (!c.iri) {
        alert(`Class "${c.label || 'unknown'}" is missing IRI`);
        return;
      }
      if (!c.label) {
        alert(`Class with IRI "${c.iri}" is missing label`);
        return;
      }
    }

    // Validate all properties have iri and label
    for (const p of allProps) {
      if (!p.iri) {
        alert(`Property "${p.label || 'unknown'}" is missing IRI`);
        return;
      }
      if (!p.label) {
        alert(`Property with IRI "${p.iri}" is missing label`);
        return;
      }
    }

    setSavingOntology(true);
    try {
      const ontologySlug = newOntologyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      
      if (saveMode === 'new') {
        // For new ontology, always use name-based IRI
        const baseIri = `http://purplefabric.ai/${ontologySlug || 'custom'}`;
        
        // Create new ontology with all classes and properties
        const classesPayload = allClasses.map(c => ({
          iri: c.iri,
          label: c.label,
          comment: c.comment || ''
        }));
        const propsPayload = allProps.map(p => ({
          iri: p.iri,
          label: p.label,
          comment: p.comment || '',
          type: p.type || 'DatatypeProperty'
        }));

        const res = await fetch('/api/owl/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({
            tenantId: currentWorkspace?.tenant_id || 'default',
            workspaceId: currentWorkspace?.workspace_id || 'default',
            ontology: {
              iri: baseIri,
              label: newOntologyName.trim(),
              comment: `Extended ontology with custom properties/classes`,
              classes: classesPayload,
              dataProperties: propsPayload.filter(p => p.type === 'DatatypeProperty' || p.type === 'datatypeProperty'),
              objectProperties: propsPayload.filter(p => p.type === 'ObjectProperty' || p.type === 'objectProperty')
            }
          })
        });
        const data = await res.json();
        if (data.success) {
          alert(`✅ New ontology "${newOntologyName}" created!`);
          await loadOntologies();
          setSelectedOntologyId(data.ontologyId);
          setShowSaveOntologyModal(false);
          setCustomProperties([]);
          setCustomClasses([]);
        } else {
          alert(`❌ ${data.error || 'Failed to create ontology'}`);
        }
      } else {
        // Save as new version of existing ontology
        const res = await fetch(`/api/owl/versions/${selectedOntologyId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({
            tenantId: currentWorkspace?.tenant_id || 'default',
            workspaceId: currentWorkspace?.workspace_id || 'default',
            additions: {
              classes: customClasses,
              properties: customProperties
            },
            comment: `Added ${customClasses.length} classes, ${customProperties.length} properties`
          })
        });
        const data = await res.json();
        if (data.success) {
          alert(`✅ Ontology updated to version ${data.version}!`);
          await loadOntologyStructure(selectedOntologyId);
          setShowSaveOntologyModal(false);
          setCustomProperties([]);
          setCustomClasses([]);
        } else {
          alert(`❌ ${data.error || 'Failed to update ontology'}`);
        }
      }
    } catch (e) {
      alert(`❌ Error: ${e.message}`);
    } finally {
      setSavingOntology(false);
    }
  };

  // Extract entities from text document chunks
  const extractEntities = async () => {
    if (!staged?.chunkCount && (!staged?.sampleChunks || staged.sampleChunks.length === 0)) {
      alert('No text chunks to extract from');
      return;
    }
    setExtracting(true);
    try {
      const res = await fetch('/api/ontology/documents/extract-entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          docId,
          ontologyId: selectedOntologyId,
          sampleOnly: true, // Only extract from first few chunks for preview
          maxChunks: 3
        })
      });
      const data = await res.json();
      if (data.success) {
        setExtractedEntities(data.entities || []);
        setExtractedRelationships(data.relationships || []);
        setStep(4); // Move to review step
      } else {
        alert(`❌ ${data.error || 'Extraction failed'}`);
      }
    } catch (e) {
      alert(`❌ Error: ${e.message}`);
    } finally {
      setExtracting(false);
    }
  };

  // Copy global ontology to workspace
  const copyGlobalOntology = async (globalOntologyId) => {
    try {
      const res = await fetch('/api/owl/copy-to-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          globalOntologyId,
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default'
        })
      });
      const data = await res.json();
      if (data.success) {
        alert(`✅ Ontology copied to workspace!`);
        loadOntologies();
        // Auto-select the new workspace copy
        if (data.ontologyId) {
          handleOntologySelect(data.ontologyId);
        }
      } else {
        alert(`❌ ${data.error || 'Copy failed'}`);
      }
    } catch (e) {
      alert(`❌ Error: ${e.message}`);
    }
  };

  useEffect(() => {
    loadStagedDocument();
    loadOntologies();
  }, [docId]);

  const loadStagedDocument = async () => {
    try {
      const res = await fetch(`/api/ontology/documents/staged/${docId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      if (data.success) {
        setStaged(data.staged);
        setNewOntologyName(data.staged.document?.title?.replace(/\.[^.]+$/, '') || 'New Ontology');
        
        // Auto-select all sheets
        if (data.staged.sheets) {
          setSelectedSheets(data.staged.sheets.map(s => s.name));
        }
        
        // Auto-select folder's ontology if present
        if (data.staged.document?.ontology_id) {
          setSelectedOntologyId(data.staged.document.ontology_id);
          loadOntologyStructure(data.staged.document.ontology_id);
        }
        
        // Auto-run data profiling for CSV (instant, no LLM)
        if (data.staged.type === 'csv' && data.staged.headers?.length > 0) {
          runDataProfile(data.staged);
        }
      }
    } catch (e) {
      console.error('Failed to load staged document:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadOntologies = async () => {
    try {
      const params = new URLSearchParams({
        tenantId: currentWorkspace?.tenant_id || 'default',
        workspaceId: currentWorkspace?.workspace_id || 'default',
        scope: 'all'
      });
      const res = await fetch(`/api/owl/list?${params}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setOntologies(data.ontologies || []);
    } catch (e) {
      console.error('Failed to load ontologies:', e);
    }
  };

  // Run deterministic data profiling (no LLM, instant)
  const runDataProfile = async (stagedData) => {
    setProfiling(true);
    try {
      const headers = (stagedData.headers || []).filter(h => h !== '__sheet');
      const sampleRows = stagedData.sampleRows || [];
      const res = await fetch('/api/ontology/documents/data-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ headers, sampleRows, sheets: stagedData.sheets })
      });
      const data = await res.json();
      if (data.success) {
        setDataProfile(data.profile);
      }
    } catch (e) {
      console.warn('Data profiling failed:', e.message);
    } finally {
      setProfiling(false);
    }
  };

  const loadOntologyStructure = async (ontologyId) => {
    if (!ontologyId) {
      setOntologyStructure(null);
      setPrimaryClass('');
      // Initialize mappings for all columns with defaults (no ontology)
      if (activeHeaders.length > 0) {
        const defaultMappings = {};
        activeHeaders.forEach(col => {
          defaultMappings[col] = {
            property: '',
            propertyLabel: col,
            linkedClass: '',
            linkedClassLabel: '',
            domain: '',
            domainLabel: '',
            ignore: false
          };
        });
        setColumnMappings(defaultMappings);
      } else {
        setColumnMappings({});
      }
      return;
    }
    try {
      const params = new URLSearchParams({
        tenantId: currentWorkspace?.tenant_id || 'default',
        workspaceId: currentWorkspace?.workspace_id || 'default',
        scope: 'all'
      });
      const res = await fetch(`/api/owl/structure/${ontologyId}?${params}`, { headers: getTenantHeaders() });
      const data = await res.json();
      setOntologyStructure(data);
      // Resolve per-sheet primary class labels to IRIs from loaded ontology
      if (data.classes) {
        setSheetPrimaryClasses(prev => {
          const resolved = { ...prev };
          for (const [sheet, val] of Object.entries(resolved)) {
            if (val && !val.startsWith('http')) {
              const cls = data.classes.find(c => c.label === val);
              if (cls) resolved[sheet] = cls.iri;
            }
          }
          return resolved;
        });
      }
      if (activeHeaders.length > 0 && data.classes && data.properties) {
        // Try to load saved column mappings first
        let loadedSaved = false;
        try {
          const mapParams = new URLSearchParams({
            ontologyId,
            workspaceId: currentWorkspace?.workspace_id || 'default',
            headers: JSON.stringify(activeHeaders)
          });
          const mapRes = await fetch(`/api/ontology/documents/column-mappings?${mapParams}`, { headers: getTenantHeaders() });
          const mapData = await mapRes.json();
          if (mapData.success && mapData.mappings) {
            // Check if saved mappings are relevant to this document's columns
            // Saved mappings are per-ontology, so a different document may have different columns
            const savedHeaders = mapData.sourceHeaders || Object.keys(mapData.mappings);
            const savedHeaderSet = new Set(savedHeaders);
            const currentHeaderSet = new Set(activeHeaders);
            const overlap = activeHeaders.filter(h => savedHeaderSet.has(h)).length;
            const overlapRatio = savedHeaders.length > 0 ? overlap / Math.max(savedHeaders.length, activeHeaders.length) : 0;
            
            if (overlapRatio < 0.3) {
              // Less than 30% column overlap — this mapping is from a different document structure
              console.warn(`⚠️ Saved mapping has low column overlap (${(overlapRatio * 100).toFixed(0)}%), ignoring — likely from a different document`);
              // Don't load saved mappings, fall through to autoMapColumns
            } else {
              // Check ontology version staleness
              if (mapData.ontologyStale) {
                const stale = mapData.ontologyStale;
                const diffMsg = stale.diff
                  ? `\nChanges: ${stale.diff.classes_added || 0} classes added, ${stale.diff.classes_removed || 0} removed, ${stale.diff.properties_added || 0} properties added, ${stale.diff.properties_removed || 0} removed`
                  : '';
                setTimeout(() => {
                  alert(`⚠️ Ontology has changed since this mapping was saved.\n\nMapping was built for version: ${stale.mappingBuiltFor?.slice(0, 20)}...\nCurrent version: ${stale.currentVersion?.slice(0, 20)}...${diffMsg}\n\nSome mapped classes or properties may no longer exist. Review your mappings before committing.`);
                }, 300);
              }

              // Detect column changes from saved mapping
              const addedCols = activeHeaders.filter(h => !savedHeaderSet.has(h));
              const removedCols = savedHeaders.filter(h => !currentHeaderSet.has(h));
              
              if (addedCols.length > 0 || removedCols.length > 0) {
                console.warn(`⚠️ Column changes detected: +${addedCols.length} added, -${removedCols.length} removed`);
                setTimeout(() => {
                  const msg = [];
                  if (addedCols.length > 0) msg.push(`New columns: ${addedCols.join(', ')}`);
                  if (removedCols.length > 0) msg.push(`Removed columns: ${removedCols.join(', ')}`);
                  alert(`⚠️ Column changes detected since last mapping (v${mapData.version || 1}):\n\n${msg.join('\n')}\n\nNew columns will need mapping. Removed columns were skipped.`);
                }, 500);
              }
              
              // Merge saved mappings with current headers (in case columns changed)
              // Saved mappings may use per-sheet keys ("SheetName:col") or flat keys ("col")
              const hasPerSheetKeys = Object.keys(mapData.mappings).some(k => k.includes(':'));
              if (hasPerSheetKeys) {
                // Per-sheet format — load directly
                setColumnMappings(mapData.mappings);
              } else if (staged?.sheets?.length > 1) {
                // Flat keys but multi-sheet workbook — expand to per-sheet keys
                const expanded = {};
                for (const sheet of staged.sheets) {
                  if (!selectedSheets.includes(sheet.name)) continue;
                  for (const col of (sheet.headers || [])) {
                    const key = `${sheet.name}:${col}`;
                    expanded[key] = mapData.mappings[col] || {
                      property: '', propertyLabel: col, linkedClass: '', linkedClassLabel: '', domain: '', domainLabel: '', ignore: false
                    };
                  }
                }
                setColumnMappings(expanded);
              } else {
                const merged = {};
                activeHeaders.forEach(col => {
                  merged[col] = mapData.mappings[col] || {
                    property: '', propertyLabel: col, linkedClass: '', linkedClassLabel: '', domain: '', domainLabel: '', ignore: false
                  };
                });
                setColumnMappings(merged);
              }
              if (mapData.primaryClass) setPrimaryClass(mapData.primaryClass);
              // Restore per-sheet primary classes from saved mapping
              if (mapData.sheetClassMap && typeof mapData.sheetClassMap === 'object') {
                const allClasses = [...(data.classes || []), ...customClasses];
                const resolved = {};
                for (const [sheet, classLabel] of Object.entries(mapData.sheetClassMap)) {
                  const cls = allClasses.find(c =>
                    c.iri === classLabel ||
                    c.label?.toLowerCase() === classLabel?.toLowerCase() ||
                    c.localName?.toLowerCase() === classLabel?.toLowerCase()
                  );
                  if (cls) resolved[sheet] = cls.iri;
                }
                if (Object.keys(resolved).length > 0) {
                  setSheetPrimaryClasses(prev => ({ ...prev, ...resolved }));
                }
              }
              loadedSaved = true;
              console.log(`📋 Loaded saved column mappings v${mapData.version || 1} from ${mapData.savedAt}`);
            }
          }
        } catch (e) {
          console.warn('Could not load saved column mappings:', e.message);
        }
        if (!loadedSaved) {
          autoMapColumns(activeHeaders, data);
        }
      }
    } catch (e) {
      console.error('Failed to load ontology structure:', e);
    }
  };

  // Auto-map CSV columns to ontology using domain/range
  const autoMapColumns = (headers, structure) => {
    const mappings = {};
    const classes = structure.classes || [];
    const properties = structure.properties || [];
    
    // Set primary class only if not already set or current selection is not in this ontology
    if (classes.length > 0) {
      const currentValid = classes.some(c => c.iri === primaryClass);
      if (!primaryClass || !currentValid) {
        const aiPrimary = suggestedSchema?.entityTypes?.find(et => et.isPrimary);
        const matched = aiPrimary && classes.find(c => c.label === aiPrimary.name || c.label === aiPrimary.label);
        setPrimaryClass(matched ? matched.iri : classes[0].iri);
      }
    }

    // Build a normalized lookup: normalizedName → property (prefer exact, then prefix)
    const propByExact = new Map();
    const propByLocal = new Map();
    properties.forEach(p => {
      const label = (p.label || '').toLowerCase().replace(/[_\s-]/g, '');
      const local = (p.localName || '').toLowerCase().replace(/[_\s-]/g, '');
      if (label) propByExact.set(label, p);
      if (local) propByLocal.set(local, p);
    });

    // Build class lookup for FK detection
    const classByName = new Map();
    classes.forEach(c => {
      const name = (c.label || c.localName || '').toLowerCase().replace(/[_\s-]/g, '');
      if (name) classByName.set(name, c);
    });

    // Build class IRI → label map for domain resolution
    const classIriToLabel = new Map();
    classes.forEach(c => {
      if (c.iri) classIriToLabel.set(c.iri, c.label || c.localName || c.iri.split('#').pop());
    });

    // Helper: normalize a name for fuzzy matching (camelCase, snake_case, etc → lowercase tokens)
    const tokenize = (name) => {
      if (!name) return [];
      return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
        .replace(/[_\s-]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(t => t.length > 0);
    };

    headers.forEach(col => {
      const colNorm = col.toLowerCase().replace(/[_\s-]/g, '');
      const colTokens = tokenize(col);
      
      // 1. Exact match on label or localName
      let matchedProp = propByExact.get(colNorm) || propByLocal.get(colNorm);
      
      // 2. If no exact match, try matching with common suffixes stripped (e.g. "customerid" → "customer" + "id")
      if (!matchedProp) {
        if (colNorm.length >= 4) {
          matchedProp = properties.find(p => {
            const pName = (p.label || p.localName || '').toLowerCase().replace(/[_\s-]/g, '');
            return pName.length >= 4 && (pName === colNorm || pName === colNorm.replace(/id$/, ''));
          });
        }
      }

      // 2b. Fuzzy token match: "order_ts" matches "orderTimestamp", "signup_date" matches "signupDate"
      if (!matchedProp && colTokens.length > 0) {
        let bestScore = 0;
        let bestProp = null;
        for (const p of properties) {
          const pTokens = tokenize(p.label || p.localName || '');
          if (pTokens.length === 0) continue;
          // Count matching tokens (allow partial: "ts" matches "timestamp")
          let score = 0;
          for (const ct of colTokens) {
            if (ct === 'id') continue; // skip generic "id" token
            for (const pt of pTokens) {
              if (pt === ct) { score += 2; break; }
              if (pt.startsWith(ct) || ct.startsWith(pt)) { score += 1; break; }
            }
          }
          // Normalize by total tokens to prefer tighter matches
          const normalized = score / Math.max(colTokens.length, pTokens.length);
          if (normalized > bestScore && normalized >= 0.5) {
            bestScore = normalized;
            bestProp = p;
          }
        }
        if (bestProp) matchedProp = bestProp;
      }
      
      // 3. FK detection: column ending in "id" → look for matching class
      let matchedClass = null;
      const idMatch = colNorm.match(/^(.+?)id$/);
      if (idMatch) {
        matchedClass = classByName.get(idMatch[1]) || null;
        // Fuzzy: "chargeback_id" → "chargeback" matches class "Chargeback"
        if (!matchedClass) {
          const stem = idMatch[1];
          for (const [name, cls] of classByName) {
            if (name.startsWith(stem) || stem.startsWith(name)) {
              matchedClass = cls;
              break;
            }
          }
        }
        // Compound FK names: "PrimaryCustomerID" → tokens ["primary","customer"] → match class "Customer"
        // Handles prefixed FK columns like PrimaryCustomerID, OriginBranchID, SourceAccountID
        if (!matchedClass) {
          const stemTokens = tokenize(idMatch[1]); // e.g. "primarycustomer" → ["primary","customer"]
          for (const [name, cls] of classByName) {
            if (stemTokens.includes(name) || stemTokens.some(t => t.length >= 4 && (name.startsWith(t) || t.startsWith(name)))) {
              matchedClass = cls;
              break;
            }
          }
        }
      }
      // Also try full column name as class (e.g., column "currency" → class "Currency")
      // Only if no data property was already matched — a matched data property means
      // this column is a literal value, not a foreign key to another entity
      if (!matchedClass && (!matchedProp || matchedProp.type === 'objectProperty')) {
        matchedClass = classByName.get(colNorm) || null;
      }
      // Also try column tokens against class names (e.g., "merchant_category" → "MerchantCategory")
      if (!matchedClass && (!matchedProp || matchedProp.type === 'objectProperty') && colTokens.length > 0) {
        const colJoined = colTokens.join('');
        matchedClass = classByName.get(colJoined) || null;
      }

      // 3b. If FK detected a class, find the best ObjectProperty to use as the relationship
      // Key rule: a DatatypeProperty cannot serve as an object link — if the matched property
      // is a DatatypeProperty (e.g., ontology defines "customerId" as xsd:string on Customer),
      // we must find the correct ObjectProperty instead (e.g., "assessesCustomer" with range=Customer).
      if (matchedClass) {
        const propIsDatatype = matchedProp && matchedProp.type !== 'objectProperty';
        if (!matchedProp || propIsDatatype) {
          const linkedClassLabel = (matchedClass.label || matchedClass.localName || '').toLowerCase().replace(/[_\s-]/g, '');
          const linkedClassIri = matchedClass.iri;

          // Strategy 1: Find ObjectProperty where range = linkedClass
          // Prefer one whose domain matches the current sheet's class (if known from sheetPrimaryClasses)
          const objPropsWithRange = properties.filter(p => {
            if (p.type !== 'objectProperty') return false;
            const range = (p.range || p.rangeLabel || '').toLowerCase().replace(/[_\s-]/g, '');
            const rangeLocal = p.range?.includes('://') ? p.range.split(/[#/]/).pop().toLowerCase().replace(/[_\s-]/g, '') : range;
            return range === linkedClassLabel || rangeLocal === linkedClassLabel
              || p.range === linkedClassIri;
          });

          if (objPropsWithRange.length > 0) {
            // If we know the sheet's class, prefer the property whose domain matches it
            // This handles: RiskScores sheet (class=RiskAssessment) + CustomerID → assessesCustomer (domain=RiskAssessment, range=Customer)
            //               Accounts sheet (class=Account) + CustomerID → hasPrimaryCustomer (domain=Account, range=Customer)
            // For flat (non-sheet) mapping, we don't have sheet context yet — pick the first match
            matchedProp = objPropsWithRange[0]; // default: first ObjectProperty with correct range
          }

          // Strategy 2: Fallback — look for "has{ClassName}" pattern
          if (!matchedProp || (matchedProp && matchedProp.type !== 'objectProperty')) {
            const hasName = `has${linkedClassLabel}`;
            const hasProp = properties.find(p => {
              const pName = (p.label || p.localName || '').toLowerCase().replace(/[_\s-]/g, '');
              return pName === hasName && p.type === 'objectProperty';
            });
            if (hasProp) matchedProp = hasProp;
          }

          // If we still only have a DatatypeProperty, clear it — it can't be used as an object link
          if (matchedProp && matchedProp.type !== 'objectProperty') {
            matchedProp = null;
          }
        }
      }

      // 4. Resolve domain for literal properties from ontology rdfs:domain
      let domain = '';
      let domainLabel = '';
      if (!matchedClass && matchedProp) {
        // Literal property — check ontology domain
        const propDomain = matchedProp.domain;
        if (propDomain) {
          // domain can be a local name or full IRI
          const domainIri = propDomain.includes('://') ? propDomain : null;
          const domainLocal = propDomain.includes('://') ? propDomain.split(/[#/]/).pop() : propDomain;
          // Find matching class
          const domainClass = domainIri
            ? classes.find(c => c.iri === domainIri)
            : classes.find(c => (c.label || c.localName || '') === domainLocal);
          if (domainClass) {
            domain = domainClass.iri;
            domainLabel = domainClass.label || domainClass.localName || '';
          }
        }
      }
      
      mappings[col] = {
        property: matchedProp?.iri || '',
        propertyLabel: matchedProp?.label || matchedProp?.localName || col,
        linkedClass: matchedClass?.iri || '',
        linkedClassLabel: matchedClass?.label || matchedClass?.localName || '',
        domain: domain,
        domainLabel: domainLabel,
        ignore: false
      };
    });
    
    // For multi-sheet: expand flat mappings into per-sheet keys
    // A column that is the PK of its own sheet should be literal in that sheet but FK in others
    if (staged?.sheets && staged.sheets.length > 1) {
      const perSheetMappings = {};
      for (const sheet of staged.sheets) {
        if (!selectedSheets.includes(sheet.name)) continue;
        const sheetClassIri = sheetPrimaryClasses[sheet.name] || primaryClass;
        const sheetClassLabel = classes.find(c => c.iri === sheetClassIri)?.label?.toLowerCase().replace(/[_\s-]/g, '') || '';
        
        for (const col of (sheet.headers || [])) {
          const flatMapping = mappings[col];
          if (!flatMapping) continue;
          const key = `${sheet.name}:${col}`;
          
          // Check if this column links to the same class as this sheet's primary class
          // e.g., BranchID links to Branch, and this is the Branches sheet → make it literal
          if (flatMapping.linkedClass) {
            const linkedLabel = (flatMapping.linkedClassLabel || '').toLowerCase().replace(/[_\s-]/g, '');
            if (linkedLabel && linkedLabel === sheetClassLabel) {
              // This column is the PK of this sheet — treat as literal
              perSheetMappings[key] = {
                ...flatMapping,
                linkedClass: '',
                linkedClassLabel: '',
                domain: '',
                domainLabel: '',
              };
              continue;
            }
          }
          perSheetMappings[key] = { ...flatMapping };

          // Refine ObjectProperty selection using sheet context:
          // The flat mapping picked the first ObjectProperty with correct range.
          // Now that we know the sheet's class, prefer the one whose domain matches.
          // e.g., Accounts sheet (class=Account) + CustomerID → hasPrimaryCustomer (domain=Account, range=Customer)
          //        vs RiskScores sheet (class=RiskAssessment) + CustomerID → assessesCustomer (domain=RiskAssessment, range=Customer)
          if (flatMapping.linkedClass && sheetClassIri) {
            const linkedClassLabel = (flatMapping.linkedClassLabel || '').toLowerCase().replace(/[_\s-]/g, '');
            const linkedClassIri = flatMapping.linkedClass;
            const domainAwareObjProp = properties.find(p => {
              if (p.type !== 'objectProperty') return false;
              // Check range matches linked class
              const range = (p.range || p.rangeLabel || '').toLowerCase().replace(/[_\s-]/g, '');
              const rangeLocal = p.range?.includes('://') ? p.range.split(/[#/]/).pop().toLowerCase().replace(/[_\s-]/g, '') : range;
              const rangeMatch = range === linkedClassLabel || rangeLocal === linkedClassLabel || p.range === linkedClassIri;
              if (!rangeMatch) return false;
              // Check domain matches this sheet's class
              const dom = p.domain || '';
              const domLocal = dom.includes('://') ? dom.split(/[#/]/).pop().toLowerCase().replace(/[_\s-]/g, '') : dom.toLowerCase().replace(/[_\s-]/g, '');
              return dom === sheetClassIri || domLocal === sheetClassLabel;
            });
            if (domainAwareObjProp) {
              perSheetMappings[key] = {
                ...perSheetMappings[key],
                property: domainAwareObjProp.iri,
                propertyLabel: domainAwareObjProp.label || domainAwareObjProp.localName || perSheetMappings[key].propertyLabel,
              };
            }
          }
        }
      }
      setColumnMappings(perSheetMappings);
    } else {
      setColumnMappings(mappings);
    }

    // Auto-detect per-sheet primary classes for multi-sheet Excel
    if (staged?.sheets && staged.sheets.length > 1 && classes.length > 0) {
      const sheetClasses = {};
      for (const sheet of staged.sheets) {
        const sheetNorm = sheet.name.toLowerCase().replace(/[_\s-]/g, '');
        // Try exact match, then singular form (e.g., "Users" → "user" → class "User")
        let cls = classByName.get(sheetNorm);
        if (!cls) {
          // Strip trailing 's' for plural → singular
          const singular = sheetNorm.replace(/s$/, '');
          cls = classByName.get(singular);
        }
        if (!cls) {
          // Try partial match: "Chargebacks" → "chargeback"
          for (const [name, c] of classByName) {
            if (sheetNorm.startsWith(name) || name.startsWith(sheetNorm.replace(/s$/, ''))) {
              cls = c;
              break;
            }
          }
        }
        if (cls) sheetClasses[sheet.name] = cls.iri;
      }
      if (Object.keys(sheetClasses).length > 0) {
        setSheetPrimaryClasses(prev => ({ ...prev, ...sheetClasses }));
      }
    }
  };

  // Analyze schema using LLM - for ONTOLOGY CREATION (no existing ontology)
  const analyzeSchema = async () => {
    setAnalyzing(true);
    try {
      const isCSV = staged?.type === 'csv' && staged?.headers;
      
      if (isCSV) {
        // Filter headers/rows by selected sheets if multi-sheet
        let headers = staged.headers;
        let sampleRows = staged.sampleRows;
        const sheetsInfo = staged.sheets;
        
        if (sheetsInfo && sheetsInfo.length > 1 && selectedSheets.length > 0 && selectedSheets.length < sheetsInfo.length) {
          // Get headers only from selected sheets
          const selectedSheetHeaders = new Set();
          sheetsInfo.filter(s => selectedSheets.includes(s.name)).forEach(s => s.headers.forEach(h => selectedSheetHeaders.add(h)));
          headers = staged.headers.filter(h => selectedSheetHeaders.has(h));
          // Filter sample rows to selected sheets
          sampleRows = (staged.sampleRows || []).filter(r => selectedSheets.includes(r.__sheet));
        }
        
        const selectedSheetsInfo = sheetsInfo?.filter(s => selectedSheets.includes(s.name));
        
        // CSV schema analysis
        const res = await fetch('/api/ontology/documents/analyze-csv-schema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({ 
            headers,
            sampleRows,
            sheets: selectedSheetsInfo && selectedSheetsInfo.length > 1 ? selectedSheetsInfo : undefined
          })
        });
        const data = await res.json();
        
        if (data.success && data.analysis) {
          const analysis = data.analysis;
          const entityTypes = [
            { name: analysis.primaryClass, label: analysis.primaryClass, description: analysis.description, isPrimary: true },
            ...(analysis.entityTypes || []).filter(et => et.name !== analysis.primaryClass)
          ];
          setSuggestedSchema({ ...analysis, entityTypes, relationships: analysis.relationships || [] });
          
          // Populate per-sheet primary classes from AI entity types
          if (selectedSheetsInfo && selectedSheetsInfo.length > 1) {
            const perSheet = {};
            for (const s of selectedSheetsInfo) {
              const et = entityTypes.find(e => 
                e.description?.includes(`"${s.name}"`) || 
                e.name?.toLowerCase().replace(/[^a-z0-9]/g, '') === s.name.toLowerCase().replace(/[^a-z0-9]/g, '')
              );
              if (et) perSheet[s.name] = et.name; // store label; will resolve to IRI after ontology creation
            }
            setSheetPrimaryClasses(perSheet);
          }
          return;
        }
      } else {
        // Text/PDF schema analysis
        const res = await fetch('/api/ontology/documents/analyze-text-schema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({ 
            sampleChunks: staged.sampleChunks 
          })
        });
        const data = await res.json();
        
        if (data.success && data.analysis) {
          const analysis = data.analysis;
          const entityTypes = [
            { name: analysis.primaryClass, label: analysis.primaryClass, description: analysis.description, isPrimary: true },
            ...(analysis.entityTypes || []).filter(et => et.name !== analysis.primaryClass)
          ];
          setSuggestedSchema({ ...analysis, entityTypes });
          return;
        }
      }

      // Fallback
      const res = await fetch('/api/ontology/documents/analyze-staged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ docId })
      });
      const data = await res.json();
      if (data.success && data.analysis) {
        setSuggestedSchema(data.analysis);
      }
    } catch (e) {
      console.error('Analysis failed:', e);
      alert('Analysis failed: ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Create ontology from suggested schema
  const createOntologyFromSchema = async () => {
    if (!suggestedSchema) {
      alert('No schema analysis available');
      return;
    }
    if (!newOntologyName.trim()) {
      alert('Ontology name is required');
      return;
    }

    const entityTypes = suggestedSchema.entityTypes || [];
    const validClasses = entityTypes.filter(et => et.name || et.label);

    setCreatingOntology(true);
    try {
      const ontologySlug = newOntologyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const baseIri = `http://purplefabric.ai/${ontologySlug || 'ontology'}`;
      
      // Build classes - add default Record class if none detected
      let classes = validClasses.map(et => {
        const name = (et.name || et.label).trim();
        return {
          iri: `${baseIri}#${name.replace(/\s+/g, '')}`,
          label: name,
          comment: et.description || et.definition || ''
        };
      });
      
      if (classes.length === 0) {
        classes = [{ iri: `${baseIri}#Record`, label: 'Record', comment: 'Default record class' }];
      }

      // Build object properties from AI analysis — deduplicate by name, merge domains
      const objProps = suggestedSchema.objectProperties || suggestedSchema.relationships || [];
      const objPropMap = new Map();
      for (const r of objProps) {
        const predicate = (r.name || r.predicate || r.type || '').trim();
        if (!predicate) continue;
        const key = predicate.replace(/\s+/g, '');
        const domain = r.domain || r.from;
        const range = r.range || r.to;
        if (objPropMap.has(key)) {
          const existing = objPropMap.get(key);
          if (domain && !existing.domain.includes(`${baseIri}#${domain.replace(/\s+/g, '')}`)) {
            existing.domain.push(`${baseIri}#${domain.replace(/\s+/g, '')}`);
          }
        } else {
          objPropMap.set(key, {
            iri: `${baseIri}#${key}`,
            label: predicate,
            domain: domain ? [`${baseIri}#${domain.replace(/\s+/g, '')}`] : [],
            range: range ? [`${baseIri}#${range.replace(/\s+/g, '')}`] : []
          });
        }
      }
      const objectProperties = Array.from(objPropMap.values());

      // Build data properties from AI analysis — deduplicate by name, merge domains
      const dataProps = suggestedSchema.dataProperties || [];
      const XSD = 'http://www.w3.org/2001/XMLSchema#';
      const dataPropMap = new Map();
      for (const dp of dataProps) {
        const name = (dp.name || '').trim();
        if (!name) continue;
        const key = name.replace(/\s+/g, '');
        let rangeIri = dp.range || 'xsd:string';
        if (rangeIri.startsWith('xsd:')) rangeIri = XSD + rangeIri.substring(4);
        const domainIri = dp.domain ? `${baseIri}#${dp.domain.replace(/\s+/g, '')}` : null;
        if (dataPropMap.has(key)) {
          const existing = dataPropMap.get(key);
          if (domainIri && !existing.domain.includes(domainIri)) {
            existing.domain.push(domainIri);
          }
        } else {
          dataPropMap.set(key, {
            iri: `${baseIri}#${key}`,
            label: name,
            domain: domainIri ? [domainIri] : [],
            range: [rangeIri]
          });
        }
      }
      const dataProperties = Array.from(dataPropMap.values());

      const res = await fetch('/api/owl/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          ontology: {
            iri: baseIri,
            label: newOntologyName.trim(),
            comment: `Auto-generated from ${staged?.document?.title}`,
            classes,
            objectProperties,
            dataProperties
          }
        })
      });
      const data = await res.json();
      if (data.success && data.ontologyId) {
        await loadOntologies();
        setSelectedOntologyId(data.ontologyId);
        await loadOntologyStructure(data.ontologyId);
        
        // Build column mappings directly from AI analysis — no need for another LLM call
        const aiMappings = {};
        const columns = suggestedSchema.columns || [];
        for (const col of columns) {
          if (!col.column) continue;
          if (col.includeAsNode && col.linkedClass) {
            aiMappings[col.column] = {
              property: col.objectProperty ? `${baseIri}#${col.objectProperty.replace(/\s+/g, '')}` : '',
              propertyLabel: col.objectProperty || col.column,
              linkedClass: `${baseIri}#${col.linkedClass.replace(/\s+/g, '')}`,
              linkedClassLabel: col.linkedClass,
              domain: '',
              domainLabel: '',
              ignore: false
            };
          } else {
            const propName = col.dataProperty || col.column;
            aiMappings[col.column] = {
              property: `${baseIri}#${propName.replace(/\s+/g, '')}`,
              propertyLabel: propName,
              linkedClass: '',
              linkedClassLabel: '',
              domain: col.domain ? `${baseIri}#${col.domain.replace(/\s+/g, '')}` : '',
              domainLabel: col.domain || '',
              ignore: false
            };
          }
        }
        if (Object.keys(aiMappings).length > 0) {
          // Set per-sheet primary classes if available
          let aiPrimaryClass = '';
          let aiSheetMap = undefined;
          if (suggestedSchema.entityTypes?.length > 0) {
            const firstClass = suggestedSchema.entityTypes[0];
            aiPrimaryClass = `${baseIri}#${(firstClass.name || firstClass.label).replace(/\s+/g, '')}`;
            setPrimaryClass(aiPrimaryClass);
            
            // Map each sheet to its entity class IRI
            if (staged?.sheets?.length > 1) {
              const perSheet = {};
              for (const s of staged.sheets) {
                const et = suggestedSchema.entityTypes.find(e =>
                  e.description?.includes(`"${s.name}"`) ||
                  (e.name || e.label || '').toLowerCase().replace(/[^a-z0-9]/g, '') === s.name.toLowerCase().replace(/[^a-z0-9]/g, '')
                );
                const className = et ? (et.name || et.label) : (firstClass.name || firstClass.label);
                perSheet[s.name] = `${baseIri}#${className.replace(/\s+/g, '')}`;
              }
              setSheetPrimaryClasses(perSheet);
              aiSheetMap = perSheet;
            }
          }

          // For multi-sheet: expand into per-sheet keys, making PK columns literal in their own sheet
          if (staged?.sheets?.length > 1 && aiSheetMap) {
            const perSheetMappings = {};
            for (const s of staged.sheets) {
              if (!selectedSheets.includes(s.name)) continue;
              const sheetClassIri = aiSheetMap[s.name] || aiPrimaryClass;
              const sheetClassLabel = (sheetClassIri.split('#').pop() || '').toLowerCase();
              for (const col of (s.headers || [])) {
                const flat = aiMappings[col];
                if (!flat) continue;
                const key = `${s.name}:${col}`;
                if (flat.linkedClass) {
                  const linkedLabel = (flat.linkedClassLabel || '').toLowerCase().replace(/\s+/g, '');
                  if (linkedLabel && linkedLabel === sheetClassLabel) {
                    perSheetMappings[key] = { ...flat, linkedClass: '', linkedClassLabel: '', domain: '', domainLabel: '' };
                    continue;
                  }
                }
                perSheetMappings[key] = { ...flat };
              }
            }
            setColumnMappings(perSheetMappings);
          } else {
            setColumnMappings(aiMappings);
          }
        
          // Persist AI-generated mappings to Redis so they survive page refresh
          await saveColumnMappings(aiMappings, data.ontologyId, aiPrimaryClass, aiSheetMap);
        }
        
        alert(`✅ Ontology "${newOntologyName}" created with ${classes.length} class(es)!`);
      } else {
        alert(`❌ ${data.error || data.message || 'Failed to create ontology'}`);
      }
    } catch (e) {
      alert('Failed to create ontology: ' + e.message);
    } finally {
      setCreatingOntology(false);
    }
  };

  // Persist column mappings to Redis so they survive page refresh / modal close
  const saveColumnMappings = async (mappings, ontologyId, pClass, sheetMap) => {
    const effectiveOntologyId = ontologyId || selectedOntologyId;
    const effectiveMappings = mappings || columnMappings;
    const effectivePrimaryClass = pClass || primaryClass;
    if (!effectiveOntologyId || !effectiveMappings || Object.keys(effectiveMappings).length === 0) return;
    try {
      await fetch('/api/ontology/documents/column-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          ontologyId: effectiveOntologyId,
          workspaceId: currentWorkspace?.workspace_id || 'default',
          columnMappings: effectiveMappings,
          primaryClass: effectivePrimaryClass,
          sheetClassMap: sheetMap || (staged?.sheets?.length > 1 ? sheetPrimaryClasses : undefined),
          sourceHeaders: activeHeaders
        })
      });
    } catch (e) {
      console.warn('Failed to persist column mappings:', e.message);
    }
  };

  const handleOntologySelect = (ontologyId) => {
    setSelectedOntologyId(ontologyId);
    loadOntologyStructure(ontologyId);
  };

  const updateMapping = (col, field, value) => {
    setColumnMappings(prev => {
      const updated = { ...prev[col], [field]: value };
      // When linkedClass is set (object property), clear domain since it's not applicable
      if (field === 'linkedClass' && value) {
        updated.domain = '';
        updated.domainLabel = '';
      }
      return { ...prev, [col]: updated };
    });
  };

  // Get the mapping key for a column — for multi-sheet uses "SheetName:col", for single sheet just "col"
  const mappingKey = (col, sheetName) => {
    if (sheetName && staged?.sheets?.length > 1) return `${sheetName}:${col}`;
    return col;
  };

  // Get mapping for a column, with sheet-specific override falling back to flat key
  const getMapping = (col, sheetName) => {
    if (sheetName && staged?.sheets?.length > 1) {
      return columnMappings[`${sheetName}:${col}`] || columnMappings[col] || {};
    }
    return columnMappings[col] || {};
  };

  // Generate preview of what will be created
  const getPreviewTriples = () => {
    if (!staged?.sampleRows?.[0]) return [];
    const row = staged.sampleRows[0];
    const sheetName = row.__sheet;
    const triples = [];
    const entityUri = 'example:entity/0';
    const primaryLabel = ontologyStructure?.classes?.find(c => c.iri === primaryClass)?.label || 'Record';
    
    triples.push({ s: entityUri, p: 'rdf:type', o: primaryLabel });
    
    staged.headers?.forEach(col => {
      if (col === '__sheet') return;
      const mapping = getMapping(col, sheetName);
      if (mapping?.ignore) return;
      const value = row[col];
      if (!value) return;
      
      const propLabel = mapping?.propertyLabel || col;
      if (mapping?.linkedClass) {
        const classLabel = mapping.linkedClassLabel || 'Entity';
        triples.push({ s: entityUri, p: propLabel, o: `${classLabel}:${value}` });
      } else {
        triples.push({ s: entityUri, p: propLabel, o: `"${value}"` });
      }
    });
    
    return triples;
  };

  const handleCommit = async () => {
    setCommitting(true);
    try {
      const res = await fetch('/api/ontology/documents/commit-staged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          docId,
          ontologyId: selectedOntologyId || null,
          primaryClass,
          columnMappings,
          selectedSheets: selectedSheets.length > 0 ? selectedSheets : undefined,
          // Map sheet names to their entity class for multi-sheet Excel
          sheetClassMap: (() => {
            if (!staged?.sheets || staged.sheets.length <= 1) return undefined;
            const allClasses = getAllClasses();
            const sheetsToMap = selectedSheets.length > 0 
              ? staged.sheets.filter(s => selectedSheets.includes(s.name))
              : staged.sheets;
            const map = {};
            for (const s of sheetsToMap) {
              const iri = sheetPrimaryClasses[s.name] || primaryClass;
              const cls = allClasses.find(c => c.iri === iri);
              map[s.name] = cls?.label || 'Record';
            }
            return map;
          })(),
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          // Include extracted entities and relationships for all document types
          extractedEntities: extractedEntities?.length > 0 ? extractedEntities : undefined,
          extractedRelationships: extractedRelationships?.length > 0 ? extractedRelationships : undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        alert(`✅ Commit started in background!\n\nJob ID: ${data.jobId}\n\nCheck Processing panel to monitor progress.`);
        onCommit?.(data);
        onClose?.();
      } else {
        alert('❌ ' + (data.error || 'Commit failed'));
      }
    } catch (e) {
      alert('❌ ' + e.message);
    } finally {
      setCommitting(false);
    }
  };

  if (loading) return <div className="sdr-overlay"><div className="sdr-modal"><div className="sdr-loading">Loading...</div></div></div>;
  if (!staged) return <div className="sdr-overlay"><div className="sdr-modal"><div className="sdr-error">Document not found</div></div></div>;

  return (
    <div className="sdr-overlay">
      <div className="sdr-modal">
        <div className="sdr-header">
          <h2>📄 {staged.document?.title}</h2>
          <div className="sdr-steps">
            {staged.type === 'csv' ? (
              ['Preview', 'Ontology', 'Mapping', 'Review', 'Commit'].map((label, i) => (
                <span key={i} className={step >= i + 1 ? 'active' : ''} onClick={() => step > i && setStep(i + 1)}>
                  {i + 1}. {label}
                </span>
              ))
            ) : (
              ['Preview', 'Ontology', 'Extract', 'Review', 'Commit'].map((label, i) => (
                <span key={i} className={step >= i + 1 ? 'active' : ''} onClick={() => step > i && setStep(i + 1)}>
                  {i + 1}. {label}
                </span>
              ))
            )}
          </div>
          <button className="sdr-close" onClick={onClose}>×</button>
        </div>

        <div className="sdr-content">
          {/* Step 1: Preview */}
          {step === 1 && (
            <div className="sdr-step">
              <h3>Data Preview</h3>
              {staged.type === 'csv' ? (
                <>
                  <div className="sdr-stats">
                    <span>📊 {staged.sheets?.length > 1
                      ? `${staged.sheets.filter(s => selectedSheets.includes(s.name)).reduce((sum, s) => sum + (s.rowCount || 0), 0)} rows (${selectedSheets.length}/${staged.sheets.length} sheets)`
                      : `${staged.rowCount} rows`
                    }</span>
                    <span>📋 {activeHeaders.length} columns</span>
                    {staged.sheets && staged.sheets.length > 1 && <span>📑 {staged.sheets.length} sheets</span>}
                  </div>
                  {staged.sheets && staged.sheets.length > 1 && (
                    <div className="sdr-sheet-selector">
                      <label><strong>Sheets:</strong></label>
                      <div className="sdr-sheet-chips">
                        {staged.sheets.map(s => (
                          <label key={s.name} className={`sdr-sheet-chip ${selectedSheets.includes(s.name) ? 'selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={selectedSheets.includes(s.name)}
                              onChange={e => {
                                setSelectedSheets(prev => e.target.checked
                                  ? [...prev, s.name]
                                  : prev.filter(n => n !== s.name)
                                );
                              }}
                            />
                            {s.name} <small>({s.rowCount} rows, {s.headers.length} cols)</small>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="sdr-table-wrap">
                    {staged.sheets && staged.sheets.length > 1 ? (
                      /* Multi-sheet: render a table per selected sheet */
                      staged.sheets
                        .filter(s => selectedSheets.includes(s.name))
                        .map(sheet => {
                          const sheetRows = (staged.sampleRows || []).filter(r => r.__sheet === sheet.name);
                          const sheetHeaders = sheet.headers || [];
                          return (
                            <div key={sheet.name} className="sdr-sheet-preview-block">
                              <h4 className="sdr-sheet-preview-title">📄 {sheet.name} <small>({sheet.rowCount} rows · {sheetHeaders.length} cols)</small></h4>
                              <table className="sdr-table">
                                <thead><tr>{sheetHeaders.map(h => <th key={h}>{h}</th>)}</tr></thead>
                                <tbody>
                                  {sheetRows.slice(0, 3).map((row, i) => (
                                    <tr key={i}>{sheetHeaders.map(h => <td key={h}>{row[h]}</td>)}</tr>
                                  ))}
                                  {sheetRows.length === 0 && (
                                    <tr><td colSpan={sheetHeaders.length} className="sdr-no-data">No sample rows</td></tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          );
                        })
                    ) : (
                      /* Single sheet / plain CSV */
                      <table className="sdr-table">
                        <thead><tr>{activeHeaders.map(h => <th key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {activeSampleRows.slice(0, 5).map((row, i) => (
                            <tr key={i}>{activeHeaders.map(h => <td key={h}>{row[h]}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  {/* Data Profile Results (instant, no LLM) */}
                  {dataProfile && (
                    <div className="sdr-data-profile">
                      <h4>📊 Column Analysis <small>(auto-detected)</small></h4>
                      {staged.sheets && staged.sheets.length > 1 ? (
                        /* Multi-sheet: group columns by sheet */
                        staged.sheets
                          .filter(s => selectedSheets.includes(s.name))
                          .map(sheet => {
                            const sheetCols = Object.values(dataProfile.columns)
                              .filter(col => sheet.headers?.includes(col.header));
                            if (sheetCols.length === 0) return null;
                            return (
                              <div key={sheet.name} className="sdr-profile-sheet-block">
                                <h5 className="sdr-profile-sheet-title">📄 {sheet.name} <small>({sheet.rowCount} rows · {sheetCols.length} cols)</small></h5>
                                <div className="sdr-profile-grid">
                                  {sheetCols.map(col => (
                                    <div key={col.header} className="sdr-profile-card">
                                      <div className="sdr-profile-header">{col.header}</div>
                                      <div className="sdr-profile-type">
                                        <span className={`sdr-type-badge sdr-type-${col.type}`}>{col.type === 'fk' ? 'text' : col.type}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })
                      ) : (
                        /* Single sheet / plain CSV */
                        <div className="sdr-profile-grid">
                          {Object.values(dataProfile.columns).map(col => (
                            <div key={col.header} className="sdr-profile-card">
                              <div className="sdr-profile-header">{col.header}</div>
                              <div className="sdr-profile-type">
                                <span className={`sdr-type-badge sdr-type-${col.type}`}>{col.type === 'fk' ? 'text' : col.type}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {dataProfile.fkCandidates?.length > 0 && (
                        <div className="sdr-fk-candidates">
                          <h5>🔗 Detected Relationships</h5>
                          {dataProfile.fkCandidates.map((fk, i) => (
                            <div key={i} className="sdr-fk-item">
                              <span>{fk.fromColumn}</span>
                              <span className="sdr-fk-arrow">→</span>
                              <span>{fk.toColumn}</span>
                              <span className="sdr-fk-sheets">({fk.fromSheet} → {fk.toSheet})</span>
                              <span className="sdr-fk-match">{(fk.matchRate * 100).toFixed(0)}% match</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {profiling && <div className="sdr-profiling">⏳ Analyzing columns...</div>}
                </>
              ) : (
                <>
                  <div className="sdr-stats">
                    <span>📄 {staged.chunkCount} chunks</span>
                    <span>📝 {staged.document?.doc_type?.toUpperCase() || 'Document'}</span>
                  </div>
                  <div className="sdr-text-preview">
                    <h4>Text Preview</h4>
                    {staged.sampleChunks?.map((chunk, i) => (
                      <div key={i} className="sdr-chunk-preview">
                        <strong>Chunk {chunk.order + 1}:</strong>
                        <p>{chunk.text}...</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 2: Select or Create Ontology */}
          {step === 2 && (
            <div className="sdr-step">
              <h3>Select or Create Ontology</h3>
              
              {/* Schema Analysis Section */}
              <div className="sdr-analysis-section">
                <h4>🤖 AI Schema Analysis</h4>
                {!suggestedSchema ? (
                  <div className="sdr-analyze-prompt">
                    <p>Analyze your data to get AI-suggested classes and relationships</p>
                    <button onClick={analyzeSchema} disabled={analyzing} className="sdr-btn-analyze">
                      {analyzing ? '🔄 Analyzing...' : '🔍 Analyze Schema'}
                    </button>
                  </div>
                ) : (
                  <div className="sdr-suggested-schema">
                    {suggestedSchema.datasetType && (
                      <div className="sdr-dataset-type">
                        📋 Detected: <strong>{suggestedSchema.datasetType}</strong>
                      </div>
                    )}
                    <div className="sdr-schema-results">
                      <div className="sdr-schema-col">
                        <h5>🏷️ Classes ({suggestedSchema.entityTypes?.length || 0})</h5>
                        {suggestedSchema.entityTypes?.length > 0 ? (
                          <ul>{suggestedSchema.entityTypes.map((et, i) => (
                            <li key={i}><strong>{et.name || et.label}</strong>{et.description ? ` - ${et.description.substring(0, 50)}` : ''}</li>
                          ))}</ul>
                        ) : (
                          <p className="sdr-no-results">No entity classes detected.</p>
                        )}
                      </div>
                      <div className="sdr-schema-col">
                        <h5>🔗 Object Properties ({suggestedSchema.objectProperties?.length || suggestedSchema.relationships?.length || 0})</h5>
                        {(suggestedSchema.objectProperties?.length > 0 || suggestedSchema.relationships?.length > 0) ? (
                          <ul>
                            {(suggestedSchema.objectProperties || suggestedSchema.relationships || []).map((r, i) => (
                              <li key={i}>
                                <strong>{r.name || r.predicate}</strong>: {r.domain || r.from} → {r.range || r.to}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="sdr-no-results">No object properties detected.</p>
                        )}
                      </div>
                      <div className="sdr-schema-col">
                        <h5>📝 Data Properties ({suggestedSchema.dataProperties?.length || 0})</h5>
                        {suggestedSchema.dataProperties?.length > 0 ? (
                          <ul>{suggestedSchema.dataProperties.map((dp, i) => (
                            <li key={i}><strong>{dp.name}</strong>: {dp.range || 'xsd:string'}</li>
                          ))}</ul>
                        ) : (
                          <p className="sdr-no-results">No data properties detected.</p>
                        )}
                      </div>
                    </div>
                    {suggestedSchema.columns && (
                      <details className="sdr-column-details">
                        <summary>📊 Column Analysis ({suggestedSchema.columns.length} columns)</summary>
                        <ul>
                          {suggestedSchema.columns.map((col, i) => (
                            <li key={i}>
                              <strong>{col.column}</strong>: {col.suggestedType}
                              {col.includeAsNode && <span className="sdr-badge-node"> → Node ({col.linkedClass})</span>}
                              {col.objectProperty && <span className="sdr-badge-rel"> via {col.objectProperty}</span>}
                              {col.dataProperty && !col.includeAsNode && <span className="sdr-badge-prop"> as {col.dataProperty}</span>}
                              {col.reasoning && <span className="sdr-col-reason"> — {col.reasoning}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="sdr-create-ontology">
                      <input 
                        type="text" 
                        value={newOntologyName} 
                        onChange={e => setNewOntologyName(e.target.value)}
                        placeholder="Ontology name"
                      />
                      <button onClick={createOntologyFromSchema} disabled={creatingOntology || !newOntologyName.trim()}>
                        {creatingOntology ? '⏳ Creating...' : '➕ Create Ontology from Analysis'}
                      </button>
                      <button onClick={() => setSuggestedSchema(null)} className="sdr-btn-secondary">
                        🔄 Re-analyze
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="sdr-divider">— OR select existing ontology —</div>

              {/* Workspace Ontologies */}
              <div className="sdr-ontology-section">
                <h4>📁 Workspace Ontologies</h4>
                <div className="sdr-ontology-grid">
                  {ontologies.filter(o => o.scope !== 'global').map(ont => (
                    <div 
                      key={ont.ontologyId}
                      className={`sdr-ontology-card ${selectedOntologyId === ont.ontologyId ? 'selected' : ''}`}
                      onClick={() => handleOntologySelect(ont.ontologyId)}
                    >
                      <div className="sdr-ont-icon">📁</div>
                      <div className="sdr-ont-name">{ont.label || ont.ontologyId}</div>
                      <div className="sdr-ont-desc">
                        {ont.classCount || 0} classes, {ont.propertyCount || 0} properties
                      </div>
                    </div>
                  ))}
                  {ontologies.filter(o => o.scope !== 'global').length === 0 && (
                    <div className="sdr-empty-hint">No workspace ontologies yet</div>
                  )}
                </div>
              </div>

              {/* Global Ontologies */}
              {ontologies.filter(o => o.scope === 'global').length > 0 && (
                <div className="sdr-ontology-section">
                  <h4>🌐 Global Ontologies <span className="sdr-hint">(copy to workspace to use)</span></h4>
                  <div className="sdr-ontology-grid">
                    {ontologies.filter(o => o.scope === 'global').map(ont => (
                      <div key={ont.ontologyId} className="sdr-ontology-card global">
                        <div className="sdr-ont-icon">🌐</div>
                        <div className="sdr-ont-name">{ont.label || ont.ontologyId}</div>
                        <div className="sdr-ont-desc">
                          {ont.classCount || 0} classes, {ont.propertyCount || 0} properties
                        </div>
                        <button 
                          className="sdr-btn-copy" 
                          onClick={(e) => { e.stopPropagation(); copyGlobalOntology(ont.ontologyId); }}
                        >
                          📥 Copy to Workspace
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Selected ontology info & preview */}
              {selectedOntologyId && ontologyStructure && (
                <div className="sdr-selected-ontology">
                  <div className="sdr-selected-header">
                    <strong>📚 {ontologies.find(o => o.ontologyId === selectedOntologyId)?.label}</strong>
                    <button className="sdr-btn-preview" onClick={() => setShowOntologyPreview(!showOntologyPreview)}>
                      {showOntologyPreview ? '▼ Hide Preview' : '▶ Preview Ontology'}
                    </button>
                  </div>
                  {showOntologyPreview && (
                    <div className="sdr-ontology-preview">
                      <div className="sdr-preview-section">
                        <h5>Classes ({ontologyStructure.classes?.length || 0})</h5>
                        <div className="sdr-preview-list">
                          {ontologyStructure.classes?.slice(0, 10).map((c, i) => (
                            <span key={i} className="sdr-preview-tag class">{c.localName || c.label}</span>
                          ))}
                          {ontologyStructure.classes?.length > 10 && <span className="sdr-more">+{ontologyStructure.classes.length - 10} more</span>}
                        </div>
                      </div>
                      <div className="sdr-preview-section">
                        <h5>Properties ({ontologyStructure.properties?.length || 0})</h5>
                        <div className="sdr-preview-list">
                          {ontologyStructure.properties?.slice(0, 10).map((p, i) => (
                            <span key={i} className={`sdr-preview-tag ${p.type === 'objectProperty' ? 'rel' : 'prop'}`}>
                              {p.localName || p.label}
                            </span>
                          ))}
                          {ontologyStructure.properties?.length > 10 && <span className="sdr-more">+{ontologyStructure.properties.length - 10} more</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Column Mapping (CSV) or Entity Extraction (Text) */}
          {step === 3 && staged?.type === 'csv' && (
            <div className="sdr-step sdr-step-mapping">
              <div className="sdr-step-header">
                <h3>Column Mapping</h3>
                <div className="sdr-step-actions">
                  <button className="sdr-preview-toggle" onClick={() => setShowPreviewPanel(!showPreviewPanel)}>
                    {showPreviewPanel ? '📊 Hide Preview' : '📊 Show Preview'}
                  </button>
                  <button className="sdr-help-btn" onClick={() => setShowHelp(true)} title="Mapping Help">
                    ❓ Help
                  </button>
                </div>
              </div>
              
              
              {/* Concept explanation banner */}
              <div className="sdr-concept-banner">
                <div className="sdr-concept-item">
                  <ConceptTooltip concept="primaryClass">
                    <strong>🎯 Primary Class</strong>
                  </ConceptTooltip>
                  <span>What each row represents</span>
                </div>
                <div className="sdr-concept-item">
                  <ConceptTooltip concept="property">
                    <strong>📝 Property</strong>
                  </ConceptTooltip>
                  <span>Column name/label</span>
                </div>
                <div className="sdr-concept-item">
                  <ConceptTooltip concept="linkedClass">
                    <strong>🔗 Links To</strong>
                  </ConceptTooltip>
                  <span>Empty = literal, Class = relationship</span>
                </div>
              </div>
              
              <div className="sdr-mapping-layout">
                <div className="sdr-mapping-main">
                  {ontologyStructure || customClasses.length > 0 ? (
                    <>
                      {/* Primary class selector — only for single sheet */}
                      {(!staged?.sheets || staged.sheets.length <= 1) && (
                        <div className="sdr-primary-class">
                          <ConceptTooltip concept="primaryClass">
                            <label>Primary Entity Class:</label>
                          </ConceptTooltip>
                          <select value={primaryClass} onChange={e => setPrimaryClass(e.target.value)}>
                            {getAllClasses().map(c => (
                              <option key={c.iri} value={c.iri}>{c.label}{c.isCustom ? ' ✨' : ''}</option>
                            ))}
                          </select>
                          <button className="sdr-add-btn" onClick={() => setShowAddClass(true)} title="Add new class">+</button>
                          {suggestedSchema?.primaryClassExplanation && (
                            <div className="sdr-primary-explanation">
                              <span className="sdr-ai-badge">🤖</span> {suggestedSchema.primaryClassExplanation}
                            </div>
                          )}
                        </div>
                      )}
                      
                      {/* Sheet-to-Class mapping for multi-sheet Excel */}
                      {staged?.sheets?.length > 1 && (
                        <div className="sdr-sheet-class-map">
                          <h4>📋 Sheet → Primary Class Mapping</h4>
                          <div className="sdr-sheet-class-grid">
                            {staged.sheets.filter(s => !selectedSheets.length || selectedSheets.includes(s.name)).map(s => {
                              return (
                                <div key={s.name} className="sdr-sheet-class-row">
                                  <span className="sdr-sheet-name">📄 {s.name}</span>
                                  <span className="sdr-sheet-arrow">→</span>
                                  <select 
                                    value={sheetPrimaryClasses[s.name] || primaryClass} 
                                    onChange={e => setSheetPrimaryClasses(prev => ({ ...prev, [s.name]: e.target.value }))}
                                  >
                                    {getAllClasses().map(c => (
                                      <option key={c.iri} value={c.iri}>{c.label}{c.isCustom ? ' ✨' : ''}</option>
                                    ))}
                                  </select>
                                  <span className="sdr-sheet-meta">{s.rowCount} rows · {s.headers.length} cols</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Custom additions indicator */}
                      {hasCustomAdditions && (
                        <div className="sdr-custom-additions">
                          ✨ Custom additions: {customProperties.length} properties, {customClasses.length} classes
                          <button onClick={() => { setSaveMode(selectedOntologyId ? 'version' : 'new'); setShowSaveOntologyModal(true); }}>Save to Ontology</button>
                        </div>
                      )}
                      
                      <div className="sdr-mapping-hint">
                        <div className="sdr-hint-box">
                          <strong>💡 Mapping Guide:</strong>
                          <ul className="sdr-hint-list">
                            <li><span className="sdr-hint-literal">Literal</span> = Store value directly as a <em>data property</em> (e.g., amount, date, status)</li>
                            <li><span className="sdr-hint-linked">Links To [Class]</span> = <strong>Creates a new node</strong> of that class and links via <em>object property</em> (e.g., customer_id → creates Customer node)</li>
                          </ul>
                          <div className="sdr-hint-note">
                            ⚠️ <strong>Note:</strong> Selecting a class in "Links To" creates separate graph nodes that can be traversed. Use for foreign keys and references.
                          </div>
                        </div>
                      </div>
                      
                      <table className="sdr-mapping-table">
                        <thead>
                          <tr>
                            <th>Column</th>
                            <th>Sample</th>
                            <th><ConceptTooltip concept="property">Relationship / Property</ConceptTooltip></th>
                            <th><ConceptTooltip concept="linkedClass">Links To (creates node)</ConceptTooltip></th>
                            <th>Skip</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(staged?.sheets?.length > 1
                            ? /* Multi-sheet: render per-sheet sections */
                              staged.sheets
                                .filter(s => selectedSheets.includes(s.name))
                                .flatMap(sheet => {
                                  const sheetClassIri = sheetPrimaryClasses[sheet.name] || primaryClass;
                                  const sheetClassLabel = getAllClasses().find(c => c.iri === sheetClassIri)?.label || 'Record';
                                  return [
                                    <tr key={`header-${sheet.name}`} className="sdr-sheet-section-row">
                                      <td colSpan={5}>
                                        <strong>📄 {sheet.name}</strong>
                                        <span className="sdr-sheet-section-meta"> — {sheet.rowCount} rows · Primary: {sheetClassLabel}</span>
                                      </td>
                                    </tr>,
                                    ...(sheet.headers || []).filter(h => h !== '__sheet').map(col => {
                                      const key = mappingKey(col, sheet.name);
                                      const mapping = getMapping(col, sheet.name);
                                      const sampleRow = (staged.sampleRows || []).find(r => r.__sheet === sheet.name && r[col] != null && r[col] !== '');
                                      return (
                                        <tr key={key} className={mapping.ignore ? 'ignored' : ''}>
                                          <td><strong>{col}</strong></td>
                                          <td className="sdr-sample">{sampleRow?.[col]}</td>
                                          <td>
                                            <div className="sdr-select-with-add">
                                              <select value={mapping.property || ''} onChange={e => updateMapping(key, 'property', e.target.value)} disabled={mapping.ignore}>
                                                <option value="">Auto ({col})</option>
                                                {getAllProperties().map(p => <option key={p.iri} value={p.iri}>{p.label}{p.isCustom ? ' ✨' : ''}</option>)}
                                              </select>
                                              <button className="sdr-add-btn-sm" onClick={() => { setShowAddProperty(key); setNewPropertyName(col); }} title="Add new property">+</button>
                                            </div>
                                            {showAddProperty === key && (
                                              <div className="sdr-inline-add">
                                                <input type="text" value={newPropertyName} onChange={e => setNewPropertyName(e.target.value)} placeholder="Property name" autoFocus />
                                                <button onClick={() => addCustomProperty(key)}>Add</button>
                                                <button onClick={() => setShowAddProperty(null)}>✕</button>
                                              </div>
                                            )}
                                          </td>
                                          <td>
                                            <div className="sdr-select-with-add">
                                              <select value={getAllClasses().some(c => c.iri === mapping.linkedClass) ? mapping.linkedClass : ''} onChange={e => updateMapping(key, 'linkedClass', e.target.value)} disabled={mapping.ignore}>
                                                <option value="">Literal</option>
                                                {getAllClasses().map(c => <option key={c.iri} value={c.iri}>{c.label}{c.isCustom ? ' ✨' : ''}</option>)}
                                              </select>
                                              <button className="sdr-add-btn-sm" onClick={() => setShowAddClass(true)} title="Add new class">+</button>
                                            </div>
                                          </td>
                                          <td><input type="checkbox" checked={mapping.ignore || false} onChange={e => updateMapping(key, 'ignore', e.target.checked)} /></td>
                                        </tr>
                                      );
                                    })
                                  ];
                                })
                            : /* Single sheet: flat list */
                              activeHeaders.map(col => {
                                const mapping = columnMappings[col] || {};
                                return (
                                  <tr key={col} className={mapping.ignore ? 'ignored' : ''}>
                                    <td><strong>{col}</strong></td>
                                    <td className="sdr-sample">{activeSampleRows?.[0]?.[col]}</td>
                                    <td>
                                      <div className="sdr-select-with-add">
                                        <select value={mapping.property || ''} onChange={e => updateMapping(col, 'property', e.target.value)} disabled={mapping.ignore}>
                                          <option value="">Auto ({col})</option>
                                          {getAllProperties().map(p => <option key={p.iri} value={p.iri}>{p.label}{p.isCustom ? ' ✨' : ''}</option>)}
                                        </select>
                                        <button className="sdr-add-btn-sm" onClick={() => { setShowAddProperty(col); setNewPropertyName(col); }} title="Add new property">+</button>
                                      </div>
                                      {showAddProperty === col && (
                                        <div className="sdr-inline-add">
                                          <input type="text" value={newPropertyName} onChange={e => setNewPropertyName(e.target.value)} placeholder="Property name" autoFocus />
                                          <button onClick={() => addCustomProperty(col)}>Add</button>
                                          <button onClick={() => setShowAddProperty(null)}>✕</button>
                                        </div>
                                      )}
                                    </td>
                                    <td>
                                      <div className="sdr-select-with-add">
                                        <select value={getAllClasses().some(c => c.iri === mapping.linkedClass) ? mapping.linkedClass : ''} onChange={e => updateMapping(col, 'linkedClass', e.target.value)} disabled={mapping.ignore}>
                                          <option value="">Literal</option>
                                          {getAllClasses().map(c => <option key={c.iri} value={c.iri}>{c.label}{c.isCustom ? ' ✨' : ''}</option>)}
                                        </select>
                                        <button className="sdr-add-btn-sm" onClick={() => setShowAddClass(true)} title="Add new class">+</button>
                                      </div>
                                    </td>
                                    <td><input type="checkbox" checked={mapping.ignore || false} onChange={e => updateMapping(col, 'ignore', e.target.checked)} /></td>
                                  </tr>
                                );
                              })
                          )}
                        </tbody>
                      </table>
                                            
                      {/* Add Class Modal */}
                      {showAddClass && (
                        <div className="sdr-inline-modal">
                          <h4>Add New Class</h4>
                          <input 
                            type="text" 
                            value={newClassName} 
                            onChange={e => setNewClassName(e.target.value)}
                            placeholder="Class name (e.g., Customer, Product)"
                            autoFocus
                          />
                          <div className="sdr-inline-modal-btns">
                            <button onClick={addCustomClass} disabled={!newClassName.trim()}>Add Class</button>
                        <button onClick={() => setShowAddClass(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              ) : null}
                </div>
                
                {/* Live Preview Panel */}
                {showPreviewPanel && (
                  <div className="sdr-preview-panel">
                    <h4>📊 Live Preview</h4>
                    <p className="sdr-preview-subtitle">How your data will be stored and queried</p>
                    
                    <div className="sdr-preview-section">
                      <h5>🗄️ Storage (Triples)</h5>
                      <p className="sdr-preview-explain">Each row becomes an entity with properties:</p>
                      <div className="sdr-preview-triples-mini">
                        {getPreviewTriples().slice(0, 4).map((t, i) => (
                          <div key={i} className="sdr-triple-row">
                            <span className="sdr-triple-s">{t.s}</span>
                            <span className="sdr-triple-p">{t.p}</span>
                            <span className="sdr-triple-o">{t.o}</span>
                          </div>
                        ))}
                        {getPreviewTriples().length > 4 && <div className="sdr-triple-more">...and {getPreviewTriples().length - 4} more</div>}
                      </div>
                    </div>
                    
                    <div className="sdr-preview-section">
                      <h5>🔍 Example Queries</h5>
                      <p className="sdr-preview-explain">How to find your data:</p>
                      <div className="sdr-query-examples">
                        <div className="sdr-query-example-item">
                          <strong>Find all records:</strong>
                          <code>SELECT * WHERE {'{'} ?entity a {getAllClasses().find(c => c.iri === primaryClass)?.label || 'Record'} {'}'}</code>
                        </div>
                        {staged.headers?.filter(h => h !== '__sheet').slice(0, 2).map(col => {
                          const sheetName = staged.sampleRows?.[0]?.__sheet;
                          const mapping = getMapping(col, sheetName);
                          if (mapping?.ignore) return null;
                          const propLabel = mapping?.propertyLabel || col;
                          const sampleVal = staged.sampleRows?.[0]?.[col];
                          if (mapping?.linkedClass) {
                            return (
                              <div key={col} className="sdr-query-example-item">
                                <strong>Find by {col}:</strong>
                                <code>SELECT * WHERE {'{'} ?entity {propLabel} ?{col.replace(/[^a-zA-Z]/g, '')} {'}'}</code>
                                <span className="sdr-query-note">→ Traverses relationship</span>
                              </div>
                            );
                          }
                          return (
                            <div key={col} className="sdr-query-example-item">
                              <strong>Filter by {col}:</strong>
                              <code>SELECT * WHERE {'{'} ?entity {propLabel} "{sampleVal}" {'}'}</code>
                              <span className="sdr-query-note">→ Direct match</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    
                    <div className="sdr-preview-section">
                      <h5>📈 Summary</h5>
                      <ul className="sdr-preview-stats">
                        <li><strong>{staged.rowCount}</strong> entities will be created</li>
                        <li><strong>{Object.values(columnMappings).filter(m => !m.ignore).length}</strong> properties per entity</li>
                        <li><strong>{Object.values(columnMappings).filter(m => m.linkedClass).length}</strong> relationships per entity</li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Entity Extraction (Text documents) */}
          {step === 3 && staged?.type !== 'csv' && (
            <div className="sdr-step">
              <h3>🔍 Extract Entities & Relationships</h3>
              <p>Use AI to extract entities and relationships from your document text.</p>
              
              {selectedOntologyId && (
                <div className="sdr-extraction-info">
                  <p>✅ Using ontology: <strong>{ontologies.find(o => o.ontologyId === selectedOntologyId)?.label}</strong></p>
                  <p className="sdr-hint">Extraction will be constrained to classes and properties defined in this ontology.</p>
                </div>
              )}
              
              <div className="sdr-extraction-preview">
                <h4>📄 Text to analyze ({staged?.chunkCount || 0} chunks)</h4>
                <div className="sdr-chunk-samples">
                  {staged?.sampleChunks?.slice(0, 2).map((chunk, i) => (
                    <div key={i} className="sdr-chunk-sample">
                      <strong>Chunk {chunk.order + 1}:</strong>
                      <p>{chunk.text?.substring(0, 300)}...</p>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="sdr-extraction-action">
                <button 
                  className="sdr-btn-extract" 
                  onClick={extractEntities} 
                  disabled={extracting}
                >
                  {extracting ? '🔄 Extracting...' : '🤖 Extract Entities (Preview)'}
                </button>
                <p className="sdr-hint">This will analyze a sample of chunks. Full extraction happens on commit.</p>
              </div>
            </div>
          )}

          {/* Step 4: Preview Generated Triples (CSV) or Extracted Entities (Text) */}
          {step === 4 && staged?.type === 'csv' && (
            <div className="sdr-step">
              <h3>Preview Generated Data</h3>
              <p>Sample of what will be created for the first row:</p>
              <div className="sdr-preview-triples">
                <table className="sdr-triples-table">
                  <thead><tr><th>Subject</th><th>Predicate</th><th>Object</th></tr></thead>
                  <tbody>
                    {getPreviewTriples().map((t, i) => (
                      <tr key={i}><td>{t.s}</td><td>{t.p}</td><td>{t.o}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sdr-preview-stats">
                <p>This will create approximately:</p>
                <ul>
                  <li><strong>{staged.rowCount}</strong> primary entities</li>
                  <li><strong>{staged.rowCount * Object.values(columnMappings).filter(m => !m.ignore).length}</strong> property triples</li>
                  <li><strong>{staged.rowCount * Object.values(columnMappings).filter(m => m.linkedClass).length}</strong> linked entities</li>
                </ul>
              </div>
            </div>
          )}

          {/* Step 4: Review Extracted Entities (Text documents) */}
          {step === 4 && staged?.type !== 'csv' && (
            <div className="sdr-step">
              <h3>Review Extracted Entities</h3>
              {extractedEntities.length === 0 && extractedRelationships.length === 0 ? (
                <div className="sdr-no-extraction">
                  <p>No entities extracted yet. Go back to Step 3 to run extraction.</p>
                </div>
              ) : (
                <>
                  <div className="sdr-extracted-summary">
                    <span>🏷️ {extractedEntities.length} entities</span>
                    <span>🔗 {extractedRelationships.length} relationships</span>
                  </div>
                  
                  <div className="sdr-extracted-entities">
                    <h4>Entities</h4>
                    <table className="sdr-table">
                      <thead><tr><th>Type</th><th>Name</th><th>Confidence</th><th>Evidence</th></tr></thead>
                      <tbody>
                        {extractedEntities.slice(0, 20).map((e, i) => (
                          <tr key={i}>
                            <td><span className="sdr-entity-type">{e.class || e.type}</span></td>
                            <td>{e.name || e.label}</td>
                            <td>{Math.round((e.confidence || 0.7) * 100)}%</td>
                            <td className="sdr-evidence">{e.evidence?.substring(0, 50)}...</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {extractedEntities.length > 20 && <p className="sdr-hint">Showing 20 of {extractedEntities.length} entities</p>}
                  </div>
                  
                  {extractedRelationships.length > 0 && (
                    <div className="sdr-extracted-relationships">
                      <h4>Relationships</h4>
                      <table className="sdr-table">
                        <thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Confidence</th></tr></thead>
                        <tbody>
                          {extractedRelationships.slice(0, 10).map((r, i) => (
                            <tr key={i}>
                              <td>{r.from_entity || r.from}</td>
                              <td><strong>{r.type || r.predicate}</strong></td>
                              <td>{r.to_entity || r.to}</td>
                              <td>{Math.round((r.confidence || 0.7) * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 5: Confirm */}
          {step === 5 && (
            <div className="sdr-step">
              <h3>Confirm & Commit</h3>
              {staged?.type === 'csv' ? (
              <div className="sdr-summary">
                <div className="sdr-summary-item"><span className="label">Document:</span><span>{staged.document?.title}</span></div>
                <div className="sdr-summary-item"><span className="label">Rows:</span><span>{staged.rowCount}</span></div>
                <div className="sdr-summary-item">
                  <span className="label">Ontology:</span>
                  <span>
                    {selectedOntologyId ? (
                      <>
                        {ontologies.find(o => o.ontologyId === selectedOntologyId)?.label}
                        {ontologyStructure?.version && <small style={{color:'#666', marginLeft:'8px'}}>v{ontologyStructure.version}</small>}
                      </>
                    ) : 'None (auto-detect)'}
                  </span>
                </div>
                <div className="sdr-summary-item"><span className="label">Primary Class:</span><span>{getAllClasses().find(c => c.iri === primaryClass)?.label || 'Record'}</span></div>
                <div className="sdr-summary-item"><span className="label">Columns Mapped:</span><span>{Object.values(columnMappings).filter(m => !m.ignore).length} of {staged.headers?.length}</span></div>
              </div>
              ) : (
              <div className="sdr-summary">
                <div className="sdr-summary-item"><span className="label">Document:</span><span>{staged?.document?.title}</span></div>
                <div className="sdr-summary-item"><span className="label">Chunks:</span><span>{staged?.chunkCount}</span></div>
                <div className="sdr-summary-item"><span className="label">Entities to create:</span><span>{extractedEntities.length}</span></div>
                <div className="sdr-summary-item"><span className="label">Relationships:</span><span>{extractedRelationships.length}</span></div>
              </div>
              )}
              <div className="sdr-info-box" style={{background:'#e8f4fd',border:'1px solid #b8daff',padding:'12px',borderRadius:'6px',marginBottom:'12px'}}>
                <strong>ℹ️ Note:</strong> Data is stored in your workspace graph, separate from the ontology schema. 
                {staged?.type !== 'csv' && ' Chunks and embeddings are stored in Redis for semantic search.'}
              </div>
              {hasCustomAdditions && (
                <div className="sdr-custom-warning-box">
                  <strong>⚠️ You have unsaved custom additions:</strong>
                  <ul>
                    {customProperties.length > 0 && <li>{customProperties.length} custom properties</li>}
                    {customClasses.length > 0 && <li>{customClasses.length} custom classes</li>}
                  </ul>
                  <p>These will be used for this import but won't be saved to any ontology.</p>
                  <button onClick={() => { setSaveMode(selectedOntologyId ? 'version' : 'new'); setShowSaveOntologyModal(true); }}>💾 Save to Ontology</button>
                </div>
              )}
              <div className="sdr-warning">⚠️ This will create {staged.rowCount} entities in GraphDB.</div>
            </div>
          )}
        </div>

        <div className="sdr-footer">
          <button className="sdr-btn-cancel" onClick={onClose}>Cancel</button>
          <div className="sdr-nav">
            {step > 1 && <button className="sdr-btn-back" onClick={() => setStep(s => s - 1)}>← Back</button>}
            {step < 5 ? (
              <button 
                className="sdr-btn-next" 
                onClick={() => {
                  // Persist column mappings when leaving Step 3 (Mapping)
                  if (step === 3 && staged?.type === 'csv' && selectedOntologyId && Object.keys(columnMappings).length > 0) {
                    saveColumnMappings();
                  }
                  setStep(s => s + 1);
                }}
                disabled={step === 2 && !selectedOntologyId}
                title={step === 2 && !selectedOntologyId ? 'Select or create an ontology first' : ''}
              >
                Next →
              </button>
            ) : (
              <button className="sdr-btn-commit" onClick={handleCommit} disabled={committing || !canUpload}>
                {committing ? '⏳ Committing...' : '✅ Commit to GraphDB'}
              </button>
            )}
          </div>
        </div>
      </div>
      
      {/* Help Modal */}
      {showHelp && <MappingHelpModal onClose={() => setShowHelp(false)} />}
      
      {/* Save Ontology Modal */}
      {showSaveOntologyModal && (
        <div className="sdr-modal-overlay">
          <div className="sdr-modal sdr-save-ontology-modal">
            <h3>💾 Save Custom Additions to Ontology</h3>
            <p>You've added {customProperties.length} properties and {customClasses.length} classes.</p>
            
            <div className="sdr-save-options">
              {selectedOntologyId && (
                <label className={saveMode === 'version' ? 'selected' : ''}>
                  <input type="radio" name="saveMode" value="version" checked={saveMode === 'version'} onChange={() => setSaveMode('version')} />
                  <strong>Add to "{ontologies.find(o => o.ontologyId === selectedOntologyId)?.label}"</strong>
                  <span>Create new version with additions</span>
                </label>
              )}
              
              <label className={saveMode === 'new' ? 'selected' : ''}>
                <input type="radio" name="saveMode" value="new" checked={saveMode === 'new'} onChange={() => setSaveMode('new')} />
                <strong>Create New Ontology</strong>
                <span>Save as a brand new ontology</span>
              </label>
            </div>
            
            {saveMode === 'new' && (
              <div className="sdr-new-ontology-name">
                <label>New Ontology Name:</label>
                <input 
                  type="text" 
                  value={newOntologyName} 
                  onChange={e => setNewOntologyName(e.target.value)}
                  placeholder="e.g., My Custom Ontology"
                />
              </div>
            )}
            
            <div className="sdr-modal-footer">
              <button onClick={() => setShowSaveOntologyModal(false)}>Cancel</button>
              <button 
                onClick={saveOntologyChanges} 
                disabled={savingOntology || (saveMode === 'new' && !newOntologyName.trim())}
                className="sdr-btn-primary"
              >
                {savingOntology ? '⏳ Saving...' : '💾 Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StagedDocumentReview;
