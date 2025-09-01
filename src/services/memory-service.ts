import crypto from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { config } from '../config/index.js';
import type {
  BatchMemoryInput,
  ConsolidateMemoryInput,
  DeleteMemoryInput,
  GraphSearchInput,
  ListMemoryInput,
  SearchMemoryInput,
  StoreMemoryInput,
  UpdateMemoryInput,
} from '../schemas/validation.js';
import type { Database, Memory, MemoryRelation, NewMemory } from '../types/database.js';
import { getCacheService } from './cache-service.js';
import { ClusteringService } from './clustering-service.js';
import { CompressionService } from './compression-service.js';
import { EmbeddingService } from './embedding-service.js';
import { queueService } from './queue-service.js';

export class MemoryService {
  private db: Kysely<Database>;
  private embeddingService: EmbeddingService;
  private cache = getCacheService();
  private clusteringService: ClusteringService;
  private compressionService: CompressionService;
  private readonly COMPRESSION_THRESHOLD = 100000; // 100KB

  constructor(db: Kysely<Database>) {
    this.db = db;
    this.embeddingService = new EmbeddingService();
    this.clusteringService = new ClusteringService(db, queueService);
    this.compressionService = new CompressionService(db, {
      minLength: this.COMPRESSION_THRESHOLD,
      compressionRatio: 0.3,
    });
  }

  async store(input: StoreMemoryInput, useAsyncEmbedding = true): Promise<Memory> {
    const contentHash = this.embeddingService.generateContentHash(input.content);

    // Check for existing memory with same content hash
    const existing = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('content_hash', '=', contentHash)
      .where('user_context', '=', input.user_context || 'default')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (existing) {
      // Update access count and accessed_at
      await this.db
        .updateTable('memories')
        .set({
          access_count: sql`access_count + 1`,
          accessed_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();

      // Invalidate cache for this memory
      await this.cache.invalidateMemory(existing.id);

      // Return the updated memory
      const updated = await this.db
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow();

      return updated;
    }

    // Prepare content string
    const originalContentString = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
    let contentString = originalContentString;
    let isCompressed = false;
    let compressionMetadata: Record<string, unknown> | null = null;

    // Apply compression for large content
    if (originalContentString.length > this.COMPRESSION_THRESHOLD) {
      const tempMemory: Memory = {
        id: crypto.randomUUID(),
        content: { text: originalContentString } as Record<string, unknown>,
        user_context: input.user_context || 'default',
        type: input.type,
        tags: input.tags || [],
        metadata: null,
        source: input.source,
        confidence: input.confidence,
        content_hash: '',
        embedding: null,
        similarity_threshold: 0.7,
        created_at: new Date(),
        updated_at: new Date(),
        accessed_at: new Date(),
        deleted_at: null,
        access_count: 0,
        parent_id: null,
        relation_type: null,
        cluster_id: null,
        importance_score: 0.5,
        decay_rate: 0.1,
        is_compressed: false,
      };
      const compressedResult = await this.compressionService.compressMemory(tempMemory);
      contentString = compressedResult.compressedContent;
      isCompressed = true;
      compressionMetadata = {
        originalSize: originalContentString.length,
        compressedSize: contentString.length,
        compressionRatio: contentString.length / originalContentString.length,
        compressionType: 'adaptive',
      };
    }

    let embedding: number[] | null = null;

    // Use async job processing if enabled
    if (useAsyncEmbedding && config.ENABLE_ASYNC_PROCESSING) {
      // Store memory without embedding first
      embedding = null;
    } else {
      // Generate embedding synchronously (fallback) - use original content for embeddings
      embedding = await this.embeddingService.generateEmbedding(originalContentString);
    }

    // Store the memory with compressed content if applicable (always JSON encode for jsonb)
    const newMemory: NewMemory = {
      user_context: input.user_context || 'default',
      is_compressed: isCompressed,
      content: JSON.stringify(isCompressed ? { text: contentString } : input.content),
      content_hash: contentHash,
      embedding: embedding ? JSON.stringify(embedding) : null, // NULL for async processing
      tags: input.tags || [],
      type: input.type,
      source: input.source,
      confidence: input.confidence,
      similarity_threshold: config.DEFAULT_SIMILARITY_THRESHOLD,
      parent_id: input.parent_id || null,
      relation_type: input.relation_type || null,
      importance_score: input.importance_score || 0.5,
      decay_rate: 0.01,
      access_count: 0,
      metadata: compressionMetadata ? JSON.stringify(compressionMetadata) : null,
    };

    const result = await this.db.insertInto('memories').values(newMemory).returningAll().executeTakeFirstOrThrow();

    // Queue embedding generation if async
    if (useAsyncEmbedding && config.ENABLE_ASYNC_PROCESSING && !embedding) {
      await queueService.addEmbeddingJob({
        // Generate embedding from original content for better semantic fidelity
        content: originalContentString,
        memoryId: result.id,
        priority: input.importance_score ? Math.round(input.importance_score * 10) : 5,
      });
    }

    // Create relationships if relate_to is provided
    if (input.relate_to && input.relate_to.length > 0) {
      const relationPromises = input.relate_to.map((relation) =>
        this.createRelation(result.id, relation.memory_id, relation.relation_type, relation.strength || 0.5)
      );
      await Promise.allSettled(relationPromises); // Use allSettled to not fail if some relationships can't be created
    }

    // Cache the new memory
    await this.cache.cacheMemory(result.id, result);

    // Invalidate search cache since we have a new memory
    await this.cache.clearNamespace('search');

    return result;
  }

  async search(input: SearchMemoryInput): Promise<Memory[]> {
    // Check cache first
    const cacheKey = { ...input };
    const cached = await this.cache.getCachedSearchResult(input.query, cacheKey);
    if (cached) {
      return cached as Memory[];
    }

    // Generate embedding for search query
    const queryEmbedding = await this.embeddingService.generateEmbedding(input.query);
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    let query = this.db
      .selectFrom('memories')
      .selectAll()
      .select(sql<number>`1 - (embedding <=> ${embeddingString}::vector)`.as('similarity'))
      .where('deleted_at', 'is', null)
      .where('embedding', 'is not', null); // Exclude memories without embeddings

    // Filter by user_context (default to 'default' if not provided)
    const searchUserContext = input.user_context || 'default';
    query = query.where('user_context', '=', searchUserContext);

    // Apply filters
    if (input.type) {
      query = query.where('type', '=', input.type);
    }

    if (input.tags && input.tags.length > 0) {
      const tagsArray = `{${input.tags.join(',')}}`;
      query = query.where((eb) => eb(sql<boolean>`tags && ${tagsArray}::text[]`, '=', true));
    }

    // Apply similarity threshold and order by similarity
    const results = await query
      .where(sql`1 - (embedding <=> ${embeddingString}::vector)`, '>=', input.threshold)
      .orderBy(sql`1 - (embedding <=> ${embeddingString}::vector)`, 'desc')
      .limit(input.limit)
      .execute();

    // Update access count for returned memories
    if (results.length > 0) {
      await this.db
        .updateTable('memories')
        .set({
          access_count: sql`access_count + 1`,
          accessed_at: new Date(),
        })
        .where(
          'id',
          'in',
          results.map((r) => r.id)
        )
        .execute();
    }

    // Cache the search results
    await this.cache.cacheSearchResult(input.query, cacheKey, results);

    return results;
  }

  async list(input: ListMemoryInput): Promise<Memory[]> {
    let query = this.db.selectFrom('memories').selectAll().where('deleted_at', 'is', null);

    // Filter by user_context (default to 'default' if not provided)
    const searchUserContext = input.user_context || 'default';
    query = query.where('user_context', '=', searchUserContext);

    if (input.type) {
      query = query.where('type', '=', input.type);
    }

    if (input.tags && input.tags.length > 0) {
      const tagsArray = `{${input.tags.join(',')}}`;
      query = query.where((eb) => eb(sql<boolean>`tags && ${tagsArray}::text[]`, '=', true));
    }

    const results = await query.orderBy('created_at', 'desc').limit(input.limit).offset(input.offset).execute();

    // Decompress any compressed memories for client consumption
    return this.decompressMemories(results);
  }

  async update(input: UpdateMemoryInput): Promise<Memory> {
    const updates: Partial<{
      tags: string[];
      confidence: number;
      importance_score: number;
      type: string;
      source: string;
      updated_at: Date;
    }> = {};

    if (input.updates.tags !== undefined) {
      updates.tags = input.updates.tags;
    }
    if (input.updates.confidence !== undefined) {
      updates.confidence = input.updates.confidence;
    }
    if (input.updates.importance_score !== undefined) {
      updates.importance_score = input.updates.importance_score;
    }
    if (input.updates.type !== undefined) {
      updates.type = input.updates.type;
    }
    if (input.updates.source !== undefined) {
      updates.source = input.updates.source;
    }

    if (!input.preserve_timestamps) {
      updates.updated_at = new Date();
    }

    const result = await this.db
      .updateTable('memories')
      .set(updates)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Invalidate caches
    await this.cache.invalidateMemory(input.id);

    return result;
  }

  async delete(input: DeleteMemoryInput): Promise<{ success: boolean; message: string }> {
    // Soft delete - set deleted_at timestamp
    let query = this.db.updateTable('memories').set({ deleted_at: new Date() }).where('deleted_at', 'is', null);

    if (input.id) {
      query = query.where('id', '=', input.id);
    } else if (input.content_hash) {
      query = query.where('content_hash', '=', input.content_hash);
    }

    const result = await query.executeTakeFirst();

    if (result.numUpdatedRows > 0) {
      // Invalidate caches for deleted memories
      if (input.id) {
        await this.cache.invalidateMemory(input.id);
      }
      return { success: true, message: `Soft deleted ${result.numUpdatedRows} memory/memories` };
    } else {
      return { success: false, message: 'No memory found to delete' };
    }
  }

  async batchDelete(ids: string[]): Promise<{ success: boolean; deleted: number; message: string }> {
    // Soft delete multiple memories by their IDs
    const result = await this.db
      .updateTable('memories')
      .set({ deleted_at: new Date() })
      .where('deleted_at', 'is', null)
      .where('id', 'in', ids)
      .executeTakeFirst();

    // Invalidate caches for all deleted memories
    if (result.numUpdatedRows > 0) {
      await Promise.all(ids.map((id) => this.cache.invalidateMemory(id)));
    }

    return {
      success: result.numUpdatedRows > 0,
      deleted: Number(result.numUpdatedRows),
      message: `Soft deleted ${result.numUpdatedRows} memory/memories`,
    };
  }

  async batchStore(
    input: BatchMemoryInput
  ): Promise<{ success: Memory[]; failed: Array<{ memory: unknown; error: string }> }> {
    const success: Memory[] = [];
    const failed: Array<{ memory: unknown; error: string }> = [];

    for (const memory of input.memories) {
      try {
        const stored = await this.store({
          ...memory,
          user_context: input.user_context || memory.user_context,
        });
        success.push(stored);
      } catch (error) {
        failed.push({
          memory,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { success, failed };
  }

  async graphSearch(input: GraphSearchInput): Promise<Memory[]> {
    // First perform regular search
    const initialResults = await this.search(input);

    if (initialResults.length === 0 || input.depth === 0) {
      return initialResults;
    }

    const visited = new Set<string>(initialResults.map((m) => m.id));
    const queue = [...initialResults];
    const allResults = [...initialResults];
    const relationshipMap = new Map<string, Array<{ relatedId: string; type: string; strength: number }>>();

    for (let depth = 1; depth <= input.depth; depth++) {
      const currentLevelSize = queue.length;

      for (let i = 0; i < currentLevelSize; i++) {
        const memory = queue.shift();
        if (!memory) continue;

        // Find related memories through both parent relationships and memory_relations
        const relations = await this.db
          .selectFrom('memory_relations')
          .selectAll()
          .where((eb) => eb.or([eb('from_memory_id', '=', memory.id), eb('to_memory_id', '=', memory.id)]))
          .orderBy('strength', 'desc')
          .execute();

        // Also check parent relationships
        const parentRelations = await this.db
          .selectFrom('memories')
          .selectAll()
          .where((eb) => eb.or([eb('parent_id', '=', memory.id), eb('id', '=', memory.parent_id || '')]))
          .where('deleted_at', 'is', null)
          .execute();

        // Process memory_relations
        for (const relation of relations) {
          const relatedId = relation.from_memory_id === memory.id ? relation.to_memory_id : relation.from_memory_id;

          // Store relationship info for later use
          if (!relationshipMap.has(memory.id)) {
            relationshipMap.set(memory.id, []);
          }
          relationshipMap.get(memory.id)?.push({
            relatedId,
            type: relation.relation_type,
            strength: relation.strength,
          });

          if (!visited.has(relatedId)) {
            visited.add(relatedId);

            const relatedMemory = await this.db
              .selectFrom('memories')
              .selectAll()
              .where('id', '=', relatedId)
              .where('deleted_at', 'is', null)
              .executeTakeFirst();

            if (relatedMemory) {
              queue.push(relatedMemory);
              allResults.push(relatedMemory);
            }
          }
        }

        // Process parent relationships
        for (const parentRelation of parentRelations) {
          if (!visited.has(parentRelation.id)) {
            visited.add(parentRelation.id);
            queue.push(parentRelation);
            allResults.push(parentRelation);
          }
        }
      }
    }

    // Add relationship metadata to results (stored in a way that doesn't break the Memory type)
    return allResults.map((memory) => ({
      ...memory,
      metadata: {
        ...((memory.metadata as object) || {}),
        relationships: relationshipMap.get(memory.id) || [],
      },
    }));
  }

  async consolidate(input: ConsolidateMemoryInput): Promise<{ clustersCreated: number; memoriesArchived: number }> {
    // Use the clustering service with DBSCAN algorithm
    const result = await this.clusteringService.clusterMemories(
      {
        userId: input.user_context || 'default',
      },
      {
        epsilon: 1 - input.threshold, // Convert threshold to epsilon (distance)
        minPoints: input.min_cluster_size,
      }
    );

    return {
      clustersCreated: result.clusterCount,
      memoriesArchived: result.clusteredMemories,
    };
  }

  // Helper method to decompress memories
  private async decompressMemories(memories: Memory[]): Promise<Memory[]> {
    return Promise.all(
      memories.map(async (memory) => {
        if (memory.is_compressed) {
          try {
            // Decompress the content
            const decompressed = await this.compressionService.decompressMemory(memory);
            return {
              ...memory,
              // Keep as object to satisfy type expectations
              content: { text: decompressed.decompressedContent } as unknown as Record<string, unknown>,
              is_compressed: false, // Mark as decompressed for client
            };
          } catch (error) {
            console.error(`Failed to decompress memory ${memory.id}:`, error);
            return memory; // Return compressed if decompression fails
          }
        }
        return memory;
      })
    );
  }

  // Helper method to create memory without embedding
  async create(input: StoreMemoryInput, generateEmbedding = true): Promise<Memory> {
    return this.store({ ...input }, !generateEmbedding);
  }

  // Get memories by IDs
  async getByIds(ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];

    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', ids)
      .where('deleted_at', 'is', null)
      .execute();

    return memories;
  }

  // Archive memories
  async archiveMemories(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.db
      .updateTable('memories')
      .set({
        deleted_at: new Date(),
        metadata: sql`
          CASE 
            WHEN metadata IS NULL THEN '{"archived": true}'::jsonb
            ELSE metadata || '{"archived": true}'::jsonb
          END
        `,
      })
      .where('id', 'in', ids)
      .execute();

    // Clear cache for archived memories
    for (const id of ids) {
      await this.cache.invalidateMemory(id);
    }
  }

  // Batch import memories
  async batchImport(
    memories: Array<Omit<StoreMemoryInput, 'user_context'>>,
    userContext = 'default'
  ): Promise<{ jobId: string }> {
    if (!config.ENABLE_ASYNC_PROCESSING) {
      // Fallback to synchronous processing
      const results = [];
      for (const memory of memories) {
        try {
          const stored = await this.store({ ...memory, user_context: userContext }, false);
          results.push(stored);
        } catch (error) {
          console.error('Failed to import memory:', error);
        }
      }
      return { jobId: `sync-${Date.now()}` };
    }

    // Queue batch import job
    const job = await queueService.addBatchImportJob({
      memories: memories.map((m) => ({
        type: m.type,
        content: m.content,
        source: m.source,
        confidence: m.confidence,
        metadata: m as Record<string, unknown>,
      })),
      userId: userContext,
    });

    return { jobId: job.id || 'unknown' };
  }

  // Trigger memory consolidation
  async triggerConsolidation(
    memoryIds: string[],
    strategy: 'merge' | 'summarize' | 'cluster' = 'cluster'
  ): Promise<{ jobId: string }> {
    if (!config.ENABLE_ASYNC_PROCESSING) {
      // Fallback to simple consolidation
      await this.consolidate({
        user_context: 'default',
        threshold: 0.7,
        min_cluster_size: 2,
      });
      return { jobId: `sync-consolidation-${Date.now()}` };
    }

    // Queue consolidation job
    const job = await queueService.addConsolidationJob({
      memoryIds,
      strategy,
    });

    return { jobId: job.id || 'unknown' };
  }

  // Get queue statistics
  async getQueueStats() {
    return queueService.getQueueStats();
  }

  async getStats(userContext?: string): Promise<{
    total_memories: number;
    recent_memories_24h: number;
    clustered_memories: number;
    type_distribution: Array<{ type: string; count: unknown }>;
    user_context: string;
    total_relationships: number;
    relationship_distribution: Array<{ relation_type: string; count: unknown }>;
    avg_relationship_strength: number;
    cache_stats?: {
      redis: boolean;
      localKeys: number;
      localHits: number;
      localMisses: number;
      redisKeys?: number;
    };
  }> {
    const baseQuery = this.db
      .selectFrom('memories')
      .where('user_context', '=', userContext || 'default')
      .where('deleted_at', 'is', null);

    const totalMemories = await baseQuery.select((eb) => eb.fn.count('id').as('count')).executeTakeFirst();

    const typeDistribution = await baseQuery
      .select('type')
      .select((eb) => eb.fn.count('id').as('count'))
      .groupBy('type')
      .execute();

    const recentMemories = await baseQuery
      .select((eb) => eb.fn.count('id').as('count'))
      .where('created_at', '>', sql<Date>`CURRENT_TIMESTAMP - INTERVAL '24 hours'`)
      .executeTakeFirst();

    const clusteredMemories = await baseQuery
      .select((eb) => eb.fn.count('id').as('count'))
      .where('cluster_id', 'is not', null)
      .executeTakeFirst();

    // Get relationship statistics
    const totalRelationships = await this.db
      .selectFrom('memory_relations')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();

    const relationshipDistribution = await this.db
      .selectFrom('memory_relations')
      .select('relation_type')
      .select((eb) => eb.fn.count('id').as('count'))
      .groupBy('relation_type')
      .execute();

    const avgStrength = await this.db
      .selectFrom('memory_relations')
      .select((eb) => eb.fn.avg('strength').as('avg_strength'))
      .executeTakeFirst();

    // Get cache statistics
    const cacheStats = await this.cache.getStats();

    return {
      total_memories: Number(totalMemories?.count || 0),
      recent_memories_24h: Number(recentMemories?.count || 0),
      clustered_memories: Number(clusteredMemories?.count || 0),
      type_distribution: typeDistribution,
      user_context: userContext || 'default',
      total_relationships: Number(totalRelationships?.count || 0),
      relationship_distribution: relationshipDistribution,
      avg_relationship_strength: Number(avgStrength?.avg_strength || 0),
      cache_stats: cacheStats,
    };
  }

  async getTypes(): Promise<string[]> {
    const types = await this.db
      .selectFrom('memories')
      .select('type')
      .where('deleted_at', 'is', null)
      .distinct()
      .orderBy('type')
      .execute();

    return types.map((t) => t.type);
  }

  async getTags(): Promise<string[]> {
    const result = await this.db
      .selectFrom('memories')
      .select(sql<string[]>`ARRAY_AGG(DISTINCT unnest(tags))`.as('all_tags'))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return result?.all_tags || [];
  }

  async getRelationships(): Promise<MemoryRelation[]> {
    return await this.db.selectFrom('memory_relations').selectAll().orderBy('created_at', 'desc').limit(100).execute();
  }

  async createRelation(
    fromMemoryId: string,
    toMemoryId: string,
    relationType: 'references' | 'contradicts' | 'supports' | 'extends',
    strength = 0.5
  ): Promise<MemoryRelation> {
    // Validate both memories exist
    const [fromMemory, toMemory] = await Promise.all([
      this.db
        .selectFrom('memories')
        .select('id')
        .where('id', '=', fromMemoryId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      this.db
        .selectFrom('memories')
        .select('id')
        .where('id', '=', toMemoryId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    ]);

    if (!fromMemory) {
      throw new Error(`Source memory ${fromMemoryId} not found`);
    }
    if (!toMemory) {
      throw new Error(`Target memory ${toMemoryId} not found`);
    }

    // Check if relationship already exists
    const existing = await this.db
      .selectFrom('memory_relations')
      .selectAll()
      .where('from_memory_id', '=', fromMemoryId)
      .where('to_memory_id', '=', toMemoryId)
      .executeTakeFirst();

    if (existing) {
      // Update existing relationship
      const updated = await this.db
        .updateTable('memory_relations')
        .set({
          relation_type: relationType,
          strength: Math.max(0, Math.min(1, strength)), // Clamp between 0 and 1
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Invalidate cache for both memories
      await Promise.all([this.cache.invalidateMemory(fromMemoryId), this.cache.invalidateMemory(toMemoryId)]);

      return updated;
    }

    // Create new relationship
    const relation = await this.db
      .insertInto('memory_relations')
      .values({
        from_memory_id: fromMemoryId,
        to_memory_id: toMemoryId,
        relation_type: relationType,
        strength: Math.max(0, Math.min(1, strength)), // Clamp between 0 and 1
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Invalidate cache for both memories
    await Promise.all([this.cache.invalidateMemory(fromMemoryId), this.cache.invalidateMemory(toMemoryId)]);

    return relation;
  }

  async deleteRelation(fromMemoryId: string, toMemoryId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('memory_relations')
      .where('from_memory_id', '=', fromMemoryId)
      .where('to_memory_id', '=', toMemoryId)
      .executeTakeFirst();

    if (result.numDeletedRows > 0) {
      // Invalidate cache for both memories
      await Promise.all([this.cache.invalidateMemory(fromMemoryId), this.cache.invalidateMemory(toMemoryId)]);
      return true;
    }

    return false;
  }

  async updateRelation(
    fromMemoryId: string,
    toMemoryId: string,
    updates: { relation_type?: 'references' | 'contradicts' | 'supports' | 'extends'; strength?: number }
  ): Promise<MemoryRelation | null> {
    const updateData: { relation_type?: 'references' | 'contradicts' | 'supports' | 'extends'; strength?: number } = {};
    if (updates.relation_type) {
      updateData.relation_type = updates.relation_type;
    }
    if (updates.strength !== undefined) {
      updateData.strength = Math.max(0, Math.min(1, updates.strength)); // Clamp between 0 and 1
    }

    const result = await this.db
      .updateTable('memory_relations')
      .set(updateData)
      .where('from_memory_id', '=', fromMemoryId)
      .where('to_memory_id', '=', toMemoryId)
      .returningAll()
      .executeTakeFirst();

    if (result) {
      // Invalidate cache for both memories
      await Promise.all([this.cache.invalidateMemory(fromMemoryId), this.cache.invalidateMemory(toMemoryId)]);
    }

    return result || null;
  }

  async getMemoryRelations(memoryId: string): Promise<MemoryRelation[]> {
    const relations = await this.db
      .selectFrom('memory_relations')
      .selectAll()
      .where((eb) => eb.or([eb('from_memory_id', '=', memoryId), eb('to_memory_id', '=', memoryId)]))
      .orderBy('strength', 'desc')
      .execute();

    return relations;
  }

  async createBidirectionalRelation(
    memoryId1: string,
    memoryId2: string,
    relationType: 'references' | 'contradicts' | 'supports' | 'extends',
    strength = 0.5,
    reverseType?: 'references' | 'contradicts' | 'supports' | 'extends'
  ): Promise<{ forward: MemoryRelation; reverse: MemoryRelation }> {
    // Determine reverse relationship type if not specified
    const reverseRelationType = reverseType || this.getReverseRelationType(relationType);

    // Create both relationships
    const [forward, reverse] = await Promise.all([
      this.createRelation(memoryId1, memoryId2, relationType, strength),
      this.createRelation(memoryId2, memoryId1, reverseRelationType, strength),
    ]);

    return { forward, reverse };
  }

  private getReverseRelationType(
    relationType: 'references' | 'contradicts' | 'supports' | 'extends'
  ): 'references' | 'contradicts' | 'supports' | 'extends' {
    // Define reverse relationship mappings
    const reverseMap: Record<string, 'references' | 'contradicts' | 'supports' | 'extends'> = {
      references: 'references', // Bidirectional
      contradicts: 'contradicts', // Bidirectional
      supports: 'supports', // Bidirectional
      extends: 'references', // If A extends B, then B is referenced by A
    };

    return reverseMap[relationType] || relationType;
  }

  async getClusters(): Promise<Array<{ cluster_id: string | null; count: unknown }>> {
    const clusters = await this.db
      .selectFrom('memories')
      .select('cluster_id')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('cluster_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('cluster_id')
      .orderBy('count', 'desc')
      .limit(20)
      .execute();

    return clusters;
  }

  async cleanup(): Promise<void> {
    // Clean up cache service
    await this.cache.close();

    // Clean up queue service if it's running
    if (config.ENABLE_ASYNC_PROCESSING) {
      await queueService.shutdown();
    }

    // Destroy database connection
    await this.db.destroy();
  }
}
