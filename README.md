# MCP AI Memory

A production-ready Model Context Protocol (MCP) server for semantic memory management that enables AI agents to store, retrieve, and manage contextual knowledge across sessions.

## Features

- **TypeScript** - Full type safety with strict mode
- **PostgreSQL + pgvector** - Vector similarity search with HNSW indexing
- **Kysely ORM** - Type-safe SQL queries
- **Local Embeddings** - Uses Transformers.js (no API calls)
- **Intelligent Caching** - Redis + in-memory fallback for blazing fast performance
- **Multi-Agent Support** - User context isolation
- **Memory Relationships** - Graph structure for connected knowledge
- **Soft Deletes** - Data recovery with deleted_at timestamps
- **Clustering** - Automatic memory consolidation
- **Token Efficient** - Embeddings removed from responses

## Prerequisites

- Node.js 20+ or Bun
- PostgreSQL with pgvector extension
- Redis (optional, for caching)

## Installation

1. Install dependencies:
```bash
bun install
```

2. Set up PostgreSQL with pgvector:
```sql
CREATE DATABASE mcp_ai_memory;
\c mcp_ai_memory
CREATE EXTENSION IF NOT EXISTS vector;
```

3. Create environment file:
```bash
# Create .env with your database credentials
touch .env
```

4. Run migrations:
```bash
bun run migrate
```

## Usage

### Development
```bash
bun run dev
```

### Production
```bash
bun run build
bun run start
```

## MCP Integration

Add to your Claude Code config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-ai-memory/src/index.ts"],
      "env": {
        "MEMORY_DB_URL": "postgresql://user:password@localhost:5432/mcp_ai_memory",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

## Available Tools

### Core Operations
- `memory_store` - Store memories with embeddings
- `memory_search` - Semantic similarity search
- `memory_list` - List memories with filtering
- `memory_update` - Update memory metadata
- `memory_delete` - Delete memories

### Advanced Operations
- `memory_batch` - Bulk store memories
- `memory_batch_delete` - Bulk delete memories by IDs
- `memory_graph_search` - Traverse relationships
- `memory_consolidate` - Cluster similar memories
- `memory_stats` - Database statistics

## Resources

- `memory://stats` - Database statistics
- `memory://types` - Available memory types
- `memory://tags` - All unique tags
- `memory://relationships` - Memory relationships
- `memory://clusters` - Memory clusters

## Prompts

- `load-context` - Load relevant context for a task
- `memory-summary` - Generate topic summaries
- `conversation-context` - Load conversation history

## Architecture

```
src/
├── server.ts           # MCP server implementation
├── types/              # TypeScript definitions
├── schemas/            # Zod validation schemas
├── services/           # Business logic
├── database/           # Kysely migrations and client
└── config/             # Configuration management
```

## Environment Variables

```bash
# Required
MEMORY_DB_URL=postgresql://user:password@localhost:5432/mcp_ai_memory

# Optional - Caching (falls back to in-memory if Redis unavailable)
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600                  # 1 hour default cache
EMBEDDING_CACHE_TTL=86400       # 24 hours for embeddings
SEARCH_CACHE_TTL=3600           # 1 hour for search results
MEMORY_CACHE_TTL=7200           # 2 hours for individual memories

# Optional - Model & Performance
EMBEDDING_MODEL=Xenova/all-mpnet-base-v2
LOG_LEVEL=info
MAX_CONTENT_SIZE=1048576
DEFAULT_SEARCH_LIMIT=20
DEFAULT_SIMILARITY_THRESHOLD=0.7

# Optional - Async Processing (requires Redis)
ENABLE_ASYNC_PROCESSING=true    # Enable background job processing
BULL_CONCURRENCY=3              # Worker concurrency
ENABLE_REDIS_CACHE=true          # Enable Redis caching
```

## Caching Architecture

The server implements a two-tier caching strategy:

1. **Redis Cache** (if available) - Distributed, persistent caching
2. **In-Memory Cache** (fallback) - Local NodeCache for when Redis is unavailable

## Async Job Processing

When Redis is available and `ENABLE_ASYNC_PROCESSING=true`, the server uses BullMQ for background job processing:

### Features
- **Async Embedding Generation**: Offloads CPU-intensive embedding generation to background workers
- **Batch Import**: Processes large memory imports without blocking the main server
- **Memory Consolidation**: Runs clustering and merging operations in the background
- **Automatic Retries**: Failed jobs are retried with exponential backoff
- **Dead Letter Queue**: Permanently failed jobs are tracked for manual intervention

### Running Workers

```bash
# Start all workers
bun run workers

# Or start individual workers
bun run worker:embedding   # Embedding generation worker
bun run worker:batch       # Batch import and consolidation worker

# Test async processing
bun run test:async
```

### Queue Monitoring
The `memory_stats` tool includes queue statistics when async processing is enabled:
- Active, waiting, completed, and failed job counts
- Processing rates and performance metrics
- Worker health status

### Cache Invalidation
- Memory updates/deletes automatically invalidate relevant caches
- Search results are cached with query+filter combinations
- Embeddings are cached for 24 hours (configurable)

## Development

### Type Checking
```bash
bun run typecheck
```

### Linting
```bash
bun run lint
```

## Implementation Status

### ✅ Fully Integrated Features
- **DBSCAN Clustering**: Advanced clustering algorithm for memory consolidation
- **Smart Compression**: Automatic compression for large memories (>100KB)
- **Context Window Management**: Token counting and intelligent truncation
- **Input Sanitization**: Comprehensive validation and sanitization
- **All Workers Active**: Embedding, batch, and clustering workers all operational

### Testing
The project includes a comprehensive test suite covering:
- Memory service operations (store, search, update, delete)
- Input validation and sanitization
- Clustering and consolidation
- Compression for large content

Run tests with `bun test`.

## License

MIT
