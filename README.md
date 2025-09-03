# MCP AI Memory

[![npm version](https://badge.fury.io/js/mcp-ai-memory.svg)](https://www.npmjs.com/package/mcp-ai-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-ready Model Context Protocol (MCP) server for semantic memory management that enables AI agents to store, retrieve, and manage contextual knowledge across sessions.

> **📖 System Prompt Available**: See [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) for a comprehensive guide on how to instruct AI models to use this memory system effectively. This prompt helps models understand when and how to use memory tools, especially for proactive memory retrieval.

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

- Node.js 18+ or Bun
- PostgreSQL with pgvector extension
- Redis (optional - falls back to in-memory cache if not available)

## Installation

### NPM Package (Recommended for Claude Desktop)

```bash
npm install -g mcp-ai-memory
```

### From Source

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

## Troubleshooting

### Embedding Dimension Mismatch Error

If you see an error like:
```
Failed to generate embedding: Error: Embedding dimension mismatch: Model produces 384-dimensional embeddings, but database expects 768
```

This occurs when the embedding model changes between sessions. To fix:

1. **Option 1: Reset and Re-embed (Recommended for new installations)**
   ```bash
   # Clear existing memories and start fresh
   psql -d your_database -c "TRUNCATE TABLE memories CASCADE;"
   ```

2. **Option 2: Specify a Consistent Model**
   Add `EMBEDDING_MODEL` to your Claude Desktop config:
   ```json
   {
     "mcpServers": {
       "memory": {
         "command": "npx",
         "args": ["-y", "mcp-ai-memory"],
         "env": {
           "MEMORY_DB_URL": "postgresql://...",
           "EMBEDDING_MODEL": "Xenova/all-mpnet-base-v2"
         }
       }
     }
   }
   ```
   Common models:
   - `Xenova/all-mpnet-base-v2` (768 dimensions - default, best quality)
   - `Xenova/all-MiniLM-L6-v2` (384 dimensions - smaller/faster)

3. **Option 3: Run Migration for Flexible Dimensions**
   If you're using the source version:
   ```bash
   bun run migrate
   ```
   This allows mixing different embedding dimensions in the same database.

### Database Connection Issues

Ensure your PostgreSQL has the pgvector extension:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Claude Desktop Integration

> **💡 For Best Results**: Include the [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) content in your Claude Desktop system prompt or initial conversation to help Claude understand how to use the memory tools effectively.

### Quick Setup (NPM)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-ai-memory"],
      "env": {
        "DATABASE_URL": "postgresql://username:password@localhost:5432/memory_db"
      }
    }
  }
}
```

### With Optional Redis Cache

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-ai-memory"],
      "env": {
        "DATABASE_URL": "postgresql://username:password@localhost:5432/memory_db",
        "REDIS_URL": "redis://localhost:6379",
        "EMBEDDING_MODEL": "Xenova/all-MiniLM-L6-v2",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | **Required** |
| `REDIS_URL` | Redis connection string (optional) | None - uses in-memory cache |
| `EMBEDDING_MODEL` | Transformers.js model | `Xenova/all-MiniLM-L6-v2` |
| `LOG_LEVEL` | Logging level | `info` |
| `CACHE_TTL` | Cache TTL in seconds | `3600` |
| `MAX_MEMORIES_PER_QUERY` | Max results per search | `10` |
| `MIN_SIMILARITY_SCORE` | Min similarity threshold | `0.5` |

## Available Tools

> **💡 Token Efficiency**: Default limits are set to 10 results to optimize token usage. Increase only when needed.

### Core Operations (Most Important)
- **`memory_search`** - SEARCH FIND RECALL - Search stored information using natural language (USE THIS FIRST! Default limit: 10)
- **`memory_list`** - LIST BROWSE SHOW - List all memories chronologically (fallback when search fails, default limit: 10)
- **`memory_store`** - STORE SAVE REMEMBER - Store new information after checking for duplicates
- `memory_update` - UPDATE MODIFY EDIT - Update existing memory metadata
- `memory_delete` - DELETE REMOVE FORGET - Delete specific memories

### Advanced Operations
- `memory_batch` - BATCH BULK IMPORT - Store multiple memories efficiently
- `memory_batch_delete` - Delete multiple memories at once
- `memory_graph_search` - GRAPH RELATED - Search with relationship traversal
- `memory_consolidate` - MERGE CLUSTER - Group similar memories
- `memory_stats` - STATS INFO - Database statistics
- `memory_relate` - LINK CONNECT - Create memory relationships
- `memory_unrelate` - UNLINK DISCONNECT - Remove relationships
- `memory_get_relations` - Show all relationships for a memory

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
DEFAULT_SEARCH_LIMIT=10                 # Default 10 for token efficiency
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

## Using with AI Models

### System Prompt for Better Memory Usage

The memory tools include enhanced descriptions with keywords to help models understand when to use each tool. However, for best results with models like Gemma3, Qwen, or other open-source models:

1. **Include the System Prompt**: Copy the content from [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) and include it in your initial conversation or system prompt
2. **Key Behaviors to Reinforce**:
   - Always use `memory_search` FIRST before any operation
   - Use `memory_list` as a fallback when search returns no results
   - Search for user information at conversation start (e.g., "user name preferences")
   - Store structured JSON in the content field

### Example Initial Prompt for Models
```
You have access to a memory system. ALWAYS start by using memory_search with query="user name preferences personal information" to check for stored user details. If no results, use memory_list to see recent memories. Default limits are 10 results for token efficiency - only increase if needed. Follow the patterns in the system prompt for best results.
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
