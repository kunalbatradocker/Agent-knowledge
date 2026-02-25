# Enterprise Knowledge Graph Platform

A sophisticated multi-tenant knowledge graph platform that combines semantic web technologies with AI-powered document processing and conversational interfaces.

## Architecture

- **GraphDB** (RDF/SPARQL) for semantic knowledge storage with global ontologies
- **Neo4j** for graph analytics and visualization
- **Redis** for vector embeddings and caching
- **Multi-tenant workspace isolation** with enterprise-grade security
- **Local/Cloud LLM support** for document processing and chat

## Key Features

### 🏢 **Enterprise Multi-Tenancy**
- Tenant and workspace isolation
- Global ontologies shared across all tenants
- Workspace-specific data graphs
- Role-based access control ready

### 📚 **Ontology Management**
- Global ontology library (Resume, Legal Contract, Banking, AML)
- OWL/RDF/Turtle format support
- SPARQL query interface
- Ontology versioning and migration tools

### 🤖 **AI-Powered Processing**
- Document concept extraction using LLM
- Automatic entity recognition and relationship mapping
- Vector embeddings for semantic search
- Conversational Q&A with Graph RAG

### 📊 **Advanced Analytics**
- Interactive graph visualization (Cytoscape.js)
- SPARQL analytics and reporting
- Cross-workspace querying capabilities
- Real-time metrics and monitoring

### 🔧 **Developer Tools**
- Background job processing (BullMQ)
- Migration and testing scripts
- REST API with comprehensive endpoints
- Modern React frontend with proxy setup

## Prerequisites

- Node.js (v14 or higher)
- **GraphDB** (v10.0 or higher) - Primary semantic database
- **Neo4j** (v4.0 or higher) - For graph analytics and visualization
- **Redis** (v6.0 or higher) - For vector embeddings and caching
- npm or yarn
- **For LLM processing, choose one:**
  - **Local LLM**: Ollama or LM Studio (recommended for privacy and cost)
  - **OpenAI API**: API key from https://platform.openai.com/api-keys

## Installation

1. **Clone or navigate to the project directory:**
   ```bash
   cd /Users/kunalbatra/Documents/neo4j
   ```

2. **Install all dependencies:**
   ```bash
   npm run install-all
   ```

3. **Set up environment variables:**
   - Copy `.env.template` to `.env` and configure:
   
   **Required Database Configuration:**
   ```
   # GraphDB (Primary semantic database)
   GRAPHDB_URL=http://localhost:7200
   GRAPHDB_REPOSITORY=knowledge_graph_1
   
   # Neo4j (Graph analytics)
   NEO4J_URI=bolt://localhost:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=your_password_here
   NEO4J_DATABASE=neo
   
   # Redis (Vector embeddings)
   REDIS_URL=redis://localhost:6379
   
   # Server Configuration
   PORT=5002
   CLIENT_PORT=3001
   ```
   
   **LLM Configuration - Choose ONE:**
   
   **Option A: Local LLM (Recommended)**
   ```
   USE_LOCAL_LLM=true
   LOCAL_LLM_BASE_URL=http://localhost:11434/v1
   LOCAL_LLM_MODEL=gemma3:4b
   LOCAL_EMBEDDING_MODEL=nomic-embed-text
   ```
   
   **Option B: OpenAI API**
   ```
   USE_LOCAL_LLM=false
   OPENAI_API_KEY=your_openai_api_key_here
   OPENAI_MODEL=gpt-4o-mini
   ```

4. **Start required services:**
   - **GraphDB**: Start GraphDB server and create repository `knowledge_graph_1`
   - **Neo4j**: Start Neo4j database
   - **Redis**: Start Redis server
   - **Local LLM** (if using): Start Ollama (`ollama serve`) or LM Studio

## Running the Application

### Pre-flight Check (Recommended)
Before starting the application, verify all services are running:
```bash
npm run health
```

### Option 1: Run all services together (recommended)
```bash
npm run dev
```

### Option 2: Run separately

**Terminal 1 - Backend:**
```bash
npm run server
```

**Terminal 2 - Frontend:**
```bash
npm run client
```

**Terminal 3 - Background Workers:**
```bash
npm run workers
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:5002

## Usage

1. **Access the web application:**
   - Open http://localhost:3000 in your browser
   - The system includes 4 pre-loaded global ontologies:
     - Resume Ontology
     - Legal Contract Ontology  
     - Banking Ontology
     - Anti-Money Laundering (AML) Ontology

2. **Upload documents for processing:**
   - Navigate to the "Files" section
   - Upload PDF documents or structured data files
   - The system will:
     1. Extract text and concepts using AI
     2. Map entities to existing ontologies
     3. Store vector embeddings in Redis
     4. Create knowledge graph relationships

3. **Explore your knowledge:**
   - **Chat**: Ask questions about your documents using Graph RAG
   - **Ontologies**: Browse and manage ontology structures
   - **Entities**: View extracted entities and relationships
   - **Graph**: Visualize knowledge graph connections
   - **Analytics**: View metrics and insights

## Project Structure

```
neo4j/
├── server/
│   ├── config/           # Database and service configurations
│   ├── routes/           # API endpoints (owl, sparql, chat, etc.)
│   ├── services/         # Business logic and integrations
│   ├── middleware/       # Authentication and error handling
│   ├── models/           # Data models and schemas
│   ├── workers/          # Background job processing
│   └── index.js          # Express server entry point
├── client/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── contexts/     # React contexts (TenantContext)
│   │   ├── hooks/        # Custom React hooks
│   │   └── App.js        # Main React application
│   └── package.json
├── scripts/              # Migration and testing scripts
├── uploads/              # Temporary file storage
├── .env                  # Environment configuration
└── package.json          # Main project configuration
```

## API Endpoints

### Core Ontology Management
- `GET /api/owl/list` - List ontologies with scope filtering
- `POST /api/owl/upload` - Upload and process ontology files
- `GET /api/owl/:ontologyId` - Get specific ontology details
- `DELETE /api/owl/:ontologyId` - Delete ontology

### SPARQL Queries
- `POST /api/sparql/query` - Execute SPARQL queries
- `GET /api/sparql/prefixes` - Get available prefixes

### Document Processing
- `POST /api/extraction/extract` - Extract entities from documents
- `GET /api/extraction/jobs/:jobId` - Get extraction job status

### Chat & RAG
- `POST /api/chat/query` - Conversational Q&A with Graph RAG
- `GET /api/chat/history` - Get chat history

### Enterprise Features
- `GET /api/tenants` - List tenants
- `POST /api/tenants` - Create tenant
- `GET /api/enterprise/workspaces` - List workspaces
- `POST /api/enterprise/workspaces` - Create workspace

## Graph Structure

The application uses a hybrid storage approach:

### GraphDB (Primary Semantic Store)
**Global Ontologies:**
- `http://example.org/graphs/global/ontology/resume`
- `http://example.org/graphs/global/ontology/legal-contract`
- `http://example.org/graphs/global/ontology/banking`
- `http://example.org/graphs/global/ontology/aml`

**Workspace Data:**
- `http://example.org/graphs/tenant/{tenant}/workspace/{workspace}/data`

### Neo4j (Analytics & Visualization)
**Node Types:**
- `Ontology`: Represents the uploaded ontology
- `Class`: OWL classes
- `Property`: OWL object properties
- `Individual`: OWL named individuals

**Relationships:**
- `BELONGS_TO`: Connects nodes to their ontology
- `SUBCLASS_OF`: Class hierarchy relationships
- `HAS_DOMAIN`: Property domain relationships
- `HAS_RANGE`: Property range relationships
- `INSTANCE_OF`: Individual type relationships

## Troubleshooting

### GraphDB Connection Issues
- Ensure GraphDB is running: Check GraphDB Workbench at http://localhost:7200
- Verify repository `knowledge_graph_1` exists in GraphDB
- Check `GRAPHDB_URL` and `GRAPHDB_REPOSITORY` in `.env`

### Neo4j Connection Issues
- Ensure Neo4j is running: `neo4j status`
- Check connection credentials in `.env`
- Verify Neo4j URI format: `bolt://localhost:7687`

### Redis Connection Issues
- Ensure Redis is running: `redis-cli ping`
- Check `REDIS_URL` in `.env`
- Default Redis URL: `redis://localhost:6379`

### File Upload Issues
- Check file size (max 50MB for PDFs, 10MB for ontology files)
- Verify file format is supported
- Check server logs for parsing errors

### PDF Processing Issues

**For Local LLM (Ollama/LM Studio):**
- Ensure `USE_LOCAL_LLM=true` in `.env`
- Verify Ollama is running: `ollama serve` or check LM Studio is running
- Check `LOCAL_LLM_BASE_URL` matches your local LLM server:
  - Ollama default: `http://localhost:11434/v1`
  - LM Studio default: `http://localhost:1234/v1`
- Ensure the model specified in `LOCAL_LLM_MODEL` is downloaded/available
- Test: `curl http://localhost:11434/v1/models` (for Ollama)

**For OpenAI:**
- Ensure `USE_LOCAL_LLM=false` and `OPENAI_API_KEY` is set in `.env`
- Verify your OpenAI API key is valid and has credits
- Check OpenAI API rate limits if processing multiple PDFs

**General:**
- Large PDFs may be truncated (first 100,000 characters processed)
- Some local models may not return perfect JSON - the system will try to extract it

### Graph Visualization Not Loading
- Ensure graph data exists (upload an ontology first)
- Check browser console for errors
- Verify API endpoints are accessible

## Development

### Adding Support for New Formats
1. Add file extension to `multer` configuration in `server/routes/ontology.js`
2. Add parsing logic in `server/services/ontologyParser.js` (for structured formats)
   - Or add text extraction in `server/services/pdfParser.js` (for document formats)
   - Update `server/services/llmService.js` prompt if using AI extraction
3. Update frontend file accept attribute in `client/src/components/FileUpload.js`

### Customizing LLM Behavior
- Modify the prompt in `server/services/llmService.js` `buildOntologyPrompt()` method
- Adjust `maxChars` parameter to control how much PDF text is processed
- Change `OPENAI_MODEL` in `.env` to use different models (e.g., `gpt-4`, `gpt-4-turbo`)

### Customizing Graph Visualization
Edit styles and layout in `client/src/components/GraphVisualization.js`

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

