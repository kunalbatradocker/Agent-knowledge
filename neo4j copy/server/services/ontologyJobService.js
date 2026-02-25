/**
 * Ontology Job Service
 * Manages background jobs for ontology preview and generation
 * Uses Redis for job state, supports parallel processing
 */

const { v4: uuidv4 } = require('uuid');
const { client: redisClient } = require('../config/redis');
const logger = require('../utils/logger');

// Redis key prefixes
const REDIS_KEYS = {
  JOB: 'ontology_job:',
  JOB_LIST: 'ontology_jobs:',
  JOB_BY_FILE: 'ontology_job:file:'
};

// Job statuses
const JOB_STATUS = {
  UPLOADED: 'uploaded',      // File uploaded, waiting for user to trigger generation
  PENDING: 'pending',        // Generation queued
  EXTRACTING: 'extracting',  // Extracting text from document
  ANALYZING: 'analyzing',    // LLM analyzing content
  GENERATING: 'generating',  // Generating ontology suggestions
  COMPLETED: 'completed',    // Ready for user review
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  APPROVED: 'approved',      // User approved the extraction
  REJECTED: 'rejected'
};

// Job retention settings (in seconds)
const JOB_RETENTION = {
  COMPLETED: 24 * 60 * 60,    // 24 hours for completed jobs
  APPROVED: 7 * 24 * 60 * 60, // 7 days for approved jobs
  REJECTED: 24 * 60 * 60,     // 24 hours for rejected jobs
  FAILED: 7 * 24 * 60 * 60,   // 7 days for failed jobs
  CANCELLED: 24 * 60 * 60,    // 24 hours for cancelled jobs
  MAX_JOBS_PER_WORKSPACE: 100 // Max jobs to keep per workspace
};

class OntologyJobService {
  constructor() {
    this.activeJobs = new Map(); // In-memory tracking of running jobs
    
    // Start cleanup interval (every hour)
    this.cleanupInterval = setInterval(() => this.cleanupOldJobs(), 60 * 60 * 1000);
    
    // Run initial cleanup after 30 seconds
    setTimeout(() => this.cleanupOldJobs(), 30000);
  }

  /**
   * Create a new ontology generation job
   */
  async createJob(jobData) {
    const jobId = uuidv4();
    const now = new Date().toISOString();
    
    // Default to 'uploaded' status if not specified (file uploaded, waiting for generation)
    const initialStatus = jobData.status || JOB_STATUS.UPLOADED;
    const jobType = jobData.jobType || jobData.job_type || 'extraction';

    // Processing steps vary by job type
    const stepsByType = {
      upload: [
        { step: 'queued', label: 'Queued', status: 'active', timestamp: now },
        { step: 'parsing', label: 'Parsing File', status: 'pending' },
        { step: 'chunking', label: 'Chunking', status: 'pending' },
        { step: 'staging', label: 'Staging for Review', status: 'pending' },
        { step: 'complete', label: 'Ready for Review', status: 'pending' }
      ],
      commit: [
        { step: 'queued', label: 'Queued', status: 'active', timestamp: now },
        { step: 'extraction', label: 'Extracting Triples', status: 'pending' },
        { step: 'embedding', label: 'Embedding Chunks', status: 'pending' },
        { step: 'writing', label: 'Writing to GraphDB', status: 'pending' },
        { step: 'syncing', label: 'Syncing to Neo4j', status: 'pending' },
        { step: 'complete', label: 'Committed', status: 'pending' }
      ],
      extraction: [
        { step: 'queued', label: 'Queued', status: initialStatus === JOB_STATUS.PENDING ? 'active' : 'pending', timestamp: now },
        { step: 'text_extraction', label: 'Text Extraction', status: 'pending' },
        { step: 'chunking', label: 'Chunking', status: 'pending' },
        { step: 'llm_extraction', label: 'LLM Extraction', status: 'pending' },
        { step: 'validation', label: 'Validation', status: 'pending' },
        { step: 'complete', label: 'Complete', status: 'pending' }
      ],
      schema_analysis: [
        { step: 'queued', label: 'Queued', status: 'active', timestamp: now },
        { step: 'analyzing', label: 'Analyzing Documents', status: 'pending' },
        { step: 'schema_gen', label: 'Generating Schema', status: 'pending' },
        { step: 'complete', label: 'Schema Ready', status: 'pending' }
      ]
    };
    
    const job = {
      job_id: jobId,
      status: initialStatus,
      job_type: jobType,
      file_name: jobData.fileName || '',
      file_path: jobData.filePath || '',
      file_size: jobData.fileSize || 0,
      workspace_id: jobData.workspaceId || '',
      tenant_id: jobData.tenantId || '',
      folder_id: jobData.folderId || '',
      industry: jobData.industry || 'general',
      document_id: jobData.documentId || '', // Link to existing document if any
      staged_doc_id: jobData.staged_doc_id || '', // Link to staged document for commit jobs
      created_at: now,
      updated_at: now,
      progress: '0',
      progress_message: initialStatus === JOB_STATUS.UPLOADED 
        ? 'File uploaded. Click "Generate" to extract ontology.' 
        : 'Queued for processing',
      processing_steps: JSON.stringify(stepsByType[jobType] || stepsByType.extraction),
      // Results (populated during processing)
      preview_text: '',
      extracted_entities: '',
      extracted_relationships: '',
      suggested_ontology: '',
      ontology_suggestions: '',  // New: suggestions for missing ontology terms
      entity_count: '0',
      relationship_count: '0',
      error: ''
    };

    // Save to Redis
    await redisClient.hSet(`${REDIS_KEYS.JOB}${jobId}`, job);
    await redisClient.sAdd(`${REDIS_KEYS.JOB_LIST}all`, jobId);
    
    if (jobData.workspaceId) {
      await redisClient.sAdd(`${REDIS_KEYS.JOB_LIST}workspace:${jobData.workspaceId}`, jobId);
    }

    logger.debug(`Job created: ${jobId} (${jobData.fileName})`);
    return job;
  }


  /**
   * Create an extraction job for a document
   * Alias for createJob with extraction-specific defaults
   */
  async createExtractionJob(jobData) {
    const job = await this.createJob({
      fileName: jobData.fileName || `Document ${jobData.documentId}`,
      filePath: jobData.filePath || '',
      fileSize: jobData.fileSize || 0,
      workspaceId: jobData.workspace_id || jobData.workspaceId || '',
      folderId: jobData.folder_id || jobData.folderId || '',
      industry: jobData.industry || 'general',
      documentId: jobData.documentId || '',
      ontologyId: jobData.ontologyId || '',
      schemaMode: jobData.schemaMode || 'constrained',
      status: JOB_STATUS.PENDING
    });

    // Return with id field for compatibility
    return {
      ...job,
      id: job.job_id
    };
  }

  /**
   * Get job by ID
   */
  async getJob(jobId) {
    const data = await redisClient.hGetAll(`${REDIS_KEYS.JOB}${jobId}`);
    if (!data || !data.job_id) return null;
    
    // Parse numeric fields
    data.progress = parseInt(data.progress) || 0;
    data.entity_count = parseInt(data.entity_count) || 0;
    data.relationship_count = parseInt(data.relationship_count) || 0;
    data.file_size = parseInt(data.file_size) || 0;
    data.embedding_failures = parseInt(data.embedding_failures) || 0;
    
    // Parse JSON fields
    const jsonFields = [
      'extracted_entities', 
      'extracted_relationships', 
      'suggested_ontology', 
      'ontology_suggestions',
      'validation_stats',
      'processing_steps'
    ];
    
    for (const field of jsonFields) {
      if (data[field]) {
        try {
          data[field] = JSON.parse(data[field]);
        } catch (e) {
          // Keep as string if not valid JSON
        }
      }
    }

    // Self-heal: fix legacy jobs that have wrong processing steps for their type
    const steps = Array.isArray(data.processing_steps) ? data.processing_steps : [];
    const jobType = data.job_type || 'extraction';
    const hasLegacySteps = steps.some(s => s.step === 'text_extraction') && jobType !== 'extraction';
    const isTerminal = ['completed', 'committed', 'failed', 'cancelled', 'approved', 'rejected'].includes(data.status);
    // Committed upload jobs should show commit steps (with embedding), not upload steps
    const isCommittedUpload = data.status === 'committed' && jobType === 'upload' && !steps.some(s => s.step === 'embedding');

    if (hasLegacySteps || isCommittedUpload || (isTerminal && steps.some(s => s.status === 'active'))) {
      const now = data.updated_at || new Date().toISOString();
      const finalStatus = isTerminal ? 'completed' : 'pending';
      // Committed upload jobs should use commit steps
      const effectiveType = isCommittedUpload ? 'commit' : jobType;
      const correctSteps = {
        upload: [
          { step: 'queued', label: 'Queued', status: 'completed', timestamp: now },
          { step: 'parsing', label: 'Parsing File', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'chunking', label: 'Chunking', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'staging', label: 'Staging for Review', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'complete', label: 'Ready for Review', status: finalStatus }
        ],
        commit: [
          { step: 'queued', label: 'Queued', status: 'completed', timestamp: now },
          { step: 'extraction', label: 'Extracting Triples', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'embedding', label: 'Embedding Chunks', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'writing', label: 'Writing to GraphDB', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'syncing', label: 'Syncing to Neo4j', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'complete', label: 'Committed', status: finalStatus }
        ],
        schema_analysis: [
          { step: 'queued', label: 'Queued', status: 'completed', timestamp: now },
          { step: 'analyzing', label: 'Analyzing Documents', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'schema_gen', label: 'Generating Schema', status: finalStatus === 'completed' ? 'completed' : 'pending' },
          { step: 'complete', label: 'Schema Ready', status: finalStatus }
        ]
      };
      const template = correctSteps[effectiveType] || correctSteps[jobType];
      if (template) {
        // For committed upload jobs with embedding failures, mark the embedding step
        let fixed = template.map(s => {
          if (data.status === 'failed' && s.status === 'pending') return { ...s, status: 'skipped' };
          if (s.step === 'embedding' && data.embedding_failures > 0) {
            return { ...s, status: 'completed', failed: data.embedding_failures, stored: 0 };
          }
          return s;
        });
        data.processing_steps = fixed;
        // Persist fix back to Redis (fire-and-forget)
        redisClient.hSet(`${REDIS_KEYS.JOB}${jobId}`, { processing_steps: JSON.stringify(fixed) }).catch(() => {});
      }
    }
    
    return data;
  }

  /**
   * Get all jobs (optionally filtered)
   */
  async getJobs(filters = {}) {
    let jobIds;
    
    // If workspace filter is provided, ONLY get jobs from that workspace
    if (filters.workspaceId) {
      // Get jobs from workspace-specific set
      const wsJobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}workspace:${filters.workspaceId}`);
      
      // Also scan all jobs to catch any that weren't indexed to the workspace set
      const allJobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}all`);
      const wsSet = new Set(wsJobIds || []);
      
      for (const jobId of allJobIds) {
        if (wsSet.has(jobId)) continue;
        const job = await this.getJob(jobId);
        if (job && job.workspace_id === filters.workspaceId) {
          wsSet.add(jobId);
          // Backfill workspace index
          await redisClient.sAdd(`${REDIS_KEYS.JOB_LIST}workspace:${filters.workspaceId}`, jobId);
        }
      }
      
      jobIds = Array.from(wsSet);
    } else {
      // No workspace filter - get all jobs (admin view)
      jobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}all`);
    }
    
    const jobs = [];
    const seenIds = new Set();
    
    for (const jobId of jobIds) {
      if (seenIds.has(jobId)) continue;
      seenIds.add(jobId);
      
      const job = await this.getJob(jobId);
      if (job) {
        // Double-check workspace filter for legacy jobs
        if (filters.workspaceId && job.workspace_id && job.workspace_id !== filters.workspaceId) {
          continue;
        }
        // Apply status filter
        if (filters.status && job.status !== filters.status) continue;
        jobs.push(job);
      }
    }
    
    // Sort by created_at descending
    return jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  /**
   * Update job status and progress
   */
  async updateJob(jobId, updates) {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    
    const updateData = {
      updated_at: new Date().toISOString()
    };
    
    // Process each update field
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null) {
        continue; // Skip undefined/null values
      }
      
      if (typeof value === 'object') {
        // Stringify all objects and arrays
        updateData[key] = JSON.stringify(value);
      } else if (typeof value === 'number') {
        // Convert numbers to strings for Redis
        updateData[key] = String(value);
      } else if (typeof value === 'boolean') {
        // Convert booleans to strings
        updateData[key] = String(value);
      } else {
        // Keep strings as-is
        updateData[key] = value;
      }
    }
    
    await redisClient.hSet(`${REDIS_KEYS.JOB}${jobId}`, updateData);
    
    return { ...job, ...updates };
  }

  /**
   * Update a specific processing step status
   * @param {string} jobId - Job ID
   * @param {string} stepName - Step name (queued, text_extraction, chunking, llm_extraction, validation, complete)
   * @param {string} status - Status (pending, active, completed, failed, skipped)
   * @param {object} details - Optional details (duration, count, error, etc.)
   */
  async updateProcessingStep(jobId, stepName, status, details = {}) {
    const job = await this.getJob(jobId);
    if (!job) return;
    
    let steps = [];
    try {
      steps = typeof job.processing_steps === 'string' 
        ? JSON.parse(job.processing_steps) 
        : (job.processing_steps || []);
    } catch (e) {
      steps = [];
    }
    
    const now = new Date().toISOString();
    const stepIndex = steps.findIndex(s => s.step === stepName);
    
    if (stepIndex >= 0) {
      steps[stepIndex] = {
        ...steps[stepIndex],
        status,
        timestamp: now,
        ...details
      };
      
      // If this step is now active, mark previous steps as completed
      if (status === 'active') {
        for (let i = 0; i < stepIndex; i++) {
          if (steps[i].status === 'active' || steps[i].status === 'pending') {
            steps[i].status = 'completed';
            if (!steps[i].timestamp) steps[i].timestamp = now;
          }
        }
      }
    }
    
    await redisClient.hSet(`${REDIS_KEYS.JOB}${jobId}`, {
      processing_steps: JSON.stringify(steps),
      updated_at: now
    });
  }


  /**
   * Cancel a job
   */
  async cancelJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    
    if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.APPROVED) {
      return { success: false, error: 'Cannot cancel completed or approved job' };
    }
    
    // Mark for cancellation
    await this.updateJob(jobId, {
      status: JOB_STATUS.CANCELLED,
      progress_message: 'Cancelled by user'
    });
    
    // Remove from active jobs if running
    this.activeJobs.delete(jobId);
    
    return { success: true };
  }

  /**
   * Approve job results (proceed with graph creation)
   */
  async approveJob(jobId, modifications = {}) {
    const job = await this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    
    if (job.status !== JOB_STATUS.COMPLETED) {
      return { success: false, error: 'Can only approve completed jobs' };
    }
    
    // Apply any modifications to the ontology
    let finalOntology = job.suggested_ontology;
    if (modifications.ontology) {
      finalOntology = modifications.ontology;
    }
    
    await this.updateJob(jobId, {
      status: JOB_STATUS.APPROVED,
      progress_message: 'Approved - ready for graph creation',
      suggested_ontology: finalOntology
    });
    
    return { success: true, job: await this.getJob(jobId) };
  }

  /**
   * Reject job results
   */
  async rejectJob(jobId, reason = '') {
    const job = await this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    
    await this.updateJob(jobId, {
      status: JOB_STATUS.REJECTED,
      progress_message: reason || 'Rejected by user'
    });
    
    return { success: true };
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    
    // Remove from Redis
    await redisClient.del(`${REDIS_KEYS.JOB}${jobId}`);
    await redisClient.sRem(`${REDIS_KEYS.JOB_LIST}all`, jobId);
    
    if (job.workspace_id) {
      await redisClient.sRem(`${REDIS_KEYS.JOB_LIST}workspace:${job.workspace_id}`, jobId);
    }
    
    this.activeJobs.delete(jobId);
    
    return { success: true };
  }


  /**
   * Process a job (runs in background)
   * Uses GraphRAG extraction with ontology alignment
   */
  async processJob(jobId, processingFunctions) {
    const { extractText, analyzeWithLLM } = processingFunctions;
    
    try {
      this.activeJobs.set(jobId, true);
      
      const job = await this.getJob(jobId);
      if (!job || job.status === JOB_STATUS.CANCELLED) {
        return;
      }

      logger.job(`[${jobId.slice(0,8)}] Starting extraction: ${job.file_name}`);

      // Update to pending status
      await this.updateJob(jobId, {
        status: JOB_STATUS.PENDING,
        progress: 5,
        progress_message: 'Starting ontology extraction...'
      });

      // Step 1: Extract text (20%)
      await this.updateJob(jobId, {
        status: JOB_STATUS.EXTRACTING,
        progress: 10,
        progress_message: 'Extracting text from document...'
      });
      logger.extraction(`[${jobId.slice(0,8)}] Extracting text...`);

      const textResult = await extractText(job.file_path);
      
      if (this.isJobCancelled(jobId)) return;
      
      const textLength = textResult.text?.length || 0;
      logger.extraction(`[${jobId.slice(0,8)}] Text extracted: ${(textLength / 1000).toFixed(1)}K chars`);
      
      await this.updateJob(jobId, {
        progress: 30,
        progress_message: 'Text extraction complete',
        preview_text: textResult.text?.substring(0, 5000) || '' // First 5000 chars for preview
      });

      // Step 2: Analyze with LLM using GraphRAG extraction (60%)
      await this.updateJob(jobId, {
        status: JOB_STATUS.ANALYZING,
        progress: 40,
        progress_message: 'Analyzing document with LLM (ontology alignment)...'
      });
      logger.extraction(`[${jobId.slice(0,8)}] Sending to LLM for analysis...`);

      if (this.isJobCancelled(jobId)) return;

      const analysisResult = await analyzeWithLLM(textResult.text, job.industry);
      
      if (this.isJobCancelled(jobId)) return;

      logger.extraction(`[${jobId.slice(0,8)}] LLM analysis complete`);
      
      await this.updateJob(jobId, {
        progress: 70,
        progress_message: 'Entity and relationship extraction complete'
      });

      // Step 3: Process results (90%)
      await this.updateJob(jobId, {
        status: JOB_STATUS.GENERATING,
        progress: 80,
        progress_message: 'Processing extraction results...'
      });

      if (this.isJobCancelled(jobId)) return;

      // Extract data from GraphRAG format
      const entities = analysisResult.entities || [];
      const relationships = analysisResult.relationships || [];
      const ontologySuggestions = analysisResult.ontologySuggestions || {};
      
      // Build suggested ontology structure for review
      const suggestedOntology = {
        extractionSummary: analysisResult.extractionSummary || {},
        entity_types: this.extractEntityTypes(entities),
        relationship_types: this.extractRelationshipTypes(relationships),
        entities: entities.slice(0, 100), // Limit for preview
        relationships: relationships.slice(0, 100),
        stats: analysisResult.stats || {}
      };

      // Step 4: Complete
      await this.updateJob(jobId, {
        status: JOB_STATUS.COMPLETED,
        progress: 100,
        progress_message: 'Analysis complete - ready for review',
        extracted_entities: entities,
        extracted_relationships: relationships,
        suggested_ontology: suggestedOntology,
        ontology_suggestions: ontologySuggestions,
        entity_count: entities.length,
        relationship_count: relationships.length
      });

      logger.milestone(`[${jobId.slice(0,8)}] Job complete: ${entities.length} entities, ${relationships.length} relationships`);
      
    } catch (error) {
      logger.error(`[${jobId.slice(0,8)}] Job failed: ${error.message}`);
      await this.updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        progress_message: `Error: ${error.message}`,
        error: error.message
      });
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Check if job was cancelled
   */
  isJobCancelled(jobId) {
    return !this.activeJobs.has(jobId);
  }

  /**
   * Extract unique entity types from entities
   */
  extractEntityTypes(entities) {
    const types = new Map();
    for (const entity of entities) {
      const type = entity.type || entity.label || 'Unknown';
      if (!types.has(type)) {
        types.set(type, { type, count: 0, examples: [] });
      }
      const typeInfo = types.get(type);
      typeInfo.count++;
      if (typeInfo.examples.length < 3) {
        // Try multiple property names for the entity name
        const entityName = entity.label || entity.name || entity.text || 'Unknown';
        if (entityName && entityName !== 'Unknown') {
          typeInfo.examples.push(entityName);
        }
      }
    }
    return Array.from(types.values());
  }

  /**
   * Extract unique relationship types
   */
  extractRelationshipTypes(relationships) {
    const types = new Map();
    for (const rel of relationships) {
      // Use predicate first (semantic relationship), then fall back to type
      const type = rel.predicate || rel.type || rel.relationship || 'RELATED_TO';
      if (!types.has(type)) {
        types.set(type, { type, count: 0 });
      }
      types.get(type).count++;
    }
    return Array.from(types.values());
  }

  /**
   * Cleanup old jobs based on retention settings
   * Called periodically and after job status changes
   */
  async cleanupOldJobs() {
    try {
      const allJobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}all`);
      const now = Date.now();
      let deletedCount = 0;
      let checkedCount = 0;
      
      for (const jobId of allJobIds) {
        checkedCount++;
        const job = await this.getJob(jobId);
        
        if (!job) {
          // Job data missing, remove from index
          await redisClient.sRem(`${REDIS_KEYS.JOB_LIST}all`, jobId);
          deletedCount++;
          continue;
        }
        
        const updatedAt = new Date(job.updated_at || job.created_at).getTime();
        const ageSeconds = (now - updatedAt) / 1000;
        
        // Determine retention based on status
        let retentionSeconds = null;
        switch (job.status) {
          case JOB_STATUS.COMPLETED:
            retentionSeconds = JOB_RETENTION.COMPLETED;
            break;
          case JOB_STATUS.APPROVED:
            retentionSeconds = JOB_RETENTION.APPROVED;
            break;
          case JOB_STATUS.REJECTED:
            retentionSeconds = JOB_RETENTION.REJECTED;
            break;
          case JOB_STATUS.FAILED:
            retentionSeconds = JOB_RETENTION.FAILED;
            break;
          case JOB_STATUS.CANCELLED:
            retentionSeconds = JOB_RETENTION.CANCELLED;
            break;
          default:
            // Keep active/pending jobs indefinitely
            retentionSeconds = null;
        }
        
        // Delete if past retention period
        if (retentionSeconds !== null && ageSeconds > retentionSeconds) {
          await this.deleteJob(jobId);
          deletedCount++;
          console.log(`🗑️ Deleted old job: ${jobId} (status: ${job.status}, age: ${Math.round(ageSeconds / 3600)}h)`);
        }
      }
      
      // Also enforce max jobs per workspace
      await this.enforceWorkspaceJobLimits();
      
      // Only log if something was deleted
      if (deletedCount > 0) {
        console.log(`🧹 Job cleanup: deleted ${deletedCount} of ${checkedCount} jobs`);
      }
    } catch (error) {
      console.error('❌ Error during job cleanup:', error.message);
    }
  }

  /**
   * Enforce maximum jobs per workspace
   * Keeps the most recent jobs, deletes oldest
   */
  async enforceWorkspaceJobLimits() {
    try {
      // Get all workspace-specific job sets using SCAN instead of KEYS
      const keys = [];
      let cursor = '0';
      do {
        const result = await redisClient.sendCommand(['SCAN', cursor, 'MATCH', `${REDIS_KEYS.JOB_LIST}workspace:*`, 'COUNT', '200']);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');
      
      for (const key of keys) {
        const jobIds = await redisClient.sMembers(key);
        
        if (jobIds.length <= JOB_RETENTION.MAX_JOBS_PER_WORKSPACE) {
          continue;
        }
        
        // Get all jobs with their timestamps
        const jobsWithTime = [];
        for (const jobId of jobIds) {
          const job = await this.getJob(jobId);
          if (job) {
            jobsWithTime.push({
              jobId,
              createdAt: new Date(job.created_at).getTime(),
              status: job.status
            });
          }
        }
        
        // Sort by created_at descending (newest first)
        jobsWithTime.sort((a, b) => b.createdAt - a.createdAt);
        
        // Delete jobs beyond the limit (oldest first)
        const toDelete = jobsWithTime.slice(JOB_RETENTION.MAX_JOBS_PER_WORKSPACE);
        
        for (const { jobId, status } of toDelete) {
          // Don't delete active jobs
          if (['pending', 'extracting', 'analyzing', 'generating'].includes(status)) {
            continue;
          }
          await this.deleteJob(jobId);
          console.log(`   🗑️ Deleted excess job: ${jobId} (workspace limit)`);
        }
      }
    } catch (error) {
      console.error('❌ Error enforcing workspace job limits:', error.message);
    }
  }

  /**
   * Clean up jobs for a specific workspace
   * Called when workspace is deleted or cleaned
   */
  async cleanupWorkspaceJobs(workspaceId) {
    console.log(`🧹 Cleaning up jobs for workspace: ${workspaceId}`);
    
    try {
      const jobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}workspace:${workspaceId}`);
      let deletedCount = 0;
      
      for (const jobId of jobIds) {
        await this.deleteJob(jobId);
        deletedCount++;
      }
      
      console.log(`   ✅ Deleted ${deletedCount} jobs for workspace ${workspaceId}`);
      return { success: true, deletedCount };
    } catch (error) {
      console.error(`❌ Error cleaning up workspace jobs:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get job statistics
   */
  async getJobStats() {
    try {
      const allJobIds = await redisClient.sMembers(`${REDIS_KEYS.JOB_LIST}all`);
      const stats = {
        total: allJobIds.length,
        byStatus: {},
        byWorkspace: {}
      };
      
      for (const jobId of allJobIds) {
        const job = await this.getJob(jobId);
        if (!job) continue;
        
        // Count by status
        stats.byStatus[job.status] = (stats.byStatus[job.status] || 0) + 1;
        
        // Count by workspace
        const ws = job.workspace_id || 'global';
        stats.byWorkspace[ws] = (stats.byWorkspace[ws] || 0) + 1;
      }
      
      return stats;
    } catch (error) {
      console.error('Error getting job stats:', error.message);
      return { total: 0, byStatus: {}, byWorkspace: {} };
    }
  }
}

module.exports = new OntologyJobService();
module.exports.JOB_STATUS = JOB_STATUS;
module.exports.JOB_RETENTION = JOB_RETENTION;
