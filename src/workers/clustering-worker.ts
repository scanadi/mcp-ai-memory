import { type Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createDatabase } from '../database/client.js';
import { ClusteringService } from '../services/clustering-service.js';
import type { QueueService } from '../services/queue-service.js';

export interface ClusteringJob {
  type: 'full-clustering' | 'incremental' | 'merge-clusters' | 'split-clusters';
  filters?: {
    type?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    minImportance?: number;
  };
  memoryIds?: string[];
  config?: {
    epsilon?: number;
    minPoints?: number;
    minClusterSize?: number;
  };
}

export class ClusteringWorker {
  private worker: Worker<ClusteringJob>;
  private clusteringService: ClusteringService;
  private connection: Redis | null = null;

  constructor(connection?: Redis, queueService?: QueueService) {
    const db = createDatabase(config.MEMORY_DB_URL);
    this.clusteringService = new ClusteringService(db, queueService);

    // Use provided connection or create new one
    this.connection =
      connection ||
      new Redis(config.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

    // Initialize worker
    if (!this.connection) {
      throw new Error('Redis connection is required for clustering worker');
    }
    this.worker = new Worker<ClusteringJob>('clustering', this.processClusteringJob.bind(this), {
      connection: this.connection,
      concurrency: 1, // Single concurrency to avoid conflicts
      autorun: true,
    });

    this.setupEventHandlers();
  }

  private async processClusteringJob(job: Job<ClusteringJob>): Promise<Record<string, unknown>> {
    const { type, filters, memoryIds, config: clusterConfig } = job.data;
    const startTime = Date.now();

    try {
      await job.log(`Starting ${type} clustering job`);
      await job.updateProgress(10);

      let result: Record<string, unknown>;

      switch (type) {
        case 'full-clustering':
          result = await this.performFullClustering(job, filters, clusterConfig);
          break;

        case 'incremental':
          if (!memoryIds || memoryIds.length === 0) {
            throw new Error('Memory IDs required for incremental clustering');
          }
          result = await this.performIncrementalClustering(job, memoryIds, clusterConfig);
          break;

        case 'merge-clusters':
          result = await this.performClusterMerging(job);
          break;

        case 'split-clusters':
          result = await this.performClusterSplitting(job);
          break;

        default:
          throw new Error(`Unknown clustering job type: ${type}`);
      }

      const duration = Date.now() - startTime;
      await job.log(`Clustering job completed in ${duration}ms`);
      await job.updateProgress(100);

      return {
        ...result,
        jobType: type,
        processingTimeMs: duration,
      };
    } catch (error) {
      await job.log(`Clustering job failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async performFullClustering(
    job: Job,
    filters?: Record<string, unknown>,
    clusterConfig?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await job.log('Performing full DBSCAN clustering on database');
    await job.updateProgress(20);

    const stats = await this.clusteringService.clusterMemories(filters, clusterConfig);

    await job.updateProgress(60);

    // Post-processing: merge and split as needed
    const mergedCount = await this.clusteringService.mergeSimilarClusters(0.85);
    await job.log(`Merged ${mergedCount} similar clusters`);

    await job.updateProgress(80);

    const splitCount = await this.clusteringService.splitLargeClusters(100, 0.4);
    await job.log(`Split ${splitCount} large incoherent clusters`);

    await job.updateProgress(90);

    // Get final cluster summary
    const clustersSummary = await this.clusteringService.getClustersSummary();

    return {
      ...stats,
      mergedClusters: mergedCount,
      splitClusters: splitCount,
      finalClusterCount: clustersSummary.length,
      clustersSummary: clustersSummary.slice(0, 10), // Top 10 clusters
    };
  }

  private async performIncrementalClustering(
    job: Job,
    memoryIds: string[],
    clusterConfig?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await job.log(`Performing incremental clustering for ${memoryIds.length} memories`);
    await job.updateProgress(30);

    const stats = await this.clusteringService.clusterNewMemories(memoryIds, clusterConfig);

    await job.updateProgress(90);

    return { ...stats };
  }

  private async performClusterMerging(job: Job): Promise<Record<string, unknown>> {
    await job.log('Merging similar clusters');
    await job.updateProgress(30);

    const beforeSummary = await this.clusteringService.getClustersSummary();
    const initialCount = beforeSummary.length;

    await job.updateProgress(50);

    const mergedCount = await this.clusteringService.mergeSimilarClusters(0.8);

    await job.updateProgress(80);

    const afterSummary = await this.clusteringService.getClustersSummary();
    const finalCount = afterSummary.length;

    await job.log(`Merged ${mergedCount} cluster pairs, reduced from ${initialCount} to ${finalCount} clusters`);

    return {
      initialClusterCount: initialCount,
      finalClusterCount: finalCount,
      mergedPairs: mergedCount,
      reduction: initialCount - finalCount,
    };
  }

  private async performClusterSplitting(job: Job): Promise<Record<string, unknown>> {
    await job.log('Splitting large incoherent clusters');
    await job.updateProgress(30);

    const beforeSummary = await this.clusteringService.getClustersSummary();
    const initialCount = beforeSummary.length;

    await job.updateProgress(50);

    const splitCount = await this.clusteringService.splitLargeClusters(50, 0.4);

    await job.updateProgress(80);

    const afterSummary = await this.clusteringService.getClustersSummary();
    const finalCount = afterSummary.length;

    await job.log(`Split ${splitCount} clusters, increased from ${initialCount} to ${finalCount} clusters`);

    return {
      initialClusterCount: initialCount,
      finalClusterCount: finalCount,
      splitClusters: splitCount,
      increase: finalCount - initialCount,
    };
  }

  private setupEventHandlers(): void {
    this.worker.on('completed', (job) => {
      console.log(`[ClusteringWorker] Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, error) => {
      console.error(`[ClusteringWorker] Job ${job?.id} failed:`, error.message);
    });

    this.worker.on('active', (job) => {
      console.log(`[ClusteringWorker] Job ${job.id} started`);
    });

    this.worker.on('stalled', (jobId) => {
      console.warn(`[ClusteringWorker] Job ${jobId} stalled`);
    });

    this.worker.on('error', (error) => {
      console.error('[ClusteringWorker] Worker error:', error);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async getMetrics() {
    // Get clustering-specific metrics
    const clustersSummary = await this.clusteringService.getClustersSummary();

    return {
      totalClusters: clustersSummary.length,
      totalClusteredMemories: clustersSummary.reduce((sum, c) => sum + c.size, 0),
      largestCluster: Math.max(...clustersSummary.map((c) => c.size), 0),
      averageClusterSize:
        clustersSummary.length > 0 ? clustersSummary.reduce((sum, c) => sum + c.size, 0) / clustersSummary.length : 0,
      topTypes: [...new Set(clustersSummary.flatMap((c) => c.types))].slice(0, 5),
    };
  }

  async pause(): Promise<void> {
    await this.worker.pause();
    console.log('[ClusteringWorker] Worker paused');
  }

  async resume(): Promise<void> {
    await this.worker.resume();
    console.log('[ClusteringWorker] Worker resumed');
  }

  async shutdown(): Promise<void> {
    console.log('[ClusteringWorker] Closing worker...');
    await this.worker.close();
    if (this.connection) {
      await this.connection.quit();
    }
    console.log('[ClusteringWorker] Worker closed');
  }
}

// Start worker if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  new ClusteringWorker();
  console.log('[ClusteringWorker] Worker started');
}
