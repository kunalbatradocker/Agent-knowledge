# Purple Fabric — Technical Architecture Document

**Version:** 3.1  
**Date:** February 2026  
**Classification:** Internal — Technical Leadership  

---

## 1. Executive Summary

Purple Fabric is an enterprise-grade, multi-tenant knowledge graph platform that combines semantic web technologies (OWL/RDF/SPARQL), property graph analytics (Neo4j), vector embeddings (Redis), AI-powered document processing (AWS Bedrock / OpenAI / Ollama), and federated SQL querying (Trino) into a unified system for automated knowledge extraction, ontology management, and intelligent conversational agents.

The platform ingests structured (CSV/Excel) and unstructured (PDF/text) documents through two independent services: **Service A (RAG)** handles chunking and embedding at upload time for immediate semantic search, while **Service B (KG Enrichment)** optionally extracts entities and relationships using LLM-powered pipelines, stores them as RDF triples in GraphDB with full ontology conformance, and syncs to Neo4j for graph analytics.

Conversational AI agents provide the primary query interface. Each agent is configured with specific data sources (document folders, ontologies, VKG databases) and maintains long-term memory across sessions. When a user asks a question, the **Unified Agent Query Pipeline** uses an LLM-based planner to route the query across up to four parallel retrieval channels — vector search, ontology-guided graph traversal, federated SQL via VKG, and memory recall — then fuses the results into a single coherent response.

Ontologies stored in GraphDB serve as the semantic backbone: they guide Neo4j graph queries, inform VKG SQL generation, and structure entity extraction. The **Virtual Knowledge Graph (VKG)** layer federates queries across external databases via Trino, using ontology-to-table mappings to translate natural language into SQL without requiring users to know the underlying schema.

---

## 2. Why Ontologies Matter

Ontologies are the semantic foundation of Purple Fabric. They provide a formal, machine-readable model of a domain — defining what types of things exist, what properties they have, and how they relate to each other. This isn't just metadata; it's the intelligence layer that makes every other component smarter.

### 2.1 Benefits for Data

- **Structural consistency**: Ontologies enforce a shared vocabulary across all data sources. Whether data comes from a CSV upload, a PDF extraction, or a live database, it maps to the same classes and properties. "Customer" means the same thing everywhere.
- **Cross-source linking**: Entity URIs derived from ontology classes enable automatic deduplication. A customer mentioned in a PDF and a customer row in a database resolve to the same entity when they share the same ontology class and natural key.
- **Domain-aware routing**: During KG enrichment, the `rdfs:domain` on each property ensures that literal values attach to the correct entity. A `branchName` property routes to the Branch entity, not the Customer, even when both appear in the same CSV row.
- **Schema evolution**: Ontology versioning tracks changes over time. When a new property is added or a class is renamed, impact analysis shows which documents and mappings are affected before anything breaks.

### 2.2 Benefits for Processes

- **Guided extraction**: When extracting entities from documents, the ontology tells the LLM exactly which entity types and relationships to look for — reducing hallucination and improving precision.
- **VKG translation**: Ontology-to-table mappings let the system translate natural language questions into SQL without users knowing table names, column names, or join conditions. The ontology is the abstraction layer between human intent and database structure.
- **Ontology-guided Cypher**: When querying Neo4j, the ontology provides semantic context about entity relationships. The LLM knows that a Customer connects to a Branch through a `hasBranch` relationship because the ontology defines it.
- **Column mapping**: During KG enrichment of CSV/Excel files, the ontology structure drives the column mapping UI — each column maps to an ontology property with a known domain, range, and type.

### 2.3 Benefits for Decision Making (Ontology + Agent Memory)

The combination of ontologies and agent long-term memory creates a powerful decision-support system:

- **Contextual recall**: When an agent answers a question, it draws on both the formal knowledge graph (structured by the ontology) and its memory of past conversations. A question like "What changed since last quarter?" can be answered by combining graph data (current state) with memory (what the user discussed previously).
- **Preference-aware responses**: Agent memory stores user preferences (e.g., "always show amounts in EUR") as persistent facts. Combined with ontology-structured data, the agent delivers responses tailored to the user's working style.
- **Accumulated domain knowledge**: Over time, the agent builds a semantic memory of domain-specific facts, decisions, and events. This memory is searchable via vector embeddings and organized by type (semantic, preference, decision, event). The ontology provides the structural framework; memory provides the experiential context.
- **Audit trail**: Every memory entry is immutable — updates invalidate the old entry and create a new one. Combined with ontology versioning, this creates a full audit trail of what was known, when, and what changed.
- **Cross-session continuity**: Core memory (Tier 1) persists the most important facts across all sessions. A user doesn't need to re-explain their context — the agent remembers. The ontology ensures that the entities referenced in memory are grounded in a formal schema, not just free text.

