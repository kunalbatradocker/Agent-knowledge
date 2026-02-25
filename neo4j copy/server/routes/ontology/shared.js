/**
 * Shared utilities and configuration for ontology routes
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const graphSchemaService = require('../../services/graphSchemaService');
const { UPLOAD } = require('../../config/constants');

// Initialize schema on startup
let schemaInitialized = false;

async function ensureSchemaInitialized() {
  if (!schemaInitialized) {
    try {
      await graphSchemaService.initializeSchema();
      schemaInitialized = true;
    } catch (error) {
      console.warn('Could not initialize schema:', error.message);
    }
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // Workspace-scoped upload directories
    const workspaceId = req.body?.workspaceId || req.body?.workspace_id
      || req.headers?.['x-workspace-id'] || 'default';
    const uploadsDir = path.join(__dirname, '../../../uploads', workspaceId);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Supported RDF/OWL formats for ontology upload
const ALLOWED_ONTOLOGY_EXTENSIONS = ['.owl', '.rdf', '.ttl', '.turtle', '.jsonld', '.n3', '.nt'];

// Supported document formats for processing
const ALLOWED_DOCUMENT_EXTENSIONS = ['.pdf', '.txt', '.md', '.html', '.csv', '.xlsx', '.xls'];

const upload = multer({
  storage: storage,
  limits: {
    fileSize: UPLOAD.MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Determine if this is an ontology upload based on route
    const isOntologyUpload = req.route?.path?.includes('owl') || req.url?.includes('ontology');
    const allowedExtensions = isOntologyUpload ? ALLOWED_ONTOLOGY_EXTENSIONS : ALLOWED_DOCUMENT_EXTENSIONS;
    
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed types: ${allowedExtensions.join(', ')}`));
    }
  }
});

/**
 * Sanitize a string to be a valid Neo4j label
 * Neo4j labels can't have spaces - convert to PascalCase
 */
function sanitizeLabel(str) {
  if (!str) return 'Concept';
  return str.split(/\s+/).map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join('');
}

/**
 * Clean up uploaded file
 */
function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to clean up file:', err.message);
    }
  }
}

module.exports = {
  ensureSchemaInitialized,
  upload,
  sanitizeLabel,
  cleanupFile,
  ALLOWED_ONTOLOGY_EXTENSIONS,
  ALLOWED_DOCUMENT_EXTENSIONS
};
