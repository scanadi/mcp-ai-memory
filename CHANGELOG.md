# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2025-09-04

### Added
- **Graph Relationships and Memory Decay System**
  - Added comprehensive graph traversal capabilities with BFS/DFS algorithms
  - Implemented memory lifecycle management with decay scoring
  - Added new memory states: `active`, `dormant`, `archived`, `expired`
  - Introduced preservation mechanism for important memories

### New Features
- **Database Schema Enhancements**
  - Added `state`, `decay_score`, and `last_decay_update` fields to memories table
  - Expanded relation types to include: `causes`, `caused_by`, `precedes`, `follows`, `part_of`, `contains`, `relates_to` (in addition to existing types)
  - Added CHECK and UNIQUE constraints on memory_relations table
  - Added GIN index for tags to improve tag-based queries
  - Added composite indexes on memory_relations for better traversal performance

- **New MCP Tools**
  - `memory_traverse`: Traverse memory graph using BFS/DFS with filtering options
  - `memory_decay_status`: Get decay and lifecycle status of a memory
  - `memory_preserve`: Preserve a memory from decay with optional expiration
  - `memory_graph_analysis`: Analyze graph connectivity and degree metrics
  - `memory_graph_search`: Alias for `memory_traverse` for backward compatibility

- **Services**
  - **DecayService**: Manages memory lifecycle with exponential decay, access boosts, and preservation
  - **TraversalService**: Provides graph traversal with depth limits, relation filtering, and timeout protection
  - **DecayWorker**: BullMQ-based worker for scheduled decay processing

- **Configuration**
  - Added decay configuration options: `BASE_DECAY_RATE`, `ACCESS_BOOST`, `ARCHIVAL_THRESHOLD`, `EXPIRATION_THRESHOLD`
  - Added preservation tags configuration
  - Added feature flags for decay and graph traversal

### Changed
- Updated embedding worker to set `embedding_dimension` when storing embeddings
- Enhanced relation type validation with automatic normalization to v1 types
- Migration automatically backfills state and decay scores for existing memories

### Technical Improvements
- Idempotent migration with safe data transformation
- Preservation precedence system for important memories
- Automatic compression trigger for archived memories
- Soft-delete policy for expired memories with configurable retention

### Migration Notes
- Run migrations with `bun run migrate` to apply schema changes
- Existing memories will be automatically migrated with calculated decay scores
- Unknown relation types will be normalized to `relates_to`

## [1.0.6] - Previous Version
- Core memory management functionality
- Basic relationship system
- Embedding generation and search