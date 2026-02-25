# Enterprise Knowledge Graph Platform - Architecture Flow

## High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (React)                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │   Chat   │ │  Files   │ │Ontologies│ │ Entities │ │  Graph   │          │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘          │
└───────┼────────────┼────────────┼────────────┼────────────┼─────────────────┘
        │            │            │            │            │
        ▼            ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXPRESS SERVER (Port 5002)                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                           API Routes                                 │    │
│  │  /api/chat  /api/owl  /api/sparql  /api/entities  /api/graph        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVICES LAYER                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │ GraphRAGService│  │  LLMService    │  │ExtractionService│                │
│  │  (Query/Chat)  │  │ (AI Processing)│  │(Entity Extract) │                │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘                 │
│          │                   │                   │                          │
│  ┌───────┴───────────────────┴───────────────────┴───────┐                  │
│  │              Core Data Services                        │                  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │                  │
│  │  │GraphDBStore  │ │ Neo4jService │ │VectorStore   │   │                  │
│  │  │  (RDF/SPARQL)│ │  (Cypher)    │ │  (Redis)     │   │                  │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘   │                  │
│  └─────────┼────────────────┼────────────────┼───────────┘                  │
└────────────┼────────────────┼────────────────┼──────────────────────────────┘
             │                │                │
             ▼                ▼                ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│    GraphDB     │  │     Neo4j      │  │     Redis      │
│  (RDF Store)   │  │ (Graph Analytics)│ │(Vectors/Cache)│
│   Port 7200    │  │   Port 7687    │  │   Port 6379    │
└────────────────┘  └────────────────┘  └────────────────┘
```

## Document Processing Flow

```
┌──────────────┐
│ User Uploads │
│   Document   │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                    File Upload Handler                    │
│              (server/routes/ontology/documents.js)        │
└──────────────────────────┬───────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  PDF Parser  │   │  CSV Parser  │   │ Text Handler │
│(pdfParser.js)│   │(csvParser.js)│   │(textHandler) │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                   Chunking Service                        │
│              (chunkingService.js)                         │
│   • Split into semantic chunks                            │
│   • Preserve context boundaries                           │
└──────────────────────────┬───────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐       ┌──────────────────────┐
│   Embedding Service  │       │  Extraction Service  │
│ (embeddingService.js)│       │(extractionService.js)│
│  • Generate vectors  │       │  • LLM entity extract│
│  • Store in Redis    │       │  • Relationship map  │
└──────────┬───────────┘       └──────────┬───────────┘
           │                               │
           ▼                               ▼
┌──────────────────────┐       ┌──────────────────────┐
│   Vector Store       │       │   Graph Storage      │
│      (Redis)         │       │  (GraphDB + Neo4j)   │
└──────────────────────┘       └──────────────────────┘
```

## Chat/Query Flow (Graph RAG)

```
┌──────────────┐
│ User Question│
│  "Tell me    │
│   about..."  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                   GraphRAGService.query()                 │
│              (graphRAGService.js)                         │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   Select Search Mode   │
              └────────────┬───────────┘
                           │
       ┌───────────┬───────┼───────┬───────────┐
       ▼           ▼       ▼       ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│   RAG    │ │  Graph   │ │  Neo4j   │ │ GraphDB  │
│  Only    │ │  Only    │ │  Direct  │ │  Direct  │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │            │
     ▼            ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Vector  │ │  Graph   │ │ Generate │ │ Generate │
│  Search  │ │ Traverse │ │  Cypher  │ │  SPARQL  │
│ (Redis)  │ │ (Neo4j)  │ │   (LLM)  │ │   (LLM)  │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │            │
     └────────────┴─────┬──────┴────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────┐
│                  Build Context String                     │
│   • Merge results from selected sources                   │
│   • Deduplicate concepts                                  │
│   • Enrich with document names                            │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                   LLM Response Generation                 │
│   • Send context + question to LLM                        │
│   • Generate grounded answer                              │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    Return Response                        │
│   { answer, sources, metadata, sparql/cypher }           │
└──────────────────────────────────────────────────────────┘
```

## Multi-Tenant Data Isolation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GLOBAL ONTOLOGIES                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │   Resume    │ │   Legal     │ │   Banking   │ │     AML     │           │
│  │  Ontology   │ │  Contract   │ │  Ontology   │ │  Ontology   │           │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘           │
│                    (Shared across all tenants)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐
│     Tenant A      │     │     Tenant B      │     │     Tenant C      │
│  ┌─────────────┐  │     │  ┌─────────────┐  │     │  ┌─────────────┐  │
│  │ Workspace 1 │  │     │  │ Workspace 1 │  │     │  │ Workspace 1 │  │
│  │  (Data)     │  │     │  │  (Data)     │  │     │  │  (Data)     │  │
│  └─────────────┘  │     │  └─────────────┘  │     │  └─────────────┘  │
│  ┌─────────────┐  │     │  ┌─────────────┐  │     └───────────────────┘
│  │ Workspace 2 │  │     │  │ Workspace 2 │  │
│  │  (Data)     │  │     │  │  (Data)     │  │
│  └─────────────┘  │     │  └─────────────┘  │
└───────────────────┘     └───────────────────┘

GraphDB Named Graphs:
  • Global: http://example.org/graphs/global/ontology/{name}
  • Tenant: http://example.org/graphs/tenant/{id}/workspace/{id}/data
```

## Entity Extraction Pipeline

```
┌──────────────┐
│   Document   │
│    Chunk     │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│              Enhanced Extraction Service                  │
│         (enhancedExtractionService.js)                    │
└──────────────────────────┬───────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ LLM Extract  │   │ NER Extract  │   │Pattern Extract│
│(llmService)  │   │(nerService)  │   │  (regex)     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                   Build Consensus                         │
│   • Merge overlapping entities                            │
│   • Select best entity per group                          │
│   • Validate against ontology                             │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                Entity Resolution Service                  │
│   • Find duplicates (Levenshtein, Jaro-Winkler)          │
│   • Merge entities                                        │
│   • Generate canonical IDs                                │
└──────────────────────────┬───────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐       ┌──────────────────────┐
│      GraphDB         │       │       Neo4j          │
│  (RDF Triples)       │       │  (Property Graph)    │
│  • Semantic storage  │       │  • Analytics         │
│  • SPARQL queries    │       │  • Visualization     │
└──────────────────────┘       └──────────────────────┘
```

## Background Job Processing

```
┌──────────────────────────────────────────────────────────┐
│                      BullMQ Queues                        │
│                       (Redis)                             │
└──────────────────────────┬───────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Document    │   │  Embedding   │   │    Graph     │
│ Processing   │   │ Generation   │   │  Creation    │
│   Queue      │   │   Queue      │   │   Queue      │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Processor   │   │  Processor   │   │  Processor   │
│(documentProc)│   │(embeddingProc)│  │(graphProc)   │
└──────────────┘   └──────────────┘   └──────────────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
                  ┌────────────────┐
                  │  Job Status    │
                  │   Updates      │
                  │  (WebSocket)   │
                  └────────────────┘
```

## Key Service Dependencies

```
graphRAGService
    ├── vectorStoreService (Redis)
    ├── neo4jService
    ├── graphDBStore
    └── llmService (OpenAI/Ollama)

extractionService
    ├── chunkingService
    ├── embeddingService
    ├── conceptExtractionService
    ├── entityResolutionService
    └── graphDBTripleService

owlOntologyService
    ├── graphDBStore
    ├── neo4jService
    └── ontologyParser
```
