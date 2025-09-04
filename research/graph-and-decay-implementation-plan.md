# MCP-AI-Memory: Unified Plan for Graph Relationships and Memory Decay (Authoritative, Sept 2025)

This document is the single source of truth for implementing graph relationships and memory decay. It favors the latest decisions, is concise, and contains a compact agent checklist for execution.

## 1) Objectives
- Add robust graph relationships using the existing relational model.
- Implement adaptive memory decay with clear lifecycle state transitions.
- Preserve backward compatibility and minimize complexity.
- Prioritize observability and safe rollout.

## 2) Constraints
- PostgreSQL-only (no graph DB); TypeScript/Kysely/Bun; pgvector with HNSW.
- Align with BullMQ workers and MCP tools.
- All queries must scope by `user_context` and exclude `deleted_at IS NOT NULL`.

## 3) Architecture Decisions
- Relationships: keep `memory_relations(from_memory_id, to_memory_id, relation_type, strength)`; no separate inverse table. For bidirectional semantics, create two directed rows.
- Relation types (v1): `references | contradicts | supports | extends | causes | caused_by | precedes | follows | part_of | contains | relates_to`.
- Traversal defaults to edge-only; include `parent_id` traversal only when explicitly requested.
- Decay fields live on `memories` (not a separate lifecycle table). Use `metadata` for optional transition history.
- Graph analytics (PageRank/communities) deferred or run on-demand; do not persist metrics in v1.

## 4) Database Changes (DDL)
- `memories` add:
  - `state VARCHAR(20) DEFAULT 'active'`
  - `decay_score REAL DEFAULT 1.0`
  - `last_decay_update TIMESTAMPTZ DEFAULT NOW()`
- `memory_relations`:
  - CHECK constraint limiting `relation_type` to the v1 set above.
  - UNIQUE constraint on `(from_memory_id, to_memory_id, relation_type)` to prevent duplicate edges.
- Indexes:
  - `memory_relations (from_memory_id, relation_type)`
  - `memory_relations (to_memory_id, relation_type)`
  - `memories USING GIN (tags)` for tag overlap queries
- Keep existing HNSW index for `embedding`.

## 5) Data Migration of Existing Memories (idempotent)
- Normalize `relation_type` values to the v1 set; map unknowns to `relates_to` and log the original value for audit (e.g., in a migration log table or stdout).
- Backfill `state='active'` where NULL; `last_decay_update=NOW()` where NULL.
- Compute initial `decay_score`:
  - Base: `importance_score * exp(-effective_decay_rate * days_since_access)` where `effective_decay_rate = COALESCE(decay_rate, baseDecayRate)`.
  - Add `log1p(access_count) * accessBoost`; multiply by `confidence`; clamp to [0,1].
- Derive initial `state` from thresholds: `active (>=0.5)`, `dormant (>=archivalThreshold)`, `archived (>=expirationThreshold)`, else `expired`.
- Ensure `accessed_at` is set; default to `created_at` if NULL.
- Backfill `embedding_dimension` from stored vectors when present; enqueue async embeddings for rows with `embedding IS NULL`.

## 6) Services and Workers
- DecayService:
  - Exponential decay by recency; boost by access frequency; scale by confidence; optional relationship-degree boost using on-demand counts (no persistent metrics).
  - Update `decay_score`, `last_decay_update`, and transition `state` using thresholds. On `archived`, compress via existing compression service. On `expired`, soft-delete (`deleted_at`), with a configurable retention window.
  - Preservation precedence: if preservation tag present (or explicit `until` date not passed), keep `state='active'` and clamp `decay_score` near 1.0.
- Traversal service:
  - BFS/DFS with `max_depth` (<=5), `max_nodes` cap, optional time budget. Filters by `relation_type`, `types`, `tags`. Exclude soft-deleted nodes.
  - Always scope to `user_context`.
- Embedding worker:
  - When writing embeddings, set `embedding_dimension` to the vector length to keep search eligibility consistent.
- Decay worker:
  - Add a BullMQ repeatable `decay` queue/worker (hourly by default), small batch size, configurable concurrency. Support pause/resume.

## 7) MCP Tools (backward compatible surface)
- `memory_traverse`: BFS/DFS traversal with depth and filters (edge-only by default; `include_parent_links` flag optional).
- `memory_decay_status`: returns `state`, `decay_score`, `last_decay_update`, predicted next state, and whether preservation is in effect.
- `memory_preserve`: add preservation tag and reset `decay_score` to 1.0; optional `until` date stored in `metadata`.
- `memory_graph_analysis` (optional): quick in/out degree and top connectors; no heavy analytics persisted.
- Deprecation/alias: document `memory_graph_search` as alias of `memory_traverse` to avoid tool duplication for agents.

## 8) Configuration (defaults)
- Decay: `baseDecayRate=0.01`, `accessBoost=0.1`, `archivalThreshold=0.1`, `expirationThreshold=0.01`.
- Preservation tags: `['permanent','important','bookmark','favorite','pinned','preserved']`.
- Traversal limits: `max_depth<=5`, `max_nodes<=1000`, optional time budget.
- Expired retention: soft-deleted items retained for a configurable window before permanent deletion.

## 9) Implementation Order
1) Schema: add fields/constraints/indexes.
2) Migration: normalize relation types, backfill `state/decay_score/last_decay_update/accessed_at/embedding_dimension`, enqueue missing embeddings.
3) Services: implement DecayService and Traversal service.
4) Workers: add BullMQ repeatable `decay` worker; canary run.
5) Tools: add `memory_traverse`, `memory_decay_status`, `memory_preserve`, optional `memory_graph_analysis`; alias `memory_graph_search` to `memory_traverse`.
6) Config/flags: wire defaults and feature flags; enable gradually.
7) Docs/prompts: update prompts, README, comparison doc, tool descriptions, CHANGELOG; document deprecation/alias.

## 10) Testing
- Traversal: directionality, depth/limit/timeout, filters, user_context scoping, excludes soft-deleted; performance target <100ms at depth 3 with indexes.
- Decay: transitions and preservation precedence; batch processing time scalable to thousands; compression on ARCHIVED; soft-delete policy on EXPIRED.
- Embeddings: `embedding_dimension` set whenever `embedding` is present; search returns eligible memories.
- Constraints: uniqueness prevents duplicate edges; relation CHECK enforced.
- Backward compatibility: existing tools continue to work; alias respects prior behavior.

## 11) Monitoring & Rollout
- Metrics/logging for decay worker: processed, transitioned, errors, duration; ability to pause/resume.
- Track relation distribution and average strengths via existing stats endpoint.
- Rollout: run migrations, deploy services/workers, enable decay for a subset, observe, then expand. Fallback: pause the decay queue.
- Retention: schedule periodic cleanup for items past retention window after soft-delete.

## 12) Documentation & Prompt Updates (mandatory)
- Update `SYSTEM_PROMPT.md` with new tools, relation types, traversal guidance, and deprecation/alias notice for `memory_graph_search`.
- Update `README.md` and `research/mem0-vs-mcp-memory-comparison.md` to reflect graph/decay features and operational guidance.
- Update tool descriptions in `src/server.ts` (keywords/semantics) and add `CHANGELOG` describing schema and tool changes.

## 13) Acceptance Criteria
- Schema and indexes present; relation CHECK + uniqueness enforced; queries scope by `user_context` and exclude soft-deleted.
- Migration completed idempotently; all memories have valid `state`, `decay_score`, `last_decay_update`, and `embedding_dimension` when embeddings exist.
- Decay worker stable under load; traversal returns correct, filtered results within targets.
- Docs/system prompt reflect the new tools and deprecations; agents can reliably use a single traversal tool.

---

## Agent Checklist (Action-Ordered)
1) Apply DB schema changes: add `state/decay_score/last_decay_update`; add relation CHECK + UNIQUE; add composite and GIN indexes.
2) Normalize existing `relation_type` values to v1; map unknowns to `relates_to`; log unmapped values.
3) Backfill `state`, `last_decay_update`, `accessed_at` (fallback to `created_at`).
4) Compute initial `decay_score` using defaults if `decay_rate` is NULL; set lifecycle `state` from thresholds.
5) Backfill `embedding_dimension` from existing vectors; enqueue embeddings for missing ones.
6) Implement DecayService and Traversal service per plan (recency decay, boosts, preservation precedence; BFS/DFS with limits and filters; user_context scoping; exclude soft-deleted).
7) Ensure embedding worker sets `embedding_dimension` whenever writing `embedding`.
8) Add BullMQ repeatable `decay` worker; set safe batch size and concurrency; enable pause/resume.
9) Add MCP tools: `memory_traverse`, `memory_decay_status`, `memory_preserve`, optional `memory_graph_analysis`; alias `memory_graph_search` to `memory_traverse`.
10) Wire config defaults and feature flags; enable decay on a small subset first.
11) Add tests covering traversal limits/filters/scoping, decay transitions/preservation, embedding_dimension write, and uniqueness constraint behavior.
12) Add monitoring/logging for decay worker; verify index usage and latency targets; rate-limit traversal if necessary.
13) Update `SYSTEM_PROMPT.md`, `README.md`, comparison doc, server tool descriptions, and `CHANGELOG`; document deprecation/alias.
14) Roll out progressively; observe metrics; expand scope; keep the ability to pause the decay queue as a safety valve.
