const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Load .env from project root (one level up from server/)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ontologyRouter = require('./routes/ontology/index');
const owlRouter = require('./routes/owl');
const sparqlRouter = require('./routes/sparql');
const graphRouter = require('./routes/graph');
const chatRouter = require('./routes/chat');
const foldersRouter = require('./routes/folders');
const enterpriseRouter = require('./routes/enterprise');
const tenantsRouter = require('./routes/tenants');
const versioningRouter = require('./routes/versioning');
const ontologyVersionsRouter = require('./routes/ontologyVersions');
const entitiesRouter = require('./routes/entities');
const extractionRouter = require('./routes/extraction');
const evidenceRouter = require('./routes/evidence');
const ontologyPacksRouter = require('./routes/ontologyPacks');
const reviewQueueRouter = require('./routes/reviewQueue');
const metricsRouter = require('./routes/metrics');
const identityRouter = require('./routes/identity');
const settingsRouter = require('./routes/settings');
const syncRouter = require('./routes/sync');
const adminRouter = require('./routes/admin');
const jdbcConnectorRouter = require('./routes/jdbcConnector');
const authRouter = require('./routes/auth');
const trinoCatalogsRouter = require('./routes/trinoCatalogs');
const vkgQueryRouter = require('./routes/vkgQuery');
const { requireAuth, requireAdmin, requireManager, requireMember, requireWorkspaceAccess, csrfProtection } = require('./middleware/auth');
const { injectUserLLMToken } = require('./middleware/llmToken');
const { activityLogger } = require('./middleware/activityLogger');
const minimalGraphSchemaService = require('./services/minimalGraphSchemaService');
const initializationService = require('./services/initializationService');
const ontologyInitializationService = require('./services/ontologyInitializationService');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 5002;

// Middleware
const CORS_ORIGIN = process.env.CORS_ORIGIN;
app.use(cors({
  origin: CORS_ORIGIN ? CORS_ORIGIN.split(',').map(s => s.trim()) : true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// CSRF protection on all /api state-changing requests
app.use('/api', csrfProtection);

// API rate limiting (200 req/min per user/IP)
app.use('/api', apiLimiter);

// Activity audit logger (before routes so it captures everything including auth)
app.use('/api', activityLogger);

// Auth routes (public - no token needed)
app.use('/api/auth', authRouter);

// Swagger UI (public — no auth needed)
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const swaggerDocument = yaml.load(fs.readFileSync(path.join(__dirname, '../docs/openapi.yaml'), 'utf8'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Purple Fabric API Docs',
}));

// Health check (public)
app.get('/api/health', async (req, res) => {
  const { checkConnection: checkRedisConnection } = require('./config/redis');
  const { checkConnection: checkGraphDBConnection } = require('./config/graphdb');
  const neo4jService = require('./services/neo4jService');
  
  try {
    const neo4jStatus = await neo4jService.checkConnection();
    const redisStatus = await checkRedisConnection();
    const graphdbStatus = await checkGraphDBConnection();
    
    let ollamaStatus = { connected: false, message: 'Not configured' };
    let trinoStatus = { connected: false, message: 'Not checked' };

    // Check Trino
    try {
      const trinoClient = require('./config/trino');
      trinoStatus = await trinoClient.checkConnection();
    } catch (trinoErr) {
      trinoStatus = { connected: false, message: trinoErr.message };
    }

    if (process.env.USE_LOCAL_LLM === 'true') {
      try {
        const ollamaUrl = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1';
        const baseUrl = ollamaUrl.replace('/v1', '');
        const response = await fetch(`${baseUrl}/api/tags`, { method: 'GET', timeout: 5000 });
        if (response.ok) {
          const data = await response.json();
          const models = data.models?.map(m => m.name) || [];
          const configuredModel = process.env.LOCAL_LLM_MODEL || 'gemma3:4b';
          const hasModel = models.some(m => m.includes(configuredModel.split(':')[0]));
          ollamaStatus = { connected: true, message: hasModel ? 'Connected with model available' : `Connected but model ${configuredModel} not found`, models: models.slice(0, 5), configuredModel, hasModel };
        } else {
          ollamaStatus = { connected: false, message: `HTTP ${response.status}` };
        }
      } catch (ollamaError) {
        ollamaStatus = { connected: false, message: ollamaError.code === 'ECONNREFUSED' ? 'Ollama not running. Start with: ollama serve' : ollamaError.message };
      }
    }
    
    res.json({ status: 'ok', message: 'Enterprise Knowledge Graph Platform API is running', connections: { graphdb: graphdbStatus, neo4j: neo4jStatus, redis: redisStatus, trino: trinoStatus, ollama: ollamaStatus } });
  } catch (error) {
    res.json({ status: 'ok', message: 'API is running but connection check failed', error: error.message });
  }
});

// Protect all other API routes (skip /api/auth, /api/health, and /api/graph/connection)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/health' || req.path === '/graph/connection') return next();
  requireAuth(req, res, next);
});

// Inject per-user LLM token into request context (after auth, for all authenticated routes)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/health' || !req.user) return next();
  injectUserLLMToken(req, res, next);
});

// Routes
app.use('/api/owl', owlRouter);
app.use('/api/sparql', requireWorkspaceAccess, sparqlRouter);
app.use('/api/ontology', ontologyRouter);
app.use('/api/graph', graphRouter);
app.use('/api/chat', chatRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/enterprise', requireManager, enterpriseRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/versioning', requireWorkspaceAccess, versioningRouter);
app.use('/api/ontology-versions', ontologyVersionsRouter);
app.use('/api/entities', entitiesRouter);
app.use('/api/extraction', extractionRouter);
app.use('/api/evidence', requireMember, evidenceRouter);
app.use('/api/ontology-packs', ontologyPacksRouter);
app.use('/api/review-queue', requireWorkspaceAccess, reviewQueueRouter);
app.use('/api/metrics', requireWorkspaceAccess, metricsRouter);
app.use('/api/identity', identityRouter);
app.use('/api/settings', requireAdmin, settingsRouter);
app.use('/api/sync', requireManager, syncRouter);
app.use('/api/admin', requireAdmin, adminRouter);
app.use('/api/jdbc', requireMember, jdbcConnectorRouter);
app.use('/api/trino', requireMember, trinoCatalogsRouter);
app.use('/api/vkg', requireMember, vkgQueryRouter);

// Serve React build in production (Docker)
const clientBuildPath = path.join(__dirname, '../client/build');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Global error handling middleware (must be last)
app.use(errorHandler);

// Function to free the port before starting
function freePort(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti:${port}`, (error, stdout) => {
      if (stdout && stdout.trim()) {
        const pids = stdout.trim().split('\n').filter(pid => pid);
        if (pids.length > 0) {
          console.log(`Freeing port ${port} (killing PIDs: ${pids.join(', ')})...`);
          exec(`kill -9 ${pids.join(' ')} 2>/dev/null`, () => {
            // Wait a moment for port to be released
            setTimeout(resolve, 1000);
          });
        } else {
          resolve();
        }
      } else {
        resolve();
      }
    });
  });
}

// Start server
let server;

async function startServer() {
  // Free the port first
  await freePort(PORT);
  
  server = app.listen(PORT, async () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/api/health`);
    console.log(`   API base URL: http://localhost:${PORT}/api`);
    
    // Initialize Neo4j schema in the background
    try {
      console.log('\n🔧 Initializing Neo4j schema...');
      await minimalGraphSchemaService.initializeSchema();
      
      // Initialize master admin user in Redis
      console.log('\n🔐 Initializing auth...');
      const authService = require('./services/authService');
      await authService.initializeMasterAdmin();
      
      // Initialize default tenant/workspace and migrate orphaned documents
      console.log('\n🏢 Initializing tenant/workspace system...');
      await initializationService.initialize();
      
      // Initialize ontologies from GraphDB (or load from files if missing)
      console.log('\n📚 Initializing ontologies from GraphDB...');
      await ontologyInitializationService.initializeOnStartup();
      
      // Migrate old vector store data to RediSearch format (if any)
      try {
        const vectorStoreService = require('./services/vectorStoreService');
        console.log('\n🔍 Checking for vector store migration...');
        const migrated = await vectorStoreService.migrateOldData();
        if (migrated > 0) {
          console.log(`   Migrated ${migrated} chunks to RediSearch HNSW index`);
        } else {
          console.log('   No migration needed');
        }
      } catch (migrationError) {
        console.warn('⚠️  Vector store migration skipped:', migrationError.message);
      }
      
    } catch (error) {
      console.warn('⚠️  Could not complete initialization:', error.message);
      console.log('   System will continue but some features may be limited.');
    }
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} is still in use after cleanup attempt.`);
      console.error(`   Please manually run: lsof -ti:${PORT} | xargs kill -9`);
      console.error(`   Or change the PORT in your .env file`);
      process.exit(1);
    } else {
      console.error(`\n❌ Server error: ${err.message}`);
      throw err;
    }
  });
  
  return server;
}

// Graceful shutdown
function shutdown() {
  if (server) {
    console.log('\nClosing HTTP server...');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    
    // Force close after 5 seconds
    setTimeout(() => {
      console.log('Forcing shutdown...');
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received');
  shutdown();
});

process.on('SIGINT', () => {
  console.log('\nSIGINT signal received');
  shutdown();
});

// Global error handlers to prevent server crashes
process.on('uncaughtException', (error) => {
  console.error('\n❌ UNCAUGHT EXCEPTION:');
  console.error(error);
  console.error('Server will continue running...\n');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ UNHANDLED REJECTION:');
  console.error('Reason:', reason);
  console.error('Server will continue running...\n');
});

// Start the server
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
