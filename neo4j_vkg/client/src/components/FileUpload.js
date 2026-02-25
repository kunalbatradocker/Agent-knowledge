import React, { useRef, useState, useEffect } from 'react';
import { useTenant } from '../contexts/TenantContext';
import './FileUpload.css';
import SchemaReview from './SchemaReview';
import OntologyManager from './OntologyManager';

// Use relative URL - the proxy (setupProxy.js) forwards /api to the server
const API_BASE_URL = '/api';

const FileUpload = ({ onUpload, loading }) => {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [workspaceOntologies, setWorkspaceOntologies] = useState([]);
  const [globalOntologies, setGlobalOntologies] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('auto');
  const [chunkingMethods, setChunkingMethods] = useState([]);
  const [selectedChunkingMethod, setSelectedChunkingMethod] = useState('fixed');
  const [csvProcessingModes, setCsvProcessingModes] = useState([]);
  const [selectedCsvProcessingMode, setSelectedCsvProcessingMode] = useState('graph');
  const [csvChunkingEnabled, setCsvChunkingEnabled] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [uploadProgress, setUploadProgress] = useState({});
  
  // PDF extraction method state
  const [extractionMethods, setExtractionMethods] = useState([]);
  const [selectedExtractionMethod, setSelectedExtractionMethod] = useState('pdf-parse');
  
  // Two-phase upload state
  const [schemaAnalysis, setSchemaAnalysis] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [reviewSchemaEnabled, setReviewSchemaEnabled] = useState(true);
  
  // Predefined industry schema state
  const [industrySchema, setIndustrySchema] = useState(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  
  // Predefined schema converted to analysis format for SchemaReview
  const [predefinedAnalysis, setPredefinedAnalysis] = useState(null);
  
  // Ontology Manager visibility
  const [showOntologyManager, setShowOntologyManager] = useState(false);
  
  // Show copy global ontology modal
  const [showCopyGlobalModal, setShowCopyGlobalModal] = useState(false);
  const [selectedGlobalToCopy, setSelectedGlobalToCopy] = useState(null);
  const [copyingOntology, setCopyingOntology] = useState(false);

  // Folder selection state
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [loadingFolders, setLoadingFolders] = useState(false);

  // Processing progress state (for chunk/concept extraction)
  const [processingProgress, setProcessingProgress] = useState(null);

  // Legacy templates state (for backward compatibility)
  const [templates, setTemplates] = useState([]);

  const MAX_FILES = 50;

  // Check if any selected file is a CSV/Excel (tabular)
  const hasCsvFiles = selectedFiles.some(f => /\.(csv|xlsx|xls)$/i.test(f.name));
  
  // Check if any selected file is a PDF
  const hasPdfFiles = selectedFiles.some(f => f.name.toLowerCase().endsWith('.pdf'));
  
  // Check if ontology is selected
  const hasOntologySelected = selectedTemplate && selectedTemplate !== 'auto';
  const hasWorkspaceOntologies = workspaceOntologies.length > 0;

  // Fetch workspace and global ontologies
  const fetchOntologies = async () => {
    try {
      const tenantId = currentWorkspace?.tenant_id || 'default';
      const workspaceId = currentWorkspace?.workspace_id || 'default';
      
      // Fetch workspace ontologies
      const wsParams = new URLSearchParams({ tenantId, workspaceId, scope: 'workspace' });
      const wsRes = await fetch(`${API_BASE_URL}/owl/list?${wsParams}`, {
        headers: getTenantHeaders()
      });
      
      // Fetch global ontologies
      const globalParams = new URLSearchParams({ scope: 'global' });
      const globalRes = await fetch(`${API_BASE_URL}/owl/list?${globalParams}`);
      
      if (wsRes.ok) {
        const wsData = await wsRes.json();
        setWorkspaceOntologies(wsData.ontologies || []);
      }
      
      if (globalRes.ok) {
        const globalData = await globalRes.json();
        setGlobalOntologies(globalData.ontologies || []);
      }
    } catch (error) {
      console.error('Failed to fetch ontologies:', error);
    }
  };

  // Fetch ontologies on mount and when workspace changes
  useEffect(() => {
    fetchOntologies();
  }, [currentWorkspace?.workspace_id]);

  // Fetch available options on mount
  useEffect(() => {
    const fetchOptions = async () => {
      try {
        // Fetch chunking methods, CSV modes, and extraction methods in parallel
        const [chunkingRes, csvModesRes, extractionRes] = await Promise.all([
          fetch(`${API_BASE_URL}/ontology/chunking-methods`),
          fetch(`${API_BASE_URL}/ontology/csv-processing-modes`),
          fetch(`${API_BASE_URL}/ontology/extraction-methods`)
        ]);
        
        const chunkingData = await chunkingRes.json();
        const csvModesData = await csvModesRes.json();
        const extractionData = await extractionRes.json();
        
        setChunkingMethods(chunkingData.methods || [
          { id: 'fixed', name: 'Fixed Length', description: 'Split by character count', isDefault: true },
          { id: 'page', name: 'Page-based', description: 'One chunk per page (PDFs)' }
        ]);
        setCsvProcessingModes(csvModesData.modes || [
          { id: 'graph', name: 'Graph Mode', icon: '🔗', description: 'Columns become node types', isDefault: true },
          { id: 'text', name: 'Text Mode', icon: '📝', description: 'Treat as text, use LLM' }
        ]);
        setExtractionMethods(extractionData.methods || [
          { id: 'pdf-parse', name: 'PDF Text Extraction', icon: '📄', description: 'Fast, best for text PDFs', isDefault: true },
          { id: 'ocr', name: 'OCR (Tesseract)', icon: '🔍', description: 'For scanned documents' },
          { id: 'hybrid', name: 'Hybrid', icon: '🔄', description: 'Auto-select best method' }
        ]);
      } catch (error) {
        console.error('Failed to fetch options:', error);
        setChunkingMethods([
          { id: 'fixed', name: 'Fixed Length', description: 'Split by character count', isDefault: true },
          { id: 'page', name: 'Page-based', description: 'One chunk per page (PDFs)' }
        ]);
        setCsvProcessingModes([
          { id: 'graph', name: 'Graph Mode', icon: '🔗', description: 'Columns become node types', isDefault: true },
          { id: 'text', name: 'Text Mode', icon: '📝', description: 'Treat as text, use LLM' }
        ]);
        setExtractionMethods([
          { id: 'pdf-parse', name: 'PDF Text Extraction', icon: '📄', description: 'Fast, best for text PDFs', isDefault: true },
          { id: 'ocr', name: 'OCR (Tesseract)', icon: '🔍', description: 'For scanned documents' },
          { id: 'hybrid', name: 'Hybrid', icon: '🔄', description: 'Auto-select best method' }
        ]);
      } finally {
        setLoadingOptions(false);
      }
    };
    fetchOptions();
  }, []);

  // Fetch folders on mount
  useEffect(() => {
    const fetchFolders = async () => {
      setLoadingFolders(true);
      try {
        const response = await fetch(`${API_BASE_URL}/folders/tree`);
        if (response.ok) {
          const data = await response.json();
          setFolders(data.folders || []);
        }
      } catch (error) {
        console.error('Failed to fetch folders:', error);
      } finally {
        setLoadingFolders(false);
      }
    };
    fetchFolders();
  }, []);

  // Auto-select ontology when folder with default ontology is selected
  useEffect(() => {
    if (selectedFolder && selectedFolder.ontology_id) {
      setSelectedTemplate(selectedFolder.ontology_id);
    }
  }, [selectedFolder]);

  // Fetch ontology structure when an ontology is selected
  useEffect(() => {
    const fetchOntologySchema = async () => {
      if (!selectedTemplate || selectedTemplate === 'auto') {
        setIndustrySchema(null);
        return;
      }

      setLoadingSchema(true);
      try {
        const tenantId = currentWorkspace?.tenant_id || 'default';
        const workspaceId = currentWorkspace?.workspace_id || 'default';
        
        // Try to fetch ontology structure from OWL service
        const response = await fetch(
          `${API_BASE_URL}/owl/structure/${encodeURIComponent(selectedTemplate)}?tenantId=${tenantId}&workspaceId=${workspaceId}`,
          { headers: getTenantHeaders() }
        );
        
        if (response.ok) {
          const structure = await response.json();
          // Convert to schema format
          setIndustrySchema({
            id: selectedTemplate,
            name: structure.label || selectedTemplate,
            description: structure.comment || '',
            entityTypes: (structure.classes || []).map(c => ({
              label: c.label || c.uri?.split('#').pop(),
              userLabel: c.label || c.uri?.split('#').pop(),
              description: c.comment || '',
              include: true
            })),
            relationships: (structure.properties || []).map(p => ({
              predicate: p.label || p.uri?.split('#').pop(),
              userPredicate: p.label || p.uri?.split('#').pop(),
              from: p.domain?.split('#').pop() || '',
              to: p.range?.split('#').pop() || '',
              include: true
            })),
            conceptTypes: (structure.classes || []).map(c => c.label || c.uri?.split('#').pop()),
            isCustom: true,
            // Store raw structure for CSV mapping
            classes: structure.classes || [],
            properties: structure.properties || []
          });
        } else {
          // Fallback to legacy template endpoint
          const legacyRes = await fetch(`${API_BASE_URL}/ontology/templates/${selectedTemplate}`);
          if (legacyRes.ok) {
            const schema = await legacyRes.json();
            setIndustrySchema(schema);
          } else {
            setIndustrySchema(null);
          }
        }
      } catch (error) {
        console.error('Failed to fetch ontology schema:', error);
        setIndustrySchema(null);
      } finally {
        setLoadingSchema(false);
      }
    };
    fetchOntologySchema();
  }, [selectedTemplate, currentWorkspace?.workspace_id]);

  // Copy global ontology to workspace
  const handleCopyGlobalOntology = async (globalOntology) => {
    setCopyingOntology(true);
    try {
      const workspaceName = prompt(
        `Enter a name for your workspace copy of "${globalOntology.label || globalOntology.ontologyId}":`,
        globalOntology.label || globalOntology.ontologyId
      );
      
      if (!workspaceName) {
        setCopyingOntology(false);
        return;
      }

      const response = await fetch(`${API_BASE_URL}/owl/copy-global`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          tenantId: currentWorkspace?.tenant_id || 'default',
          workspaceId: currentWorkspace?.workspace_id || 'default',
          globalOntologyId: globalOntology.ontologyId,
          workspaceName
        })
      });

      if (response.ok) {
        const result = await response.json();
        alert(`✅ Ontology copied to workspace as "${result.workspaceOntologyId}"`);
        // Refresh ontologies and select the new one
        await fetchOntologies();
        setSelectedTemplate(result.workspaceOntologyId);
      } else {
        const error = await response.json();
        alert(`❌ Failed to copy: ${error.message}`);
      }
    } catch (error) {
      console.error('Failed to copy ontology:', error);
      alert('❌ Failed to copy ontology');
    } finally {
      setCopyingOntology(false);
      setShowCopyGlobalModal(false);
    }
  };

  // Check if using predefined schema (not auto)
  const usingPredefinedSchema = selectedTemplate !== 'auto' && industrySchema;
  
  // Convert predefined/custom schema to analysis format for SchemaReview
  const createPredefinedAnalysis = (file) => {
    if (!industrySchema) return null;
    
    console.log('createPredefinedAnalysis - industrySchema:', industrySchema);
    console.log('createPredefinedAnalysis - isCustom:', industrySchema.isCustom);
    console.log('createPredefinedAnalysis - originalEntityTypes:', industrySchema.originalEntityTypes);
    console.log('createPredefinedAnalysis - originalRelationships:', industrySchema.originalRelationships);
    console.log('createPredefinedAnalysis - conceptTypes:', industrySchema.conceptTypes);
    console.log('createPredefinedAnalysis - relationships:', industrySchema.relationships);
    
    const analysisId = `predefined-${Date.now()}`;
    const isCustom = industrySchema.isCustom;
    
    // For custom ontologies, use the saved original entity types/relationships
    // For predefined, convert from the simpler format
    let entityTypes, relationships;
    
    if (isCustom && industrySchema.originalEntityTypes && industrySchema.originalEntityTypes.length > 0) {
      // Custom ontology - use saved data directly
      console.log('Using originalEntityTypes from custom ontology');
      entityTypes = industrySchema.originalEntityTypes.map(et => ({
        ...et,
        label: et.userLabel || et.label,
        userLabel: et.userLabel || et.label,
        include: et.include !== false
      }));
      relationships = (industrySchema.originalRelationships || []).map(r => ({
        ...r,
        predicate: r.userPredicate || r.predicate,
        userPredicate: r.userPredicate || r.predicate,
        from: r.from || '',
        to: r.to || '',
        include: r.include !== false
      }));
    } else {
      // Predefined industry or custom without originalEntityTypes - convert from simple format
      console.log('Converting from conceptTypes/relationships format');
      const nodeTypes = industrySchema.conceptTypes || industrySchema.nodeTypes || [];
      entityTypes = nodeTypes.map(type => ({
        label: type,
        description: `${type} entity from ${industrySchema.name}`,
        include: true,
        userLabel: type
      }));
      relationships = (industrySchema.relationships || []).map(rel => ({
        predicate: rel.type || rel.predicate,
        userPredicate: rel.type || rel.predicate,
        from: rel.from || '',
        to: rel.to || '',
        description: rel.description || `Properties: ${(rel.properties || []).join(', ') || 'none'}`,
        include: true
      }));
    }
    
    console.log('createPredefinedAnalysis - Final entityTypes:', entityTypes);
    console.log('createPredefinedAnalysis - Final relationships:', relationships);
    
    // Get ontology classes for CSV column mapping
    const ontologyClasses = entityTypes.map(et => et.label || et.userLabel).filter(Boolean);
    
    return {
      id: analysisId,
      fileType: file.name.toLowerCase().split('.').pop(),
      documentName: file.name,
      industry: isCustom ? 'custom' : selectedTemplate,
      isPredefined: !isCustom,
      isCustom: isCustom,
      
      entityTypes,
      relationships,
      
      // Include ontology classes for CSV column mapping
      ontologyClasses,
      ontologyRelationships: relationships,
      
      summary: {
        suggestedEntityTypes: entityTypes.length,
        suggestedRelationships: relationships.length,
        documentType: isCustom ? 'custom_ontology' : 'predefined_schema',
        primaryDomain: selectedTemplate
      },
      
      // Store original schema for reference
      originalSchema: industrySchema,
      chunkingMethod: selectedChunkingMethod
    };
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = (files) => {
    const allowedExtensions = ['.owl', '.rdf', '.ttl', '.turtle', '.json', '.jsonld', '.pdf', '.txt', '.md', '.html', '.csv', '.xlsx', '.xls'];
    
    const validFiles = files.filter(file => {
      const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
      return allowedExtensions.includes(ext);
    });

    const invalidFiles = files.filter(file => {
      const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
      return !allowedExtensions.includes(ext);
    });

    if (invalidFiles.length > 0) {
      alert(`${invalidFiles.length} file(s) skipped (invalid type). Allowed: ${allowedExtensions.join(', ')}`);
    }

    // Combine with existing files, up to MAX_FILES
    const combined = [...selectedFiles, ...validFiles].slice(0, MAX_FILES);
    
    if (selectedFiles.length + validFiles.length > MAX_FILES) {
      alert(`Maximum ${MAX_FILES} files allowed. Some files were not added.`);
    }

    setSelectedFiles(combined);
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    setUploadProgress({});
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Analyze file and get schema suggestions
  const analyzeFile = async (file) => {
    console.log('analyzeFile called for:', file.name);
    setIsAnalyzing(true);
    
    // Derive industry from selected template (sync with ontology selection)
    const industry = selectedTemplate === 'auto' ? 'general' : selectedTemplate;
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('industry', industry);
      formData.append('chunkingMethod', selectedChunkingMethod);  // Pass user's chunking preference

      console.log('Sending analyze request to:', `${API_BASE_URL}/ontology/analyze`, 'with industry:', industry, 'chunking:', selectedChunkingMethod);
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout
      
      let response;
      try {
        response = await fetch(`${API_BASE_URL}/ontology/analyze`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
          // Don't set Content-Type header - let browser set it with boundary for multipart/form-data
        });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('Analysis request timed out. The file may be too large or the server is slow. Try direct upload instead.');
        }
        // Check if it's a network error
        if (fetchError.message && (fetchError.message.includes('Failed to fetch') || fetchError.message.includes('NetworkError'))) {
          // Note: In browser context, we can't access server port directly
          // The proxy handles routing, so we just show a generic message
          throw new Error('Failed to connect to server. Please check if the server is running.');
        }
        throw fetchError;
      }

      console.log('Analyze response status:', response.status);
      console.log('Analyze response headers:', Object.fromEntries(response.headers.entries()));
      console.log('Analyze response ok?', response.ok);

      if (!response.ok) {
        let errorText = '';
        try {
          const errorData = await response.json();
          errorText = errorData.error || errorData.message || JSON.stringify(errorData);
        } catch (e) {
          try {
            errorText = await response.text() || `HTTP ${response.status} ${response.statusText}`;
          } catch (textErr) {
            errorText = `HTTP ${response.status} ${response.statusText}`;
          }
        }
        console.error('Analyze response error:', errorText);
        throw new Error(`Analysis failed: ${errorText}`);
      }

      // Check if response has content
      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      console.log('Response content-length:', contentLength);
      console.log('Response content-type:', contentType);

      let result;
      try {
        const responseText = await response.text();
        console.log('Raw response text length:', responseText.length);
        
        if (!responseText || responseText.trim().length === 0) {
          console.error('Response is empty');
          throw new Error('Server returned empty response');
        }
        
        console.log('Raw response text (first 1000 chars):', responseText.substring(0, 1000));
        
        try {
          result = JSON.parse(responseText);
          console.log('Parsed JSON result:', result);
          console.log('Result keys:', Object.keys(result || {}));
          console.log('Has analysis property?', result && 'analysis' in result);
        } catch (parseError) {
          console.error('JSON parse error:', parseError);
          console.error('Response text that failed to parse (first 2000 chars):', responseText.substring(0, 2000));
          throw new Error(`Failed to parse server response as JSON: ${parseError.message}. Response preview: ${responseText.substring(0, 200)}`);
        }
      } catch (textError) {
        console.error('Failed to read response text:', textError);
        console.error('Response status:', response.status);
        console.error('Response statusText:', response.statusText);
        throw new Error(`Invalid response from server: ${response.status} ${response.statusText}. Error: ${textError.message}`);
      }
      
      if (!result) {
        console.error('Result is null or undefined');
        throw new Error('Invalid response: server returned empty result');
      }
      
      if (!result.analysis) {
        console.error('Missing analysis in response. Result structure:', JSON.stringify(result, null, 2));
        throw new Error(`Invalid response: analysis data missing from server response. Response structure: ${JSON.stringify(result)}`);
      }
      
      console.log('Analysis extracted successfully:', result.analysis);
      return result.analysis;
    } catch (error) {
      console.error('Analysis error:', error);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      
      // Provide more helpful error message
      if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('ECONNREFUSED'))) {
        // Note: In browser context, we can't access server port directly
        // The proxy handles routing, so we just show a generic message
        throw new Error('Failed to connect to server. Please check if the server is running.');
      }
      // Re-throw with original message if it's already a custom error
      if (error.message && error.message.includes('Failed to connect')) {
        throw error;
      }
      // Re-throw the original error to preserve the actual error message
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Update analysis with user edits
  const updateAnalysis = async (updates) => {
    if (!schemaAnalysis?.id) {
      const errorMsg = 'No analysis ID available. Please analyze the file first.';
      console.error('updateAnalysis:', errorMsg);
      console.error('updateAnalysis: schemaAnalysis:', schemaAnalysis);
      throw new Error(errorMsg);
    }
    
    console.log('updateAnalysis: Updating analysis', schemaAnalysis.id, 'with updates:', updates);
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/analysis/${schemaAnalysis.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      console.log('updateAnalysis: Response status:', response.status);
      console.log('updateAnalysis: Response ok:', response.ok);

      if (!response.ok) {
        let errorMessage = `Update failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
          console.error('updateAnalysis: Error response:', errorData);
        } catch (e) {
          const errorText = await response.text();
          console.error('updateAnalysis: Error response text:', errorText);
          errorMessage = errorText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      // Parse JSON response
      let result;
      try {
        // Check content type
        const contentType = response.headers.get('content-type');
        console.log('updateAnalysis: Response content-type:', contentType);
        
        // Verify it's JSON
        if (contentType && !contentType.includes('application/json')) {
          console.warn('updateAnalysis: ⚠️ Response is not JSON, content-type:', contentType);
          // Still try to parse as JSON in case content-type is wrong
        }
        
        // Use response.json() directly - it's more reliable than text() + parse
        result = await response.json();
        console.log('updateAnalysis: ✅ Successfully parsed JSON response');
        console.log('updateAnalysis: result type:', typeof result);
        console.log('updateAnalysis: result:', result);
        console.log('updateAnalysis: result.success:', result.success);
        console.log('updateAnalysis: result.analysis exists:', !!result.analysis);
        console.log('updateAnalysis: result.analysis type:', typeof result.analysis);
        
        if (result.analysis) {
          console.log('updateAnalysis: result.analysis.id:', result.analysis.id);
          console.log('updateAnalysis: result.analysis.entityTypes length:', result.analysis.entityTypes?.length);
          console.log('updateAnalysis: result.analysis.relationships length:', result.analysis.relationships?.length);
          console.log('updateAnalysis: result.analysis keys:', Object.keys(result.analysis));
        } else {
          console.error('updateAnalysis: ⚠️ result.analysis is missing!');
          console.error('updateAnalysis: Available keys in result:', Object.keys(result || {}));
        }
      } catch (parseError) {
        console.error('updateAnalysis: ❌ Failed to parse JSON response:', parseError);
        console.error('updateAnalysis: Parse error message:', parseError.message);
        console.error('updateAnalysis: Parse error stack:', parseError.stack);
        throw new Error(`Failed to parse server response as JSON: ${parseError.message}`);
      }
      
      // Check if result has analysis - server returns { success: true, analysis: {...} }
      if (!result) {
        console.error('updateAnalysis: Result is null/undefined');
        throw new Error('Server returned invalid response: result is null');
      }
      
      if (!result.analysis) {
        console.error('updateAnalysis: ❌ No analysis property in result');
        console.error('updateAnalysis: Result keys:', Object.keys(result || {}));
        console.error('updateAnalysis: Full result:', JSON.stringify(result, null, 2));
        throw new Error(`Server returned success but no analysis data. Response: ${JSON.stringify(result)}`);
      }
      
      const analysisData = result.analysis;
      
      if (!analysisData || typeof analysisData !== 'object') {
        console.error('updateAnalysis: analysisData is invalid:', analysisData);
        console.error('updateAnalysis: analysisData type:', typeof analysisData);
        throw new Error(`Server returned analysis but it is invalid. Type: ${typeof analysisData}, Value: ${JSON.stringify(analysisData)}`);
      }
      
      console.log('updateAnalysis: ✅ Analysis data retrieved successfully');
      console.log('updateAnalysis: Analysis ID:', analysisData.id);
      console.log('updateAnalysis: Analysis entityTypes count:', analysisData.entityTypes?.length);
      console.log('updateAnalysis: Analysis relationships count:', analysisData.relationships?.length);
      
      // Ensure we have a valid analysis object with ID
      if (!analysisData.id) {
        console.warn('updateAnalysis: ⚠️ Analysis data missing ID, using schemaAnalysis.id');
        analysisData.id = schemaAnalysis.id;
      }
      
      // Update state
      setSchemaAnalysis(analysisData);
      console.log('updateAnalysis: ✅ State updated, returning analysis data');
      console.log('updateAnalysis: Returning analysis with ID:', analysisData.id);
      return analysisData;
    } catch (error) {
      console.error('updateAnalysis: Error:', error);
      console.error('updateAnalysis: Error message:', error.message);
      console.error('updateAnalysis: Error stack:', error.stack);
      throw error;
    }
  };

  // Create nodes from approved schema
  const createFromAnalysis = async (approvedData) => {
    if (!schemaAnalysis?.id) {
      throw new Error('No analysis found. Please analyze the file first.');
    }
    
    console.log('Creating nodes from analysis:', {
      analysisId: schemaAnalysis.id,
      hasApprovedData: !!approvedData
    });
    
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/create-from-analysis/${schemaAnalysis.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        let errorMessage = 'Creation failed';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (e) {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log('Creation result:', result);
      
      if (!result || !result.result) {
        throw new Error('Invalid response from server');
      }
      
      // Clear state on success
      setSchemaAnalysis(null);
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      alert(`✅ Created ${result.result.nodesCreated} nodes and ${result.result.relationshipsCreated} relationships!`);
      
      // Notify parent to refresh stats
      if (onUpload) {
        onUpload(null, null, null, null, null, null, true); // Signal completion
      }

      return result;
    } catch (error) {
      console.error('Create error:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        analysisId: schemaAnalysis?.id
      });
      throw error;
    }
  };

  // Cancel analysis
  const cancelAnalysis = async () => {
    if (schemaAnalysis?.id) {
      try {
        await fetch(`${API_BASE_URL}/ontology/analysis/${schemaAnalysis.id}`, {
          method: 'DELETE'
        });
      } catch (error) {
        console.error('Cancel error:', error);
      }
    }
    setSchemaAnalysis(null);
  };

  // Create nodes with predefined schema (uses SchemaReview approved data)
  const createWithPredefinedSchema = async (approvedData) => {
    if (!predefinedAnalysis) return;

    // Get the approved entity types and relationships from the passed data or fall back to state
    const entityTypesData = approvedData?.entityTypes || predefinedAnalysis.entityTypes;
    const relationshipsData = approvedData?.relationships || predefinedAnalysis.relationships;
    
    const approvedEntityTypes = entityTypesData
      ?.filter(et => et.include !== false)
      .map(et => et.userLabel || et.label) || [];
    const approvedRelationships = relationshipsData
      ?.filter(r => r.include !== false)
      .map(r => r.userPredicate || r.predicate) || [];

    if (approvedEntityTypes.length === 0) {
      alert('Please select at least one entity type');
      return;
    }

    // Get files to process - either from multi-file context or selected files
    const filesToProcess = predefinedAnalysis.allFiles || selectedFiles;
    const totalFiles = filesToProcess.length;
    
    console.log(`📤 Processing ${totalFiles} file(s) with approved schema:`, {
      nodeTypes: approvedEntityTypes,
      relationships: approvedRelationships,
      folder: selectedFolder?.name || 'No folder'
    });

    let totalNodesCreated = 0;
    let totalRelationshipsCreated = 0;
    let totalChunksCreated = 0;
    let processedCount = 0;
    let errorCount = 0;

    // Initialize processing progress
    setProcessingProgress({
      stage: 'starting',
      currentFile: 0,
      totalFiles: totalFiles,
      currentFileName: filesToProcess[0]?.name || '',
      chunksProcessed: 0,
      totalChunks: 0,
      conceptsExtracted: 0,
      embeddingsGenerated: 0,
      message: 'Starting processing...'
    });

    try {
      for (let fileIndex = 0; fileIndex < filesToProcess.length; fileIndex++) {
        const file = filesToProcess[fileIndex];
        
        // Update progress for current file
        setProcessingProgress(prev => ({
          ...prev,
          stage: 'uploading',
          currentFile: fileIndex + 1,
          currentFileName: file.name,
          message: `Uploading ${file.name}...`
        }));

        try {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('industry', selectedTemplate);
          formData.append('chunkingMethod', predefinedAnalysis.chunkingMethod || selectedChunkingMethod);
          formData.append('extractionMethod', selectedExtractionMethod);
          // Pass the user-approved types and relationships
          formData.append('predefinedSchema', JSON.stringify({
            entityTypes: approvedEntityTypes,
            relationships: approvedRelationships
          }));
          // Pass folder_id if selected
          if (selectedFolder?.folder_id) {
            formData.append('folder_id', selectedFolder.folder_id);
          }
          // Pass ontology ID for ontology-aware processing
          if (selectedTemplate && selectedTemplate !== 'auto') {
            formData.append('ontologyId', selectedTemplate);
          }
          // Pass column mapping for CSV files
          if (approvedData?.columnMapping) {
            formData.append('columnMapping', JSON.stringify(approvedData.columnMapping));
          }
          // Pass relationship mapping for CSV files
          if (approvedData?.relationshipMapping) {
            formData.append('relationshipMapping', JSON.stringify(approvedData.relationshipMapping));
          }

          console.log(`   Processing [${fileIndex + 1}/${totalFiles}]: ${file.name} (extraction: ${selectedExtractionMethod})`);

          // Create AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

          let response;
          try {
            response = await fetch(`${API_BASE_URL}/ontology/create-with-predefined-schema`, {
              method: 'POST',
              body: formData,
              signal: controller.signal
            });
            clearTimeout(timeoutId);
          } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
              console.error(`   ❌ Timeout: ${file.name} - Request took too long`);
              setProcessingProgress(prev => ({
                ...prev,
                stage: 'error',
                message: `Timeout processing ${file.name}`
              }));
            } else {
              console.error(`   ❌ Network error: ${file.name} - ${fetchError.message}`);
            }
            errorCount++;
            continue;
          }

          if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            let errorDetails = null;
            try {
              const errorData = await response.json();
              errorMessage = errorData.error || errorData.message || errorMessage;
              errorDetails = errorData;
            } catch (e) {
              try {
                errorMessage = await response.text() || errorMessage;
              } catch (e2) {
                // Keep default error message
              }
            }
            console.error(`   ❌ Failed: ${file.name}`);
            console.error(`   Error: ${errorMessage}`);
            if (errorDetails) {
              console.error(`   Details:`, errorDetails);
            }
            setProcessingProgress(prev => ({
              ...prev,
              stage: 'error',
              message: `Error: ${errorMessage}`
            }));
            errorCount++;
            continue;
          }

          const result = await response.json();
          const nodesCreated = result.result?.nodesCreated || result.result?.conceptsCreated || 0;
          const relsCreated = result.result?.relationshipsCreated || 0;
          const chunksCreated = result.result?.chunksCreated || 0;
          
          totalNodesCreated += nodesCreated;
          totalRelationshipsCreated += relsCreated;
          totalChunksCreated += chunksCreated;
          processedCount++;
          
          // Update progress with results
          setProcessingProgress(prev => ({
            ...prev,
            stage: 'complete',
            chunksProcessed: prev.chunksProcessed + chunksCreated,
            conceptsExtracted: prev.conceptsExtracted + nodesCreated,
            embeddingsGenerated: prev.embeddingsGenerated + chunksCreated,
            message: `✅ ${file.name}: ${chunksCreated} chunks, ${nodesCreated} concepts`
          }));
          
          console.log(`   ✅ Done: ${file.name} - ${chunksCreated} chunks, ${nodesCreated} concepts`);
        } catch (fileError) {
          console.error(`   ❌ Error processing ${file.name}:`, fileError);
          errorCount++;
        }
      }

      // Final progress update
      setProcessingProgress(prev => ({
        ...prev,
        stage: 'finished',
        message: `Completed: ${processedCount}/${totalFiles} files processed`
      }));

      // Clear state after a delay
      setTimeout(() => {
        setProcessingProgress(null);
        setPredefinedAnalysis(null);
        setSelectedFiles([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }, 3000);

      const message = errorCount > 0 
        ? `✅ Processed ${processedCount}/${totalFiles} files. Created ${totalChunksCreated} chunks, ${totalNodesCreated} concepts, and ${totalRelationshipsCreated} relationships. (${errorCount} errors)`
        : `✅ Processed ${totalFiles} file(s). Created ${totalChunksCreated} chunks, ${totalNodesCreated} concepts, and ${totalRelationshipsCreated} relationships!`;
      
      alert(message);
      
      // Notify parent to refresh stats
      if (onUpload) {
        onUpload(null, null, null, null, null, null, true);
      }

    } catch (error) {
      console.error('Create error:', error);
      setProcessingProgress(prev => ({
        ...prev,
        stage: 'error',
        message: `Error: ${error.message}`
      }));
      alert(`Error: ${error.message}`);
    }
  };

  // Cancel predefined analysis review
  const cancelPredefinedAnalysis = () => {
    setPredefinedAnalysis(null);
  };

  // Update predefined analysis with user edits (local only, no server call needed)
  const updatePredefinedAnalysis = (updates) => {
    let updatedAnalysis = null;
    setPredefinedAnalysis(prev => {
      updatedAnalysis = {
        ...prev,
        ...updates
      };
      return updatedAnalysis;
    });
    // Return the updated analysis for SchemaReview validation
    return updatedAnalysis || { ...predefinedAnalysis, ...updates };
  };

  // Handle ontology selection from OntologyManager
  const handleOntologySelect = (ontologyId) => {
    setSelectedTemplate(ontologyId);
    setShowOntologyManager(false);
  };

  // Refresh templates after ontology manager changes
  const refreshTemplates = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/ontology/templates`);
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (error) {
      console.error('Failed to refresh templates:', error);
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) return;

    console.log('handleUpload called:', {
      reviewSchemaEnabled,
      usingPredefinedSchema,
      selectedTemplate,
      industrySchema: !!industrySchema,
      fileCount: selectedFiles.length,
      fileName: selectedFiles[0]?.name
    });

    // If a predefined template is selected but schema hasn't loaded yet, wait for it
    if (selectedTemplate !== 'auto' && !industrySchema) {
      console.log('Waiting for industry schema to load...');
      alert('Please wait for the industry schema to load before uploading.');
      return;
    }

    // If using predefined/custom schema, show SchemaReview for confirmation
    // This applies to single or multi-file uploads - confirm schema once, then process all
    if (usingPredefinedSchema) {
      console.log('Using predefined/custom schema - showing SchemaReview for confirmation');
      const file = selectedFiles[0]; // Use first file for analysis context
      const analysis = createPredefinedAnalysis(file);
      // Mark that we have multiple files to process after approval
      analysis.multiFileUpload = selectedFiles.length > 1;
      analysis.totalFiles = selectedFiles.length;
      analysis.allFiles = selectedFiles;
      setPredefinedAnalysis(analysis);
      return; // Show SchemaReview for confirmation
    }

    // If review schema is enabled and using auto-detect, analyze the file(s)
    if (reviewSchemaEnabled && !usingPredefinedSchema) {
      // For now, analyze only the first file
      const file = selectedFiles[0];
      const ext = file.name.toLowerCase().split('.').pop();
      
      console.log('Checking file for analysis:', { ext, supportedTypes: ['csv', 'pdf', 'txt', 'md', 'html'] });
      
      // Only analyze CSV, PDF, and text files
      if (['csv', 'xlsx', 'xls', 'pdf', 'txt', 'md', 'html'].includes(ext)) {
        try {
          console.log('Starting analysis for:', file.name);
          const analysis = await analyzeFile(file);
          console.log('Analysis result:', analysis);
          console.log('Analysis entityTypes:', analysis?.entityTypes);
          console.log('Analysis relationships:', analysis?.relationships);
          console.log('Analysis columns:', analysis?.columns);
          setSchemaAnalysis(analysis);
          return; // Stop here - user will review and approve
        } catch (error) {
          console.error('Analysis failed:', error);
          console.error('Error stack:', error.stack);
          const errorMsg = error.message || 'Unknown error';
          console.error('Error message:', errorMsg);
          // Show alert for all errors to help debug
          alert(`Analysis failed: ${errorMsg}. Proceeding with direct upload.`);
        }
      } else {
        console.log('File type not supported for analysis, proceeding with direct upload');
      }
    } else {
      console.log('Review schema disabled, proceeding with direct upload');
    }

    // Direct upload (original flow)
    await directUpload();
  };

  const directUpload = async () => {
    // Initialize progress for all files
    const initialProgress = {};
    selectedFiles.forEach((file, idx) => {
      initialProgress[idx] = { status: 'pending', progress: 0 };
    });
    setUploadProgress(initialProgress);

    // Upload files with template, chunking method, and schema mode
    const templateId = selectedTemplate === 'auto' ? null : selectedTemplate;
    
    for (let i = 0; i < selectedFiles.length; i++) {
      setUploadProgress(prev => ({
        ...prev,
        [i]: { status: 'uploading', progress: 0 }
      }));

      try {
        // Determine if this file is a CSV/Excel and pass the processing mode
        const isTabular = /\.(csv|xlsx|xls)$/i.test(selectedFiles[i].name);
        const csvMode = isTabular ? selectedCsvProcessingMode : null;
        const csvChunking = isTabular ? csvChunkingEnabled : false;
        
        console.log('📤 Uploading with options:', {
          file: selectedFiles[i].name,
          templateId,
          chunkingMethod: selectedChunkingMethod,
          csvMode,
          csvChunking
        });
        
        await onUpload(selectedFiles[i], templateId, selectedChunkingMethod, csvMode, csvChunking, (progress) => {
          setUploadProgress(prev => ({
            ...prev,
            [i]: { status: 'uploading', progress }
          }));
        });

        setUploadProgress(prev => ({
          ...prev,
          [i]: { status: 'complete', progress: 100 }
        }));
      } catch (error) {
        setUploadProgress(prev => ({
          ...prev,
          [i]: { status: 'error', progress: 0, error: error.message }
        }));
      }
    }

    // Clear files after all uploads complete
    setTimeout(() => {
      setSelectedFiles([]);
      setUploadProgress({});
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }, 2000);
  };

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending': return '⏳';
      case 'uploading': return '📤';
      case 'complete': return '✅';
      case 'error': return '❌';
      default: return '📄';
    }
  };

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);

  // If we have a schema analysis pending review, show the SchemaReview component
  if (schemaAnalysis) {
    return (
      <SchemaReview
        analysis={schemaAnalysis}
        onApprove={createFromAnalysis}
        onCancel={cancelAnalysis}
        onUpdate={updateAnalysis}
      />
    );
  }

  // If we have a predefined schema pending review, show the SchemaReview component
  if (predefinedAnalysis) {
    return (
      <SchemaReview
        analysis={predefinedAnalysis}
        onApprove={createWithPredefinedSchema}
        onCancel={cancelPredefinedAnalysis}
        onUpdate={updatePredefinedAnalysis}
        isPredefined={true}
      />
    );
  }

  return (
    <div className="file-upload">
      {/* Processing Progress Bar */}
      {processingProgress && (
        <div className="processing-progress-overlay">
          <div className="processing-progress-modal">
            <h3>🔄 Processing Documents</h3>
            <div className="progress-info">
              <p className="progress-file">
                📄 {processingProgress.currentFileName} ({processingProgress.currentFile}/{processingProgress.totalFiles})
              </p>
              <div className="progress-bar-container">
                <div 
                  className="progress-bar-fill"
                  style={{ 
                    width: `${(processingProgress.currentFile / processingProgress.totalFiles) * 100}%` 
                  }}
                />
              </div>
              <div className="progress-stats">
                <span>📝 Chunks: {processingProgress.chunksProcessed}</span>
                <span>🧠 Concepts: {processingProgress.conceptsExtracted}</span>
                <span>🔢 Embeddings: {processingProgress.embeddingsGenerated}</span>
              </div>
              <p className={`progress-message ${processingProgress.stage}`}>
                {processingProgress.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Schema Review Toggle */}
      <div className="schema-review-toggle">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={reviewSchemaEnabled}
            onChange={(e) => setReviewSchemaEnabled(e.target.checked)}
          />
          <span className="toggle-text">
            📋 Review & edit schema before creating nodes
          </span>
          <span className="toggle-hint">
            (Analyze document and let you customize labels)
          </span>
        </label>
      </div>

      {/* Folder Selection */}
      <div className="folder-selection">
        <label htmlFor="folder-select">
          <span className="option-label">📁 Save to Folder</span>
          <span className="option-help" title="Select a folder to organize your documents">ⓘ</span>
        </label>
        <select
          id="folder-select"
          value={selectedFolder?.folder_id || ''}
          onChange={(e) => {
            const folderId = e.target.value;
            if (folderId) {
              const folder = folders.find(f => f.folder_id === folderId);
              setSelectedFolder(folder || null);
            } else {
              setSelectedFolder(null);
            }
          }}
          disabled={loadingFolders || loading}
          className="option-dropdown"
        >
          <option value="">No folder (root)</option>
          {folders.map((folder) => (
            <option key={folder.folder_id} value={folder.folder_id}>
              📁 {folder.name} {folder.ontology_id ? `(🏭 ${folder.ontology_id})` : ''}
            </option>
          ))}
        </select>
        {selectedFolder?.ontology_id && (
          <p className="folder-ontology-hint">
            ✨ This folder uses <strong>{selectedFolder.ontology_id}</strong> ontology by default
          </p>
        )}
      </div>

      {/* Processing Options Row */}
      <div className="options-row">
        {/* Ontology Selector */}
        <div className="option-selector ontology-selector-container">
          <label htmlFor="ontology-template">
            <span className="option-label">🏭 Ontology</span>
            <span className="option-help" title="Select an ontology for structured entity extraction">ⓘ</span>
          </label>
          <div className="ontology-selector-row">
            <select
              id="ontology-template"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              disabled={loadingOptions || loading || loadingSchema}
              className={`option-dropdown ${!hasOntologySelected ? 'no-ontology' : ''}`}
            >
              <option value="auto">🔍 Auto-detect (no ontology)</option>
              
              {workspaceOntologies.length > 0 && (
                <optgroup label="📁 Workspace Ontologies">
                  {workspaceOntologies.map((ont) => (
                    <option key={ont.ontologyId} value={ont.ontologyId}>
                      {ont.label || ont.ontologyId}
                    </option>
                  ))}
                </optgroup>
              )}
              
              {globalOntologies.length > 0 && (
                <optgroup label="🌐 Global Ontologies (read-only)">
                  {globalOntologies.map((ont) => (
                    <option key={ont.ontologyId} value={ont.ontologyId} disabled>
                      {ont.label || ont.ontologyId} (copy to use)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {loadingSchema && <span className="loading-indicator">⏳</span>}
          </div>
          
          {/* No ontology warning */}
          {!hasOntologySelected && selectedFiles.length > 0 && (
            <div className="ontology-warning">
              <span className="warning-icon">⚠️</span>
              <span className="warning-text">
                {hasCsvFiles 
                  ? 'CSV files need an ontology for proper entity mapping'
                  : 'Without an ontology, entities won\'t be aligned to a schema'
                }
              </span>
            </div>
          )}
          
          {/* No workspace ontologies - show copy options */}
          {!hasWorkspaceOntologies && globalOntologies.length > 0 && (
            <div className="ontology-setup-prompt">
              <p>No workspace ontologies yet. Copy a global ontology to get started:</p>
              <div className="global-ontology-chips">
                {globalOntologies.slice(0, 4).map((ont) => (
                  <button
                    key={ont.ontologyId}
                    className="ontology-chip"
                    onClick={() => handleCopyGlobalOntology(ont)}
                    disabled={copyingOntology}
                  >
                    {copyingOntology ? '⏳' : '📋'} {ont.label || ont.ontologyId}
                  </button>
                ))}
              </div>
            </div>
          )}
          
          {/* Selected ontology info */}
          {hasOntologySelected && industrySchema && (
            <p className="option-description ontology-info">
              ✅ {industrySchema.entityTypes?.length || 0} classes, {industrySchema.relationships?.length || 0} relationships
            </p>
          )}
        </div>

        {/* Chunking Method Selector */}
        <div className="option-selector">
          <label htmlFor="chunking-method">
            <span className="option-label">✂️ Chunking Method</span>
            <span className="option-help" title="How to split documents into chunks">ⓘ</span>
          </label>
          <select
            id="chunking-method"
            value={selectedChunkingMethod}
            onChange={(e) => setSelectedChunkingMethod(e.target.value)}
            disabled={loadingOptions || loading}
            className="option-dropdown"
          >
            {chunkingMethods.map((method) => (
              <option key={method.id} value={method.id}>
                {method.isDefault ? '⭐ ' : ''}{method.name}
              </option>
            ))}
          </select>
          <p className="option-description">
            {chunkingMethods.find(m => m.id === selectedChunkingMethod)?.description || 'Fixed length chunks'}
            {selectedChunkingMethod === 'page' && !hasPdfFiles && (
              <span className="option-warning"> (best for PDFs)</span>
            )}
          </p>
        </div>
      </div>

      {/* PDF Extraction Method - shown when PDF files are selected */}
      {hasPdfFiles && (
        <div className="pdf-extraction-section">
          <div className="pdf-extraction-header">
            <span className="pdf-icon">📄</span>
            <span className="pdf-title">PDF Text Extraction Method</span>
            <span className="pdf-hint">Choose how to extract text from PDFs</span>
          </div>
          <div className="extraction-mode-buttons">
            {extractionMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                className={`extraction-mode-btn ${selectedExtractionMethod === method.id ? 'active' : ''}`}
                onClick={() => setSelectedExtractionMethod(method.id)}
                disabled={loadingOptions || loading}
              >
                <span className="mode-icon">{method.icon}</span>
                <div className="mode-info">
                  <span className="mode-name">{method.name}</span>
                  <span className="mode-description">{method.description}</span>
                </div>
                {method.isDefault && <span className="mode-default">★ Default</span>}
              </button>
            ))}
          </div>
          {selectedExtractionMethod === 'ocr' && (
            <p className="extraction-note">
              ⚠️ OCR is slower but better for scanned documents and receipts. Requires poppler installed.
            </p>
          )}
        </div>
      )}

      {/* Predefined Industry Schema Indicator */}
      {usingPredefinedSchema && (
        <div className="predefined-schema-indicator">
          <span className="schema-icon">🏭</span>
          <span className="schema-text">
            <strong>{industrySchema.name}</strong> schema selected
          </span>
          <span className="schema-hint">
            Click upload to review and edit entity types & relationships
          </span>
        </div>
      )}

      {/* CSV Processing Mode - shown when CSV files are selected */}
      {hasCsvFiles && (
        <div className="csv-processing-section">
          <div className="csv-processing-header">
            <span className="csv-icon">📊</span>
            <span className="csv-title">CSV Processing Mode</span>
            <span className="csv-hint">CSV files detected - choose how to process them</span>
          </div>
          <div className="csv-mode-buttons">
            {csvProcessingModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`csv-mode-btn ${selectedCsvProcessingMode === mode.id ? 'active' : ''}`}
                onClick={() => setSelectedCsvProcessingMode(mode.id)}
                disabled={loadingOptions || loading}
              >
                <span className="mode-icon">{mode.icon}</span>
                <div className="mode-info">
                  <span className="mode-name">{mode.name}</span>
                  <span className="mode-description">{mode.description}</span>
                </div>
                {mode.isDefault && <span className="mode-default">★ Recommended</span>}
              </button>
            ))}
          </div>
          <div className="csv-mode-details">
            <p>{csvProcessingModes.find(m => m.id === selectedCsvProcessingMode)?.details}</p>
            {csvProcessingModes.find(m => m.id === selectedCsvProcessingMode)?.example && (
              <code>{csvProcessingModes.find(m => m.id === selectedCsvProcessingMode)?.example}</code>
            )}
          </div>
          <div className="csv-chunking-option">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={csvChunkingEnabled}
                onChange={(e) => setCsvChunkingEnabled(e.target.checked)}
                disabled={loadingOptions || loading}
              />
              <span>Enable chunking for CSV</span>
            </label>
            <span className="option-help" title="When enabled, CSV rows are grouped into chunks for semantic search. When disabled, each row becomes a separate entity.">ⓘ</span>
          </div>
        </div>
      )}



      <div
        className={`upload-area ${dragActive ? 'drag-active' : ''}`}
        onClick={handleButtonClick}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        style={{ cursor: 'pointer' }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".owl,.rdf,.ttl,.turtle,.json,.jsonld,.pdf,.txt,.md,.html,.csv"
          onChange={handleChange}
          style={{ display: 'none' }}
        />
        
        <div className="upload-content">
          <svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <h3>Upload Documents</h3>
          <p>Drag and drop files here, or click to browse</p>
          <p className="file-types">Supported: OWL, RDF, Turtle, JSON-LD, PDF, TXT, MD, HTML, CSV</p>
          <p className="file-types multi-file-hint">
            📁 Upload up to {MAX_FILES} files at once
          </p>
        </div>
      </div>

      {/* Selected Files List */}
      {selectedFiles.length > 0 && (
        <div className="selected-files">
          <div className="selected-files-header">
            <span className="files-count">
              {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
              <span className="files-size">({(totalSize / 1024 / 1024).toFixed(2)} MB)</span>
            </span>
            <button className="clear-files-btn" onClick={clearFiles} disabled={loading}>
              Clear All
            </button>
          </div>
          
          <div className="files-list">
            {selectedFiles.map((file, index) => (
              <div key={index} className={`file-item ${uploadProgress[index]?.status || ''}`}>
                <span className="file-status-icon">
                  {getStatusIcon(uploadProgress[index]?.status)}
                </span>
                <span className="file-name" title={file.name}>
                  {file.name.length > 40 ? file.name.substring(0, 37) + '...' : file.name}
                </span>
                <span className="file-size">
                  {(file.size / 1024).toFixed(1)} KB
                </span>
                {uploadProgress[index]?.status === 'uploading' && (
                  <div className="file-progress">
                    <div 
                      className="file-progress-bar" 
                      style={{ width: `${uploadProgress[index]?.progress || 0}%` }}
                    />
                  </div>
                )}
                {!loading && !uploadProgress[index]?.status && (
                  <button 
                    className="remove-file-btn" 
                    onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                    title="Remove file"
                  >
                    ×
                  </button>
                )}
                {uploadProgress[index]?.status === 'error' && (
                  <span className="file-error" title={uploadProgress[index]?.error}>
                    Error
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        className="upload-button"
        onClick={handleUpload}
        disabled={selectedFiles.length === 0 || loading || isAnalyzing || (selectedTemplate !== 'auto' && loadingSchema)}
      >
        {loadingSchema && selectedTemplate !== 'auto'
          ? '⏳ Loading schema...'
          : isAnalyzing 
            ? '🔍 Analyzing document...'
            : loading 
              ? `Processing... (${Object.values(uploadProgress).filter(p => p.status === 'complete').length}/${selectedFiles.length})`
              : usingPredefinedSchema
                ? `📋 Review ${industrySchema?.name || 'Predefined'} Schema`
                : reviewSchemaEnabled && selectedFiles.length === 1
                  ? '📋 Analyze & Review Schema'
                  : `Upload ${selectedFiles.length > 0 ? selectedFiles.length : ''} File${selectedFiles.length !== 1 ? 's' : ''} & Create Graph`
        }
      </button>

      {/* Ontology Manager Modal */}
      {showOntologyManager && (
        <OntologyManager
          onClose={() => {
            setShowOntologyManager(false);
            refreshTemplates(); // Refresh list in case changes were made
          }}
          onSelectOntology={handleOntologySelect}
        />
      )}
    </div>
  );
};

export default FileUpload;
