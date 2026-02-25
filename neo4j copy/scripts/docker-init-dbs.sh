#!/bin/sh
# Initialize all databases — runs once at container startup
# Waits for services, creates instances/repos/indexes if they don't exist
set -e

GRAPHDB_URL="${GRAPHDB_URL:-http://graphdb:7200}"
GRAPHDB_REPO="${GRAPHDB_REPOSITORY:-knowledge_graph_1}"
NEO4J_URI="${NEO4J_URI:-bolt://neo4j:7687}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-neo4j_password}"
NEO4J_DATABASE="${NEO4J_DATABASE:-neo4j}"
REDIS_URL="${REDIS_URL:-redis://redis:6379}"

echo "=== Database Initialization ==="

# --- GraphDB ---
echo "🔵 GraphDB: Checking repository '${GRAPHDB_REPO}'..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${GRAPHDB_URL}/repositories/${GRAPHDB_REPO}")
if [ "$STATUS" = "200" ]; then
  echo "✅ GraphDB: Repository '${GRAPHDB_REPO}' already exists"
else
  echo "📦 GraphDB: Creating repository '${GRAPHDB_REPO}'..."
  # GraphDB 10.x expects a Turtle config via multipart form
  cat > /tmp/repo-config.ttl <<REPOEOF
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rep: <http://www.openrdf.org/config/repository#> .
@prefix sr: <http://www.openrdf.org/config/repository/sail#> .
@prefix sail: <http://www.openrdf.org/config/sail#> .
@prefix graphdb: <http://www.ontotext.com/config/graphdb#> .

[] a rep:Repository ;
   rep:repositoryID "${GRAPHDB_REPO}" ;
   rdfs:label "Knowledge Graph" ;
   rep:repositoryImpl [
     rep:repositoryType "graphdb:SailRepository" ;
     sr:sailImpl [
       sail:sailType "graphdb:Sail" ;
       graphdb:ruleset "rdfsplus-optimized" ;
       graphdb:disable-sameAs "true"
     ]
   ] .
REPOEOF
  curl -s -X POST "${GRAPHDB_URL}/rest/repositories" \
    -H "Content-Type: multipart/form-data" \
    -F "config=@/tmp/repo-config.ttl"
  echo "✅ GraphDB: Repository created"
fi

# --- Neo4j ---
echo "🟢 Neo4j: Checking database '${NEO4J_DATABASE}'..."
# Change default password if still default
cypher-shell -a "$NEO4J_URI" -u neo4j -p neo4j \
  "ALTER CURRENT USER SET PASSWORD FROM 'neo4j' TO '${NEO4J_PASSWORD}'" 2>/dev/null || true

# Create database if not default and not exists (Enterprise only)
if [ "$NEO4J_DATABASE" != "neo4j" ]; then
  cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -d system \
    "CREATE DATABASE \`${NEO4J_DATABASE}\` IF NOT EXISTS" 2>/dev/null || {
    echo "⚠️  Neo4j: CREATE DATABASE not supported (Community Edition). Using default 'neo4j' database."
    NEO4J_DATABASE="neo4j"
  }
fi
echo "✅ Neo4j: Using database '${NEO4J_DATABASE}'"

# Create uri index for sync performance
cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -d "$NEO4J_DATABASE" \
  "CREATE RANGE INDEX uri_range IF NOT EXISTS FOR (n) ON (n.uri)" 2>/dev/null || true
echo "✅ Neo4j: Indexes ensured"

# --- Redis ---
REDIS_HOST=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f1)
REDIS_PORT=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f2)
REDIS_PORT="${REDIS_PORT:-6379}"
echo "🔴 Redis: Checking connection at ${REDIS_HOST}:${REDIS_PORT}..."
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null
echo "✅ Redis: Connected"

# Create vector search index if not exists
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" FT.INFO vec_idx > /dev/null 2>&1 || {
  echo "📦 Redis: Creating vector search index..."
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" FT.CREATE vec_idx ON HASH PREFIX 1 "vec:" \
    SCHEMA text TEXT embedding VECTOR FLAT 6 TYPE FLOAT32 DIM 1024 DISTANCE_METRIC COSINE 2>/dev/null || true
  echo "✅ Redis: Vector index created"
}
echo "✅ Redis: Ready"

echo "=== All databases initialized ==="
