# Graph-RAG Platform: API Specification

**Version:** 1.0  
**Date:** 2026-01-08

## API Overview

All APIs follow RESTful principles with consistent request/response patterns. Multi-tenant context is provided via headers or path parameters.

### Base URL Pattern
```
/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/...
```

### Authentication
- **Headers**: `Authorization: Bearer <token>`
- **Tenant Context**: `X-Tenant-Id`, `X-Workspace-Id` (optional if in path)

### Standard Response Format
```json
{
  "success": true,
  "data": {...},
  "message": "Optional success message",
  "pagination": {...} // For paginated responses
}
```

### Error Response Format
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "details": {...} // Optional additional details
}
```

## Document Management APIs

### Upload Document
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/documents
Content-Type: multipart/form-data

{
  "file": <binary>,
  "metadata": {
    "title": "Document Title",
    "source": "upload|import|api",
    "tags": ["tag1", "tag2"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "docId": "doc_abc123",
    "status": "uploaded",
    "checksum": "sha256:...",
    "size": 1024000,
    "mimeType": "application/pdf",
    "processingJobId": "job_xyz789"
  }
}
```

### Get Document Status
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/documents/{docId}/status
```

**Response:**
```json
{
  "success": true,
  "data": {
    "docId": "doc_abc123",
    "status": "processing|completed|failed",
    "pipeline": {
      "parsing": {"status": "completed", "timestamp": "2026-01-08T10:00:00Z"},
      "chunking": {"status": "completed", "timestamp": "2026-01-08T10:01:00Z"},
      "embedding": {"status": "in_progress", "progress": 0.75},
      "extraction": {"status": "pending"}
    },
    "stats": {
      "pages": 25,
      "chunks": 150,
      "entities": 45,
      "relations": 78
    }
  }
}
```

### List Documents
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/documents?page=1&pageSize=50&status=completed
```

### Delete Document
```http
DELETE /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/documents/{docId}
```
*Note: Triggers retraction of all extracted triples*

## Ontology Management APIs

### Get Active Ontology
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/ontology/active
```

**Response:**
```json
{
  "success": true,
  "data": {
    "versionId": "v1.2.3",
    "createdAt": "2026-01-08T10:00:00Z",
    "classes": [
      {
        "uri": "urn:tenant:t1:onto:Person",
        "label": "Person",
        "description": "Individual human being",
        "aliases": ["Individual", "Human"]
      }
    ],
    "properties": [
      {
        "uri": "urn:tenant:t1:onto:worksFor",
        "label": "works for",
        "domain": "urn:tenant:t1:onto:Person",
        "range": "urn:tenant:t1:onto:Organization"
      }
    ]
  }
}
```

### List Ontology Versions
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/ontology/versions
```

### Create Ontology Proposal
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/ontology/proposals

{
  "title": "Add Healthcare Entities",
  "description": "Extend ontology with medical concepts",
  "changes": {
    "addClasses": [
      {
        "uri": "urn:tenant:t1:onto:Patient",
        "label": "Patient",
        "description": "Person receiving medical care"
      }
    ],
    "addProperties": [
      {
        "uri": "urn:tenant:t1:onto:treatedBy",
        "label": "treated by",
        "domain": "urn:tenant:t1:onto:Patient",
        "range": "urn:tenant:t1:onto:Doctor"
      }
    ]
  }
}
```

### Approve/Reject Ontology Proposal
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/ontology/proposals/{proposalId}/approve

{
  "comment": "Approved with minor modifications",
  "modifications": {...} // Optional changes to proposal
}
```

```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/ontology/proposals/{proposalId}/reject

{
  "reason": "Conflicts with existing schema",
  "comment": "Please revise domain constraints"
}
```

## Extraction & Processing APIs

### Trigger Extraction Run
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/extractions/run

{
  "docIds": ["doc_abc123", "doc_def456"], // Optional: specific docs
  "ontologyVersion": "v1.2.3", // Optional: specific version
  "extractionConfig": {
    "confidenceThreshold": 0.7,
    "maxEntitiesPerChunk": 10
  }
}
```

### Get Extraction Run Status
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/extractions/runs/{runId}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "runId": "run_xyz789",
    "status": "in_progress|completed|failed",
    "progress": {
      "documentsProcessed": 15,
      "totalDocuments": 20,
      "entitiesExtracted": 450,
      "relationsExtracted": 230
    },
    "config": {
      "ontologyVersion": "v1.2.3",
      "confidenceThreshold": 0.7
    },
    "startedAt": "2026-01-08T10:00:00Z",
    "completedAt": "2026-01-08T10:15:00Z"
  }
}
```

## Entity Resolution APIs

### Get Entity Candidates
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/{entityId}/candidates
```

**Response:**
```json
{
  "success": true,
  "data": {
    "entity": {
      "uri": "urn:tenant:t1:entity:e123",
      "label": "John Doe",
      "type": "urn:tenant:t1:onto:Person"
    },
    "candidates": [
      {
        "uri": "urn:tenant:t1:entity:e456",
        "label": "J. Doe",
        "similarity": 0.85,
        "reasons": ["name_similarity", "shared_attributes"]
      }
    ]
  }
}
```

### Merge Entities
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/merge

{
  "canonicalEntityId": "e123",
  "duplicateEntityIds": ["e456", "e789"],
  "reason": "Same person with different name variations"
}
```

### Split Entity
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/split

{
  "entityId": "e123",
  "splitCriteria": {
    "attributeKey": "organization",
    "values": ["Acme Corp", "Beta Inc"]
  },
  "reason": "Mixed mentions of different people"
}
```

## Graph-RAG Query APIs

### Execute Query
```http
POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/query

{
  "question": "Who works for Acme Corporation?",
  "options": {
    "maxHops": 2,
    "includeProvenance": true,
    "confidenceThreshold": 0.6
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "answer": "Based on the documents, John Doe and Jane Smith work for Acme Corporation.",
    "confidence": 0.87,
    "citations": [
      {
        "docId": "doc_abc123",
        "chunkId": "chunk_456",
        "quote": "John Doe joined Acme Corporation as a senior engineer",
        "pageNumber": 2,
        "relevanceScore": 0.92
      }
    ],
    "graphPaths": [
      {
        "entities": [
          {"uri": "urn:tenant:t1:entity:john_doe", "label": "John Doe"},
          {"uri": "urn:tenant:t1:entity:acme_corp", "label": "Acme Corporation"}
        ],
        "relations": [
          {"uri": "urn:tenant:t1:onto:worksFor", "label": "works for"}
        ]
      }
    ],
    "relatedEntities": [
      {"uri": "urn:tenant:t1:entity:jane_smith", "label": "Jane Smith"}
    ]
  }
}
```

### Get Query History
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/queries/history?page=1&pageSize=20
```

## Graph Exploration APIs

### Get Entity Details
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/{entityId}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "entity": {
      "uri": "urn:tenant:t1:entity:john_doe",
      "label": "John Doe",
      "type": "urn:tenant:t1:onto:Person",
      "attributes": {
        "title": "Senior Engineer",
        "email": "john.doe@example.com"
      },
      "aliases": ["J. Doe", "John D."]
    },
    "relations": [
      {
        "predicate": "urn:tenant:t1:onto:worksFor",
        "object": "urn:tenant:t1:entity:acme_corp",
        "confidence": 0.95,
        "provenance": [
          {
            "docId": "doc_abc123",
            "chunkId": "chunk_456",
            "quote": "John works for Acme"
          }
        ]
      }
    ],
    "mentions": [
      {
        "docId": "doc_abc123",
        "chunkId": "chunk_456",
        "text": "John Doe",
        "context": "...John Doe joined the company..."
      }
    ]
  }
}
```

### Get Entity Neighbors
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/{entityId}/neighbors?hops=1&limit=50
```

### Search Entities
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/entities/search?q=john&type=Person&limit=20
```

## Admin & Monitoring APIs

### Get Workspace Statistics
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documents": {
      "total": 150,
      "processed": 145,
      "failed": 2,
      "processing": 3
    },
    "entities": {
      "total": 2500,
      "byType": {
        "Person": 800,
        "Organization": 300,
        "Location": 200
      }
    },
    "relations": {
      "total": 4500,
      "byPredicate": {
        "worksFor": 800,
        "locatedIn": 600
      }
    },
    "ontology": {
      "version": "v1.2.3",
      "classes": 25,
      "properties": 45
    }
  }
}
```

### Get Processing Jobs
```http
GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/jobs?status=running&type=extraction
```

### Health Check
```http
GET /api/v1/health
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "services": {
      "database": "healthy",
      "vectorStore": "healthy",
      "llmProvider": "healthy",
      "queue": "healthy"
    },
    "timestamp": "2026-01-08T10:00:00Z"
  }
}
```

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Access denied |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict (e.g., duplicate) |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |
| `SERVICE_UNAVAILABLE` | 503 | External service unavailable |

## Rate Limits

- **Document Upload**: 100 requests/hour per tenant
- **Query API**: 1000 requests/hour per tenant
- **Extraction Runs**: 10 concurrent runs per workspace
- **Ontology Changes**: 50 proposals/day per workspace
