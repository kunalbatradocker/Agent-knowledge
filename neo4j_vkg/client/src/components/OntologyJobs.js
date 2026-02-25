/**
 * Ontology Jobs Component
 * Displays background ontology generation jobs with progress tracking
 * Allows review, approval, modification, and cancellation
 */

import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import { StagedDocumentReview, ExtractionReview } from './ontology';
import './OntologyJobs.css';

const API_BASE_URL = '/api';

const STATUS_LABELS = {
  pending: { label: 'Pending', icon: '⏳', color: '#6b7280' },
  processing: { label: 'Processing', icon: '⚙️', color: '#3b82f6' },
  extracting: { label: 'Extracting', icon: '📄', color: '#3b82f6' },
  analyzing: { label: 'Analyzing', icon: '🔍', color: '#8b5cf6' },
  generating: { label: 'Generating', icon: '⚙️', color: '#f59e0b' },
  completed: { label: 'Ready for Review', icon: '✅', color: '#10b981' },
  committed: { label: 'Committed', icon: '💾', color: '#059669' },
  failed: { label: 'Failed', icon: '❌', color: '#ef4444' },
  cancelled: { label: 'Cancelled', icon: '🚫', color: '#6b7280' },
  approved: { label: 'Approved', icon: '👍', color: '#10b981' },
  rejected: { label: 'Rejected', icon: '👎', color: '#ef4444' }
};

// Job type definitions with their specific actions
const JOB_TYPES = {
  upload: {
    label: 'Upload',
    icon: '📤',
    completedActions: ['review', 'delete'],
    description: 'Document upload - awaiting ontology mapping'
  },
  commit: {
    label: 'Commit',
    icon: '💾',
    completedActions: ['delete'],
    description: 'Writing triples to GraphDB'
  },
  extraction: {
    label: 'Extraction',
    icon: '🔍',
    completedActions: ['review', 'reject', 'createGraph'],
    description: 'Entity extraction from document'
  },
  schema_analysis: {
    label: 'Schema Analysis',
    icon: '📊',
    completedActions: ['saveSchema'],
    description: 'Analyze document for ontology schema'
  }
};

function OntologyJobs() {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const { canUpload, canDelete, canManageOntology } = usePermissions();
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [resultsTab, setResultsTab] = useState('entities'); // 'entities' or 'relationships'
  
  // Staged document review
  const [showStagedReview, setShowStagedReview] = useState(false);
  const [selectedStagedDocId, setSelectedStagedDocId] = useState(null);
  
  // Extraction review modal
  const [showExtractionReview, setShowExtractionReview] = useState(false);
  const [extractionReviewJobId, setExtractionReviewJobId] = useState(null);
  
  // Edit mode state for extraction review
  const [editMode, setEditMode] = useState(false);
  const [editedEntities, setEditedEntities] = useState([]);
  const [editedRelationships, setEditedRelationships] = useState([]);

  const loadJobs = useCallback(async () => {
    // Don't load jobs if no workspace is selected
    if (!currentWorkspace?.workspace_id) {
      setJobs([]);
      setLoading(false);
      return;
    }
    
    try {
      const params = new URLSearchParams();
      params.append('workspace_id', currentWorkspace.workspace_id);
      if (filter !== 'all') {
        params.append('status', filter);
      }

      const response = await fetch(`${API_BASE_URL}/ontology/jobs?${params}`, {
        headers: getTenantHeaders()
      });
      const data = await response.json();
      
      if (data.success) {
        setJobs(data.jobs || []);
      }
    } catch (error) {
      console.error('Error loading jobs:', error);
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace?.workspace_id, filter, getTenantHeaders]);


  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Auto-refresh for active jobs
  useEffect(() => {
    if (!autoRefresh) return;
    
    const hasActiveJobs = jobs.some(j => 
      ['pending', 'processing', 'extracting', 'analyzing', 'generating'].includes(j.status)
    );
    
    if (hasActiveJobs) {
      const interval = setInterval(loadJobs, 3000);
      return () => clearInterval(interval);
    }
  }, [jobs, autoRefresh, loadJobs]);

  // Initialize edit mode with job data
  const startEditMode = (job) => {
    // Get entities from various possible locations in the job data
    const rawEntities = job.suggested_ontology?.entities || 
                        job.extracted_entities || 
                        [];
    
    const entities = rawEntities.map((e, i) => ({
      ...e,
      id: e.id || `entity_${i}`,
      name: e.name || e.label || 'Unknown',
      type: e.type || 'Entity',
      properties: e.properties || {},
      confidence: e.confidence || 0,
      sourceSpan: e.sourceSpan || '',
      include: true,
      originalName: e.name || e.label
    }));
    
    // Get relationships from various possible locations
    const rawRelationships = job.suggested_ontology?.relationships ||
                             job.extracted_relationships ||
                             [];
    
    const relationships = rawRelationships.map((r, i) => ({
      ...r,
      id: r.id || `rel_${i}`,
      source: r.sourceLabel || r.source || r.from_entity || '',
      target: r.targetLabel || r.target || r.to_entity || '',
      type: r.predicate || r.type || r.relationship || 'RELATED_TO',
      properties: r.properties || {},
      confidence: r.confidence || 0,
      sourceSpan: r.sourceSpan || '',
      include: true
    }));
    
    console.log(`📝 Starting edit mode with ${entities.length} entities and ${relationships.length} relationships`);
    
    setEditedEntities(entities);
    setEditedRelationships(relationships);
    setEditMode(true);
  };

  const cancelEditMode = () => {
    setEditMode(false);
    setEditedEntities([]);
    setEditedRelationships([]);
  };

  const toggleEntity = (index) => {
    setEditedEntities(prev => prev.map((e, i) => 
      i === index ? { ...e, include: !e.include } : e
    ));
  };

  const updateEntityName = (index, newName) => {
    setEditedEntities(prev => prev.map((e, i) => 
      i === index ? { ...e, name: newName } : e
    ));
  };

  const updateEntityType = (index, newType) => {
    if (newType === '__custom__') {
      const custom = prompt('Enter custom entity type:');
      if (!custom) return;
      newType = custom;
    }
    setEditedEntities(prev => prev.map((e, i) => 
      i === index ? { ...e, type: newType } : e
    ));
  };

  const toggleRelationship = (index) => {
    setEditedRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, include: !r.include } : r
    ));
  };

  // Update relationship source
  const updateRelationshipSource = (index, newSource) => {
    setEditedRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, source: newSource, sourceLabel: newSource } : r
    ));
  };

  // Update relationship target
  const updateRelationshipTarget = (index, newTarget) => {
    setEditedRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, target: newTarget, targetLabel: newTarget } : r
    ));
  };

  // Update relationship type/predicate
  const updateRelationshipType = (index, newType) => {
    setEditedRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, type: newType, predicate: newType } : r
    ));
  };

  // Update entity property
  const updateEntityProperty = (entityIndex, propKey, newValue) => {
    setEditedEntities(prev => prev.map((e, i) => {
      if (i !== entityIndex) return e;
      return {
        ...e,
        properties: {
          ...e.properties,
          [propKey]: newValue
        }
      };
    }));
  };

  // Add new entity
  const addNewEntity = () => {
    const newEntity = {
      id: `entity_new_${Date.now()}`,
      name: 'New Entity',
      label: 'New Entity',
      type: getEntityTypes()[0] || 'Entity',
      properties: {},
      confidence: 1.0,
      sourceSpan: '',
      include: true,
      isNew: true
    };
    setEditedEntities(prev => [...prev, newEntity]);
  };

  // Remove entity
  const removeEntity = (index) => {
    setEditedEntities(prev => prev.filter((_, i) => i !== index));
  };

  // Add new relationship
  const addNewRelationship = () => {
    const entityLabels = editedEntities.filter(e => e.include).map(e => e.name || e.label);
    const newRel = {
      id: `rel_new_${Date.now()}`,
      source: entityLabels[0] || '',
      sourceLabel: entityLabels[0] || '',
      target: entityLabels[1] || entityLabels[0] || '',
      targetLabel: entityLabels[1] || entityLabels[0] || '',
      type: 'RELATED_TO',
      predicate: 'RELATED_TO',
      properties: {},
      confidence: 1.0,
      sourceSpan: '',
      include: true,
      isNew: true
    };
    setEditedRelationships(prev => [...prev, newRel]);
  };

  // Remove relationship
  const removeRelationship = (index) => {
    setEditedRelationships(prev => prev.filter((_, i) => i !== index));
  };

  // Get entity labels for relationship dropdowns
  const getEntityLabels = () => {
    return editedEntities.filter(e => e.include).map(e => e.name || e.label);
  };

  const cancelJob = async (jobId) => {
    try {
      await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: getTenantHeaders()
      });
      loadJobs();
    } catch (error) {
      console.error('Error cancelling job:', error);
    }
  };

  // Approve with modifications and create graph
  const approveAndCreateGraph = async (jobId) => {
    try {
      // Filter to only included items
      const includedEntities = editedEntities.filter(e => e.include);
      const includedRelationships = editedRelationships.filter(r => r.include);
      
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}/approve-and-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          entities: includedEntities,
          relationships: includedRelationships
        })
      });
      
      const data = await response.json();
      if (data.success) {
        alert(`✅ Graph created successfully!\n\nNodes: ${data.nodesCreated || 0}\nRelationships: ${data.relationshipsCreated || 0}`);
        setEditMode(false);
        setSelectedJob(null);
        loadJobs();
      } else {
        alert(`❌ Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error approving job:', error);
      alert(`❌ Error: ${error.message}`);
    }
  };

  const rejectJob = async (jobId, reason) => {
    try {
      await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ reason })
      });
      loadJobs();
      setSelectedJob(null);
      setEditMode(false);
    } catch (error) {
      console.error('Error rejecting job:', error);
    }
  };

  // Re-extract entities from a job (when results are unsatisfactory)
  const reExtractJob = async (jobId) => {
    if (!window.confirm('Re-run extraction? This will discard current results and extract again.')) return;
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}/re-extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          extractionMode: 'auto' // Could add UI to select mode
        })
      });
      
      const data = await response.json();
      if (data.success) {
        setSelectedJob(null);
        setEditMode(false);
        loadJobs();
      } else {
        alert(`❌ Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error re-extracting job:', error);
      alert(`❌ Error: ${error.message}`);
    }
  };

  const deleteJob = async (jobId, skipConfirm = false) => {
    if (!skipConfirm && !window.confirm('Delete this job?')) return;
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      const data = await response.json();
      
      if (!response.ok || !data.success) {
        console.error('Failed to delete job:', data.error);
        alert(`Failed to delete job: ${data.error || 'Unknown error'}`);
        return;
      }
      
      loadJobs();
      if (selectedJob?.job_id === jobId) {
        setSelectedJob(null);
        setEditMode(false);
      }
    } catch (error) {
      console.error('Error deleting job:', error);
      alert(`Error deleting job: ${error.message}`);
    }
  };

  const createGraph = async (jobId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}/create-graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() }
      });
      const data = await response.json();
      if (data.success) {
        alert('Graph created successfully!');
        loadJobs();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error creating graph:', error);
    }
  };

  // Save schema analysis as ontology
  const saveAsOntology = async (job) => {
    const name = prompt('Enter ontology name:', job.suggested_ontology?.documentNames?.join(', ') + ' Schema' || 'New Schema');
    if (!name) return;
    
    try {
      const schema = job.suggested_ontology || {};
      const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          name,
          description: `Auto-generated from document analysis. Industry: ${schema.industry || 'general'}`,
          workspace_id: currentWorkspace?.workspace_id || '',
          entityTypes: (schema.entityTypes || []).filter(e => e.include !== false).map(e => ({
            label: e.userLabel || e.label,
            userLabel: e.userLabel || e.label,
            description: e.description || '',
            properties: (e.suggestedProperties || e.properties || []).map(p => 
              typeof p === 'string' ? { name: p, data_type: 'string' } : p
            )
          })),
          relationships: (schema.relationships || []).filter(r => r.include !== false).map(r => ({
            type: r.userPredicate || r.predicate,
            predicate: r.userPredicate || r.predicate,
            from: r.from,
            to: r.to,
            description: r.description || ''
          }))
        })
      });
      
      const result = await response.json();
      if (response.ok) {
        alert(`✅ Ontology "${name}" created successfully!`);
        await deleteJob(job.job_id, true);
      } else {
        alert(`❌ ${result.error || 'Failed to save ontology'}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString();
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Get unique entity types from edited entities
  const getEntityTypes = () => {
    const types = new Set(editedEntities.map(e => e.type).filter(Boolean));
    return Array.from(types);
  };


  if (loading) {
    return <div className="ontology-jobs loading">Loading jobs...</div>;
  }

  return (
    <div className="ontology-jobs">
      <div className="oj-header">
        <h3>📋 Processing Jobs</h3>
        <div className="oj-controls">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All Jobs</option>
            <option value="pending">⏳ Pending / Processing</option>
            <option value="completed">✅ Ready for Review</option>
            <option value="committed">💾 Committed</option>
            <option value="approved">👍 Approved</option>
            <option value="rejected">👎 Rejected</option>
            <option value="failed">❌ Failed</option>
            <option value="cancelled">🚫 Cancelled</option>
          </select>
          <label className="oj-auto-refresh">
            <input 
              type="checkbox" 
              checked={autoRefresh} 
              onChange={(e) => setAutoRefresh(e.target.checked)} 
            />
            Auto-refresh
          </label>
          <button onClick={loadJobs} className="btn-refresh">🔄</button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="oj-empty">
          <p>No ontology jobs found</p>
          <p className="hint">Upload files to start generating ontologies</p>
        </div>
      ) : (
        <div className="oj-list">
          {jobs.map(job => {
            const statusInfo = STATUS_LABELS[job.status] || STATUS_LABELS.pending;
            const isActive = ['pending', 'processing', 'extracting', 'analyzing', 'generating'].includes(job.status);
            
            return (
              <div 
                key={job.job_id} 
                className={`oj-item ${selectedJob?.job_id === job.job_id ? 'selected' : ''} ${job.status} ${job.job_type === 'schema_analysis' ? 'schema-analysis' : ''}`}
                onClick={() => {
                  // Completed jobs: open the appropriate review modal directly
                  if (job.status === 'completed' && job.job_type === 'extraction') {
                    setExtractionReviewJobId(job.job_id);
                    setShowExtractionReview(true);
                    return;
                  }
                  if (job.status === 'completed' && job.staged && job.staged_doc_id) {
                    setSelectedStagedDocId(job.staged_doc_id);
                    setShowStagedReview(true);
                    return;
                  }
                  // Otherwise show detail panel
                  setSelectedJob(job);
                }}
              >
                <div className="oj-item-main">
                  <div className="oj-item-icon">{statusInfo.icon}</div>
                  <div className="oj-item-info">
                    <div className="oj-item-name">
                      {job.file_name}
                      {job.job_type && JOB_TYPES[job.job_type] && (
                        <span className={`job-type-badge ${job.job_type}`}>
                          {JOB_TYPES[job.job_type].icon} {JOB_TYPES[job.job_type].label}
                        </span>
                      )}
                    </div>
                    <div className="oj-item-meta">
                      <span className="status" style={{ color: statusInfo.color }}>
                        {statusInfo.label}
                      </span>
                      <span className="size">{formatFileSize(job.file_size)}</span>
                      <span className="date">{formatDate(job.created_at)}</span>
                    </div>
                  </div>
                </div>
                
                {isActive && (
                  <div className="oj-progress">
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                    <span className="progress-text">{job.progress}%</span>
                  </div>
                )}
                
                {/* Processing Steps - show for active jobs */}
                {isActive && job.processing_steps && Array.isArray(job.processing_steps) && (
                  <div className="oj-processing-steps">
                    {job.processing_steps.map((step, idx) => (
                      <div 
                        key={step.step} 
                        className={`processing-step ${step.status}`}
                        title={step.duration || step.error || ''}
                      >
                        <span className="step-indicator">
                          {step.status === 'completed' ? '✓' : 
                           step.status === 'active' ? '⟳' : 
                           step.status === 'failed' ? '✗' : '○'}
                        </span>
                        <span className="step-label">{step.label}</span>
                        {step.status === 'completed' && step.duration && (
                          <span className="step-detail">{step.duration}</span>
                        )}
                        {step.status === 'completed' && step.entities !== undefined && (
                          <span className="step-detail">{step.entities}e</span>
                        )}
                        {step.status === 'completed' && step.chunks !== undefined && (
                          <span className="step-detail">{step.chunks}ch</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                
                <div className="oj-item-message">{job.progress_message}</div>
                
                <div className="oj-item-actions" onClick={(e) => e.stopPropagation()}>
                  {isActive && canUpload && (
                    <button onClick={() => cancelJob(job.job_id)} title="Cancel">🚫</button>
                  )}
                  {/* Schema Analysis: Save as Ontology */}
                  {job.status === 'completed' && job.job_type === 'schema_analysis' && job.suggested_ontology?.entityTypes && canManageOntology && (
                    <button onClick={() => saveAsOntology(job)} className="approve" title="Save as Ontology">💾 Save Schema</button>
                  )}
                  {/* Upload jobs with staged data: Review & Map to Ontology */}
                  {job.status === 'completed' && job.staged && job.staged_doc_id && (
                    <button 
                      onClick={() => { 
                        setSelectedStagedDocId(job.staged_doc_id); 
                        setShowStagedReview(true); 
                      }} 
                      className="approve" 
                      title="Review & Map to Ontology"
                    >
                      📋 Review & Commit
                    </button>
                  )}
                  {/* Extraction: Review & Edit, Re-extract, Reject */}
                  {job.status === 'completed' && job.job_type === 'extraction' && (
                    <>
                      <button onClick={() => { setExtractionReviewJobId(job.job_id); setShowExtractionReview(true); }} className="approve" title="Review in Modal">📝 Review</button>
                      {canUpload && <button onClick={() => reExtractJob(job.job_id)} className="redo" title="Re-extract (run again)">🔄 Redo</button>}
                      {canUpload && <button onClick={() => rejectJob(job.job_id, 'Rejected')} className="reject" title="Reject">👎</button>}
                    </>
                  )}
                  {/* Extraction Approved: Create Graph */}
                  {job.status === 'approved' && job.job_type === 'extraction' && canUpload && (
                    <button onClick={() => createGraph(job.job_id)} className="create" title="Create Graph">📊 Create Graph</button>
                  )}
                  {/* Failed/Rejected extraction jobs: Re-extract option */}
                  {['failed', 'rejected'].includes(job.status) && job.job_type === 'extraction' && canUpload && (
                    <button onClick={() => reExtractJob(job.job_id)} className="redo" title="Try extraction again">🔄 Retry</button>
                  )}
                  {/* Delete button - member+ */}
                  {canDelete && <button onClick={() => deleteJob(job.job_id)} className="delete" title="Delete">🗑️</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}


      {/* Job Details Panel */}
      {selectedJob && (
        <>
          <div className="oj-details-backdrop" onClick={() => { setSelectedJob(null); setEditMode(false); }} />
          <div className="oj-details">
          <div className="oj-details-header">
            <h4>{selectedJob.file_name}</h4>
            <button onClick={() => { setSelectedJob(null); setEditMode(false); }}>×</button>
          </div>
          
          <div className="oj-details-content">
            <div className="detail-section">
              <h5>Status</h5>
              <p style={{ color: STATUS_LABELS[selectedJob.status]?.color }}>
                {STATUS_LABELS[selectedJob.status]?.icon} {STATUS_LABELS[selectedJob.status]?.label}
              </p>
              <p className="message">{selectedJob.progress_message}</p>
            </div>

            {/* Processing Steps Timeline */}
            {selectedJob.processing_steps && Array.isArray(selectedJob.processing_steps) && selectedJob.processing_steps.length > 0 && (
              <div className="detail-section">
                <h5>Processing Steps</h5>
                <div className="processing-timeline">
                  {selectedJob.processing_steps.map((step, idx) => (
                    <div key={step.step} className={`timeline-step ${step.status}`}>
                      <div className="timeline-indicator">
                        {step.status === 'completed' ? '✓' : 
                         step.status === 'active' ? '⟳' : 
                         step.status === 'failed' ? '✗' : '○'}
                      </div>
                      <div className="timeline-content">
                        <div className="timeline-label">{step.label}</div>
                        <div className="timeline-details">
                          {step.duration && <span>{step.duration}</span>}
                          {step.chars && <span>{(step.chars / 1000).toFixed(1)}K chars</span>}
                          {step.chunks && <span>{step.chunks} chunks</span>}
                          {step.entities !== undefined && <span>{step.entities} entities</span>}
                          {step.relationships !== undefined && <span>{step.relationships} rels</span>}
                          {step.model && <span>Model: {step.model}</span>}
                          {step.error && <span className="error">{step.error}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Job Info - type-specific */}
            <div className="detail-section">
              <h5>Job Info</h5>
              <div className="job-info-grid">
                <div className="job-info-item">
                  <span className="job-info-label">Type</span>
                  <span className="job-info-value">
                    {JOB_TYPES[selectedJob.job_type]?.icon} {JOB_TYPES[selectedJob.job_type]?.label || selectedJob.job_type}
                  </span>
                </div>
                <div className="job-info-item">
                  <span className="job-info-label">Created</span>
                  <span className="job-info-value">{formatDate(selectedJob.created_at)}</span>
                </div>
                {selectedJob.file_size > 0 && (
                  <div className="job-info-item">
                    <span className="job-info-label">File Size</span>
                    <span className="job-info-value">{formatFileSize(selectedJob.file_size)}</span>
                  </div>
                )}
                {selectedJob.committed_at && (
                  <div className="job-info-item">
                    <span className="job-info-label">Committed</span>
                    <span className="job-info-value">{formatDate(selectedJob.committed_at)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Commit Job OR Upload job that was committed: Show triple/entity counts */}
            {selectedJob.status === 'committed' && (
              <div className="detail-section commit-summary">
                <h5>💾 Commit Results</h5>
                <div className="stats">
                  <div className="stat">
                    <span className="value">{selectedJob.entity_count || 0}</span>
                    <span className="label">Entities Written</span>
                  </div>
                  {(selectedJob.triple_count > 0) && (
                    <div className="stat">
                      <span className="value">{selectedJob.triple_count}</span>
                      <span className="label">Triples</span>
                    </div>
                  )}
                  {(selectedJob.assertion_count > 0) && (
                    <div className="stat">
                      <span className="value">{selectedJob.assertion_count}</span>
                      <span className="label">Assertions</span>
                    </div>
                  )}
                  {(selectedJob.evidence_count > 0) && (
                    <div className="stat">
                      <span className="value">{selectedJob.evidence_count}</span>
                      <span className="label">Evidence Links</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Upload Job: Show staged data info (only when still staged, not after commit) */}
            {selectedJob.job_type === 'upload' && selectedJob.status === 'completed' && selectedJob.staged && (
              <div className="detail-section staged-summary">
                <h5>📄 Staged Document</h5>
                <p className="message">
                  {selectedJob.entity_count || 0} items staged for ontology mapping
                </p>
                {selectedJob.staged_expires_at && (
                  <p className="staged-expiry">
                    ⏰ Expires: {formatDate(selectedJob.staged_expires_at)}
                  </p>
                )}
              </div>
            )}

            {/* Extraction Job: Show entity/relationship counts */}
            {selectedJob.job_type === 'extraction' && selectedJob.entity_count > 0 && (
              <div className="detail-section">
                <h5>🔍 Extraction Results</h5>
                <div className="stats">
                  <div className="stat">
                    <span className="value">{selectedJob.entity_count}</span>
                    <span className="label">Entities</span>
                  </div>
                  <div className="stat">
                    <span className="value">{selectedJob.relationship_count || 0}</span>
                    <span className="label">Relationships</span>
                  </div>
                </div>
              </div>
            )}

            {/* Edit Mode UI for Extraction Jobs */}
            {editMode && selectedJob.status === 'completed' && selectedJob.job_type === 'extraction' && (
              <>
                {/* Review Summary */}
                <div className="detail-section review-summary">
                  <h5>📋 Extraction Review</h5>
                  <div className="review-stats">
                    <div className="review-stat">
                      <span className="review-stat-value">{editedEntities.length}</span>
                      <span className="review-stat-label">Entities Found</span>
                    </div>
                    <div className="review-stat">
                      <span className="review-stat-value">{editedRelationships.length}</span>
                      <span className="review-stat-label">Relationships Found</span>
                    </div>
                    <div className="review-stat selected">
                      <span className="review-stat-value">{editedEntities.filter(e => e.include).length}</span>
                      <span className="review-stat-label">Entities Selected</span>
                    </div>
                    <div className="review-stat selected">
                      <span className="review-stat-value">{editedRelationships.filter(r => r.include).length}</span>
                      <span className="review-stat-label">Relations Selected</span>
                    </div>
                  </div>
                  {editedRelationships.length === 0 && (
                    <div className="review-warning">
                      ⚠️ No relationships were extracted. You can add them manually below, or the LLM may not have found clear relationships in the document.
                    </div>
                  )}
                </div>

                {/* Entities Section */}
                <div className="detail-section edit-section">
                  <div className="edit-header">
                    <h5>📦 Entities ({editedEntities.filter(e => e.include).length}/{editedEntities.length})</h5>
                    <div className="edit-header-actions">
                      <button className="btn-add" onClick={addNewEntity} title="Add new entity">
                        + Add Entity
                      </button>
                      <button className="btn-select-all" onClick={() => {
                        const allSelected = editedEntities.every(e => e.include);
                        setEditedEntities(prev => prev.map(e => ({ ...e, include: !allSelected })));
                      }}>
                        {editedEntities.every(e => e.include) ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                  </div>
                  {editedEntities.length === 0 ? (
                    <div className="edit-empty">
                      <p>No entities extracted. Click "+ Add Entity" to add manually.</p>
                    </div>
                  ) : (
                  <div className="edit-entity-list">
                    {editedEntities.map((entity, i) => (
                      <div key={entity.id || i} className={`edit-entity-item ${entity.include ? 'included' : 'excluded'} ${entity.isNew ? 'is-new' : ''}`}>
                        <div className="edit-entity-main">
                          <input 
                            type="checkbox" 
                            checked={entity.include} 
                            onChange={() => toggleEntity(i)}
                          />
                          <input 
                            type="text" 
                            className="entity-name-input"
                            value={entity.name || entity.label || ''} 
                            onChange={(e) => updateEntityName(i, e.target.value)}
                            placeholder="Entity name"
                            disabled={!entity.include}
                          />
                          <select 
                            className="entity-type-select"
                            value={entity.type || ''} 
                            onChange={(e) => updateEntityType(i, e.target.value)}
                            disabled={!entity.include}
                          >
                            {getEntityTypes().map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            <option value="__custom__">+ Custom Type</option>
                          </select>
                          {entity.confidence && <span className="entity-confidence">{Math.round(entity.confidence * 100)}%</span>}
                          <button 
                            className="btn-remove-entity" 
                            onClick={() => removeEntity(i)}
                            title="Remove entity"
                          >
                            ×
                          </button>
                        </div>
                        {entity.properties && Object.keys(entity.properties).length > 0 && (
                          <div className="edit-entity-props">
                            {Object.entries(entity.properties).map(([key, value]) => (
                              <div key={key} className="entity-prop editable">
                                <span className="prop-key">{key}:</span>
                                <input 
                                  type="text"
                                  className="prop-value-input"
                                  value={String(value || '')}
                                  onChange={(e) => updateEntityProperty(i, key, e.target.value)}
                                  disabled={!entity.include}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                        {entity.sourceSpan && (
                          <div className="edit-entity-source">
                            <span className="source-label">Source:</span>
                            <span className="source-text">{entity.sourceSpan.substring(0, 80)}{entity.sourceSpan.length > 80 ? '...' : ''}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  )}
                </div>

                {/* Relationships Section */}
                <div className="detail-section edit-section">
                  <div className="edit-header">
                    <h5>🔗 Relationships ({editedRelationships.filter(r => r.include).length}/{editedRelationships.length})</h5>
                    <div className="edit-header-actions">
                      <button className="btn-add" onClick={addNewRelationship} title="Add new relationship">
                        + Add Relationship
                      </button>
                      {editedRelationships.length > 0 && (
                        <button className="btn-select-all" onClick={() => {
                          const allSelected = editedRelationships.every(r => r.include);
                          setEditedRelationships(prev => prev.map(r => ({ ...r, include: !allSelected })));
                        }}>
                          {editedRelationships.every(r => r.include) ? 'Deselect All' : 'Select All'}
                        </button>
                      )}
                    </div>
                  </div>
                  {editedRelationships.length === 0 ? (
                    <div className="edit-empty">
                      <p>No relationships extracted.</p>
                      <p className="edit-empty-hint">Click "+ Add Relationship" to connect entities manually.</p>
                    </div>
                  ) : (
                  <div className="edit-rel-list">
                    {editedRelationships.map((rel, i) => (
                      <div key={rel.id || i} className={`edit-rel-item ${rel.include ? 'included' : 'excluded'} ${rel.isNew ? 'is-new' : ''}`}>
                        <input 
                          type="checkbox" 
                          checked={rel.include} 
                          onChange={() => toggleRelationship(i)}
                        />
                        <div className="rel-edit-fields">
                          <select
                            className="rel-source-select"
                            value={rel.source || rel.sourceLabel || ''}
                            onChange={(e) => updateRelationshipSource(i, e.target.value)}
                            disabled={!rel.include}
                          >
                            <option value="">-- Source --</option>
                            {getEntityLabels().map(label => (
                              <option key={label} value={label}>{label}</option>
                            ))}
                          </select>
                          <span className="rel-arrow">→</span>
                          <input
                            type="text"
                            className="rel-type-input"
                            value={rel.type || rel.predicate || ''}
                            onChange={(e) => updateRelationshipType(i, e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                            placeholder="RELATIONSHIP_TYPE"
                            disabled={!rel.include}
                          />
                          <span className="rel-arrow">→</span>
                          <select
                            className="rel-target-select"
                            value={rel.target || rel.targetLabel || ''}
                            onChange={(e) => updateRelationshipTarget(i, e.target.value)}
                            disabled={!rel.include}
                          >
                            <option value="">-- Target --</option>
                            {getEntityLabels().map(label => (
                              <option key={label} value={label}>{label}</option>
                            ))}
                          </select>
                          {rel.confidence && <span className="rel-confidence">{Math.round(rel.confidence * 100)}%</span>}
                          <button 
                            className="btn-remove-rel" 
                            onClick={() => removeRelationship(i)}
                            title="Remove relationship"
                          >
                            ×
                          </button>
                        </div>
                        {rel.sourceSpan && (
                          <div className="edit-rel-source">
                            <span className="source-label">Source:</span>
                            <span className="source-text">{rel.sourceSpan.substring(0, 80)}{rel.sourceSpan.length > 80 ? '...' : ''}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  )}
                </div>
              </>
            )}

            {/* Read-only view when not in edit mode - Extraction Results with Tabs */}
            {!editMode && selectedJob.job_type === 'extraction' && selectedJob.status === 'completed' && (
              <div className="detail-section extraction-results">
                {/* Tabs */}
                <div className="results-tabs">
                  <button 
                    className={`results-tab ${resultsTab === 'entities' ? 'active' : ''}`}
                    onClick={() => setResultsTab('entities')}
                  >
                    📦 Entities ({selectedJob.suggested_ontology?.entities?.length || 0})
                  </button>
                  <button 
                    className={`results-tab ${resultsTab === 'relationships' ? 'active' : ''}`}
                    onClick={() => setResultsTab('relationships')}
                  >
                    🔗 Relationships ({selectedJob.suggested_ontology?.relationships?.length || 0})
                  </button>
                </div>

                {/* Entities Tab */}
                {resultsTab === 'entities' && (
                  <div className="results-content">
                    {selectedJob.suggested_ontology?.entities?.length > 0 ? (
                      <div className="entity-preview-list">
                        {selectedJob.suggested_ontology.entities.map((e, i) => (
                          <div key={i} className="entity-preview-item entity-with-props">
                            <div className="entity-header">
                              <span className="entity-name">{e.label || e.name}</span>
                              <span className="entity-type">{e.type}</span>
                              {e.confidence && <span className="entity-confidence">{Math.round(e.confidence * 100)}%</span>}
                            </div>
                            {e.properties && Object.keys(e.properties).filter(k => e.properties[k] != null).length > 0 && (
                              <div className="entity-properties">
                                {Object.entries(e.properties).filter(([_, v]) => v != null).map(([key, value]) => (
                                  <div key={key} className="entity-prop">
                                    <span className="prop-key">{key}:</span>
                                    <span className="prop-value">{String(value)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {e.sourceSpan && (
                              <div className="entity-source">
                                <span className="source-label">📍</span>
                                <span className="source-text">"{e.sourceSpan.substring(0, 100)}{e.sourceSpan.length > 100 ? '...' : ''}"</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="results-empty">No entities extracted</div>
                    )}
                  </div>
                )}

                {/* Relationships Tab */}
                {resultsTab === 'relationships' && (
                  <div className="results-content">
                    {selectedJob.suggested_ontology?.relationships?.length > 0 ? (
                      <div className="rel-preview-list">
                        {selectedJob.suggested_ontology.relationships.map((r, i) => (
                          <div key={i} className="rel-preview-item rel-with-props">
                            <div className="rel-header">
                              <span className="rel-source">{r.sourceLabel || r.source || '?'}</span>
                              <span className="rel-arrow">→</span>
                              <span className="rel-predicate">{r.predicate || r.type || 'RELATED_TO'}</span>
                              <span className="rel-arrow">→</span>
                              <span className="rel-target">{r.targetLabel || r.target || '?'}</span>
                              {r.confidence && <span className="rel-confidence">{Math.round(r.confidence * 100)}%</span>}
                            </div>
                            {r.properties && Object.keys(r.properties).filter(k => r.properties[k] != null).length > 0 && (
                              <div className="rel-properties">
                                {Object.entries(r.properties).filter(([_, v]) => v != null).map(([key, value]) => (
                                  <div key={key} className="rel-prop">
                                    <span className="prop-key">{key}:</span>
                                    <span className="prop-value">{String(value)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {r.sourceSpan && (
                              <div className="rel-source-span">
                                <span className="source-label">📍</span>
                                <span className="source-text">"{r.sourceSpan.substring(0, 100)}{r.sourceSpan.length > 100 ? '...' : ''}"</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="results-empty">
                        <p>⚠️ No relationships extracted</p>
                        <p className="results-empty-hint">The LLM didn't find clear relationships in the document, or the ontology relationships weren't passed correctly.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Entity Types Summary (collapsible) */}
            {!editMode && selectedJob.suggested_ontology?.entity_types?.length > 0 && (
              <details className="detail-section extraction-summary">
                <summary><h5>📊 Entity Type Summary ({selectedJob.suggested_ontology.entity_types.length} types)</h5></summary>
                <div className="type-list">
                  {selectedJob.suggested_ontology.entity_types.map((t, i) => (
                    <div key={i} className="type-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="type-name">{t.type}</span>
                        <span className="type-count">{t.count} found</span>
                      </div>
                      {t.examples?.length > 0 && (
                        <div className="type-examples">
                          {t.examples.slice(0, 5).map((ex, j) => (
                            <span key={j} className="example-tag">{ex}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {!editMode && selectedJob.suggested_ontology?.relationship_types?.length > 0 && (
              <details className="detail-section extraction-summary">
                <summary><h5>🔗 Relationship Type Summary ({selectedJob.suggested_ontology.relationship_types.length} types)</h5></summary>
                <div className="type-list">
                  {selectedJob.suggested_ontology.relationship_types.map((t, i) => (
                    <div key={i} className="type-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="type-name">{t.type}</span>
                        <span className="type-count">{t.count} found</span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Schema Analysis Results - entityTypes from analyze-for-schema */}
            {/* Only show for schema_analysis jobs */}
            {selectedJob.job_type === 'schema_analysis' && selectedJob.suggested_ontology?.entityTypes && (
              <div className="detail-section schema-analysis-detail">
                <h5>🏷️ Candidate Classes ({selectedJob.suggested_ontology.entityTypes.length})</h5>
                {selectedJob.suggested_ontology.summary?.documentSummary && (
                  <p className="schema-summary">{selectedJob.suggested_ontology.summary.documentSummary}</p>
                )}
                <div className="schema-entity-list">
                  {selectedJob.suggested_ontology.entityTypes.map((t, i) => (
                    <div key={i} className="schema-entity-item">
                      <div className="entity-item-header">
                        <span className="entity-label">
                          {t.userLabel || t.label}
                          {t.type && t.type !== 'general' && (
                            <span className={`entity-type-badge ${t.type}`}>{t.type}</span>
                          )}
                        </span>
                        {t.confidence && (
                          <span className="entity-confidence">{Math.round(t.confidence * 100)}%</span>
                        )}
                      </div>
                      {t.description && <p className="entity-desc">{t.description}</p>}
                      {t.evidence && (
                        <div className="entity-evidence">"{t.evidence}"</div>
                      )}
                      {t.examples?.length > 0 && !t.evidence && (
                        <div className="entity-examples">
                          {t.examples.slice(0, 3).map((ex, j) => (
                            <span key={j} className="example-tag">{ex}</span>
                          ))}
                        </div>
                      )}
                      {t.suggestedProperties?.length > 0 && (
                        <div className="entity-props">
                          <span className="props-label">Props:</span>
                          {t.suggestedProperties.slice(0, 4).map((p, j) => (
                            <span key={j} className="prop-tag">
                              {typeof p === 'string' ? p : p.name || p.label || 'unknown'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}


            {/* Schema Analysis Results - relationships from analyze-for-schema */}
            {/* Only show for schema_analysis jobs, not extraction jobs */}
            {selectedJob.job_type === 'schema_analysis' && selectedJob.suggested_ontology?.relationships?.length > 0 && (
              <div className="detail-section schema-analysis-detail">
                <h5>🔗 Suggested Relationships ({selectedJob.suggested_ontology.relationships.length})</h5>
                <div className="schema-rel-list">
                  {selectedJob.suggested_ontology.relationships.map((r, i) => (
                    <div key={i} className="schema-rel-item">
                      <div className="rel-flow">
                        <span className="rel-from">{r.from || r.sourceLabel || '?'}</span>
                        <span className="rel-arrow">→</span>
                        <span className="rel-predicate">{r.userPredicate || r.predicate || r.type}</span>
                        <span className="rel-arrow">→</span>
                        <span className="rel-to">{r.to || r.targetLabel || '?'}</span>
                      </div>
                      {(r.description || r.evidence) && <p className="rel-desc">{r.description || r.evidence}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ontology Analysis - Attribute Candidates (concepts that should be properties, not classes) */}
            {selectedJob.suggested_ontology?.attributeCandidates?.length > 0 && (
              <div className="detail-section schema-analysis-detail">
                <h5>📋 Attribute Candidates ({selectedJob.suggested_ontology.attributeCandidates.length})</h5>
                <p className="section-hint">These concepts should be modeled as properties, not classes</p>
                <div className="attribute-list">
                  {selectedJob.suggested_ontology.attributeCandidates.map((attr, i) => (
                    <span key={i} className="attribute-tag">{attr}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Ontology Analysis - Ontology Gaps (concepts not covered by existing ontology) */}
            {selectedJob.suggested_ontology?.ontologyGaps?.length > 0 && (
              <div className="detail-section schema-analysis-detail">
                <h5>⚠️ Ontology Gaps ({selectedJob.suggested_ontology.ontologyGaps.length})</h5>
                <p className="section-hint">Concepts not covered by the existing ontology</p>
                <div className="gap-list">
                  {selectedJob.suggested_ontology.ontologyGaps.map((gap, i) => (
                    <div key={i} className="gap-item">{gap}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Ontology Analysis - Uncertainties (areas needing clarification) */}
            {selectedJob.suggested_ontology?.uncertainties?.length > 0 && (
              <div className="detail-section schema-analysis-detail">
                <h5>❓ Uncertainties ({selectedJob.suggested_ontology.uncertainties.length})</h5>
                <p className="section-hint">Areas of ambiguity that may need clarification</p>
                <div className="uncertainty-list">
                  {selectedJob.suggested_ontology.uncertainties.map((unc, i) => (
                    <div key={i} className="uncertainty-item">{unc}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Ontology Suggestions - NEW */}
            {selectedJob.ontology_suggestions && (
              <>
                {selectedJob.ontology_suggestions.newEntityTypes?.length > 0 && (
                  <div className="detail-section suggestions">
                    <h5>💡 Suggested New Entity Types</h5>
                    <p className="suggestion-hint">These types were found but not in your ontology</p>
                    <div className="suggestion-list">
                      {selectedJob.ontology_suggestions.newEntityTypes.map((t, i) => (
                        <div key={i} className="suggestion-item">
                          <div className="suggestion-name">{t.type}</div>
                          <div className="suggestion-desc">{t.description}</div>
                          {t.examples?.length > 0 && (
                            <div className="suggestion-examples">
                              Examples: {t.examples.slice(0, 3).join(', ')}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedJob.ontology_suggestions.newRelationshipTypes?.length > 0 && (
                  <div className="detail-section suggestions">
                    <h5>💡 Suggested New Relationship Types</h5>
                    <div className="suggestion-list">
                      {selectedJob.ontology_suggestions.newRelationshipTypes.map((r, i) => (
                        <div key={i} className="suggestion-item">
                          <div className="suggestion-name">{r.predicate}</div>
                          <div className="suggestion-desc">{r.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {selectedJob.preview_text && (
              <div className="detail-section">
                <h5>Text Preview</h5>
                <div className="preview-text">
                  {selectedJob.preview_text.substring(0, 1000)}
                  {selectedJob.preview_text.length > 1000 && '...'}
                </div>
              </div>
            )}

            {selectedJob.error && (
              <div className="detail-section error">
                <h5>Error</h5>
                <p>{selectedJob.error}</p>
              </div>
            )}
          </div>

          <div className="oj-details-actions">
            {/* Upload completed: Open staged review */}
            {selectedJob.status === 'completed' && selectedJob.job_type === 'upload' && selectedJob.staged_doc_id && (
              <button onClick={() => { 
                setSelectedStagedDocId(selectedJob.staged_doc_id); 
                setShowStagedReview(true); 
                setSelectedJob(null);
              }} className="btn primary">
                📋 Review & Map to Ontology
              </button>
            )}
            {/* Schema Analysis: Save as Ontology */}
            {selectedJob.status === 'completed' && selectedJob.job_type === 'schema_analysis' && selectedJob.suggested_ontology?.entityTypes && (
              <button onClick={() => saveAsOntology(selectedJob)} className="btn primary">
                💾 Save as Ontology
              </button>
            )}
            {/* Extraction: Review & Edit (not in edit mode) */}
            {selectedJob.status === 'completed' && selectedJob.job_type === 'extraction' && !editMode && (
              <>
                <button onClick={() => startEditMode(selectedJob)} className="btn primary">
                  ✏️ Review & Edit
                </button>
                <button onClick={() => rejectJob(selectedJob.job_id, 'Rejected')} className="btn secondary">
                  👎 Reject
                </button>
              </>
            )}
            {/* Extraction: Create Graph (in edit mode) */}
            {selectedJob.status === 'completed' && selectedJob.job_type === 'extraction' && editMode && (
              <>
                <button onClick={() => approveAndCreateGraph(selectedJob.job_id)} className="btn primary">
                  ✅ Create Graph ({editedEntities.filter(e => e.include).length} entities)
                </button>
                <button onClick={cancelEditMode} className="btn secondary">
                  ✖️ Cancel
                </button>
              </>
            )}
            {/* Extraction Approved: Create Knowledge Graph */}
            {selectedJob.status === 'approved' && selectedJob.job_type === 'extraction' && (
              <button onClick={() => createGraph(selectedJob.job_id)} className="btn primary">
                📊 Create Knowledge Graph
              </button>
            )}
            {/* Committed: Close and optionally delete */}
            {selectedJob.status === 'committed' && (
              <>
                {canDelete && (
                  <button onClick={() => { deleteJob(selectedJob.job_id); }} className="btn secondary">
                    🗑️ Delete Job
                  </button>
                )}
                <button onClick={() => setSelectedJob(null)} className="btn secondary">
                  Close
                </button>
              </>
            )}
            {/* Failed: Retry or delete */}
            {selectedJob.status === 'failed' && (
              <>
                {selectedJob.job_type === 'extraction' && canUpload && (
                  <button onClick={() => { reExtractJob(selectedJob.job_id); setSelectedJob(null); }} className="btn primary">
                    🔄 Retry Extraction
                  </button>
                )}
                {canDelete && (
                  <button onClick={() => { deleteJob(selectedJob.job_id); }} className="btn secondary">
                    🗑️ Delete
                  </button>
                )}
              </>
            )}
            {/* Active jobs: Cancel */}
            {['pending', 'processing', 'extracting', 'analyzing', 'generating'].includes(selectedJob.status) && canUpload && (
              <button onClick={() => { cancelJob(selectedJob.job_id); setSelectedJob(null); }} className="btn secondary">
                🚫 Cancel Job
              </button>
            )}
          </div>
        </div>
        </>
      )}

      {/* Staged Document Review Modal */}
      {showStagedReview && selectedStagedDocId && (
        <StagedDocumentReview
          docId={selectedStagedDocId}
          onClose={() => { setShowStagedReview(false); setSelectedStagedDocId(null); }}
          onCommit={() => { loadJobs(); }}
        />
      )}

      {/* Extraction Review Modal */}
      {showExtractionReview && extractionReviewJobId && (
        <ExtractionReview
          jobId={extractionReviewJobId}
          onClose={() => { setShowExtractionReview(false); setExtractionReviewJobId(null); }}
          onCommit={() => { loadJobs(); }}
        />
      )}
    </div>
  );
}

export default OntologyJobs;
