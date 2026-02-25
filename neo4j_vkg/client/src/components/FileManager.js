import { useState, useEffect, useCallback, useRef } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import { StagedDocumentReview } from './ontology';
import SheetView from './ontology/SheetView';
import './FileManager.css';

const API_BASE_URL = '/api';

const isTabularType = (t) => ['csv', 'xlsx', 'xls'].includes(t?.toLowerCase());

// Default fallback types
const DEFAULT_ENTITY_TYPES = [
  'Person', 'Organization', 'Location', 'Date', 'Event',
  'Product', 'Technology', 'Currency', 'Concept', 'Skill'
];

function FileManager() {
  const { currentWorkspace, getTenantHeaders, isWorkspaceSelected, getWorkspaceRequiredMessage } = useTenant();
  const { canUpload, canDelete, canManageOntology, canManageFolders } = usePermissions();
  const [documents, setDocuments] = useState([]);
  const [stagedDocuments, setStagedDocuments] = useState([]);
  const [folders, setFolders] = useState([]);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [documentDetails, setDocumentDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('chunks');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedChunks, setExpandedChunks] = useState(new Set());
  const [expandedFolders, setExpandedFolders] = useState(new Set(['root']));
  const [selectedFolder, setSelectedFolder] = useState('root');
  const [entityTypes, setEntityTypes] = useState(DEFAULT_ENTITY_TYPES);
  const [ontologies, setOntologies] = useState([]);
  
  // Edit states
  const [editingEntity, setEditingEntity] = useState(null);
  const [editingRelation, setEditingRelation] = useState(null);
  const [showAddEntity, setShowAddEntity] = useState(false);
  const [showAddRelation, setShowAddRelation] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderOntology, setNewFolderOntology] = useState('');
  const [saving, setSaving] = useState(false);
  
  // Upload states
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({});
  const fileInputRef = useRef(null);
  
  // Multi-select and folder edit states
  const [selectedDocs, setSelectedDocs] = useState(new Set());
  const [editingFolder, setEditingFolder] = useState(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  
  // Review/Preview states
  const [showReview, setShowReview] = useState(false);
  const [reviewData, setReviewData] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  
  // Schema analysis states
  const [showSchemaAnalysis, setShowSchemaAnalysis] = useState(false);
  const [schemaAnalysis, setSchemaAnalysis] = useState(null);
  const [analyzingSchema, setAnalyzingSchema] = useState(false);
  
  // Processing jobs panel
  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [showProcessingPanel, setShowProcessingPanel] = useState(true);
  const [selectedStagedDocId, setSelectedStagedDocId] = useState(null);
  const [showStagedReview, setShowStagedReview] = useState(false);
  const [sheetViewerDoc, setSheetViewerDoc] = useState(null);

  // Pagination for entities/relations
  const [entityPage, setEntityPage] = useState(0);
  const [relationPage, setRelationPage] = useState(0);
  const PAGE_SIZE = 50;

  // Entity/Relation filter & search
  const [entitySearch, setEntitySearch] = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState('');
  const [relationSearch, setRelationSearch] = useState('');
  const [relationPredicateFilter, setRelationPredicateFilter] = useState('');
  const [selectedEntities, setSelectedEntities] = useState(new Set());
  const [selectedRelations, setSelectedRelations] = useState(new Set());

  // Mapping tab state
  const [docMapping, setDocMapping] = useState(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [showMappingTemplates, setShowMappingTemplates] = useState(false);
  const [mappingTemplates, setMappingTemplates] = useState([]);
  const [mappingTemplatesLoading, setMappingTemplatesLoading] = useState(false);

  const loadDocumentMapping = async (ontologyId, workspaceId) => {
    if (!ontologyId || !workspaceId) {
      setDocMapping(null);
      return;
    }
    setMappingLoading(true);
    try {
      const params = new URLSearchParams({ ontologyId, workspaceId });
      const res = await fetch(`${API_BASE_URL}/ontology/documents/column-mappings?${params}`, { headers: getTenantHeaders() });
      const data = await res.json();
      if (data.success && data.mappings) {
        setDocMapping(data); // now includes ontologyStale and ontologyVersionId
      } else {
        setDocMapping(null);
      }
    } catch (e) {
      console.error('Error loading mapping:', e);
      setDocMapping(null);
    } finally {
      setMappingLoading(false);
    }
  };

  const loadMappingTemplates = async () => {
    const wsId = currentWorkspace?.workspace_id;
    if (!wsId) return;
    setMappingTemplatesLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/ontology/documents/mapping-templates?workspaceId=${wsId}`, { headers: getTenantHeaders() });
      const data = await res.json();
      if (data.success) {
        // Enrich with ontology names
        const enriched = (data.templates || []).map(t => {
          const ont = ontologies.find(o => (o.ontologyId || o.id) === t.ontologyId);
          return { ...t, ontologyName: ont?.label || ont?.name || t.ontologyId };
        });
        setMappingTemplates(enriched);
      }
    } catch (e) {
      console.error('Error loading mapping templates:', e);
    } finally {
      setMappingTemplatesLoading(false);
    }
  };

  const deleteMappingTemplate = async (ontologyId) => {
    if (!window.confirm('Delete this mapping template? Future uploads will need to create a new mapping.')) return;
    const wsId = currentWorkspace?.workspace_id;
    try {
      await fetch(`${API_BASE_URL}/ontology/documents/mapping-templates?ontologyId=${encodeURIComponent(ontologyId)}&workspaceId=${wsId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      loadMappingTemplates();
    } catch (e) {
      console.error('Error deleting mapping template:', e);
    }
  };

  // Review schema analysis job results
  const reviewSchemaJob = async (job) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${job.job_id}`, {
        headers: getTenantHeaders()
      });
      const data = await response.json();
      if (data.success && data.job?.suggested_ontology) {
        setSchemaAnalysis({
          ...data.job.suggested_ontology,
          industry: job.industry || 'general',
          documentName: job.document_title || job.file_name
        });
        setShowSchemaAnalysis(true);
      } else {
        alert('No schema analysis results found for this job.');
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    }
  };

  // Reload data when workspace changes
  useEffect(() => {
    loadDocuments();
    loadStagedDocuments();
    loadFolders();
    loadEntityTypes();
    loadOntologies();
    loadJobs();
  }, [currentWorkspace?.workspace_id]);

  // Auto-refresh jobs when there are active ones
  useEffect(() => {
    const hasActiveJobs = jobs.some(j => ['pending', 'processing', 'extracting', 'analyzing'].includes(j.status));
    if (hasActiveJobs) {
      const interval = setInterval(loadJobs, 3000);
      return () => clearInterval(interval);
    }
  }, [jobs]);

  // Load processing jobs
  const loadJobs = async () => {
    // Don't load jobs if no workspace is selected
    if (!currentWorkspace?.workspace_id) {
      console.log('[FileManager] No workspace selected, clearing jobs');
      setJobs([]);
      return;
    }
    
    console.log('[FileManager] Loading jobs for workspace:', currentWorkspace.workspace_id);
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs?workspace_id=${currentWorkspace.workspace_id}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        console.log('[FileManager] Jobs response:', data.jobs?.length, 'jobs, filter:', data.workspaceFilter);
        // Only show recent jobs (last 24h) and active ones
        const recentJobs = (data.jobs || []).filter(j => {
          const age = Date.now() - new Date(j.created_at).getTime();
          return age < 24 * 60 * 60 * 1000 || !['committed', 'failed', 'cancelled'].includes(j.status);
        });
        setJobs(recentJobs);
      }
    } catch (error) {
      console.error('Error loading jobs:', error);
    }
  };

  // Delete staged document
  const deleteStagedDocument = async (docId) => {
    if (!window.confirm('Delete this staged document?')) return;
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/staged/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      if (response.ok) {
        loadStagedDocuments();
        loadJobs();
      }
    } catch (error) {
      console.error('Error deleting staged document:', error);
    }
  };

  // Delete job
  const deleteJob = async (jobId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/jobs/${jobId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      if (response.ok) {
        loadJobs();
      }
    } catch (error) {
      console.error('Error deleting job:', error);
    }
  };

  // Clear all completed/failed jobs
  const clearCompletedJobs = async () => {
    const toDelete = jobs.filter(j => ['committed', 'failed', 'cancelled'].includes(j.status));
    for (const job of toDelete) {
      try {
        await fetch(`${API_BASE_URL}/ontology/jobs/${job.job_id}`, {
          method: 'DELETE',
          headers: getTenantHeaders()
        });
      } catch (e) { /* ignore */ }
    }
    loadJobs();
  };

  // Load staged documents (pending commit)
  const loadStagedDocuments = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/staged`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setStagedDocuments(data.staged || []);
      }
    } catch (error) {
      console.error('Error loading staged documents:', error);
    }
  };

  // Load ontologies for folder assignment (all available)
  const loadOntologies = async () => {
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      const response = await fetch(`${API_BASE_URL}/ontology/all?${params}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        // Filter to workspace-only ontologies (exclude global)
        const workspaceOntologies = (data.ontologies || []).filter(ont => ont.scope !== 'global');
        setOntologies(workspaceOntologies);
      }
    } catch (error) {
      console.error('Error loading ontologies:', error);
    }
  };

  // Load entity types from ontologies (workspace-only)
  const loadEntityTypes = async () => {
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      const response = await fetch(`${API_BASE_URL}/ontology/all?${params}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        const allTypes = new Set(DEFAULT_ENTITY_TYPES);
        
        // Filter to workspace-only ontologies first
        const workspaceOntologies = (data.ontologies || []).filter(ont => 
          ont.scope === 'workspace' || ont.isCustom
        );
        
        // Extract types from workspace ontologies using entityTypes (source of truth)
        workspaceOntologies.forEach(ont => {
          // entityTypes is the canonical source (rich format with label/userLabel)
          ont.entityTypes?.forEach(et => {
            const typeName = et.userLabel || et.label;
            if (typeName) allTypes.add(typeName);
          });
        });
        
        // Remove empty strings
        allTypes.delete('');
        
        setEntityTypes([...allTypes].sort());
      }
    } catch (error) {
      console.error('Error loading entity types:', error);
    }
  };

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      const response = await fetch(`${API_BASE_URL}/ontology/documents?${params}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setDocuments(data.documents || []);
      }
      // Also refresh staged documents
      loadStagedDocuments();
    } catch (error) {
      console.error('Error loading documents:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadFolders = async () => {
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      const response = await fetch(`${API_BASE_URL}/ontology/folders?${params}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setFolders(data.folders || []);
      }
    } catch (error) {
      console.error('Error loading folders:', error);
    }
  };

  const loadDocumentDetails = async (docId, opts = {}) => {
    const { eOffset, rOffset, append, eSearch, eType, rSearch, rPredicate } = opts;
    const entOffset = eOffset ?? 0;
    const relOffset = rOffset ?? 0;
    
    if (!append) setDetailsLoading(true);
    try {
      const params = new URLSearchParams({
        entityLimit: PAGE_SIZE,
        entityOffset: entOffset,
        relationLimit: PAGE_SIZE,
        relationOffset: relOffset
      });
      // Server-side filters
      if (eSearch) params.set('entitySearch', eSearch);
      if (eType) params.set('entityTypeFilter', eType);
      if (rSearch) params.set('relationSearch', rSearch);
      if (rPredicate) params.set('relationPredicateFilter', rPredicate);

      const response = await fetch(`${API_BASE_URL}/ontology/documents/${encodeURIComponent(docId)}?${params}`, {
        headers: getTenantHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        if (append) {
          // Append to existing data for "load more"
          setDocumentDetails(prev => {
            if (!prev) return data;
            const merged = { ...prev };
            if (opts.type === 'entities') {
              merged.concepts = [...(prev.concepts || []), ...(data.concepts || [])];
              merged.pagination = { ...prev.pagination, entities: data.pagination?.entities };
            } else if (opts.type === 'relations') {
              merged.relations = [...(prev.relations || []), ...(data.relations || [])];
              merged.pagination = { ...prev.pagination, relations: data.pagination?.relations };
            }
            merged.stats = data.stats;
            // Keep filterOptions from initial load (unfiltered types/predicates)
            if ((!merged.filterOptions || (!merged.filterOptions.entityTypes?.length && !merged.filterOptions.predicates?.length)) && data.filterOptions) {
              merged.filterOptions = data.filterOptions;
            }
            return merged;
          });
        } else {
          setDocumentDetails(data);
        }
      }
    } catch (error) {
      console.error('Error loading document details:', error);
    } finally {
      setDetailsLoading(false);
    }
  };

  // Reload entities with current filters (resets to page 0)
  const reloadEntitiesFiltered = (search, typeFilter) => {
    if (!selectedDocument) return;
    const docId = selectedDocument.doc_id || selectedDocument.uri;
    setSelectedEntities(new Set());
    // We need to reload just entities but keep existing chunks/relations
    // So we do a full reload with the filters applied
    const fetchFiltered = async () => {
      setDetailsLoading(true);
      try {
        const params = new URLSearchParams({
          entityLimit: PAGE_SIZE,
          entityOffset: 0,
          relationLimit: PAGE_SIZE,
          relationOffset: 0
        });
        if (search) params.set('entitySearch', search);
        if (typeFilter) params.set('entityTypeFilter', typeFilter);
        if (relationSearch) params.set('relationSearch', relationSearch);
        if (relationPredicateFilter) params.set('relationPredicateFilter', relationPredicateFilter);

        const response = await fetch(`${API_BASE_URL}/ontology/documents/${encodeURIComponent(docId)}?${params}`, {
          headers: getTenantHeaders()
        });
        if (response.ok) {
          const data = await response.json();
          setDocumentDetails(prev => {
            if (!prev) return data;
            return {
              ...prev,
              concepts: data.concepts,
              stats: { ...prev.stats, conceptCount: data.stats?.conceptCount },
              pagination: { ...prev.pagination, entities: data.pagination?.entities },
              // Preserve filterOptions only if they have actual data; otherwise use new response
              filterOptions: (prev.filterOptions?.entityTypes?.length > 0 || prev.filterOptions?.predicates?.length > 0)
                ? prev.filterOptions : data.filterOptions
            };
          });
        }
      } catch (error) {
        console.error('Error loading filtered entities:', error);
      } finally {
        setDetailsLoading(false);
      }
    };
    fetchFiltered();
  };

  // Reload relations with current filters (resets to page 0)
  const reloadRelationsFiltered = (search, predicateFilter) => {
    if (!selectedDocument) return;
    const docId = selectedDocument.doc_id || selectedDocument.uri;
    setSelectedRelations(new Set());
    const fetchFiltered = async () => {
      setDetailsLoading(true);
      try {
        const params = new URLSearchParams({
          entityLimit: PAGE_SIZE,
          entityOffset: 0,
          relationLimit: PAGE_SIZE,
          relationOffset: 0
        });
        if (entitySearch) params.set('entitySearch', entitySearch);
        if (entityTypeFilter) params.set('entityTypeFilter', entityTypeFilter);
        if (search) params.set('relationSearch', search);
        if (predicateFilter) params.set('relationPredicateFilter', predicateFilter);

        const response = await fetch(`${API_BASE_URL}/ontology/documents/${encodeURIComponent(docId)}?${params}`, {
          headers: getTenantHeaders()
        });
        if (response.ok) {
          const data = await response.json();
          setDocumentDetails(prev => {
            if (!prev) return data;
            return {
              ...prev,
              relations: data.relations,
              stats: { ...prev.stats, relationCount: data.stats?.relationCount },
              pagination: { ...prev.pagination, relations: data.pagination?.relations },
              filterOptions: (prev.filterOptions?.entityTypes?.length > 0 || prev.filterOptions?.predicates?.length > 0)
                ? prev.filterOptions : data.filterOptions
            };
          });
        }
      } catch (error) {
        console.error('Error loading filtered relations:', error);
      } finally {
        setDetailsLoading(false);
      }
    };
    fetchFiltered();
  };

  const loadMoreEntities = () => {
    if (!selectedDocument || !documentDetails?.pagination?.entities) return;
    const nextOffset = (documentDetails.concepts?.length || 0);
    setEntityPage(p => p + 1);
    loadDocumentDetails(selectedDocument.doc_id || selectedDocument.uri, {
      eOffset: nextOffset,
      rOffset: documentDetails.pagination?.relations?.offset ?? 0,
      append: true,
      type: 'entities',
      eSearch: entitySearch || undefined,
      eType: entityTypeFilter || undefined,
      rSearch: relationSearch || undefined,
      rPredicate: relationPredicateFilter || undefined
    });
  };

  const loadMoreRelations = () => {
    if (!selectedDocument || !documentDetails?.pagination?.relations) return;
    const nextOffset = (documentDetails.relations?.length || 0);
    setRelationPage(p => p + 1);
    loadDocumentDetails(selectedDocument.doc_id || selectedDocument.uri, {
      eOffset: documentDetails.pagination?.entities?.offset ?? 0,
      rOffset: nextOffset,
      append: true,
      type: 'relations',
      eSearch: entitySearch || undefined,
      eType: entityTypeFilter || undefined,
      rSearch: relationSearch || undefined,
      rPredicate: relationPredicateFilter || undefined
    });
  };

  const selectDocument = (doc) => {
    setSelectedDocument(doc);
    setDocumentDetails(null);
    setDocMapping(null);
    setExpandedChunks(new Set());
    setEditingEntity(null);
    setEditingRelation(null);
    setEntityPage(0);
    setRelationPage(0);
    setEntitySearch('');
    setEntityTypeFilter('');
    setRelationSearch('');
    setRelationPredicateFilter('');
    setSelectedEntities(new Set());
    setSelectedRelations(new Set());
    loadDocumentDetails(doc.doc_id || doc.uri);
  };

  const deleteDocument = async (docId) => {
    const confirmMsg = `Delete this document?\n\nThis will remove:\n• The document\n• All chunks\n• Entities unique to this document\n• Vector embeddings\n\nThis cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      const data = await response.json();
      if (response.ok) {
        setSelectedDocument(null);
        setDocumentDetails(null);
        loadDocuments();
        if (data.stats) {
          console.log('Deleted:', data.stats);
        }
      } else {
        alert(data.error || 'Failed to delete document');
      }
    } catch (error) {
      console.error('Error deleting document:', error);
      alert('Failed to delete document');
    }
  };

  // Chunk operations
  const deleteChunk = async (chunkId) => {
    if (!window.confirm('Delete this chunk and its unique entities?')) return;
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/chunks/${encodeURIComponent(chunkId)}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      if (response.ok) {
        loadDocumentDetails(selectedDocument.doc_id);
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to delete chunk');
      }
    } catch (error) {
      console.error('Error deleting chunk:', error);
    }
  };

  // Folder operations
  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    
    try {
      console.log('Creating folder:', { 
        name: newFolderName, 
        workspace_id: currentWorkspace?.workspace_id 
      });
      
      const response = await fetch(`${API_BASE_URL}/ontology/folders`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getTenantHeaders()
        },
        body: JSON.stringify({ 
          name: newFolderName, 
          parentId: selectedFolder === 'root' ? null : selectedFolder,
          ontologyId: newFolderOntology || null,
          workspace_id: currentWorkspace?.workspace_id || null
        })
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        setNewFolderName('');
        setNewFolderOntology('');
        setShowNewFolder(false);
        loadFolders();
      } else {
        console.error('Folder creation failed:', data);
        alert(`Error creating folder: ${data.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error creating folder:', error);
      alert(`Error creating folder: ${error.message}`);
    }
  };

  const deleteFolder = async (folderId) => {
    if (!window.confirm('Delete this folder? Documents will be moved to root.')) return;
    
    try {
      await fetch(`${API_BASE_URL}/ontology/folders/${folderId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      loadFolders();
      loadDocuments();
    } catch (error) {
      console.error('Error deleting folder:', error);
    }
  };

  const moveDocumentToFolder = async (docId, folderId) => {
    try {
      await fetch(`${API_BASE_URL}/ontology/documents/${docId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ folderId })
      });
      loadDocuments();
    } catch (error) {
      console.error('Error moving document:', error);
    }
  };

  // Entity operations
  const saveEntity = async (entity) => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/entities/${entity.concept_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(entity)
      });
      if (response.ok) {
        setEditingEntity(null);
        loadDocumentDetails(selectedDocument.doc_id);
      }
    } catch (error) {
      console.error('Error saving entity:', error);
      alert('Failed to save entity');
    } finally {
      setSaving(false);
    }
  };

  const deleteEntity = async (conceptId) => {
    if (!window.confirm('Delete this entity?')) return;
    
    try {
      await fetch(`${API_BASE_URL}/ontology/entities/${conceptId}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      loadDocumentDetails(selectedDocument.doc_id);
    } catch (error) {
      console.error('Error deleting entity:', error);
    }
  };

  const addEntity = async (entity) => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/${selectedDocument.doc_id}/entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(entity)
      });
      if (response.ok) {
        setShowAddEntity(false);
        loadDocumentDetails(selectedDocument.doc_id);
      }
    } catch (error) {
      console.error('Error adding entity:', error);
      alert('Failed to add entity');
    } finally {
      setSaving(false);
    }
  };

  // Relationship operations
  const addRelationship = async (rel) => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(rel)
      });
      if (response.ok) {
        setShowAddRelation(false);
        loadDocumentDetails(selectedDocument.doc_id);
      }
    } catch (error) {
      console.error('Error adding relationship:', error);
    } finally {
      setSaving(false);
    }
  };

  const updateRelationship = async (rel) => {
    setSaving(true);
    try {
      await fetch(`${API_BASE_URL}/ontology/relationships`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(rel)
      });
      setEditingRelation(null);
      loadDocumentDetails(selectedDocument.doc_id);
    } catch (error) {
      console.error('Error updating relationship:', error);
    } finally {
      setSaving(false);
    }
  };

  const deleteRelationship = async (rel) => {
    if (!window.confirm('Delete this relationship?')) return;
    
    try {
      await fetch(`${API_BASE_URL}/ontology/relationships`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({ sourceLabel: rel.source, targetLabel: rel.target, predicate: rel.predicate })
      });
      loadDocumentDetails(selectedDocument.doc_id);
    } catch (error) {
      console.error('Error deleting relationship:', error);
    }
  };

  // Upload operations
  const handleFileSelect = (e) => {
    if (!isWorkspaceSelected()) {
      alert(getWorkspaceRequiredMessage());
      e.target.value = '';
      return;
    }
    
    const files = Array.from(e.target.files);
    setUploadFiles(files);
    if (files.length > 0) {
      setUploadTargetFolder(selectedFolder);
      setShowUpload(true);
    }
  };

  const getFolderOntology = (folderId) => {
    if (folderId === 'root') return null;
    const folder = folders.find(f => f.folder_id === folderId);
    return folder?.ontology_id || null;
  };

  const getOntologyById = (ontologyId) => {
    return ontologies.find(o => o.id === ontologyId || o.ontologyId === ontologyId);
  };

  const [uploadTargetFolder, setUploadTargetFolder] = useState(null);

  const uploadAndProcess = async (options = {}) => {
    if (uploadFiles.length === 0) return;
    
    // Direct upload - creates Document + Chunks immediately
    await uploadFilesDirectly(options);
  };

  // Upload files directly (creates Document + Chunks, no ontology generation)
  const uploadFilesDirectly = async (options = {}) => {
    const { chunkingMethod = 'page', extractionMethod = 'pdf-parse', csvChunkingEnabled = false, fileNames = {} } = options;
    
    setUploading(true);
    const effectiveFolder = uploadTargetFolder || selectedFolder;
    const targetFolderId = effectiveFolder === 'root' ? null : effectiveFolder;
    const folderOntologyId = getFolderOntology(effectiveFolder);
    const ontology = folderOntologyId ? getOntologyById(folderOntologyId) : null;
    const industry = ontology?.name || ontology?.domain || 'general';
    
    let filesUploaded = 0;
    
    for (const file of uploadFiles) {
      const fileName = file.name;
      setUploadProgress(prev => ({ ...prev, [fileName]: { status: 'uploading', progress: 30 } }));
      
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('industry', industry);
        formData.append('folder_id', targetFolderId || '');
        formData.append('workspace_id', currentWorkspace?.workspace_id || '');
        formData.append('chunkingMethod', chunkingMethod);
        formData.append('extractionMethod', extractionMethod);
        formData.append('csvChunkingEnabled', csvChunkingEnabled);
        formData.append('skipOntologyGeneration', 'true'); // Don't generate ontology on upload
        const customName = fileNames[fileName];
        if (customName && customName !== fileName.replace(/\.[^/.]+$/, '')) {
          const ext = fileName.match(/\.[^/.]+$/)?.[0] || '';
          formData.append('customFileName', customName + ext);
        }
        
        setUploadProgress(prev => ({ ...prev, [fileName]: { status: 'processing', progress: 60 } }));
        
        const response = await fetch(`${API_BASE_URL}/ontology/upload-document`, {
          method: 'POST',
          headers: getTenantHeaders(),
          body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
          filesUploaded++;
          setUploadProgress(prev => ({ 
            ...prev, 
            [fileName]: { 
              status: 'complete', 
              progress: 100, 
              docId: data.document?.doc_id,
              jobId: data.jobId,
              message: data.jobId ? 'Processing in background...' : 'Complete'
            } 
          }));
        } else {
          setUploadProgress(prev => ({ 
            ...prev, 
            [fileName]: { status: 'error', progress: 0, error: data.error } 
          }));
        }
      } catch (error) {
        setUploadProgress(prev => ({ 
          ...prev, 
          [fileName]: { status: 'error', progress: 0, error: error.message } 
        }));
      }
    }
    
    setUploading(false);
    
    if (filesUploaded > 0) {
      loadDocuments(); // Refresh document list
      loadStagedDocuments(); // Refresh staged docs
      loadJobs(); // Refresh jobs
    }
  };

  const closeUploadModal = () => {
    setShowUpload(false);
    setUploadFiles([]);
    setUploadProgress({});
    setUploadTargetFolder(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // ── Extraction Wizard state ──
  const [showExtractionWizard, setShowExtractionWizard] = useState(false);
  const [wizardDocId, setWizardDocId] = useState(null);

  // Open extraction wizard for a document
  const generateGraphForDocument = (docId) => {
    setWizardDocId(docId);
    setShowExtractionWizard(true);
  };

  // Called when extraction wizard completes (either extraction started or ontology saved)
  const onExtractionWizardDone = () => {
    setShowExtractionWizard(false);
    setWizardDocId(null);
    loadDocuments();
    loadJobs();
    loadOntologies();
    if (wizardDocId) loadDocumentDetails(wizardDocId);
  };

  // Preview extraction for review before saving
  const previewExtraction = async (docId) => {
    setReviewLoading(true);
    try {
      const doc = documents.find(d => d.doc_id === docId);
      const folderOntologyId = doc?.folderId ? getFolderOntology(doc.folderId) : null;
      const ontology = folderOntologyId ? getOntologyById(folderOntologyId) : null;
      
      const entityTypes = ontology?.nodeTypes || ontology?.conceptTypes || 
        (ontology?.entityTypes || []).map(et => et.userLabel || et.label).filter(Boolean);
      const predicates = ontology?.predicates || 
        (ontology?.relationships || []).map(r => r.type || r.predicate).filter(Boolean);
      const industry = ontology ? (ontology.name || ontology.domain || ontology.id) : null;
      
      const response = await fetch(`${API_BASE_URL}/ontology/documents/${docId}/preview-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          ontologyId: ontology?.id,
          entityTypes,
          predicates,
          industry
        })
      });
      
      const result = await response.json();
      if (response.ok) {
        setReviewData(result);
        setShowReview(true);
      } else {
        alert(`❌ ${result.error}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    } finally {
      setReviewLoading(false);
    }
  };

  // Approve reviewed extraction
  const approveExtraction = async (reviewedConcepts, reviewedRelations, updateOntology, newTypes = [], newPredicates = []) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/${reviewData.document.doc_id}/approve-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          previewId: reviewData.previewId,
          concepts: reviewedConcepts,
          relations: reviewedRelations,
          updateOntology,
          ontologyId: reviewData.ontology?.id,
          newTypes,
          newPredicates
        })
      });
      
      const result = await response.json();
      if (response.ok) {
        alert(`✅ Saved ${result.conceptsCreated} concepts, ${result.relationsCreated} relations`);
        setShowReview(false);
        setReviewData(null);
        loadDocumentDetails(reviewData.document.doc_id);
        loadDocuments();
        loadOntologies(); // Refresh ontologies if updated
      } else {
        alert(`❌ ${result.error}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    }
  };

  // Bulk generate graph for selected documents
  const bulkGenerateGraph = async () => {
    if (selectedDocs.size === 0) {
      alert('Select documents first');
      return;
    }
    
    // Check if folder has an ontology assigned
    const folderOntologyId = getFolderOntology(selectedFolder);
    
    if (!folderOntologyId) {
      // No ontology - analyze documents to suggest schema (background job)
      if (!window.confirm(`Analyze ${selectedDocs.size} document(s) to suggest an ontology schema?\n\nThis will run in the background. Check "Processing Jobs" for results.`)) return;
      
      setAnalyzingSchema(true);
      try {
        const response = await fetch(`${API_BASE_URL}/ontology/documents/analyze-for-schema`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({
            docIds: Array.from(selectedDocs),
            industry: 'general',
            workspace_id: currentWorkspace?.workspace_id || ''
          })
        });
        
        const result = await response.json();
        if (response.ok && result.jobId) {
          alert(`✅ Schema analysis started!\n\nJob ID: ${result.jobId}\n\nGo to "Processing Jobs" to monitor progress and review the suggested schema.`);
          setSelectedDocs(new Set());
        } else {
          alert(`❌ ${result.error || 'Failed to start analysis'}`);
        }
      } catch (error) {
        alert(`❌ ${error.message}`);
      } finally {
        setAnalyzingSchema(false);
      }
      return;
    }
    
    // Has ontology - extract entities using it
    if (!window.confirm(`Generate knowledge graph for ${selectedDocs.size} document(s) using the assigned ontology?`)) return;
    
    setBulkGenerating(true);
    try {
      const ontology = getOntologyById(folderOntologyId);
      
      // Extract entity types from ontology (handle different formats)
      const entityTypes = ontology?.nodeTypes || ontology?.conceptTypes || 
        (ontology?.entityTypes || []).map(et => et.userLabel || et.label).filter(Boolean);
      const predicates = ontology?.predicates || 
        (ontology?.relationships || []).map(r => r.type || r.predicate).filter(Boolean);
      // Use ontology name as industry
      const industry = ontology ? (ontology.name || ontology.domain || ontology.id) : null;
      
      console.log('Using ontology:', ontology?.name, 'Industry:', industry, 'Entity types:', entityTypes, 'Predicates:', predicates);
      
      const response = await fetch(`${API_BASE_URL}/ontology/documents/bulk-generate-graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          docIds: Array.from(selectedDocs),
          ontologyId: ontology?.id,
          entityTypes,
          predicates,
          industry
        })
      });
      
      const result = await response.json();
      if (response.ok) {
        alert(`✅ Generated ${result.totalConcepts || 0} concepts, ${result.totalRelations || 0} relations for ${result.results?.filter(r => r.status === 'success').length || 0} documents`);
        setSelectedDocs(new Set());
        loadDocuments();
      } else {
        alert(`❌ ${result.error}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    } finally {
      setBulkGenerating(false);
    }
  };

  // Toggle document selection
  const toggleDocSelection = (docId, e) => {
    e.stopPropagation();
    setSelectedDocs(prev => {
      const newSet = new Set(prev);
      newSet.has(docId) ? newSet.delete(docId) : newSet.add(docId);
      return newSet;
    });
  };

  // Select all docs in current folder
  const selectAllInFolder = () => {
    const docsInFolder = getDocumentsInFolder(selectedFolder);
    if (selectedDocs.size === docsInFolder.length) {
      setSelectedDocs(new Set());
    } else {
      setSelectedDocs(new Set(docsInFolder.map(d => d.doc_id)));
    }
  };

  // Update folder (name and/or ontology)
  const updateFolder = async (folderId, updates) => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/folders/${folderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify(updates)
      });
      if (response.ok) {
        setEditingFolder(null);
        loadFolders();
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to update folder');
      }
    } catch (error) {
      console.error('Error updating folder:', error);
    }
  };

  const toggleChunkExpand = (chunkOrder) => {
    setExpandedChunks(prev => {
      const newSet = new Set(prev);
      newSet.has(chunkOrder) ? newSet.delete(chunkOrder) : newSet.add(chunkOrder);
      return newSet;
    });
  };

  const toggleFolderExpand = (folderId) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      newSet.has(folderId) ? newSet.delete(folderId) : newSet.add(folderId);
      return newSet;
    });
  };

  const formatDate = (dateObj) => {
    if (!dateObj) return '';
    try {
      if (dateObj.year && dateObj.month && dateObj.day) {
        return new Date(dateObj.year, dateObj.month - 1, dateObj.day).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric'
        });
      }
      return new Date(dateObj).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return ''; }
  };

  const getDocIcon = (docType) => {
    const icons = { pdf: '📕', csv: '📊', txt: '📝', json: '📋' };
    return icons[docType?.toLowerCase()] || '📄';
  };

  const getTypeColor = (type) => {
    const colors = {
      'Person': '#ec4899', 'Organization': '#f59e0b', 'Location': '#3b82f6',
      'Date': '#10b981', 'Technology': '#8b5cf6', 'Product': '#06b6d4',
      'Event': '#f97316', 'Currency': '#84cc16', 'Concept': '#6366f1'
    };
    return colors[type] || '#71717a';
  };

  // Group documents by folder
  const getDocumentsInFolder = useCallback((folderId) => {
    return documents.filter(doc => 
      folderId === 'root' ? !doc.folderId : doc.folderId === folderId
    ).filter(doc => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return doc.title?.toLowerCase().includes(term);
    });
  }, [documents, searchTerm]);

  // ── Entities/relations are now server-filtered; use loaded data directly ──
  const concepts = documentDetails?.concepts || [];
  const relations = documentDetails?.relations || [];

  // Filter dropdown options: prefer server-provided (covers all data), fallback to loaded data
  const allEntityTypesFromServer = (documentDetails?.filterOptions?.entityTypes?.length > 0)
    ? documentDetails.filterOptions.entityTypes
    : [...new Set((documentDetails?.concepts || []).map(c => c.type).filter(Boolean))].sort();
  const allPredicatesFromServer = (documentDetails?.filterOptions?.predicates?.length > 0)
    ? documentDetails.filterOptions.predicates
    : [...new Set((documentDetails?.relations || []).map(r => r.predicate || r.type).filter(Boolean))].sort();

  // Debug: log filter options state
  if (documentDetails) {
    console.log('[FilterOptions] documentDetails.filterOptions:', JSON.stringify(documentDetails?.filterOptions));
    console.log('[FilterOptions] derived entityTypes:', allEntityTypesFromServer);
    console.log('[FilterOptions] derived predicates:', allPredicatesFromServer);
    console.log('[FilterOptions] concepts count:', documentDetails?.concepts?.length, 'sample types:', (documentDetails?.concepts || []).slice(0, 3).map(c => c.type));
  }

  // Debounced search handlers — trigger server reload after typing stops
  const entitySearchTimerRef = useRef(null);
  const relationSearchTimerRef = useRef(null);

  const handleEntitySearchChange = (value) => {
    setEntitySearch(value);
    clearTimeout(entitySearchTimerRef.current);
    entitySearchTimerRef.current = setTimeout(() => {
      reloadEntitiesFiltered(value, entityTypeFilter);
    }, 400);
  };

  const handleEntityTypeFilterChange = (value) => {
    setEntityTypeFilter(value);
    reloadEntitiesFiltered(entitySearch, value);
  };

  const handleRelationSearchChange = (value) => {
    setRelationSearch(value);
    clearTimeout(relationSearchTimerRef.current);
    relationSearchTimerRef.current = setTimeout(() => {
      reloadRelationsFiltered(value, relationPredicateFilter);
    }, 400);
  };

  const handleRelationPredicateFilterChange = (value) => {
    setRelationPredicateFilter(value);
    reloadRelationsFiltered(relationSearch, value);
  };

  // Entity quick-select helpers
  const toggleEntitySelect = (uri, e) => {
    e?.stopPropagation();
    setSelectedEntities(prev => {
      const s = new Set(prev);
      s.has(uri) ? s.delete(uri) : s.add(uri);
      return s;
    });
  };

  const selectAllEntities = () => {
    if (selectedEntities.size === concepts.length) {
      setSelectedEntities(new Set());
    } else {
      setSelectedEntities(new Set(concepts.map(c => c.uri || c.concept_id)));
    }
  };

  const deleteSelectedEntities = async () => {
    if (selectedEntities.size === 0) return;
    if (!window.confirm(`Delete ${selectedEntities.size} selected entities?`)) return;
    for (const id of selectedEntities) {
      try {
        await fetch(`${API_BASE_URL}/ontology/entities/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: getTenantHeaders()
        });
      } catch (e) { /* continue */ }
    }
    setSelectedEntities(new Set());
    reloadEntitiesFiltered(entitySearch, entityTypeFilter);
  };

  // Relation quick-select helpers
  const toggleRelationSelect = (idx, e) => {
    e?.stopPropagation();
    setSelectedRelations(prev => {
      const s = new Set(prev);
      s.has(idx) ? s.delete(idx) : s.add(idx);
      return s;
    });
  };

  const selectAllRelations = () => {
    if (selectedRelations.size === relations.length) {
      setSelectedRelations(new Set());
    } else {
      setSelectedRelations(new Set(relations.map((_, i) => i)));
    }
  };

  const deleteSelectedRelations = async () => {
    if (selectedRelations.size === 0) return;
    if (!window.confirm(`Delete ${selectedRelations.size} selected relations?`)) return;
    const rels = relations.filter((_, i) => selectedRelations.has(i));
    for (const rel of rels) {
      try {
        await fetch(`${API_BASE_URL}/ontology/relationships`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
          body: JSON.stringify({ sourceLabel: rel.source, targetLabel: rel.target, predicate: rel.predicate })
        });
      } catch (e) { /* continue */ }
    }
    setSelectedRelations(new Set());
    reloadRelationsFiltered(relationSearch, relationPredicateFilter);
  };

  // Drag and drop handlers
  const [isDragging, setIsDragging] = useState(false);
  
  const handleDragOver = (e) => {
    e.preventDefault();
    if (!isDragging) setIsDragging(true);
  };
  
  const handleDragLeave = (e) => {
    e.preventDefault();
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isWorkspaceSelected()) {
      alert(getWorkspaceRequiredMessage());
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter(f => 
      /\.(pdf|txt|md|html|csv|xlsx|xls)$/i.test(f.name)
    );
    if (files.length > 0) {
      setUploadFiles(files);
      setUploadTargetFolder(selectedFolder);
      setShowUpload(true);
    }
  };

  return (
    <div 
      className={`file-manager ${isDragging ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-message">
            <span className="drop-icon">📥</span>
            <span>Drop files to upload</span>
          </div>
        </div>
      )}
      <div className="fm-header">
        <h2>📁 Data Management</h2>
        <div className="fm-actions">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            multiple
            accept=".pdf,.txt,.md,.html,.csv,.xlsx,.xls"
            style={{ display: 'none' }}
          />
          <button 
            className={`btn-primary ${(!isWorkspaceSelected() || !canUpload) ? 'disabled' : ''}`}
            onClick={() => {
              if (!canUpload) {
                alert('You need Member role or above to upload files.');
                return;
              }
              if (!isWorkspaceSelected()) {
                alert(getWorkspaceRequiredMessage());
                return;
              }
              fileInputRef.current?.click();
            }} 
            title={!canUpload ? 'Member role required to upload'
              : isWorkspaceSelected() 
              ? `Upload to: ${selectedFolder === 'root' ? 'All Documents' : folders.find(f => f.folder_id === selectedFolder)?.name || selectedFolder}`
              : 'Select a workspace first'}
            disabled={!canUpload}
          >
            📤 Upload{selectedFolder !== 'root' ? ` → ${folders.find(f => f.folder_id === selectedFolder)?.name || ''}` : ''}
          </button>
          {selectedDocs.size > 0 && canUpload && (
            <>
              <button 
                className="btn-bulk" 
                onClick={bulkGenerateGraph} 
                disabled={bulkGenerating || analyzingSchema}
                title={getFolderOntology(selectedFolder) 
                  ? `Extract entities using assigned ontology` 
                  : `Analyze documents to suggest schema`}
              >
                {bulkGenerating || analyzingSchema ? '⏳' : '🧠'} {getFolderOntology(selectedFolder) ? 'Extract' : 'Analyze'} ({selectedDocs.size})
              </button>
              <button 
                className="btn-icon" 
                onClick={() => setSelectedDocs(new Set())}
                title="Clear selection"
              >
                ✕
              </button>
            </>
          )}
          {canManageFolders && <button className="btn-icon" onClick={() => setShowNewFolder(true)} title="New Folder">📁+</button>}
          <button className="btn-icon" onClick={() => { setShowMappingTemplates(true); loadMappingTemplates(); }} title="Mapping Templates">🗺️</button>
          <button className="btn-icon" onClick={() => { loadDocuments(); loadFolders(); loadOntologies(); }} title="Refresh">🔄</button>
        </div>
      </div>

      {/* Show folder ontology info when documents are selected */}
      {selectedDocs.size > 0 && (
        <div className="fm-selection-info">
          <span className="selection-count">📄 {selectedDocs.size} selected</span>
          <div className="selection-ontology-details">
            {(() => {
              const folderOntologyId = getFolderOntology(selectedFolder);
              const ontology = folderOntologyId ? getOntologyById(folderOntologyId) : null;
              
              if (ontology) {
                // Extract entity types from ontology
                const entityTypes = ontology.nodeTypes || ontology.conceptTypes || 
                  (ontology.entityTypes || []).map(et => et.userLabel || et.label).filter(Boolean);
                const predicates = ontology.predicates || 
                  (ontology.relationships || []).map(r => r.type || r.predicate).filter(Boolean);
                
                return (
                  <div className="ontology-info">
                    <div className="ontology-name">🏷️ <strong>{ontology.name || ontology.id}</strong></div>
                    {entityTypes.length > 0 && (
                      <div className="ontology-types">
                        <span className="label">Entity Types:</span> 
                        <span className="values">{entityTypes.slice(0, 5).join(', ')}{entityTypes.length > 5 ? ` +${entityTypes.length - 5} more` : ''}</span>
                      </div>
                    )}
                    {predicates.length > 0 && (
                      <div className="ontology-predicates">
                        <span className="label">Relations:</span> 
                        <span className="values">{predicates.slice(0, 5).join(', ')}{predicates.length > 5 ? ` +${predicates.length - 5} more` : ''}</span>
                      </div>
                    )}
                    {entityTypes.length === 0 && predicates.length === 0 && (
                      <div className="ontology-warning">⚠️ Ontology has no entity types defined</div>
                    )}
                  </div>
                );
              }
              return <span className="no-ontology">⚠️ No ontology assigned to folder - LLM will auto-detect entity types</span>;
            })()}
          </div>
        </div>
      )}

      <div className="fm-search">
        <span>🔍</span>
        <input
          type="text"
          placeholder="Search files..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="fm-content">
        {/* Processing Panel - Inline Jobs */}
        {(jobs.length > 0 || stagedDocuments.length > 0) && (
          <div className={`fm-processing-panel ${showProcessingPanel ? 'expanded' : 'collapsed'}`}>
            <div className="processing-header" onClick={() => setShowProcessingPanel(!showProcessingPanel)}>
              <span className="processing-title">
                ⚙️ Processing ({jobs.filter(j => !['committed', 'cancelled'].includes(j.status) && !(j.staged && j.status === 'completed')).length + stagedDocuments.length})
              </span>
              <span className="processing-toggle">{showProcessingPanel ? '▼' : '▶'}</span>
            </div>
            {showProcessingPanel && (
              <div className="processing-list">
                {/* Staged documents ready for review */}
                {stagedDocuments.map(staged => (
                  <div key={staged.docId} className="processing-item staged">
                    <span className="item-icon">📄</span>
                    <span className="item-name">{staged.title || staged.fileName || staged.docId}</span>
                    <span className="item-status ready">Ready</span>
                    <button className="btn-sm btn-primary" onClick={() => { setSelectedStagedDocId(staged.docId); setShowStagedReview(true); }}>
                      Review
                    </button>
                    {canDelete && <button className="btn-sm btn-delete" onClick={() => deleteStagedDocument(staged.docId)} title="Delete">
                      🗑️
                    </button>}
                  </div>
                ))}
                {/* Active jobs (exclude completed+staged since they show in staged docs) */}
                {jobs.filter(j => !['committed', 'cancelled'].includes(j.status) && !(j.staged && j.status === 'completed')).map(job => (
                  <div key={job.job_id} className={`processing-item ${job.status}`}>
                    <span className="item-icon">{job.job_type === 'upload' ? '📤' : job.job_type === 'commit' ? '💾' : '🔍'}</span>
                    <span className="item-name">{job.document_title || job.file_name || job.job_id.slice(0, 8)}</span>
                    <span className={`item-status ${job.status}`}>
                      {job.status === 'processing' ? `${job.progress || 0}%` : job.status}
                    </span>
                    {job.status === 'completed' && job.job_type === 'upload' && (
                      <button className="btn-sm btn-primary" onClick={() => { setSelectedStagedDocId(job.document_id); setShowStagedReview(true); }}>
                        Review
                      </button>
                    )}
                    {job.status === 'completed' && job.job_type === 'schema_analysis' && (
                      <button className="btn-sm btn-primary" onClick={() => reviewSchemaJob(job)}>
                        Review Schema
                      </button>
                    )}
                    <button className="btn-sm btn-delete" onClick={() => deleteJob(job.job_id)} title="Delete">🗑️</button>
                  </div>
                ))}
                {/* Recently committed */}
                {jobs.filter(j => j.status === 'committed').slice(0, 3).map(job => (
                  <div key={job.job_id} className="processing-item committed">
                    <span className="item-icon">✅</span>
                    <span className="item-name">{job.document_title || job.job_id.slice(0, 8)}</span>
                    <span className="item-status committed">Done</span>
                    <button className="btn-sm btn-delete" onClick={() => deleteJob(job.job_id)} title="Clear">✕</button>
                  </div>
                ))}
                {/* Clear all button */}
                {jobs.length > 0 && (
                  <div className="processing-actions">
                    <button className="btn-sm btn-clear-all" onClick={clearCompletedJobs}>
                      Clear completed
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* File Tree */}
        <div className="fm-split">
        <div className="fm-tree">
          {loading ? (
            <div className="fm-loading">Loading...</div>
          ) : (
            <div className="tree-container">
              {/* Root folder */}
              <div className="tree-folder">
                <div 
                  className={`folder-header ${selectedFolder === 'root' ? 'selected' : ''}`}
                  onClick={() => { toggleFolderExpand('root'); setSelectedFolder('root'); }}
                >
                  <span className="folder-icon">{expandedFolders.has('root') ? '📂' : '📁'}</span>
                  <span className="folder-name">All Documents</span>
                  <span className="folder-count">{getDocumentsInFolder('root').length}</span>
                </div>
                {expandedFolders.has('root') && (
                  <div className="folder-contents">
                    {getDocumentsInFolder('root').map(doc => (
                      <div
                        key={doc.doc_id}
                        className={`tree-file ${selectedDocument?.doc_id === doc.doc_id ? 'selected' : ''} ${selectedDocs.has(doc.doc_id) ? 'checked' : ''}`}
                        onClick={() => selectDocument(doc)}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('docId', doc.doc_id)}
                      >
                        <input 
                          type="checkbox" 
                          className="file-checkbox"
                          checked={selectedDocs.has(doc.doc_id)}
                          onChange={(e) => toggleDocSelection(doc.doc_id, e)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="file-icon">{getDocIcon(doc.doc_type)}</span>
                        <span className="file-name">{doc.title || 'Untitled'}</span>
                        {isTabularType(doc.doc_type) && (
                          <button className="btn-tiny" title="View spreadsheet" onClick={(e) => { e.stopPropagation(); setSheetViewerDoc(doc); }}>👁️</button>
                        )}
                        <span className="file-meta">{doc.entity_count || 0}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Custom folders */}
              {folders.map(folder => (
                <div key={folder.folder_id} className="tree-folder">
                  <div 
                    className={`folder-header ${selectedFolder === folder.folder_id ? 'selected' : ''}`}
                    onClick={() => { toggleFolderExpand(folder.folder_id); setSelectedFolder(folder.folder_id); }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const docId = e.dataTransfer.getData('docId');
                      if (docId) moveDocumentToFolder(docId, folder.folder_id);
                    }}
                  >
                    <span className="folder-icon">{expandedFolders.has(folder.folder_id) ? '📂' : '📁'}</span>
                    <span className="folder-name">{folder.name}</span>
                    {folder.ontology_id && (
                      <span className="folder-ontology" title={`Ontology: ${getOntologyById(folder.ontology_id)?.name || folder.ontology_id}`}>
                        🏷️
                      </span>
                    )}
                    <span className="folder-count">{getDocumentsInFolder(folder.folder_id).length}</span>
                    {canManageFolders && (
                      <>
                        <button 
                          className="btn-tiny" 
                          onClick={(e) => { e.stopPropagation(); setEditingFolder(folder); }}
                          title="Edit folder"
                        >✏️</button>
                        <button 
                          className="btn-tiny" 
                          onClick={(e) => { e.stopPropagation(); deleteFolder(folder.folder_id); }}
                          title="Delete folder"
                        >×</button>
                      </>
                    )}
                  </div>
                  {expandedFolders.has(folder.folder_id) && (
                    <div className="folder-contents">
                      {getDocumentsInFolder(folder.folder_id).map(doc => (
                        <div
                          key={doc.doc_id}
                          className={`tree-file ${selectedDocument?.doc_id === doc.doc_id ? 'selected' : ''} ${selectedDocs.has(doc.doc_id) ? 'checked' : ''}`}
                          onClick={() => selectDocument(doc)}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData('docId', doc.doc_id)}
                        >
                          <input 
                            type="checkbox" 
                            className="file-checkbox"
                            checked={selectedDocs.has(doc.doc_id)}
                            onChange={(e) => toggleDocSelection(doc.doc_id, e)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className="file-icon">{getDocIcon(doc.doc_type)}</span>
                          <span className="file-name">{doc.title || 'Untitled'}</span>
                          {isTabularType(doc.doc_type) && (
                            <button className="btn-tiny" title="View spreadsheet" onClick={(e) => { e.stopPropagation(); setSheetViewerDoc(doc); }}>👁️</button>
                          )}
                          <span className="file-meta">{doc.entity_count || 0}</span>
                        </div>
                      ))}
                      {getDocumentsInFolder(folder.folder_id).length === 0 && (
                        <div className="empty-folder">Drop files here</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Details Panel */}
        <div className="fm-details">
          {!selectedDocument ? (
            <div className="fm-empty">
              <span className="empty-icon">📂</span>
              <p className="empty-title">No document selected</p>
              <p className="empty-hint">
                {documents.length === 0 
                  ? 'Upload files using the 📤 Upload button or drag & drop files here'
                  : 'Click a document in the sidebar to view its details'}
              </p>
            </div>
          ) : detailsLoading ? (
            <div className="fm-loading">Loading details...</div>
          ) : documentDetails ? (
            <div className="doc-details">
              <div className="doc-header">
                <div className="doc-title-row">
                  <h3>{getDocIcon(documentDetails.document?.doc_type)} {documentDetails.document?.title}</h3>
                  <div className="doc-actions">
                    <button 
                      className="btn-generate" 
                      onClick={() => generateGraphForDocument(documentDetails.document?.doc_id)}
                      disabled={detailsLoading || analyzingSchema || !canUpload}
                      title={canUpload ? "Extract entities using guided wizard" : "Member role required"}
                    >
                      🧠 Extract
                    </button>
                    <button className="btn-sm" onClick={() => setSheetViewerDoc(documentDetails.document)} title="Open spreadsheet view of entity data">
                      📊 Sheet
                    </button>
                    {canDelete && <button className="btn-delete" onClick={() => deleteDocument(documentDetails.document?.doc_id)}>🗑️</button>}
                  </div>
                </div>
                <div className="doc-badges">
                  <span className="badge">{documentDetails.document?.doc_type?.toUpperCase()}</span>
                  <span className="badge secondary">{formatDate(documentDetails.document?.created_at)}</span>
                </div>
              </div>

              <div className="doc-stats">
                <div className="stat"><strong>{documentDetails.stats?.chunkCount || 0}</strong> {isTabularType(documentDetails.document?.doc_type) ? 'Rows' : 'Chunks'}</div>
                <div className="stat"><strong>{documentDetails.stats?.conceptCount || 0}</strong> Entities</div>
                <div className="stat"><strong>{documentDetails.stats?.relationCount || 0}</strong> Relations</div>
                {documentDetails.document?.chunks_stored > 0 && (
                  <div className="stat stat-search"><strong>{documentDetails.document.chunks_stored}</strong> Searchable</div>
                )}
              </div>

              {documentDetails.note && (
                <div className="doc-note">
                  ⚠️ {documentDetails.note}
                </div>
              )}

              <div className="doc-tabs">
                {isTabularType(documentDetails.document?.doc_type) ? (
                  <>
                    <button className={`tab ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}>
                      Data
                    </button>
                  </>
                ) : (
                  <>
                    <button className={`tab ${activeTab === 'chunks' ? 'active' : ''}`} onClick={() => setActiveTab('chunks')}>
                      Chunks ({documentDetails.stats?.chunkCount || 0})
                    </button>
                  </>
                )}
                <button className={`tab ${activeTab === 'entities' ? 'active' : ''}`} onClick={() => setActiveTab('entities')}>
                  Entities ({documentDetails.stats?.conceptCount || 0})
                </button>
                <button className={`tab ${activeTab === 'relations' ? 'active' : ''}`} onClick={() => setActiveTab('relations')}>
                  Relations ({documentDetails.stats?.relationCount || 0})
                </button>
                {documentDetails.document?.ontology_id && (
                  <button className={`tab ${activeTab === 'mapping' ? 'active' : ''}`} onClick={() => {
                    setActiveTab('mapping');
                    if (!docMapping) loadDocumentMapping(documentDetails.document.ontology_id, documentDetails.document.workspace_id || currentWorkspace?.workspace_id);
                  }}>
                    Mapping
                  </button>
                )}
              </div>

              <div className="tab-content">
                {/* CSV Data Tab */}
                {activeTab === 'data' && isTabularType(documentDetails.document?.doc_type) && (
                  <CSVDataView docUri={documentDetails.document?.uri} />
                )}

                {/* Chunks Tab (PDF/Text) */}
                {activeTab === 'chunks' && (
                  <div className="chunks-list">
                    {documentDetails.chunks?.map((chunk, idx) => (
                      <div key={chunk.uri || idx} className="chunk-item">
                        <div className="chunk-header" onClick={() => toggleChunkExpand(chunk.order)}>
                          <span className="chunk-num">#{chunk.order + 1}</span>
                          {chunk.start_page && <span className="chunk-page">p.{chunk.start_page}</span>}
                          <span className="chunk-chars">{chunk.char_count || 0}c</span>
                          <span className="expand">{expandedChunks.has(chunk.order) ? '▼' : '▶'}</span>
                          {canDelete && <button 
                            className="btn-tiny-delete" 
                            onClick={(e) => { e.stopPropagation(); deleteChunk(chunk.chunk_id); }}
                            title="Delete chunk"
                          >🗑️</button>}
                        </div>
                        {expandedChunks.has(chunk.order) && (
                          <div className="chunk-text">{chunk.text || 'No text'}</div>
                        )}
                      </div>
                    ))}
                    {(!documentDetails.chunks || documentDetails.chunks.length === 0) && (
                      <div className="empty-tab">No chunks in this document</div>
                    )}
                  </div>
                )}

                {/* Entities Tab */}
                {activeTab === 'entities' && (
                  <div className="entities-list">
                    <div className="tab-toolbar">
                      <div className="toolbar-row">
                        <div className="toolbar-search">
                          <span className="toolbar-search-icon">🔍</span>
                          <input
                            type="text"
                            placeholder="Search all entities..."
                            value={entitySearch}
                            onChange={(e) => handleEntitySearchChange(e.target.value)}
                          />
                          {entitySearch && (
                            <button className="toolbar-clear" onClick={() => handleEntitySearchChange('')}>✕</button>
                          )}
                        </div>
                        <select
                          className="toolbar-filter"
                          value={entityTypeFilter}
                          onChange={(e) => handleEntityTypeFilterChange(e.target.value)}
                        >
                          <option value="">All types ({allEntityTypesFromServer.length})</option>
                          {allEntityTypesFromServer.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        {canUpload && <button className="btn-sm btn-primary" onClick={() => setShowAddEntity(true)}>+ Add</button>}
                      </div>
                      <div className="toolbar-row toolbar-actions-row">
                        <label className="toolbar-select-all">
                          <input
                            type="checkbox"
                            checked={concepts.length > 0 && selectedEntities.size === concepts.length}
                            onChange={selectAllEntities}
                          />
                          <span>Select all ({concepts.length})</span>
                        </label>
                        {selectedEntities.size > 0 && canDelete && (
                          <div className="toolbar-bulk">
                            <span className="toolbar-bulk-count">{selectedEntities.size} selected</span>
                            <button className="btn-sm btn-danger" onClick={deleteSelectedEntities}>🗑️ Delete</button>
                          </div>
                        )}
                      </div>
                    </div>
                    {concepts.map((concept, idx) => {
                      const entityId = concept.uri || concept.concept_id;
                      return (
                      <div key={entityId || idx} className={`entity-item ${selectedEntities.has(entityId) ? 'selected' : ''}`}>
                        {editingEntity === idx ? (
                          <EntityEditor
                            entity={concept}
                            onChange={(updated) => {
                              const newConcepts = [...documentDetails.concepts];
                              newConcepts[idx] = updated;
                              setDocumentDetails({...documentDetails, concepts: newConcepts});
                            }}
                            onSave={() => saveEntity(concept)}
                            onCancel={() => setEditingEntity(null)}
                            saving={saving}
                            entityTypes={entityTypes}
                          />
                        ) : (
                          <div className="entity-row">
                            <input
                              type="checkbox"
                              className="entity-checkbox"
                              checked={selectedEntities.has(entityId)}
                              onChange={(e) => toggleEntitySelect(entityId, e)}
                            />
                            <span className="entity-type-badge" style={{backgroundColor: getTypeColor(concept.type)}}>
                              {concept.type}
                            </span>
                            <span className="entity-label">{concept.label}</span>
                            {concept.confidence && (
                              <span className="entity-confidence">{Math.round(concept.confidence * 100)}%</span>
                            )}
                            <div className="entity-actions">
                              {canUpload && <button className="btn-tiny" onClick={() => setEditingEntity(idx)} title="Edit">✏️</button>}
                              {canDelete && <button className="btn-tiny" onClick={() => deleteEntity(concept.concept_id || concept.uri)} title="Delete">🗑️</button>}
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                    {concepts.length === 0 && (entitySearch || entityTypeFilter) && (
                      <div className="empty-tab">No entities match your search/filter across all data</div>
                    )}
                    {concepts.length === 0 && !entitySearch && !entityTypeFilter && (
                      <div className="empty-tab">No entities extracted yet. Use "Extract" or "Analyze" to find entities.</div>
                    )}
                    {documentDetails?.pagination?.entities && concepts.length > 0 && (
                      <div className="pagination-controls">
                        <span className="pagination-info">
                          Showing {concepts.length} of {documentDetails.pagination.entities.total}
                          {entitySearch || entityTypeFilter ? ' (filtered)' : ''} entities
                        </span>
                        {concepts.length < documentDetails.pagination.entities.total && (
                          <button className="btn-load-more" onClick={loadMoreEntities} disabled={detailsLoading}>
                            {detailsLoading ? '⏳ Loading...' : `Load more (${documentDetails.pagination.entities.total - concepts.length} remaining)`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Relations Tab */}
                {activeTab === 'relations' && (
                  <div className="relations-list">
                    <div className="tab-toolbar">
                      <div className="toolbar-row">
                        <div className="toolbar-search">
                          <span className="toolbar-search-icon">🔍</span>
                          <input
                            type="text"
                            placeholder="Search all relations..."
                            value={relationSearch}
                            onChange={(e) => handleRelationSearchChange(e.target.value)}
                          />
                          {relationSearch && (
                            <button className="toolbar-clear" onClick={() => handleRelationSearchChange('')}>✕</button>
                          )}
                        </div>
                        <select
                          className="toolbar-filter"
                          value={relationPredicateFilter}
                          onChange={(e) => handleRelationPredicateFilterChange(e.target.value)}
                        >
                          <option value="">All predicates ({allPredicatesFromServer.length})</option>
                          {allPredicatesFromServer.map(p => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                        {canUpload && <button className="btn-sm btn-primary" onClick={() => setShowAddRelation(true)}>+ Add</button>}
                      </div>
                      <div className="toolbar-row toolbar-actions-row">
                        <label className="toolbar-select-all">
                          <input
                            type="checkbox"
                            checked={relations.length > 0 && selectedRelations.size === relations.length}
                            onChange={selectAllRelations}
                          />
                          <span>Select all ({relations.length})</span>
                        </label>
                        {selectedRelations.size > 0 && canDelete && (
                          <div className="toolbar-bulk">
                            <span className="toolbar-bulk-count">{selectedRelations.size} selected</span>
                            <button className="btn-sm btn-danger" onClick={deleteSelectedRelations}>🗑️ Delete</button>
                          </div>
                        )}
                      </div>
                    </div>
                    {relations.map((rel, idx) => (
                      <div key={idx} className={`relation-item ${selectedRelations.has(idx) ? 'selected' : ''}`}>
                        {editingRelation === idx ? (
                          <RelationEditor
                            relation={rel}
                            onSave={(predicate) => updateRelationship({...rel, predicate})}
                            onCancel={() => setEditingRelation(null)}
                            saving={saving}
                          />
                        ) : (
                          <div className="relation-row">
                            <input
                              type="checkbox"
                              className="relation-checkbox"
                              checked={selectedRelations.has(idx)}
                              onChange={(e) => toggleRelationSelect(idx, e)}
                            />
                            <span className="rel-source">{rel.source}</span>
                            <span className="rel-predicate">{rel.predicate || rel.type}</span>
                            <span className="rel-target">{rel.target}</span>
                            <div className="relation-actions">
                              {canUpload && <button className="btn-tiny" onClick={() => setEditingRelation(idx)} title="Edit">✏️</button>}
                              {canDelete && <button className="btn-tiny" onClick={() => deleteRelationship(rel)} title="Delete">🗑️</button>}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {relations.length === 0 && (relationSearch || relationPredicateFilter) && (
                      <div className="empty-tab">No relations match your search/filter across all data</div>
                    )}
                    {relations.length === 0 && !relationSearch && !relationPredicateFilter && (
                      <div className="empty-tab">No relations found. Extract entities first to discover relationships.</div>
                    )}
                    {documentDetails?.pagination?.relations && relations.length > 0 && (
                      <div className="pagination-controls">
                        <span className="pagination-info">
                          Showing {relations.length} of {documentDetails.pagination.relations.total}
                          {relationSearch || relationPredicateFilter ? ' (filtered)' : ''} relations
                        </span>
                        {relations.length < documentDetails.pagination.relations.total && (
                          <button className="btn-load-more" onClick={loadMoreRelations} disabled={detailsLoading}>
                            {detailsLoading ? '⏳ Loading...' : `Load more (${documentDetails.pagination.relations.total - relations.length} remaining)`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Mapping Tab */}
                {activeTab === 'mapping' && (
                  <div className="mapping-view">
                    {mappingLoading ? (
                      <div className="fm-loading">Loading mapping...</div>
                    ) : docMapping ? (
                      <>
                        <div className="mapping-header-info">
                          <div className="mapping-meta">
                            <span className="mapping-version">v{docMapping.version || 1}</span>
                            <span className="mapping-date">Saved {docMapping.savedAt ? new Date(docMapping.savedAt).toLocaleDateString() : 'N/A'}</span>
                            {docMapping.primaryClass && (
                              <span className="mapping-primary-class">Primary: {docMapping.primaryClass.split('#').pop() || docMapping.primaryClass}</span>
                            )}
                          </div>
                          {documentDetails.document?.chunks_stored > 0 && (
                            <span className="mapping-chunks-badge">{documentDetails.document.chunks_stored} chunks stored for search</span>
                          )}
                        </div>
                        {docMapping.ontologyStale && (
                          <div className="mapping-stale-warning">
                            <span className="mapping-stale-icon">⚠️</span>
                            <div className="mapping-stale-text">
                              <strong>Ontology has changed</strong> since this mapping was saved.
                              {docMapping.ontologyStale.diff && (
                                <span className="mapping-stale-diff">
                                  {docMapping.ontologyStale.diff.classes_removed > 0 && ` ${docMapping.ontologyStale.diff.classes_removed} classes removed.`}
                                  {docMapping.ontologyStale.diff.properties_removed > 0 && ` ${docMapping.ontologyStale.diff.properties_removed} properties removed.`}
                                  {docMapping.ontologyStale.diff.classes_added > 0 && ` ${docMapping.ontologyStale.diff.classes_added} classes added.`}
                                  {docMapping.ontologyStale.diff.properties_added > 0 && ` ${docMapping.ontologyStale.diff.properties_added} properties added.`}
                                </span>
                              )}
                              <span className="mapping-stale-hint"> Re-upload to update mappings.</span>
                            </div>
                          </div>
                        )}
                        <table className="mapping-table">
                          <thead>
                            <tr>
                              <th>Column</th>
                              <th>Property</th>
                              <th>Links To</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(docMapping.mappings).map(([col, map]) => (
                              <tr key={col} className={map.ignore ? 'mapping-ignored' : ''}>
                                <td className="mapping-col-name">{col}</td>
                                <td className="mapping-property">{map.property ? (map.property.includes('#') ? map.property.split('#').pop() : map.property) : <span className="mapping-auto">auto</span>}</td>
                                <td className="mapping-linked">{map.linkedClass ? (map.linkedClass.includes('#') ? map.linkedClass.split('#').pop() : map.linkedClass) : <span className="mapping-literal">Literal</span>}</td>
                                <td>{map.ignore ? <span className="mapping-status-ignored">Ignored</span> : <span className="mapping-status-mapped">Mapped</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {docMapping.versions && docMapping.versions.length > 0 && (
                          <div className="mapping-history">
                            <h4>Version History</h4>
                            <div className="mapping-history-list">
                              {docMapping.versions.map((v, i) => (
                                <div key={i} className="mapping-history-item">
                                  <span className="mapping-history-version">v{v.version}</span>
                                  <span className="mapping-history-date">{v.savedAt ? new Date(v.savedAt).toLocaleDateString() : ''}</span>
                                  <span className="mapping-history-cols">{v.columnCount} columns</span>
                                  {v.primaryClass && <span className="mapping-history-class">{v.primaryClass.split('#').pop()}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="empty-tab">
                        No column mapping found for this document's ontology.
                        {documentDetails.document?.chunks_stored > 0 && (
                          <p className="mapping-chunks-note">{documentDetails.document.chunks_stored} chunks are stored permanently in Redis for RAG search.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>{/* end fm-split */}
      </div>{/* end fm-content */}

      {/* Modals */}
      {showNewFolder && (
        <Modal onClose={() => setShowNewFolder(false)}>
          <h3>New Folder</h3>
          <div className="form-group">
            <label>Folder Name</label>
            <input
              type="text"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Assign Ontology (optional)</label>
            <select value={newFolderOntology} onChange={(e) => setNewFolderOntology(e.target.value)}>
              <option value="">No ontology (use auto-detection)</option>
              {ontologies.map(ont => (
                <option key={ont.ontologyId || ont.id} value={ont.ontologyId || ont.id}>
                  {ont.label || ont.name || ont.ontologyId || ont.id}
                </option>
              ))}
            </select>
            <small className="form-hint">Documents uploaded to this folder will use this ontology for graph generation</small>
          </div>
          <div className="modal-actions">
            <button onClick={() => setShowNewFolder(false)}>Cancel</button>
            <button className="primary" onClick={createFolder}>Create</button>
          </div>
        </Modal>
      )}

      {showAddEntity && (
        <AddEntityModal
          chunks={documentDetails?.chunks || []}
          onAdd={addEntity}
          onClose={() => setShowAddEntity(false)}
          saving={saving}
          entityTypes={entityTypes}
        />
      )}

      {showAddRelation && (
        <AddRelationModal
          concepts={documentDetails?.concepts || []}
          onAdd={addRelationship}
          onClose={() => setShowAddRelation(false)}
          saving={saving}
        />
      )}

      {showUpload && (
        <UploadModal
          files={uploadFiles}
          uploading={uploading}
          progress={uploadProgress}
          selectedFolder={uploadTargetFolder || selectedFolder}
          folders={folders}
          ontologies={ontologies}
          getFolderOntology={getFolderOntology}
          getOntologyById={getOntologyById}
          onUpload={uploadAndProcess}
          onClose={closeUploadModal}
          onFolderChange={setUploadTargetFolder}
        />
      )}

      {editingFolder && (
        <FolderEditModal
          folder={editingFolder}
          ontologies={ontologies}
          onSave={(updates) => updateFolder(editingFolder.folder_id, updates)}
          onClose={() => setEditingFolder(null)}
        />
      )}

      {showReview && reviewData && (
        <ReviewModal
          data={reviewData}
          onApprove={approveExtraction}
          onClose={() => { setShowReview(false); setReviewData(null); }}
        />
      )}

      {showSchemaAnalysis && schemaAnalysis && (
        <SchemaAnalysisModal
          analysis={schemaAnalysis}
          onSaveAsOntology={async (name, description) => {
            try {
              const response = await fetch(`${API_BASE_URL}/ontology/custom-ontology`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
                body: JSON.stringify({
                  name,
                  description,
                  workspace_id: currentWorkspace?.workspace_id || '',
                  entityTypes: schemaAnalysis.entityTypes?.filter(e => e.include !== false).map(e => ({
                    label: e.userLabel || e.label,
                    userLabel: e.userLabel || e.label,
                    description: e.description || '',
                    // Include properties - convert string array to property objects
                    properties: (e.suggestedProperties || e.properties || []).map(p => 
                      typeof p === 'string' ? { name: p, data_type: 'string' } : p
                    )
                  })) || [],
                  relationships: schemaAnalysis.relationships?.filter(r => r.include !== false).map(r => ({
                    type: r.userPredicate || r.predicate,
                    predicate: r.userPredicate || r.predicate,
                    from: r.from,
                    to: r.to,
                    description: r.description || ''
                  })) || []
                })
              });
              
              const result = await response.json();
              if (response.ok) {
                alert(`✅ Ontology "${name}" created successfully!`);
                setShowSchemaAnalysis(false);
                setSchemaAnalysis(null);
                setSelectedDocs(new Set());
                loadOntologies();
              } else {
                alert(`❌ ${result.error || 'Failed to save ontology'}`);
              }
            } catch (error) {
              alert(`❌ ${error.message}`);
            }
          }}
          onClose={() => { setShowSchemaAnalysis(false); setSchemaAnalysis(null); }}
        />
      )}

      {showStagedReview && selectedStagedDocId && (
        <StagedDocumentReview
          docId={selectedStagedDocId}
          onClose={() => { setShowStagedReview(false); setSelectedStagedDocId(null); }}
          onCommitted={() => { 
            setShowStagedReview(false); 
            setSelectedStagedDocId(null); 
            loadDocuments(); 
            loadStagedDocuments();
            loadJobs();
          }}
        />
      )}

      {showExtractionWizard && wizardDocId && (
        <ExtractionWizardModal
          docId={wizardDocId}
          documents={documents}
          folders={folders}
          ontologies={ontologies}
          selectedFolder={selectedFolder}
          getFolderOntology={getFolderOntology}
          getOntologyById={getOntologyById}
          getTenantHeaders={getTenantHeaders}
          currentWorkspace={currentWorkspace}
          onDone={onExtractionWizardDone}
          onClose={() => { setShowExtractionWizard(false); setWizardDocId(null); }}
        />
      )}

      {sheetViewerDoc && (
        <SheetView
          doc={sheetViewerDoc}
          onClose={() => setSheetViewerDoc(null)}
        />
      )}

      {showMappingTemplates && (
        <Modal onClose={() => setShowMappingTemplates(false)}>
          <div className="mapping-templates-modal">
            <h3>🗺️ Mapping Templates</h3>
            <p className="mapping-templates-desc">Saved column mappings per ontology. These are auto-applied when uploading new files with the same ontology.</p>
            {mappingTemplatesLoading ? (
              <div className="fm-loading">Loading...</div>
            ) : mappingTemplates.length === 0 ? (
              <div className="empty-tab">No mapping templates saved yet. Mappings are created when you commit a CSV/Excel file with column mappings.</div>
            ) : (
              <div className="mapping-templates-list">
                {mappingTemplates.map((t, i) => (
                  <div key={i} className="mapping-template-card">
                    <div className="mapping-template-header">
                      <span className="mapping-template-name">{t.ontologyName}</span>
                      <span className="mapping-version">v{t.version}</span>
                    </div>
                    <div className="mapping-template-meta">
                      <span>{t.columnCount} columns</span>
                      {t.primaryClass && <span>Primary: {t.primaryClass.split('#').pop()}</span>}
                      <span>Saved {t.savedAt ? new Date(t.savedAt).toLocaleDateString() : 'N/A'}</span>
                    </div>
                    {t.sourceHeaders && t.sourceHeaders.length > 0 && (
                      <div className="mapping-template-columns">
                        {t.sourceHeaders.slice(0, 8).map((h, j) => (
                          <span key={j} className="mapping-template-col">{h}</span>
                        ))}
                        {t.sourceHeaders.length > 8 && <span className="mapping-template-col more">+{t.sourceHeaders.length - 8}</span>}
                      </div>
                    )}
                    <div className="mapping-template-actions">
                      {canDelete && (
                        <button className="btn-sm btn-danger" onClick={() => deleteMappingTemplate(t.ontologyId)}>🗑️ Delete</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// Extraction Wizard - guided flow for Extract/Analyze on committed documents
function ExtractionWizardModal({
  docId, documents, folders, ontologies, selectedFolder,
  getFolderOntology, getOntologyById, getTenantHeaders,
  currentWorkspace, onDone, onClose
}) {
  const doc = documents.find(d => d.doc_id === docId);
  const folderOntologyId = doc?.folderId ? getFolderOntology(doc.folderId) : getFolderOntology(selectedFolder);

  const [step, setStep] = useState(1); // 1: select ontology, 2: confirm/analyze, 3: extracting
  const [selectedOntId, setSelectedOntId] = useState(folderOntologyId || '');
  const [analyzing, setAnalyzing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [schemaResult, setSchemaResult] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [pollStatus, setPollStatus] = useState(null);

  const selectedOntology = selectedOntId ? getOntologyById(selectedOntId) : null;

  const entityTypes = selectedOntology?.entityTypes || selectedOntology?.nodeTypes || selectedOntology?.conceptTypes || [];
  const relationships = selectedOntology?.relationships || selectedOntology?.predicates || [];

  // Step 2a: Analyze document to suggest schema (no ontology)
  const analyzeSchema = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch('/api/ontology/documents/analyze-for-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          docIds: [docId],
          industry: doc?.industry || 'general',
          workspace_id: currentWorkspace?.workspace_id || ''
        })
      });
      const data = await res.json();
      if (res.ok && data.jobId) {
        setJobId(data.jobId);
        setPollStatus('pending');
        pollJob(data.jobId);
      } else {
        setError(data.error || 'Failed to start analysis');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Poll job until complete
  const pollJob = (jid) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/ontology/jobs/${jid}`, { headers: getTenantHeaders() });
        const data = await res.json();
        if (!data.success) return;
        const job = data.job;
        setPollStatus(job.status);
        if (job.status === 'completed' || job.status === 'committed') {
          clearInterval(interval);
          if (job.suggested_ontology) {
            setSchemaResult({
              ...job.suggested_ontology,
              industry: doc?.industry || 'general',
              documentName: doc?.title || docId
            });
            setStep(2);
          }
        } else if (job.status === 'failed') {
          clearInterval(interval);
          setError(job.error || job.progress_message || 'Analysis failed');
        }
      } catch (e) { /* retry */ }
    }, 2000);
  };

  // Save schema as ontology, then move to extraction
  const saveSchemaAsOntology = async (name) => {
    try {
      const res = await fetch('/api/ontology/custom-ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          name,
          description: `Auto-generated from ${doc?.title || 'document'}`,
          workspace_id: currentWorkspace?.workspace_id || '',
          entityTypes: (schemaResult.entityTypes || []).filter(e => e.include !== false).map(e => ({
            label: e.userLabel || e.label,
            userLabel: e.userLabel || e.label,
            description: e.description || '',
            properties: (e.suggestedProperties || []).map(p => typeof p === 'string' ? { name: p, data_type: 'string' } : p)
          })),
          relationships: (schemaResult.relationships || []).filter(r => r.include !== false).map(r => ({
            type: r.userPredicate || r.predicate,
            predicate: r.userPredicate || r.predicate,
            from: r.from, to: r.to,
            description: r.description || ''
          }))
        })
      });
      const data = await res.json();
      if (res.ok && data.ontologyId) {
        setSelectedOntId(data.ontologyId);
        setSchemaResult(null);
        setStep(1); // Go back to step 1 with new ontology selected
      } else {
        setError(data.error || 'Failed to save ontology');
      }
    } catch (e) {
      setError(e.message);
    }
  };

  // Start extraction with selected ontology
  const startExtraction = async () => {
    if (!selectedOntology) return;
    setExtracting(true);
    setError(null);
    try {
      const existingOntology = {
        entityTypes: entityTypes,
        relationships: relationships,
        datatypeProperties: selectedOntology.datatypeProperties || []
      };
      const res = await fetch(`/api/ontology/documents/${docId}/start-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          existingOntology,
          industry: selectedOntology?.name || selectedOntology?.domain || doc?.industry || 'general'
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStep(3);
        setJobId(data.jobId);
      } else {
        setError(data.error || 'Extraction failed');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content extraction-wizard" onClick={e => e.stopPropagation()}>
        <div className="wizard-header">
          <h3>🧠 Extract Entities — {doc?.title || docId}</h3>
          <button className="review-close" onClick={onClose}>×</button>
        </div>

        {/* Step indicator */}
        <div className="wizard-steps">
          <div className={`wizard-step ${step >= 1 ? 'active' : ''}`}>
            <span className="step-num">1</span> Select Ontology
          </div>
          <div className="wizard-step-arrow">→</div>
          <div className={`wizard-step ${step >= 2 ? 'active' : ''}`}>
            <span className="step-num">2</span> Review
          </div>
          <div className="wizard-step-arrow">→</div>
          <div className={`wizard-step ${step >= 3 ? 'active' : ''}`}>
            <span className="step-num">3</span> Extract
          </div>
        </div>

        {error && <div className="wizard-error">❌ {error}</div>}

        {/* Polling indicator */}
        {pollStatus && !['completed', 'committed', 'failed'].includes(pollStatus) && (
          <div className="wizard-polling">
            ⏳ Analyzing document... ({pollStatus})
          </div>
        )}

        {/* Step 1: Select ontology */}
        {step === 1 && !pollStatus?.match(/pending|extracting|analyzing|processing/) && (
          <div className="wizard-body">
            <div className="form-group">
              <label>Ontology for extraction</label>
              <select value={selectedOntId} onChange={e => setSelectedOntId(e.target.value)}>
                <option value="">— No ontology (analyze first) —</option>
                {ontologies.map(o => (
                  <option key={o.ontologyId || o.id} value={o.ontologyId || o.id}>
                    {o.label || o.name || o.id}
                    {(o.ontologyId || o.id) === folderOntologyId ? ' (folder default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedOntology && (
              <div className="wizard-ontology-preview">
                <h4>📋 {selectedOntology.name || selectedOntology.id}</h4>
                {entityTypes.length > 0 && (
                  <div className="preview-section">
                    <span className="preview-label">Entity Types ({entityTypes.length}):</span>
                    <div className="preview-tags">
                      {entityTypes.slice(0, 10).map((et, i) => (
                        <span key={i} className="preview-tag">{et.userLabel || et.label || et}</span>
                      ))}
                      {entityTypes.length > 10 && <span className="preview-more">+{entityTypes.length - 10} more</span>}
                    </div>
                  </div>
                )}
                {relationships.length > 0 && (
                  <div className="preview-section">
                    <span className="preview-label">Relationships ({relationships.length}):</span>
                    <div className="preview-tags">
                      {relationships.slice(0, 8).map((r, i) => (
                        <span key={i} className="preview-tag rel">{r.type || r.predicate || r}</span>
                      ))}
                      {relationships.length > 8 && <span className="preview-more">+{relationships.length - 8} more</span>}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="wizard-actions">
              {selectedOntId ? (
                <button className="btn-primary" onClick={startExtraction} disabled={extracting}>
                  {extracting ? '⏳ Starting...' : '🧠 Extract Entities'}
                </button>
              ) : (
                <button className="btn-primary" onClick={analyzeSchema} disabled={analyzing}>
                  {analyzing ? '⏳ Starting...' : '🔍 Analyze Document'}
                </button>
              )}
              <button onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {/* Step 2: Review schema analysis results */}
        {step === 2 && schemaResult && (
          <div className="wizard-body">
            <h4>🔍 Suggested Schema</h4>
            <p className="wizard-hint">Review the suggested entity types and relationships. Save as an ontology to use for extraction.</p>

            <div className="wizard-schema-results">
              <div className="schema-section">
                <h5>Entity Types ({schemaResult.entityTypes?.length || 0})</h5>
                <div className="schema-items">
                  {(schemaResult.entityTypes || []).map((et, i) => (
                    <div key={i} className={`schema-item ${et.include === false ? 'excluded' : ''}`}>
                      <input type="checkbox" checked={et.include !== false}
                        onChange={() => {
                          const updated = [...schemaResult.entityTypes];
                          updated[i] = { ...updated[i], include: !updated[i].include === false ? true : !(updated[i].include !== false) };
                          setSchemaResult({ ...schemaResult, entityTypes: updated });
                        }}
                      />
                      <span className="schema-item-name">{et.userLabel || et.label}</span>
                      {et.description && <span className="schema-item-desc">{et.description}</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="schema-section">
                <h5>Relationships ({schemaResult.relationships?.length || 0})</h5>
                <div className="schema-items">
                  {(schemaResult.relationships || []).map((r, i) => (
                    <div key={i} className={`schema-item ${r.include === false ? 'excluded' : ''}`}>
                      <input type="checkbox" checked={r.include !== false}
                        onChange={() => {
                          const updated = [...schemaResult.relationships];
                          updated[i] = { ...updated[i], include: !(updated[i].include !== false) };
                          setSchemaResult({ ...schemaResult, relationships: updated });
                        }}
                      />
                      <span className="schema-item-name">{r.from} → {r.userPredicate || r.predicate} → {r.to}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="wizard-actions">
              <button className="btn-primary" onClick={() => saveSchemaAsOntology(doc?.title ? `${doc.title} Schema` : 'New Schema')}>
                💾 Save as Ontology & Continue
              </button>
              <button onClick={() => { setStep(1); setSchemaResult(null); }}>← Back</button>
            </div>
          </div>
        )}

        {/* Step 3: Extraction started */}
        {step === 3 && (
          <div className="wizard-body wizard-done">
            <span className="done-icon">✅</span>
            <h4>Extraction Started</h4>
            <p>Job ID: <code>{jobId}</code></p>
            <p className="wizard-hint">Monitor progress in the Processing panel. Results will appear in the Entities and Relations tabs.</p>
            <div className="wizard-actions">
              <button className="btn-primary" onClick={onDone}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Sub-components
function Modal({ children, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function EntityEditor({ entity, onChange, onSave, onCancel, saving, entityTypes }) {
  // Ensure current type is in the list
  const allTypes = entityTypes.includes(entity.type) 
    ? entityTypes 
    : [entity.type, ...entityTypes].sort();
    
  return (
    <div className="entity-editor">
      <input
        type="text"
        value={entity.label}
        onChange={(e) => onChange({...entity, label: e.target.value})}
        placeholder="Label"
      />
      <select value={entity.type} onChange={(e) => onChange({...entity, type: e.target.value})}>
        {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <textarea
        value={entity.description || ''}
        onChange={(e) => onChange({...entity, description: e.target.value})}
        placeholder="Description"
        rows={2}
      />
      <div className="editor-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function RelationEditor({ relation, onSave, onCancel, saving }) {
  const [predicate, setPredicate] = useState(relation.predicate || '');
  
  return (
    <div className="relation-editor">
      <span>{relation.source}</span>
      <input
        type="text"
        value={predicate}
        onChange={(e) => setPredicate(e.target.value)}
        placeholder="Predicate"
      />
      <span>{relation.target}</span>
      <div className="editor-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={() => onSave(predicate)} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function AddEntityModal({ chunks, onAdd, onClose, saving, entityTypes }) {
  const [entity, setEntity] = useState({ label: '', type: entityTypes[0] || 'Concept', description: '', chunkOrder: 0 });
  
  return (
    <Modal onClose={onClose}>
      <h3>Add Entity</h3>
      <div className="form-group">
        <label>Label</label>
        <input
          type="text"
          value={entity.label}
          onChange={(e) => setEntity({...entity, label: e.target.value})}
          placeholder="Entity name"
        />
      </div>
      <div className="form-group">
        <label>Type</label>
        <select value={entity.type} onChange={(e) => setEntity({...entity, type: e.target.value})}>
          {entityTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>Description</label>
        <textarea
          value={entity.description}
          onChange={(e) => setEntity({...entity, description: e.target.value})}
          placeholder="Optional description"
          rows={2}
        />
      </div>
      <div className="form-group">
        <label>Link to Chunk</label>
        <select value={entity.chunkOrder} onChange={(e) => setEntity({...entity, chunkOrder: parseInt(e.target.value)})}>
          {chunks.map((c, i) => (
            <option key={i} value={c.order}>Chunk #{c.order + 1}</option>
          ))}
        </select>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => onAdd(entity)} disabled={saving || !entity.label}>
          {saving ? 'Adding...' : 'Add Entity'}
        </button>
      </div>
    </Modal>
  );
}

function AddRelationModal({ concepts, onAdd, onClose, saving }) {
  const [rel, setRel] = useState({ sourceId: '', targetId: '', predicate: '' });
  
  return (
    <Modal onClose={onClose}>
      <h3>Add Relationship</h3>
      <div className="form-group">
        <label>Source Entity</label>
        <select value={rel.sourceId} onChange={(e) => setRel({...rel, sourceId: e.target.value})}>
          <option value="">Select...</option>
          {concepts.map(c => (
            <option key={c.concept_id} value={c.concept_id}>{c.label} ({c.type})</option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label>Predicate</label>
        <input
          type="text"
          value={rel.predicate}
          onChange={(e) => setRel({...rel, predicate: e.target.value})}
          placeholder="e.g., WORKS_AT, LOCATED_IN"
        />
      </div>
      <div className="form-group">
        <label>Target Entity</label>
        <select value={rel.targetId} onChange={(e) => setRel({...rel, targetId: e.target.value})}>
          <option value="">Select...</option>
          {concepts.map(c => (
            <option key={c.concept_id} value={c.concept_id}>{c.label} ({c.type})</option>
          ))}
        </select>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button 
          className="primary" 
          onClick={() => onAdd(rel)} 
          disabled={saving || !rel.sourceId || !rel.targetId || !rel.predicate}
        >
          {saving ? 'Adding...' : 'Add Relationship'}
        </button>
      </div>
    </Modal>
  );
}

function UploadModal({ 
  files, uploading, progress, 
  selectedFolder, folders, ontologies,
  getFolderOntology, getOntologyById,
  onUpload, onClose, onFolderChange
}) {
  const [chunkingMethod, setChunkingMethod] = useState('page');
  const [extractionMethod, setExtractionMethod] = useState('pdf-parse');
  const [csvChunkingEnabled, setCsvChunkingEnabled] = useState(false);
  const [fileNames, setFileNames] = useState(() => {
    const names = {};
    files.forEach(f => { 
      const base = f.name.replace(/\.[^/.]+$/, '');
      names[f.name] = base;
    });
    return names;
  });
  
  const folderOntologyId = getFolderOntology(selectedFolder);
  const ontology = folderOntologyId ? getOntologyById(folderOntologyId) : null;
  const folderName = selectedFolder === 'root' 
    ? 'All Documents' 
    : folders.find(f => f.folder_id === selectedFolder)?.name || 'Unknown';
  
  const allComplete = files.length > 0 && files.every(f => 
    progress[f.name]?.status === 'complete' || progress[f.name]?.status === 'error' || progress[f.name]?.status === 'job created'
  );
  
  const hasPdfFiles = files.some(f => f.name.toLowerCase().endsWith('.pdf'));
  const hasCsvFiles = files.some(f => f.name.toLowerCase().endsWith('.csv'));
  
  const chunkingMethods = [
    { id: 'fixed', name: 'Fixed Length', description: 'Split by character count (2000 chars)', icon: '📏' },
    { id: 'page', name: 'Page-based', description: 'One chunk per page (best for PDFs)', icon: '📄' }
  ];
  
  const extractionMethods = [
    { id: 'pdf-parse', name: 'PDF Text', description: 'Fast, for text-based PDFs', icon: '📄' },
    { id: 'ocr', name: 'OCR (Tesseract)', description: 'For scanned documents', icon: '🔍' },
    { id: 'hybrid', name: 'Hybrid', description: 'Auto-select best method', icon: '🔄' }
  ];
  
  const handleUpload = () => {
    onUpload({ chunkingMethod, extractionMethod, csvChunkingEnabled, fileNames });
  };
  
  return (
    <Modal onClose={onClose}>
      <h3>📤 Upload Documents</h3>
      
      <div className="upload-info">
        <div className="upload-target">
          <span className="label">Upload to:</span>
          <select 
            className="folder-picker"
            value={selectedFolder}
            onChange={(e) => onFolderChange?.(e.target.value)}
            disabled={uploading || allComplete}
          >
            <option value="root">📂 All Documents</option>
            {folders.map(f => (
              <option key={f.folder_id} value={f.folder_id}>
                📁 {f.name}{f.ontology_id ? ' 🏷️' : ''}
              </option>
            ))}
          </select>
        </div>
        {ontology ? (
          <div className="upload-ontology">
            <span className="label">Ontology:</span>
            <span className="value">🏷️ {ontology.name || ontology.id}</span>
          </div>
        ) : (
          <div className="upload-ontology hint">
            <span className="value">💡 No ontology — entities will be auto-detected</span>
          </div>
        )}
      </div>
      
      {/* Processing Options */}
      {!uploading && !allComplete && (
        <div className="upload-options">
          <div className="option-group">
            <label>Chunking Method</label>
            <div className="option-buttons">
              {chunkingMethods.map(method => (
                <button
                  key={method.id}
                  className={`option-btn ${chunkingMethod === method.id ? 'selected' : ''}`}
                  onClick={() => setChunkingMethod(method.id)}
                  title={method.description}
                >
                  <span className="option-icon">{method.icon}</span>
                  <span className="option-name">{method.name}</span>
                </button>
              ))}
            </div>
            <small className="option-hint">
              {chunkingMethods.find(m => m.id === chunkingMethod)?.description}
            </small>
          </div>
          
          {hasPdfFiles && (
            <div className="option-group">
              <label>PDF Extraction</label>
              <div className="option-buttons">
                {extractionMethods.map(method => (
                  <button
                    key={method.id}
                    className={`option-btn ${extractionMethod === method.id ? 'selected' : ''}`}
                    onClick={() => setExtractionMethod(method.id)}
                    title={method.description}
                  >
                    <span className="option-icon">{method.icon}</span>
                    <span className="option-name">{method.name}</span>
                  </button>
                ))}
              </div>
              <small className="option-hint">
                {extractionMethods.find(m => m.id === extractionMethod)?.description}
              </small>
            </div>
          )}
          
          {hasCsvFiles && (
            <div className="option-group">
              <label>CSV Options</label>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={csvChunkingEnabled}
                  onChange={(e) => setCsvChunkingEnabled(e.target.checked)}
                />
                <span>Enable chunking for CSV files</span>
              </label>
              <small className="option-hint">
                {csvChunkingEnabled 
                  ? 'Rows will be grouped into chunks for semantic search'
                  : 'Each row becomes a separate entity (default)'}
              </small>
            </div>
          )}
        </div>
      )}
      
      <div className="upload-files">
        <h4>Files ({files.length})</h4>
        {files.map(file => {
          const ext = file.name.match(/\.[^/.]+$/)?.[0] || '';
          return (
          <div key={file.name} className={`upload-file-item ${progress[file.name]?.status || 'pending'}`}>
            {!uploading && !progress[file.name] ? (
              <span className="file-name" style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                <input
                  type="text"
                  value={fileNames[file.name] || ''}
                  onChange={(e) => setFileNames(prev => ({ ...prev, [file.name]: e.target.value }))}
                  style={{ flex: 1, padding: '2px 6px', fontSize: '0.9em', border: '1px solid #ccc', borderRadius: '4px' }}
                />
                <span style={{ color: '#888', fontSize: '0.85em' }}>{ext}</span>
              </span>
            ) : (
              <span className="file-name">{(fileNames[file.name] || file.name.replace(/\.[^/.]+$/, '')) + ext}</span>
            )}
            <span className="file-size">{(file.size / 1024).toFixed(1)} KB</span>
            {progress[file.name] && (
              <span className={`file-status ${progress[file.name].status}`}>
                {progress[file.name].status === 'uploading' && '⏳ Uploading...'}
                {progress[file.name].status === 'processing' && '⚙️ Processing...'}
                {progress[file.name].status === 'creating job' && '📋 Creating job...'}
                {progress[file.name].status === 'job created' && '✅ Job created'}
                {progress[file.name].status === 'complete' && (
                  progress[file.name].jobId 
                    ? '✅ Processing in background' 
                    : '✅ Done'
                )}
                {progress[file.name].status === 'error' && `❌ ${progress[file.name].error}`}
              </span>
            )}
          </div>
          );
        })}
      </div>
      
      {!uploading && !allComplete && (
        <div className="upload-info-box">
          <div className="info-icon">💡</div>
          <div className="info-content">
            <strong>What happens next?</strong>
            <p>Files are staged for review. Click "Review" in the Processing panel to map columns and commit to GraphDB.</p>
          </div>
        </div>
      )}
      
      {allComplete && Object.values(progress).some(p => p.jobId) && (
        <div className="upload-info-box success">
          <div className="info-icon">✅</div>
          <div className="info-content">
            <strong>Ready for Review</strong>
            <p>Files staged successfully. Click "Review" in the Processing panel above to continue.</p>
          </div>
        </div>
      )}
      
      <div className="modal-actions">
        <button onClick={onClose}>{allComplete ? 'Close' : 'Cancel'}</button>
        {!allComplete && (
          <button className="primary" onClick={handleUpload} disabled={uploading || files.length === 0}>
            {uploading ? '⏳ Processing...' : `Upload ${files.length} file(s)`}
          </button>
        )}
      </div>
    </Modal>
  );
}

function FolderEditModal({ folder, ontologies, onSave, onClose }) {
  const [name, setName] = useState(folder.name || '');
  const [ontologyId, setOntologyId] = useState(folder.ontology_id || '');
  
  const handleSave = () => {
    onSave({ name, ontologyId: ontologyId || null });
  };
  
  return (
    <Modal onClose={onClose}>
      <h3>✏️ Edit Folder</h3>
      <div className="form-group">
        <label>Folder Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name"
        />
      </div>
      <div className="form-group">
        <label>Assigned Ontology</label>
        <select value={ontologyId} onChange={(e) => setOntologyId(e.target.value)}>
          <option value="">No ontology (use auto-detection)</option>
          {ontologies.map(ont => (
            <option key={ont.ontologyId || ont.id} value={ont.ontologyId || ont.id}>
              {ont.label || ont.name || ont.ontologyId || ont.id}
            </option>
          ))}
        </select>
        <small className="form-hint">Documents in this folder will use this ontology for entity extraction</small>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={handleSave} disabled={!name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function ReviewModal({ data, onApprove, onClose }) {
  const [concepts, setConcepts] = useState(
    (data.concepts || []).map(c => ({ ...c, approved: true, addToOntology: c.isNewType }))
  );
  const [relations, setRelations] = useState(
    (data.relations || []).map(r => ({ ...r, approved: true, addToOntology: r.isNewPredicate }))
  );
  const [updateOntology, setUpdateOntology] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [filter, setFilter] = useState('all');
  const [selectedType, setSelectedType] = useState(null);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Track suggested types/predicates to add
  const [suggestedTypes, setSuggestedTypes] = useState(
    (data.suggestions?.unmatchedTypes || []).map(ut => ({ ...ut, addToOntology: false }))
  );
  const [suggestedPredicates, setSuggestedPredicates] = useState(
    (data.suggestions?.unmatchedPredicates || []).map(up => ({ ...up, addToOntology: false }))
  );
  
  const hasSuggestions = suggestedTypes.length > 0 || suggestedPredicates.length > 0;

  // Compute type distribution
  const typeDistribution = concepts.reduce((acc, c) => {
    const type = c.type || 'Unknown';
    if (!acc[type]) acc[type] = { count: 0, approved: 0, avgConfidence: 0, isNew: c.isNewType, entities: [] };
    acc[type].count++;
    acc[type].entities.push(c);
    if (c.approved) acc[type].approved++;
    acc[type].avgConfidence = (acc[type].avgConfidence * (acc[type].count - 1) + (c.confidence || 0)) / acc[type].count;
    return acc;
  }, {});

  // Compute predicate distribution
  const predicateDistribution = relations.reduce((acc, r) => {
    const pred = r.predicate || 'Unknown';
    if (!acc[pred]) acc[pred] = { count: 0, approved: 0, isNew: r.isNewPredicate };
    acc[pred].count++;
    if (r.approved) acc[pred].approved++;
    return acc;
  }, {});

  // Quality metrics
  const qualityMetrics = {
    avgConfidence: concepts.length > 0 ? concepts.reduce((sum, c) => sum + (c.confidence || 0), 0) / concepts.length : 0,
    highConfidence: concepts.filter(c => (c.confidence || 0) >= 0.8).length,
    mediumConfidence: concepts.filter(c => (c.confidence || 0) >= 0.5 && (c.confidence || 0) < 0.8).length,
    lowConfidence: concepts.filter(c => (c.confidence || 0) < 0.5).length,
    ontologyCoverage: data.ontology?.types?.length > 0 
      ? (Object.keys(typeDistribution).filter(t => data.ontology.types.includes(t)).length / Object.keys(typeDistribution).length * 100)
      : 100,
    uniqueTypes: Object.keys(typeDistribution).length,
    uniquePredicates: Object.keys(predicateDistribution).length
  };
  
  const toggleConcept = (idx) => {
    setConcepts(prev => prev.map((c, i) => i === idx ? { ...c, approved: !c.approved } : c));
  };
  
  const toggleRelation = (idx) => {
    setRelations(prev => prev.map((r, i) => i === idx ? { ...r, approved: !r.approved } : r));
  };
  
  const updateConceptType = (idx, newType) => {
    setConcepts(prev => prev.map((c, i) => i === idx ? { ...c, type: newType, isNewType: !data.ontology.types.includes(newType) } : c));
  };
  
  const updateRelationPredicate = (idx, newPredicate) => {
    setRelations(prev => prev.map((r, i) => i === idx ? { ...r, predicate: newPredicate, isNewPredicate: !data.ontology.predicates.includes(newPredicate) } : r));
  };
  
  const toggleAddToOntology = (type, idx) => {
    if (type === 'concept') {
      setConcepts(prev => prev.map((c, i) => i === idx ? { ...c, addToOntology: !c.addToOntology } : c));
    } else if (type === 'relation') {
      setRelations(prev => prev.map((r, i) => i === idx ? { ...r, addToOntology: !r.addToOntology } : r));
    } else if (type === 'suggestedType') {
      setSuggestedTypes(prev => prev.map((t, i) => i === idx ? { ...t, addToOntology: !t.addToOntology } : t));
    } else if (type === 'suggestedPredicate') {
      setSuggestedPredicates(prev => prev.map((p, i) => i === idx ? { ...p, addToOntology: !p.addToOntology } : p));
    }
  };

  // Bulk operations
  const approveAll = () => {
    setConcepts(prev => prev.map(c => ({ ...c, approved: true })));
    setRelations(prev => prev.map(r => ({ ...r, approved: true })));
  };
  
  const rejectAll = () => {
    setConcepts(prev => prev.map(c => ({ ...c, approved: false })));
    setRelations(prev => prev.map(r => ({ ...r, approved: false })));
  };

  const approveByType = (type) => {
    setConcepts(prev => prev.map(c => c.type === type ? { ...c, approved: true } : c));
  };

  const rejectByType = (type) => {
    setConcepts(prev => prev.map(c => c.type === type ? { ...c, approved: false } : c));
  };

  const approveHighConfidence = () => {
    setConcepts(prev => prev.map(c => (c.confidence || 0) >= 0.8 ? { ...c, approved: true } : c));
    setRelations(prev => prev.map(r => (r.confidence || 0) >= 0.8 ? { ...r, approved: true } : r));
  };

  const rejectLowConfidence = () => {
    setConcepts(prev => prev.map(c => (c.confidence || 0) < 0.5 ? { ...c, approved: false } : c));
    setRelations(prev => prev.map(r => (r.confidence || 0) < 0.5 ? { ...r, approved: false } : r));
  };

  const addAllNewTypesToOntology = () => {
    setConcepts(prev => prev.map(c => c.isNewType ? { ...c, addToOntology: true } : c));
    setSuggestedTypes(prev => prev.map(t => ({ ...t, addToOntology: true })));
  };

  const mapTypeToOntology = (fromType, toType) => {
    setConcepts(prev => prev.map(c => c.type === fromType ? { ...c, type: toType, isNewType: false } : c));
  };
  
  // Filtering
  const filteredConcepts = concepts.filter(c => {
    if (filter === 'new') return c.isNewType;
    if (filter === 'approved') return c.approved;
    if (filter === 'rejected') return !c.approved;
    if (filter === 'highConf') return (c.confidence || 0) >= 0.8;
    if (filter === 'lowConf') return (c.confidence || 0) < 0.5;
    return true;
  }).filter(c => {
    if (selectedType && c.type !== selectedType) return false;
    if (searchTerm && !c.label.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if ((c.confidence || 1) < confidenceThreshold) return false;
    return true;
  });
  
  const filteredRelations = relations.filter(r => {
    if (filter === 'new') return r.isNewPredicate;
    if (filter === 'approved') return r.approved;
    if (filter === 'rejected') return !r.approved;
    return true;
  }).filter(r => {
    if (searchTerm && !r.predicate.toLowerCase().includes(searchTerm.toLowerCase()) && 
        !r.sourceLabel?.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !r.targetLabel?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });
  
  const stats = {
    totalConcepts: concepts.length,
    approvedConcepts: concepts.filter(c => c.approved).length,
    newTypes: concepts.filter(c => c.isNewType && c.approved).length,
    totalRelations: relations.length,
    approvedRelations: relations.filter(r => r.approved).length,
    newPredicates: relations.filter(r => r.isNewPredicate && r.approved).length,
    suggestedTypesToAdd: suggestedTypes.filter(t => t.addToOntology).length,
    suggestedPredicatesToAdd: suggestedPredicates.filter(p => p.addToOntology).length
  };
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content review-modal review-modal-enhanced" onClick={e => e.stopPropagation()}>
        <div className="review-header">
          <div className="review-header-main">
            <h3>🔬 Schema Discovery & Review</h3>
            <p className="review-doc">📄 {data.document?.title}</p>
          </div>
          <button className="review-close" onClick={onClose}>×</button>
        </div>
        
        {/* Quality Metrics Dashboard */}
        <div className="review-metrics-dashboard">
          <div className="metrics-row">
            <div className="metric-card">
              <div className="metric-value">{stats.approvedConcepts}<span className="metric-total">/{stats.totalConcepts}</span></div>
              <div className="metric-label">Entities</div>
              <div className="metric-bar">
                <div className="metric-bar-fill" style={{width: `${stats.totalConcepts > 0 ? (stats.approvedConcepts/stats.totalConcepts*100) : 0}%`}}></div>
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{stats.approvedRelations}<span className="metric-total">/{stats.totalRelations}</span></div>
              <div className="metric-label">Relations</div>
              <div className="metric-bar">
                <div className="metric-bar-fill" style={{width: `${stats.totalRelations > 0 ? (stats.approvedRelations/stats.totalRelations*100) : 0}%`}}></div>
              </div>
            </div>
            <div className="metric-card highlight-new">
              <div className="metric-value">{qualityMetrics.uniqueTypes}</div>
              <div className="metric-label">Unique Types</div>
              <div className="metric-sub">{stats.newTypes} new</div>
            </div>
            <div className="metric-card highlight-quality">
              <div className="metric-value">{(qualityMetrics.avgConfidence * 100).toFixed(0)}%</div>
              <div className="metric-label">Avg Confidence</div>
              <div className="metric-sub">{qualityMetrics.highConfidence} high / {qualityMetrics.lowConfidence} low</div>
            </div>
            <div className="metric-card highlight-coverage">
              <div className="metric-value">{qualityMetrics.ontologyCoverage.toFixed(0)}%</div>
              <div className="metric-label">Ontology Coverage</div>
              <div className="metric-sub">{qualityMetrics.uniquePredicates} predicates</div>
            </div>
          </div>
        </div>

        {/* Quick Actions Bar */}
        <div className="review-quick-actions">
          <div className="quick-action-group">
            <span className="action-group-label">Bulk:</span>
            <button className="btn-action btn-approve" onClick={approveAll}>✓ Approve All</button>
            <button className="btn-action btn-reject" onClick={rejectAll}>✗ Reject All</button>
            <button className="btn-action btn-smart" onClick={approveHighConfidence}>⚡ Approve High Conf</button>
            <button className="btn-action btn-smart" onClick={rejectLowConfidence}>🔻 Reject Low Conf</button>
          </div>
          <div className="quick-action-group">
            <span className="action-group-label">Schema:</span>
            <button className="btn-action btn-ontology" onClick={addAllNewTypesToOntology}>➕ Add All New Types</button>
          </div>
        </div>
        
        <div className="review-tabs-enhanced">
          <button className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>
            📊 Dashboard
          </button>
          <button className={activeTab === 'concepts' ? 'active' : ''} onClick={() => setActiveTab('concepts')}>
            🏷️ Entities ({concepts.length})
          </button>
          <button className={activeTab === 'relations' ? 'active' : ''} onClick={() => setActiveTab('relations')}>
            🔗 Relations ({relations.length})
          </button>
          <button className={activeTab === 'schema' ? 'active' : ''} onClick={() => setActiveTab('schema')}>
            📐 Schema Discovery
          </button>
          {hasSuggestions && (
            <button className={`${activeTab === 'suggestions' ? 'active' : ''} has-badge`} onClick={() => setActiveTab('suggestions')}>
              💡 Suggestions
              <span className="tab-badge">{suggestedTypes.length + suggestedPredicates.length}</span>
            </button>
          )}
        </div>

        {/* Search and Filter Bar */}
        {(activeTab === 'concepts' || activeTab === 'relations') && (
          <div className="review-filter-bar">
            <input 
              type="text" 
              placeholder="🔍 Search entities..." 
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="search-input"
            />
            <select value={filter} onChange={e => setFilter(e.target.value)} className="filter-select">
              <option value="all">All Items</option>
              <option value="new">🆕 New Types Only</option>
              <option value="approved">✓ Approved</option>
              <option value="rejected">✗ Rejected</option>
              <option value="highConf">⬆️ High Confidence</option>
              <option value="lowConf">⬇️ Low Confidence</option>
            </select>
            {activeTab === 'concepts' && (
              <select value={selectedType || ''} onChange={e => setSelectedType(e.target.value || null)} className="filter-select">
                <option value="">All Types</option>
                {Object.keys(typeDistribution).sort().map(t => (
                  <option key={t} value={t}>{t} ({typeDistribution[t].count})</option>
                ))}
              </select>
            )}
            <div className="confidence-slider">
              <label>Min Conf: {(confidenceThreshold * 100).toFixed(0)}%</label>
              <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.1" 
                value={confidenceThreshold}
                onChange={e => setConfidenceThreshold(parseFloat(e.target.value))}
              />
            </div>
          </div>
        )}
        
        <div className="review-content">
          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div className="review-dashboard">
              <div className="dashboard-section">
                <h4>📊 Type Distribution</h4>
                <div className="type-distribution-chart">
                  {Object.entries(typeDistribution).sort((a, b) => b[1].count - a[1].count).map(([type, info]) => (
                    <div key={type} className={`type-bar-item ${info.isNew ? 'new-type' : ''}`} onClick={() => { setSelectedType(type); setActiveTab('concepts'); }}>
                      <div className="type-bar-header">
                        <span className="type-name">{type}</span>
                        <span className="type-count">{info.approved}/{info.count}</span>
                        {info.isNew && <span className="new-badge">NEW</span>}
                      </div>
                      <div className="type-bar-track">
                        <div 
                          className="type-bar-fill" 
                          style={{width: `${(info.count / Math.max(...Object.values(typeDistribution).map(t => t.count))) * 100}%`}}
                        >
                          <div 
                            className="type-bar-approved" 
                            style={{width: `${info.count > 0 ? (info.approved / info.count) * 100 : 0}%`}}
                          ></div>
                        </div>
                      </div>
                      <div className="type-bar-confidence">
                        Avg: {(info.avgConfidence * 100).toFixed(0)}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="dashboard-section">
                <h4>🔗 Predicate Distribution</h4>
                <div className="predicate-chips">
                  {Object.entries(predicateDistribution).sort((a, b) => b[1].count - a[1].count).map(([pred, info]) => (
                    <div key={pred} className={`predicate-chip ${info.isNew ? 'new-predicate' : ''}`}>
                      <span className="pred-name">{pred}</span>
                      <span className="pred-count">{info.count}</span>
                      {info.isNew && <span className="new-dot">●</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="dashboard-section">
                <h4>📈 Confidence Distribution</h4>
                <div className="confidence-breakdown">
                  <div className="conf-segment high">
                    <div className="conf-bar" style={{height: `${concepts.length > 0 ? (qualityMetrics.highConfidence / concepts.length) * 100 : 0}%`}}></div>
                    <span className="conf-label">High<br/>({qualityMetrics.highConfidence})</span>
                  </div>
                  <div className="conf-segment medium">
                    <div className="conf-bar" style={{height: `${concepts.length > 0 ? (qualityMetrics.mediumConfidence / concepts.length) * 100 : 0}%`}}></div>
                    <span className="conf-label">Med<br/>({qualityMetrics.mediumConfidence})</span>
                  </div>
                  <div className="conf-segment low">
                    <div className="conf-bar" style={{height: `${concepts.length > 0 ? (qualityMetrics.lowConfidence / concepts.length) * 100 : 0}%`}}></div>
                    <span className="conf-label">Low<br/>({qualityMetrics.lowConfidence})</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Schema Discovery Tab */}
          {activeTab === 'schema' && (
            <div className="schema-discovery">
              <div className="schema-comparison">
                <div className="schema-column ontology-types">
                  <h4>📚 Ontology Types ({data.ontology?.types?.length || 0})</h4>
                  <div className="schema-type-list">
                    {(data.ontology?.types || []).map(type => {
                      const used = typeDistribution[type];
                      return (
                        <div key={type} className={`schema-type ${used ? 'used' : 'unused'}`}>
                          <span className="type-name">{type}</span>
                          {used ? (
                            <span className="type-usage">✓ {used.count} found</span>
                          ) : (
                            <span className="type-usage">— not found</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="schema-column discovered-types">
                  <h4>🔍 Discovered Types ({Object.keys(typeDistribution).length})</h4>
                  <div className="schema-type-list">
                    {Object.entries(typeDistribution).map(([type, info]) => {
                      const inOntology = data.ontology?.types?.includes(type);
                      return (
                        <div key={type} className={`schema-type ${inOntology ? 'matched' : 'new'}`}>
                          <span className="type-name">{type}</span>
                          <span className="type-count">{info.count} entities</span>
                          {!inOntology && (
                            <div className="type-actions">
                              <button 
                                className="btn-mini btn-add"
                                onClick={() => {
                                  setConcepts(prev => prev.map(c => c.type === type ? { ...c, addToOntology: true } : c));
                                }}
                              >
                                ➕ Add to Ontology
                              </button>
                              <select 
                                className="map-select"
                                onChange={e => e.target.value && mapTypeToOntology(type, e.target.value)}
                                defaultValue=""
                              >
                                <option value="">Map to...</option>
                                {(data.ontology?.types || []).map(t => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'concepts' && (
            <div className="review-list enhanced-list">
              <div className="list-header">
                <span className="col-check"></span>
                <span className="col-label">Entity</span>
                <span className="col-type">Type</span>
                <span className="col-conf">Confidence</span>
                <span className="col-actions">Actions</span>
              </div>
              {filteredConcepts.map((concept, idx) => {
                const originalIdx = concepts.indexOf(concept);
                const confClass = (concept.confidence || 0) >= 0.8 ? 'high' : (concept.confidence || 0) >= 0.5 ? 'medium' : 'low';
                return (
                  <div key={idx} className={`review-item-enhanced ${concept.approved ? 'approved' : 'rejected'} ${concept.isNewType ? 'new-type' : ''}`}>
                    <input 
                      type="checkbox" 
                      checked={concept.approved} 
                      onChange={() => toggleConcept(originalIdx)}
                      className="item-checkbox"
                    />
                    <div className="item-label-col">
                      <span className="item-label">{concept.label}</span>
                      {concept.description && <span className="item-desc">{concept.description}</span>}
                    </div>
                    <div className="item-type-col">
                      <select 
                        value={concept.type} 
                        onChange={e => updateConceptType(originalIdx, e.target.value)}
                        className={`type-select ${concept.isNewType ? 'new-value' : ''}`}
                      >
                        {data.ontology.types.map(t => <option key={t} value={t}>{t}</option>)}
                        {concept.isNewType && !data.ontology.types.includes(concept.type) && (
                          <option value={concept.type}>🆕 {concept.type}</option>
                        )}
                      </select>
                    </div>
                    <div className={`item-confidence-col conf-${confClass}`}>
                      <div className="conf-indicator">
                        <div className="conf-fill" style={{width: `${(concept.confidence || 0) * 100}%`}}></div>
                      </div>
                      <span className="conf-value">{((concept.confidence || 0) * 100).toFixed(0)}%</span>
                    </div>
                    <div className="item-actions-col">
                      {concept.isNewType && concept.approved && (
                        <label className="add-to-ontology-label">
                          <input 
                            type="checkbox" 
                            checked={concept.addToOntology} 
                            onChange={() => toggleAddToOntology('concept', originalIdx)}
                          />
                          <span>Add type</span>
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredConcepts.length === 0 && <div className="empty-list">No entities match filter</div>}
            </div>
          )}
          
          {activeTab === 'relations' && (
            <div className="review-list">
              {filteredRelations.map((rel, idx) => {
                const originalIdx = relations.indexOf(rel);
                return (
                  <div key={idx} className={`review-item relation ${rel.approved ? 'approved' : 'rejected'} ${rel.isNewPredicate ? 'new-type' : ''}`}>
                    <input 
                      type="checkbox" 
                      checked={rel.approved} 
                      onChange={() => toggleRelation(originalIdx)}
                    />
                    <div className="item-main relation-main">
                      <span className="rel-source">{rel.sourceLabel}</span>
                      <input 
                        type="text"
                        value={rel.predicate}
                        onChange={e => updateRelationPredicate(originalIdx, e.target.value)}
                        className={`rel-predicate ${rel.isNewPredicate ? 'new-value' : ''}`}
                      />
                      <span className="rel-target">{rel.targetLabel}</span>
                    </div>
                    {rel.isNewPredicate && rel.approved && (
                      <label className="add-to-ontology">
                        <input 
                          type="checkbox" 
                          checked={rel.addToOntology} 
                          onChange={() => toggleAddToOntology('relation', originalIdx)}
                        />
                        Add predicate
                      </label>
                    )}
                    <span className="item-confidence">{(rel.confidence * 100).toFixed(0)}%</span>
                  </div>
                );
              })}
              {filteredRelations.length === 0 && <div className="empty-list">No relations match filter</div>}
            </div>
          )}
          
          {activeTab === 'suggestions' && (
            <div className="review-suggestions">
              <p className="suggestions-intro">
                💡 The LLM suggested these types/predicates that aren't in your ontology. 
                Check the ones you want to add.
              </p>
              
              {suggestedTypes.length > 0 && (
                <div className="suggestion-section">
                  <h4>🏷️ Suggested Entity Types</h4>
                  <div className="suggestion-list">
                    {suggestedTypes.map((st, idx) => (
                      <div key={idx} className={`suggestion-item ${st.addToOntology ? 'selected' : ''}`}>
                        <label className="suggestion-checkbox">
                          <input 
                            type="checkbox" 
                            checked={st.addToOntology} 
                            onChange={() => toggleAddToOntology('suggestedType', idx)}
                          />
                          <span className="suggestion-type">{st.suggestedType}</span>
                        </label>
                        <span className="suggestion-count">({st.count} entities)</span>
                        <span className="suggestion-assigned">→ currently assigned to: <em>{st.assignedType}</em></span>
                        <div className="suggestion-examples">
                          Examples: {st.examples.slice(0, 3).join(', ')}
                          {st.examples.length > 3 && ` +${st.examples.length - 3} more`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {suggestedPredicates.length > 0 && (
                <div className="suggestion-section">
                  <h4>🔗 Suggested Predicates</h4>
                  <div className="suggestion-list">
                    {suggestedPredicates.map((sp, idx) => (
                      <div key={idx} className={`suggestion-item ${sp.addToOntology ? 'selected' : ''}`}>
                        <label className="suggestion-checkbox">
                          <input 
                            type="checkbox" 
                            checked={sp.addToOntology} 
                            onChange={() => toggleAddToOntology('suggestedPredicate', idx)}
                          />
                          <span className="suggestion-type">{sp.suggestedPredicate}</span>
                        </label>
                        <span className="suggestion-count">({sp.count} relations)</span>
                        <span className="suggestion-assigned">→ currently assigned to: <em>{sp.assignedPredicate}</em></span>
                        <div className="suggestion-examples">
                          Examples: {sp.examples.slice(0, 2).join('; ')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {suggestedTypes.length === 0 && suggestedPredicates.length === 0 && (
                <div className="empty-list">No suggestions - all extracted types match your ontology!</div>
              )}
            </div>
          )}
        </div>
        
        {data.ontology?.id && (stats.newTypes > 0 || stats.newPredicates > 0) && (
          <div className="review-ontology-update">
            <label>
              <input 
                type="checkbox" 
                checked={updateOntology} 
                onChange={e => setUpdateOntology(e.target.checked)}
              />
              Update ontology with new types/predicates marked "Add"
            </label>
          </div>
        )}
        
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button 
            className="primary" 
            onClick={() => onApprove(
              concepts, 
              relations, 
              updateOntology,
              suggestedTypes.filter(t => t.addToOntology).map(t => t.suggestedType),
              suggestedPredicates.filter(p => p.addToOntology).map(p => p.suggestedPredicate)
            )}
            disabled={stats.approvedConcepts === 0}
          >
            ✅ Approve & Save ({stats.approvedConcepts} entities, {stats.approvedRelations} relations)
            {(stats.suggestedTypesToAdd > 0 || stats.suggestedPredicatesToAdd > 0) && 
              ` + ${stats.suggestedTypesToAdd + stats.suggestedPredicatesToAdd} to ontology`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Schema Analysis Modal - for reviewing suggested ontology from documents
function SchemaAnalysisModal({ analysis, onSaveAsOntology, onClose }) {
  const [name, setName] = useState(analysis.documentName ? `${analysis.documentName} Schema` : 'New Schema');
  const [description, setDescription] = useState(`Auto-generated from document analysis. Domain: ${analysis.industry || 'general'}`);
  const [entityTypes, setEntityTypes] = useState(analysis.entityTypes || []);
  const [relationships, setRelationships] = useState(analysis.relationships || []);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('entities');

  const toggleEntityType = (index) => {
    setEntityTypes(prev => prev.map((et, i) => 
      i === index ? { ...et, include: !et.include } : et
    ));
  };

  const toggleRelationship = (index) => {
    setRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, include: !r.include } : r
    ));
  };

  const updateEntityLabel = (index, newLabel) => {
    setEntityTypes(prev => prev.map((et, i) => 
      i === index ? { ...et, userLabel: newLabel } : et
    ));
  };

  const updateRelationshipPredicate = (index, newPredicate) => {
    setRelationships(prev => prev.map((r, i) => 
      i === index ? { ...r, userPredicate: newPredicate } : r
    ));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Please enter a name for the ontology');
      return;
    }
    setSaving(true);
    try {
      await onSaveAsOntology(name.trim(), description.trim());
    } finally {
      setSaving(false);
    }
  };

  const includedEntities = entityTypes.filter(e => e.include !== false);
  const includedRelationships = relationships.filter(r => r.include !== false);

  // Group entities by category
  const groupedEntities = entityTypes.reduce((acc, et) => {
    const cat = et.category || 'general';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(et);
    return acc;
  }, {});

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content schema-analysis-modal-v2" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="header-title">
            <h3>🔍 Schema Analysis Results</h3>
            <span className="domain-badge">{analysis.industry || 'general'}</span>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="modal-body">
          {/* Summary Section */}
          <div className="analysis-summary">
            <div className="summary-stats">
              <div className="stat-card">
                <span className="stat-value">{entityTypes.length}</span>
                <span className="stat-label">Entity Types</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{relationships.length}</span>
                <span className="stat-label">Relationships</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{analysis.documentsAnalyzed || 1}</span>
                <span className="stat-label">Documents</span>
              </div>
            </div>
            {analysis.summary?.documentSummary && (
              <p className="document-summary">{analysis.summary.documentSummary}</p>
            )}
            {analysis.summary?.subDomains?.length > 0 && (
              <div className="sub-domains">
                <span className="label">Sub-domains:</span>
                {analysis.summary.subDomains.map((d, i) => (
                  <span key={i} className="sub-domain-tag">{d}</span>
                ))}
              </div>
            )}
          </div>

          {/* Ontology Name/Description Form */}
          <div className="schema-form-compact">
            <div className="form-row">
              <div className="form-group">
                <label>Ontology Name</label>
                <input 
                  type="text" 
                  value={name} 
                  onChange={e => setName(e.target.value)}
                  placeholder="Enter ontology name"
                />
              </div>
              <div className="form-group flex-2">
                <label>Description</label>
                <input 
                  type="text"
                  value={description} 
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Enter description"
                />
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="schema-tabs">
            <button 
              className={`tab ${activeTab === 'entities' ? 'active' : ''}`}
              onClick={() => setActiveTab('entities')}
            >
              📦 Entity Types ({includedEntities.length}/{entityTypes.length})
            </button>
            <button 
              className={`tab ${activeTab === 'relationships' ? 'active' : ''}`}
              onClick={() => setActiveTab('relationships')}
            >
              🔗 Relationships ({includedRelationships.length}/{relationships.length})
            </button>
          </div>

          {/* Entity Types Tab */}
          {activeTab === 'entities' && (
            <div className="schema-section-v2">
              <div className="section-actions">
                <button className="btn-sm" onClick={() => setEntityTypes(prev => prev.map(e => ({...e, include: true})))}>
                  Select All
                </button>
                <button className="btn-sm" onClick={() => setEntityTypes(prev => prev.map(e => ({...e, include: false})))}>
                  Deselect All
                </button>
              </div>
              
              <div className="entity-grid">
                {entityTypes.map((et, idx) => (
                  <div key={idx} className={`entity-card ${et.include !== false ? 'included' : 'excluded'}`}>
                    <div className="entity-header">
                      <input 
                        type="checkbox" 
                        checked={et.include !== false} 
                        onChange={() => toggleEntityType(idx)}
                      />
                      <input 
                        type="text"
                        value={et.userLabel || et.label}
                        onChange={e => updateEntityLabel(idx, e.target.value)}
                        className="entity-label-input"
                      />
                      {et.confidence && (
                        <span className="confidence-badge" title="Confidence">
                          {Math.round(et.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    
                    <p className="entity-description">{et.description}</p>
                    
                    {et.examples?.length > 0 && (
                      <div className="entity-examples">
                        <span className="examples-label">Examples:</span>
                        <div className="examples-list">
                          {et.examples.slice(0, 4).map((ex, i) => (
                            <span key={i} className="example-tag">{ex}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {et.suggestedProperties?.length > 0 && (
                      <div className="entity-properties">
                        <span className="props-label">Properties:</span>
                        <div className="props-list">
                          {et.suggestedProperties.slice(0, 5).map((prop, i) => (
                            <span key={i} className="prop-tag">
                              {typeof prop === 'string' ? prop : prop.name || prop.label || 'unknown'}
                            </span>
                          ))}
                          {et.suggestedProperties.length > 5 && (
                            <span className="prop-more">+{et.suggestedProperties.length - 5} more</span>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {et.estimatedCount && (
                      <div className="entity-count">
                        ~{et.estimatedCount} instances found
                      </div>
                    )}
                  </div>
                ))}
              </div>
              
              {entityTypes.length === 0 && (
                <div className="empty-state">No entity types found in the analysis</div>
              )}
            </div>
          )}

          {/* Relationships Tab */}
          {activeTab === 'relationships' && (
            <div className="schema-section-v2">
              <div className="section-actions">
                <button className="btn-sm" onClick={() => setRelationships(prev => prev.map(r => ({...r, include: true})))}>
                  Select All
                </button>
                <button className="btn-sm" onClick={() => setRelationships(prev => prev.map(r => ({...r, include: false})))}>
                  Deselect All
                </button>
              </div>
              
              <div className="relationship-list">
                {relationships.map((rel, idx) => (
                  <div key={idx} className={`relationship-card ${rel.include !== false ? 'included' : 'excluded'}`}>
                    <div className="rel-header">
                      <input 
                        type="checkbox" 
                        checked={rel.include !== false} 
                        onChange={() => toggleRelationship(idx)}
                      />
                      <div className="rel-flow">
                        <span className="rel-entity from">{rel.from}</span>
                        <span className="rel-arrow">→</span>
                        <input 
                          type="text"
                          value={rel.userPredicate || rel.predicate}
                          onChange={e => updateRelationshipPredicate(idx, e.target.value)}
                          className="rel-predicate-input"
                        />
                        <span className="rel-arrow">→</span>
                        <span className="rel-entity to">{rel.to}</span>
                      </div>
                    </div>
                    
                    {rel.description && (
                      <p className="rel-description">{rel.description}</p>
                    )}
                    
                    <div className="rel-meta">
                      {rel.cardinality && (
                        <span className="meta-tag cardinality">{rel.cardinality}</span>
                      )}
                      {rel.direction && (
                        <span className="meta-tag direction">{rel.direction}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              {relationships.length === 0 && (
                <div className="empty-state">No relationships found in the analysis</div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div className="footer-info">
            <span className="selection-summary">
              {includedEntities.length} types, {includedRelationships.length} relationships selected
            </span>
          </div>
          <div className="footer-actions">
            <button className="btn-cancel" onClick={onClose}>Cancel</button>
            <button 
              className="btn-primary" 
              onClick={handleSave}
              disabled={saving || includedEntities.length === 0}
            >
              {saving ? '⏳ Saving...' : '💾 Save as Ontology'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// CSV Data View Component - queries GraphDB for CSV data
// Sheet Viewer Modal - standalone spreadsheet view for CSV/Excel files
function CSVDataView({ docUri }) {
  const { getTenantHeaders } = useTenant();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    if (docUri) loadData();
  }, [docUri, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ontology/documents/csv-data?docUri=${encodeURIComponent(docUri)}&limit=${pageSize}&offset=${page * pageSize}`, {
        headers: getTenantHeaders()
      });
      const result = await res.json();
      if (result.success) setData(result);
    } catch (e) {
      console.error('Failed to load CSV data:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="csv-loading">Loading data...</div>;
  if (!data?.rows?.length) return <div className="empty-tab">No data found. Data may be in GraphDB only.</div>;

  return (
    <div className="csv-data-view">
      <div className="csv-info">
        Showing {page * pageSize + 1}-{Math.min((page + 1) * pageSize, data.total)} of {data.total} rows
      </div>
      <div className="csv-table-wrap">
        <table className="csv-table">
          <thead>
            <tr>{data.columns?.map(col => <th key={col}>{col}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                {data.columns?.map(col => <td key={col}>{row[col]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > pageSize && (
        <div className="csv-pagination">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span>Page {page + 1} of {Math.ceil(data.total / pageSize)}</span>
          <button disabled={(page + 1) * pageSize >= data.total} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

export default FileManager;