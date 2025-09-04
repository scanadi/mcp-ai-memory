import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { DBSCAN, type DBSCANPoint, IncrementalDBSCAN } from '../algorithms/dbscan.js';
import type { Database } from '../types/database.js';
import { parseEmbedding } from '../utils/embedding.js';
import { getCacheService } from './cache-service.js';
import type { QueueService } from './queue-service.js';

export interface ClusteringConfig {
  epsilon?: number; // Default from config
  minPoints?: number; // Default from config
  minClusterSize?: number; // Minimum size to keep a cluster
  maxIterations?: number; // Maximum clustering iterations
  enableIncremental?: boolean; // Use incremental clustering
}

export interface ClusterResult {
  clusterId: string;
  memberIds: string[];
  centroid?: number[];
  coherence: number;
  size: number;
  createdAt: Date;
}

export interface ClusteringStats {
  totalMemories: number;
  clusteredMemories: number;
  noiseMemories: number;
  clusterCount: number;
  averageClusterSize: number;
  largestCluster: number;
  smallestCluster: number;
  silhouetteScore: number;
  processingTimeMs: number;
}

export class ClusteringService {
  private db: Kysely<Database>;
  private cache = getCacheService();
  private queueService?: QueueService;

  constructor(db: Kysely<Database>, queueService?: QueueService) {
    this.db = db;
    this.queueService = queueService;
  }

  /**
   * Cluster all memories or a subset based on filters
   */
  async clusterMemories(
    filters?: {
      type?: string;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
      minImportance?: number;
    },
    config?: ClusteringConfig
  ): Promise<ClusteringStats> {
    const startTime = Date.now();

    // Build query with filters
    let query = this.db
      .selectFrom('memories')
      .select(['id', 'embedding', 'type', 'importance_score', 'created_at'])
      .where('deleted_at', 'is', null)
      .where('embedding', 'is not', null);

    if (filters?.type) {
      query = query.where(
        'type',
        '=',
        filters.type as
          | 'fact'
          | 'conversation'
          | 'decision'
          | 'insight'
          | 'context'
          | 'preference'
          | 'task'
          | 'error'
          | 'merged'
          | 'summary'
      );
    }
    if (filters?.userId) {
      query = query.where('user_context', '=', filters.userId);
    }
    if (filters?.startDate) {
      query = query.where('created_at', '>=', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.where('created_at', '<=', filters.endDate);
    }
    if (filters?.minImportance) {
      query = query.where('importance_score', '>=', filters.minImportance);
    }

    const memories = await query.execute();

    if (memories.length === 0) {
      return {
        totalMemories: 0,
        clusteredMemories: 0,
        noiseMemories: 0,
        clusterCount: 0,
        averageClusterSize: 0,
        largestCluster: 0,
        smallestCluster: 0,
        silhouetteScore: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Convert to DBSCAN points
    const points: DBSCANPoint[] = memories
      .map((m) => {
        const embedding = parseEmbedding(m.embedding);
        if (!embedding) return null;
        return {
          id: m.id,
          embedding,
        };
      })
      .filter((p): p is DBSCANPoint => p !== null);

    // Run DBSCAN
    const dbscan = new DBSCAN({
      epsilon: config?.epsilon || 0.3,
      minPoints: config?.minPoints || 3,
    });

    const clusters = dbscan.cluster(points);

    // Filter out small clusters
    const minClusterSize = config?.minClusterSize || 2;
    const validClusters = new Map<number, string[]>();
    for (const [clusterId, memberIds] of clusters) {
      if (memberIds.length >= minClusterSize) {
        validClusters.set(clusterId, memberIds);
      }
    }

    // Update database with cluster assignments
    await this.updateClusterAssignments(validClusters);

    // Calculate statistics
    const stats = dbscan.getStatistics();
    const silhouetteScore = dbscan.calculateSilhouetteScore();

    return {
      totalMemories: stats.totalPoints,
      clusteredMemories: stats.clusteredPoints,
      noiseMemories: stats.noisePoints,
      clusterCount: stats.clusterCount,
      averageClusterSize: stats.averageClusterSize,
      largestCluster: stats.largestCluster,
      smallestCluster: stats.smallestCluster,
      silhouetteScore,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Incremental clustering for new memories
   */
  async clusterNewMemories(memoryIds: string[], config?: ClusteringConfig): Promise<ClusteringStats> {
    const startTime = Date.now();

    // Get new memories with embeddings
    const newMemories = await this.db
      .selectFrom('memories')
      .select(['id', 'embedding', 'cluster_id'])
      .where('id', 'in', memoryIds)
      .where('embedding', 'is not', null)
      .execute();

    if (newMemories.length === 0) {
      return {
        totalMemories: 0,
        clusteredMemories: 0,
        noiseMemories: 0,
        clusterCount: 0,
        averageClusterSize: 0,
        largestCluster: 0,
        smallestCluster: 0,
        silhouetteScore: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Get existing clustered memories (sample for efficiency)
    const existingMemories = await this.db
      .selectFrom('memories')
      .select(['id', 'embedding', 'cluster_id'])
      .where('cluster_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .orderBy(sql`random()`)
      .limit(1000) // Sample for performance
      .execute();

    // Convert to DBSCAN points
    const newPoints: DBSCANPoint[] = newMemories
      .map((m) => {
        const embedding = parseEmbedding(m.embedding);
        if (!embedding) return null;
        return {
          id: m.id,
          embedding,
        };
      })
      .filter((p): p is DBSCANPoint => p !== null);

    const existingPoints: DBSCANPoint[] = existingMemories
      .map((m) => {
        const embedding = parseEmbedding(m.embedding);
        if (!embedding) return null;
        const point: DBSCANPoint = {
          id: m.id,
          embedding,
        };
        if (m.cluster_id) {
          point.clusterId = Number(m.cluster_id);
        }
        return point;
      })
      .filter((p): p is DBSCANPoint => p !== null);

    // Run incremental DBSCAN
    const dbscan = new IncrementalDBSCAN({
      epsilon: config?.epsilon || 0.3,
      minPoints: config?.minPoints || 3,
    });

    const clusters = dbscan.addPoints(newPoints, existingPoints);

    // Update only the new memories' cluster assignments
    const updates: Array<{ id: string; clusterId: number | null }> = [];
    for (const newMemory of newMemories) {
      let assigned = false;
      for (const [clusterId, memberIds] of clusters) {
        if (memberIds.includes(newMemory.id)) {
          updates.push({ id: newMemory.id, clusterId });
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        updates.push({ id: newMemory.id, clusterId: null });
      }
    }

    // Batch update
    for (const update of updates) {
      await this.db
        .updateTable('memories')
        .set({ cluster_id: update.clusterId ? String(update.clusterId) : null, updated_at: new Date() })
        .where('id', '=', update.id)
        .execute();
    }

    const stats = dbscan.getStatistics();
    const silhouetteScore = dbscan.calculateSilhouetteScore();

    return {
      totalMemories: stats.totalPoints,
      clusteredMemories: stats.clusteredPoints,
      noiseMemories: stats.noisePoints,
      clusterCount: stats.clusterCount,
      averageClusterSize: stats.averageClusterSize,
      largestCluster: stats.largestCluster,
      smallestCluster: stats.smallestCluster,
      silhouetteScore,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Update cluster assignments in database
   */
  private async updateClusterAssignments(clusters: Map<number, string[]>): Promise<void> {
    // First, clear existing cluster assignments for these memories
    const allMemoryIds = Array.from(clusters.values()).flat();
    if (allMemoryIds.length > 0) {
      await this.db.updateTable('memories').set({ cluster_id: null }).where('id', 'in', allMemoryIds).execute();
    }

    // Then assign new clusters
    for (const [clusterId, memberIds] of clusters) {
      await this.db
        .updateTable('memories')
        .set({ cluster_id: String(clusterId), updated_at: new Date() })
        .where('id', 'in', memberIds)
        .execute();
    }

    // Invalidate cache for updated memories
    for (const memoryId of allMemoryIds) {
      await this.cache.invalidateMemory(memoryId);
    }
  }

  /**
   * Get cluster details
   */
  async getCluster(clusterId: string): Promise<ClusterResult | null> {
    const members = await this.db
      .selectFrom('memories')
      .select(['id', 'embedding', 'type', 'created_at'])
      .where('cluster_id', '=', clusterId)
      .where('deleted_at', 'is', null)
      .execute();

    if (members.length === 0) {
      return null;
    }

    // Calculate centroid
    const embeddings = members.map((m) => parseEmbedding(m.embedding)).filter((e): e is number[] => e !== null);
    const centroid = this.calculateCentroid(embeddings);

    // Calculate coherence (average similarity within cluster)
    const coherence = this.calculateCoherence(embeddings);

    return {
      clusterId,
      memberIds: members.map((m) => m.id),
      centroid,
      coherence,
      size: members.length,
      createdAt: members[0]?.created_at || new Date(),
    };
  }

  /**
   * Get all clusters summary
   */
  async getClustersSummary(): Promise<
    Array<{ clusterId: number; size: number; types: string[]; avgImportance: number }>
  > {
    const clusters = await this.db
      .selectFrom('memories')
      .select(['cluster_id'])
      .select((eb) => eb.fn.count<number>('id').as('size'))
      .select(() => sql<string>`array_agg(DISTINCT type)`.as('types'))
      .select((eb) => eb.fn.avg<number>('importance_score').as('avg_importance'))
      .where('cluster_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('cluster_id')
      .orderBy('size', 'desc')
      .execute();

    return clusters.map((c) => ({
      clusterId: c.cluster_id ? Number(c.cluster_id) : 0,
      size: Number(c.size),
      types: c.types ? (JSON.parse(c.types.replace('{', '[').replace('}', ']')) as string[]) : [],
      avgImportance: Number(c.avg_importance) || 0,
    }));
  }

  /**
   * Merge similar clusters
   */
  async mergeSimilarClusters(similarityThreshold = 0.8): Promise<number> {
    const clusters = await this.getClustersSummary();
    let mergedCount = 0;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cluster1 = await this.getCluster(String(clusters[i]?.clusterId));
        const cluster2 = await this.getCluster(String(clusters[j]?.clusterId));

        if (!cluster1?.centroid || !cluster2?.centroid) continue;

        const similarity = this.cosineSimilarity(cluster1.centroid, cluster2.centroid);

        if (similarity >= similarityThreshold) {
          // Merge cluster2 into cluster1
          await this.db
            .updateTable('memories')
            .set({ cluster_id: String(cluster1.clusterId), updated_at: new Date() })
            .where('cluster_id', '=', String(cluster2.clusterId))
            .execute();

          mergedCount++;
        }
      }
    }

    return mergedCount;
  }

  /**
   * Split large clusters if they're not coherent
   */
  async splitLargeClusters(maxSize = 100, minCoherence = 0.5): Promise<number> {
    const largeClusters = await this.db
      .selectFrom('memories')
      .select('cluster_id')
      .select((eb) => eb.fn.count<number>('id').as('size'))
      .where('cluster_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('cluster_id')
      .having(() => sql`count(id)`, '>', maxSize)
      .execute();

    let splitCount = 0;

    for (const cluster of largeClusters) {
      if (!cluster.cluster_id) continue;
      const clusterData = await this.getCluster(cluster.cluster_id);
      if (!clusterData) continue;

      if (clusterData.coherence < minCoherence) {
        // Re-cluster this subset
        const memories = await this.db
          .selectFrom('memories')
          .select(['id', 'embedding'])
          .where('cluster_id', '=', cluster.cluster_id)
          .execute();

        const points: DBSCANPoint[] = memories
          .map((m) => {
            const embedding = parseEmbedding(m.embedding);
            if (!embedding) return null;
            return {
              id: m.id,
              embedding,
            };
          })
          .filter((p): p is DBSCANPoint => p !== null);

        // Use tighter epsilon for splitting
        const dbscan = new DBSCAN({
          epsilon: 0.2,
          minPoints: 3,
        });

        const newClusters = dbscan.cluster(points);

        // Update with new sub-clusters
        let subClusterId = Number(cluster.cluster_id) * 1000; // Create sub-cluster IDs
        for (const [, memberIds] of newClusters) {
          await this.db
            .updateTable('memories')
            .set({ cluster_id: String(subClusterId++), updated_at: new Date() })
            .where('id', 'in', memberIds)
            .execute();
        }

        splitCount++;
      }
    }

    return splitCount;
  }

  /**
   * Queue clustering job
   */
  async queueClusteringJob(filters?: Record<string, unknown>, config?: ClusteringConfig): Promise<string | null> {
    if (!this.queueService) {
      console.warn('Queue service not available, running clustering synchronously');
      await this.clusterMemories(filters as Parameters<typeof this.clusterMemories>[0], config);
      return null;
    }

    const job = await this.queueService.addConsolidationJob({
      memoryIds: [], // Will be determined by filters in worker
      strategy: 'cluster',
    });

    return job.id || null;
  }

  /**
   * Calculate centroid of embeddings
   */
  private calculateCentroid(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];

    const dimensions = embeddings[0]?.length || 0;
    if (dimensions === 0) return [];
    const centroid = new Array(dimensions).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        const value = embedding[i];
        if (value !== undefined) {
          centroid[i] += value;
        }
      }
    }

    return centroid.map((sum) => sum / embeddings.length);
  }

  /**
   * Calculate coherence (average pairwise similarity)
   */
  private calculateCoherence(embeddings: number[][]): number {
    if (embeddings.length < 2) return 1;

    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const embeddingI = embeddings[i];
        const embeddingJ = embeddings[j];
        if (embeddingI && embeddingJ) {
          totalSimilarity += this.cosineSimilarity(embeddingI, embeddingJ);
        }
        pairCount++;
      }
    }

    return pairCount > 0 ? totalSimilarity / pairCount : 0;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i];
      const bVal = b[i];
      if (aVal !== undefined && bVal !== undefined) {
        dotProduct += aVal * bVal;
        normA += aVal * aVal;
        normB += bVal * bVal;
      }
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }
}
