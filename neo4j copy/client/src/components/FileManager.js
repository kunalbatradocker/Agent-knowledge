import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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

  // Schema analysis states
  const [showSchemaAnalysis, setShowSchemaAnalysis] = useState(false);
  const [schemaAnalysis, setSchemaAnalysis] = useState(null);
  const [analyzingSchema, setAnalyzingSchema] = useState(false);
  
  // Processing jobs (kept for schema analysis job tracking)
  const [jobs, setJobs] = useState([]);
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

  // Delete confirmation modal
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null); // docId or null
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);

  const loadDocumentMapping = async (ontologyId, workspaceId, sourceHeaders) => {
    if (!ontologyId || !workspaceId) {
      setDocMapping(null);
      return;
    }
    setMappingLoading(true);
    try {
      const params = new URLSearchParams({ ontologyId, workspaceId });
      if (sourceHeaders && sourceHeaders.length > 0) {
        params.append('headers', JSON.stringify(sourceHeaders));
      }
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

  // Delete job (used by schema analysis)
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

  // Load staged documents (pending enrichment) — workspace-scoped
  const loadStagedDocuments = async () => {
    try {
      const wsId = currentWorkspace?.workspace_id;
      const params = wsId ? `?workspace_id=${wsId}` : '';
      const response = await fetch(`${API_BASE_URL}/ontology/documents/staged${params}`, {
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
    setShowDeleteConfirm(docId);
  };

  const confirmDeleteDocument = async () => {
    const docId = showDeleteConfirm;
    if (!docId) return;
    setDeleting(true);
    setDeleteResult(null);
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers: getTenantHeaders()
      });
      const data = await response.json();
      if (response.ok) {
        setDeleteResult(data.results || {});
        // Auto-close after showing results
        setTimeout(() => {
          setShowDeleteConfirm(null);
          setDeleteResult(null);
          setSelectedDocument(null);
          setDocumentDetails(null);
          loadDocuments();
        }, 2000);
      } else {
        alert(data.error || 'Failed to delete document');
        setShowDeleteConfirm(null);
      }
    } catch (error) {
      console.error('Error deleting document:', error);
      alert('Failed to delete document');
      setShowDeleteConfirm(null);
    } finally {
      setDeleting(false);
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


  // Bulk generate graph for selected documents — schema analysis only (no ontology)
  const bulkAnalyzeSchema = async () => {
    if (selectedDocs.size === 0) {
      alert('Select documents first');
      return;
    }
    
    if (!window.confirm(`Analyze ${selectedDocs.size} document(s) to suggest an ontology schema?\n\nThis will run in the background. Check the Jobs page for results.`)) return;
    
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
        alert(`✅ Schema analysis started!\n\nJob ID: ${result.jobId}\n\nCheck the Jobs page to monitor progress and review the suggested schema.`);
        setSelectedDocs(new Set());
      } else {
        alert(`❌ ${result.error || 'Failed to start analysis'}`);
      }
    } catch (error) {
      alert(`❌ ${error.message}`);
    } finally {
      setAnalyzingSchema(false);
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

  // Filter options: server returns {label, count} objects; fallback to strings from loaded data
  const allEntityTypesFromServer = useMemo(() => {
    const serverTypes = documentDetails?.filterOptions?.entityTypes || [];
    if (serverTypes.length > 0) {
      // Handle both old format (string[]) and new format ({label, count}[])
      return serverTypes.map(t => typeof t === 'string' ? { label: t, count: 0 } : t);
    }
    // Fallback: derive from loaded concepts
    const counts = {};
    (documentDetails?.concepts || []).forEach(c => { if (c.type) counts[c.type] = (counts[c.type] || 0) + 1; });
    return Object.entries(counts).sort(([a],[b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count }));
  }, [documentDetails?.filterOptions?.entityTypes, documentDetails?.concepts]);

  const allPredicatesFromServer = useMemo(() => {
    const serverPreds = documentDetails?.filterOptions?.predicates || [];
    if (serverPreds.length > 0) {
      return serverPreds.map(p => typeof p === 'string' ? { label: p, count: 0 } : p);
    }
    const counts = {};
    (documentDetails?.relations || []).forEach(r => { const p = r.predicate || r.type; if (p) counts[p] = (counts[p] || 0) + 1; });
    return Object.entries(counts).sort(([a],[b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count }));
  }, [documentDetails?.filterOptions?.predicates, documentDetails?.relations]);



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
                onClick={bulkAnalyzeSchema} 
                disabled={analyzingSchema}
                title="Analyze documents to suggest an ontology schema"
              >
                {analyzingSchema ? '⏳' : '🔍'} Analyze ({selectedDocs.size})
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
                        {doc.status === 'enriched' && <span className="file-badge enriched" title="Knowledge Graph enriched">🧠</span>}
                        {isTabularType(doc.doc_type) && (
                          <button className="btn-tiny" title="View spreadsheet" onClick={(e) => { e.stopPropagation(); setSheetViewerDoc(doc); }}>👁️</button>
                        )}
                        {doc.status !== 'enriched' && (
                          <button className="btn-tiny btn-enrich" title="KG Enrich" onClick={(e) => { e.stopPropagation(); setSelectedStagedDocId(doc.doc_id); setShowStagedReview(true); }}>🧠</button>
                        )}
                        <span className="file-meta">{doc.chunks_stored || 0} chunks{doc.entity_count > 0 ? ` · ${doc.entity_count} entities` : ''}</span>
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
                          {doc.status === 'enriched' && <span className="file-badge enriched" title="Knowledge Graph enriched">🧠</span>}
                          {isTabularType(doc.doc_type) && (
                            <button className="btn-tiny" title="View spreadsheet" onClick={(e) => { e.stopPropagation(); setSheetViewerDoc(doc); }}>👁️</button>
                          )}
                          {doc.status !== 'enriched' && (
                            <button className="btn-tiny btn-enrich" title="KG Enrich" onClick={(e) => { e.stopPropagation(); setSelectedStagedDocId(doc.doc_id); setShowStagedReview(true); }}>🧠</button>
                          )}
                          <span className="file-meta">{doc.chunks_stored || 0} chunks{doc.entity_count > 0 ? ` · ${doc.entity_count} entities` : ''}</span>
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
                    <button className="btn-sm" onClick={() => setSheetViewerDoc(documentDetails.document)} title="Open spreadsheet view of entity data">
                      📊 Sheet
                    </button>
                    {canDelete && <button className="btn-delete" onClick={() => deleteDocument(documentDetails.document?.doc_id)}>🗑️</button>}
                  </div>
                </div>
                <div className="doc-badges">
                  <span className="badge">{documentDetails.document?.doc_type?.toUpperCase()}</span>
                  <span className="badge secondary">{formatDate(documentDetails.document?.created_at)}</span>
                  {selectedDocument?.status === 'enriched' ? (
                    <span className="badge enriched">🧠 Knowledge Graph</span>
                  ) : (
                    <>
                      <span className="badge uploaded">📦 RAG Ready</span>
                      <button className="btn-sm btn-enrich" onClick={() => { setSelectedStagedDocId(selectedDocument.doc_id); setShowStagedReview(true); }}>
                          🧠 Enrich
                        </button>
                    </>
                  )}
                </div>
              </div>

              <div className="doc-stats">
                <div className="stat"><strong>{documentDetails.stats?.chunkCount || 0}</strong> Chunks</div>
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
                <button className={`tab ${activeTab === 'chunks' ? 'active' : ''}`} onClick={() => setActiveTab('chunks')}>
                  Chunks ({documentDetails.stats?.chunkCount || 0})
                </button>
                <button className={`tab ${activeTab === 'entities' ? 'active' : ''}`} onClick={() => setActiveTab('entities')}>
                  Entities ({documentDetails.stats?.conceptCount || 0})
                </button>
                <button className={`tab ${activeTab === 'relations' ? 'active' : ''}`} onClick={() => setActiveTab('relations')}>
                  Relations ({documentDetails.stats?.relationCount || 0})
                </button>
                {documentDetails.document?.ontology_id && (
                  <button className={`tab ${activeTab === 'mapping' ? 'active' : ''}`} onClick={() => {
                    setActiveTab('mapping');
                    if (!docMapping) loadDocumentMapping(documentDetails.document.ontology_id, documentDetails.document.workspace_id || currentWorkspace?.workspace_id, documentDetails.document.source_headers);
                  }}>
                    Mapping
                  </button>
                )}
              </div>

              <div className="tab-content">
                {/* Chunks Tab */}
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

                {/* Entities Tab — grouped by type */}
                {activeTab === 'entities' && (
                  <div className="entities-list">
                    {/* Type tabs */}
                    {allEntityTypesFromServer.length > 0 && (
                      <div className="entity-type-tabs">
                        <button
                          className={`entity-type-tab ${!entityTypeFilter ? 'active' : ''}`}
                          onClick={() => handleEntityTypeFilterChange('')}
                        >
                          All <span className="type-tab-count">{documentDetails?.stats?.conceptCount || 0}</span>
                        </button>
                        {allEntityTypesFromServer.map(t => (
                          <button
                            key={t.label}
                            className={`entity-type-tab ${entityTypeFilter === t.label ? 'active' : ''}`}
                            onClick={() => handleEntityTypeFilterChange(t.label)}
                          >
                            {t.label} <span className="type-tab-count">{t.count || ''}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="tab-toolbar">
                      <div className="toolbar-row">
                        <div className="toolbar-search">
                          <span className="toolbar-search-icon">🔍</span>
                          <input
                            type="text"
                            placeholder={entityTypeFilter ? `Search ${entityTypeFilter}...` : 'Search all entities...'}
                            value={entitySearch}
                            onChange={(e) => handleEntitySearchChange(e.target.value)}
                          />
                          {entitySearch && (
                            <button className="toolbar-clear" onClick={() => handleEntitySearchChange('')}>✕</button>
                          )}
                        </div>
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
                            {!entityTypeFilter && (
                              <span className="entity-type-badge" style={{backgroundColor: getTypeColor(concept.type)}}>
                                {concept.type}
                              </span>
                            )}
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
                      <div className="empty-tab">No entities yet. Entities are extracted during the document commit flow.</div>
                    )}
                    {documentDetails?.pagination?.entities && concepts.length > 0 && (
                      <div className="pagination-controls">
                        <span className="pagination-info">
                          Showing {concepts.length} of {documentDetails.pagination.entities.total}
                          {entitySearch || entityTypeFilter ? ` ${entityTypeFilter || ''} (filtered)` : ''} entities
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

                {/* Relations Tab — grouped by predicate */}
                {activeTab === 'relations' && (
                  <div className="relations-list">
                    {/* Predicate tabs */}
                    {allPredicatesFromServer.length > 0 && (
                      <div className="entity-type-tabs">
                        <button
                          className={`entity-type-tab ${!relationPredicateFilter ? 'active' : ''}`}
                          onClick={() => handleRelationPredicateFilterChange('')}
                        >
                          All <span className="type-tab-count">{documentDetails?.stats?.relationCount || 0}</span>
                        </button>
                        {allPredicatesFromServer.map(p => (
                          <button
                            key={p.label}
                            className={`entity-type-tab ${relationPredicateFilter === p.label ? 'active' : ''}`}
                            onClick={() => handleRelationPredicateFilterChange(p.label)}
                          >
                            {p.label} <span className="type-tab-count">{p.count || ''}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="tab-toolbar">
                      <div className="toolbar-row">
                        <div className="toolbar-search">
                          <span className="toolbar-search-icon">🔍</span>
                          <input
                            type="text"
                            placeholder={relationPredicateFilter ? `Search ${relationPredicateFilter}...` : 'Search all relations...'}
                            value={relationSearch}
                            onChange={(e) => handleRelationSearchChange(e.target.value)}
                          />
                          {relationSearch && (
                            <button className="toolbar-clear" onClick={() => handleRelationSearchChange('')}>✕</button>
                          )}
                        </div>
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
                      <div className="empty-tab">No relations found yet. Relations are discovered during the document commit flow.</div>
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
                              <th>Belongs To</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(docMapping.mappings).map(([col, map]) => (
                              <tr key={col} className={map.ignore ? 'mapping-ignored' : ''}>
                                <td className="mapping-col-name">{col}</td>
                                <td className="mapping-property">{map.property ? (map.property.includes('#') ? map.property.split('#').pop() : map.property) : <span className="mapping-auto">auto</span>}</td>
                                <td className="mapping-linked">{map.linkedClass ? (map.linkedClass.includes('#') ? map.linkedClass.split('#').pop() : map.linkedClass) : <span className="mapping-literal">Literal</span>}</td>
                                <td className="mapping-domain">{map.linkedClass ? <span className="mapping-na">—</span> : (map.domain ? (map.domain.includes('#') ? map.domain.split('#').pop() : (map.domainLabel || map.domain)) : <span className="mapping-domain-primary">{docMapping.primaryClass ? (docMapping.primaryClass.includes('#') ? docMapping.primaryClass.split('#').pop() : docMapping.primaryClass) : 'Primary'}</span>)}</td>
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

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <Modal onClose={() => { if (!deleting) { setShowDeleteConfirm(null); setDeleteResult(null); } }}>
          {deleteResult ? (
            <div className="fm-delete-result">
              <h3>✅ Document Deleted</h3>
              <div className="fm-delete-stats">
                {deleteResult.graphdbEntities > 0 && <div className="fm-delete-stat">🔗 {deleteResult.graphdbEntities} entities removed from GraphDB</div>}
                {deleteResult.entities > 0 && <div className="fm-delete-stat">🗂️ {deleteResult.entities} nodes removed from Neo4j</div>}
                {deleteResult.concepts > 0 && <div className="fm-delete-stat">💡 {deleteResult.concepts} concepts removed</div>}
                {deleteResult.chunks > 0 && <div className="fm-delete-stat">📄 {deleteResult.chunks} chunks removed</div>}
                {deleteResult.graphdb && <div className="fm-delete-stat">✅ Graph triples cleaned from GraphDB</div>}
                {deleteResult.redis && <div className="fm-delete-stat">💾 Vector embeddings and cache cleared</div>}
              </div>
            </div>
          ) : (
            <>
              <h3>⚠️ Delete Document</h3>
              <p style={{margin: '12px 0', color: '#555'}}>
                This will permanently delete <strong>{documentDetails?.document?.title || 'this document'}</strong> and all associated data:
              </p>
              <div className="fm-delete-warning-list">
                <div className="fm-delete-warning-item">🗂️ All entities created from this file</div>
                <div className="fm-delete-warning-item">🔗 All graph triples in GraphDB</div>
                <div className="fm-delete-warning-item">🔄 Synced nodes and relationships in Neo4j</div>
                <div className="fm-delete-warning-item">📄 All chunks and text data</div>
                <div className="fm-delete-warning-item">🧠 Vector embeddings for RAG search</div>
                <div className="fm-delete-warning-item">💾 Cached metadata in Redis</div>
              </div>
              <p style={{margin: '12px 0', color: '#d32f2f', fontSize: '13px', fontWeight: 500}}>
                This action cannot be undone.
              </p>
              <div style={{display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px'}}>
                <button className="btn-secondary" onClick={() => setShowDeleteConfirm(null)} disabled={deleting}>Cancel</button>
                <button className="btn-danger" onClick={confirmDeleteDocument} disabled={deleting}>
                  {deleting ? '⏳ Deleting...' : '🗑️ Delete Everything'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

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
          onCommit={() => { 
            setShowStagedReview(false); 
            setSelectedStagedDocId(null); 
            loadDocuments(); 
            loadStagedDocuments();
            loadJobs();
          }}
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
                {mappingTemplates.map((t, i) => {
                  // Filter out garbage headers (Excel metadata, empty columns)
                  const cleanHeaders = (t.sourceHeaders || []).filter(h =>
                    h && !h.startsWith('__EMPTY') && h.length < 40 && !/^(PrimaryKey|Description|Relationships|ObjectType)$/i.test(h)
                  );
                  return (
                  <div key={i} className="mapping-template-card">
                    <div className="mapping-template-header">
                      <span className="mapping-template-name">{t.ontologyName}</span>
                      <span className="mapping-version">v{t.version}</span>
                    </div>
                    <div className="mapping-template-meta">
                      <span>{t.columnCount} columns mapped</span>
                      {t.primaryClass && <span>Primary: {t.primaryClass.split('#').pop()}</span>}
                      <span>Saved {t.savedAt ? new Date(t.savedAt).toLocaleDateString() : 'N/A'}</span>
                    </div>
                    {cleanHeaders.length > 0 && (
                      <div className="mapping-template-columns">
                        {cleanHeaders.slice(0, 8).map((h, j) => (
                          <span key={j} className="mapping-template-col">{h}</span>
                        ))}
                        {cleanHeaders.length > 8 && <span className="mapping-template-col more">+{cleanHeaders.length - 8}</span>}
                      </div>
                    )}
                    {cleanHeaders.length === 0 && (
                      <div className="mapping-template-columns">
                        <span className="mapping-template-col more" style={{ fontStyle: 'italic' }}>No clean column headers — mapping may need to be recreated</span>
                      </div>
                    )}
                    <div className="mapping-template-actions">
                      {canDelete && (
                        <button className="btn-sm btn-danger" onClick={() => deleteMappingTemplate(t.ontologyId)}>🗑️ Delete</button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      )}
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
  const hasTabularFiles = files.some(f => /\.(csv|xlsx|xls)$/i.test(f.name));
  const hasDocFiles = files.some(f => /\.(pdf|txt|md|docx|doc)$/i.test(f.name));
  const onlyTabular = hasTabularFiles && !hasDocFiles;
  
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
    if (selectedFolder === 'root') {
      alert('Please select a folder before uploading.');
      return;
    }
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
            <option value="root" disabled>— Select a folder —</option>
            {folders.map(f => (
              <option key={f.folder_id} value={f.folder_id}>
                📁 {f.name}{f.ontology_id ? ' 🏷️' : ''}
              </option>
            ))}
          </select>
          {selectedFolder === 'root' && (
            <small className="folder-required-hint">⚠️ A folder must be selected to upload files.</small>
          )}
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
          {/* Chunking method — only for document files (PDF, TXT, etc.), not tabular */}
          {hasDocFiles && (
            <div className="option-group">
              <label>Document Chunking</label>
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
          )}
          
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
          
          {hasTabularFiles && (
            <div className="option-group">
              <label>Tabular Data Options</label>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={csvChunkingEnabled}
                  onChange={(e) => setCsvChunkingEnabled(e.target.checked)}
                />
                <span>Enable chunking for RAG search</span>
              </label>
              <small className="option-hint">
                {csvChunkingEnabled 
                  ? 'Rows will be grouped into chunks (50 rows each) for semantic search. Multi-sheet workbooks are chunked per-sheet.'
                  : 'Each row becomes a separate entity (default)'}
              </small>
            </div>
          )}

          {onlyTabular && (
            <div className="upload-info-box">
              <div className="info-icon">📊</div>
              <div className="info-content">
                <p>Tabular files go through a staged review where you can map columns to ontology classes before committing to the graph.</p>
              </div>
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
            <p>Files are uploaded, chunked, and embedded immediately. Agents can query them right away. Click the 🧠 button on any document to optionally add Knowledge Graph entities and relationships.</p>
          </div>
        </div>
      )}
      
      {allComplete && Object.values(progress).some(p => p.jobId) && (
        <div className="upload-info-box success">
          <div className="info-icon">✅</div>
          <div className="info-content">
            <strong>Ready for Agents</strong>
            <p>Files uploaded and embedded. Agents can query them now. Click the 🧠 button on any document to optionally add Knowledge Graph enrichment.</p>
          </div>
        </div>
      )}
      
      <div className="modal-actions">
        <button onClick={onClose}>{allComplete ? 'Close' : 'Cancel'}</button>
        {!allComplete && (
          <button className="primary" onClick={handleUpload} disabled={uploading || files.length === 0 || selectedFolder === 'root'}>
            {uploading ? '⏳ Processing...' : selectedFolder === 'root' ? 'Select a folder first' : `Upload ${files.length} file(s)`}
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


export default FileManager;