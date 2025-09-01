import { type Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createDatabase } from '../database/client.js';
import { ClusteringService } from '../services/clustering-service.js';
import { MemoryService } from '../services/memory-service.js';
import type { BatchImportJob, ConsolidationJob } from '../services/queue-service.js';

export class BatchWorker {
  private batchWorker: Worker<BatchImportJob>;
  private consolidationWorker: Worker<ConsolidationJob>;
  private memoryService: MemoryService;
  private clusteringService: ClusteringService;
  private connection: Redis | null = null;

  constructor(connection?: Redis) {
    const db = createDatabase(config.MEMORY_DB_URL);
    this.memoryService = new MemoryService(db);
    this.clusteringService = new ClusteringService(db);

    // Use provided connection or create new one
    this.connection =
      connection ||
      new Redis(config.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

    // Initialize batch import worker
    if (!this.connection) {
      throw new Error('Redis connection is required for batch worker');
    }
    this.batchWorker = new Worker<BatchImportJob>('batch-import', this.processBatchImport.bind(this), {
      connection: this.connection,
      concurrency: 2, // Lower concurrency for batch operations
      autorun: true,
    });

    // Initialize consolidation worker
    this.consolidationWorker = new Worker<ConsolidationJob>(
      'memory-consolidation',
      this.processConsolidation.bind(this),
      {
        connection: this.connection,
        concurrency: 1, // Single concurrency to avoid conflicts
        autorun: true,
      }
    );

    this.setupEventHandlers();
  }

  private async processBatchImport(job: Job<BatchImportJob>): Promise<void> {
    const { memories } = job.data;
    const startTime = Date.now();
    const results = { success: 0, failed: 0, errors: [] as string[] };

    try {
      await job.log(`Starting batch import of ${memories.length} memories`);
      await job.updateProgress(0);

      // Process memories in chunks to avoid overwhelming the system
      const chunkSize = 10;
      const chunks = [];
      for (let i = 0; i < memories.length; i += chunkSize) {
        chunks.push(memories.slice(i, i + chunkSize));
      }

      let processed = 0;
      for (const chunk of chunks) {
        await job.log(`Processing chunk ${Math.floor(processed / chunkSize) + 1}/${chunks.length}`);

        // Process chunk in parallel
        const chunkResults = await Promise.allSettled(
          chunk.map(async (memory) => {
            try {
              // Create memory without embedding (will be queued separately)
              const created = await this.memoryService.create(
                {
                  ...memory,
                  tags: [],
                  importance_score: 0.5,
                },
                false
              ); // false = skip embedding generation

              return { success: true, memoryId: created.id };
            } catch (error) {
              return { success: false, error: (error as Error).message };
            }
          })
        );

        // Count results
        for (const result of chunkResults) {
          if (result.status === 'fulfilled' && result.value.success) {
            results.success++;
          } else {
            results.failed++;
            if (result.status === 'rejected') {
              results.errors.push(result.reason);
            } else if (result.status === 'fulfilled' && !result.value.success) {
              results.errors.push(result.value.error || 'Unknown error');
            }
          }
        }

        processed += chunk.length;
        const progress = Math.round((processed / memories.length) * 100);
        await job.updateProgress(progress);
      }

      const duration = Date.now() - startTime;
      await job.log(`Batch import completed: ${results.success} success, ${results.failed} failed in ${duration}ms`);

      // Store results for later retrieval
      if (job.id) {
        await this.storeBatchResults(job.id, results);
      }

      // If we have failures, log them but don't fail the job
      if (results.failed > 0) {
        console.warn(`[BatchWorker] Batch import had ${results.failed} failures:`, results.errors);
      }

      return;
    } catch (error) {
      await job.log(`Fatal error during batch import: ${(error as Error).message}`);
      throw error;
    }
  }

  private async processConsolidation(job: Job<ConsolidationJob>): Promise<Record<string, unknown> | undefined> {
    const { memoryIds, strategy } = job.data;
    const startTime = Date.now();

    try {
      await job.log(`Starting ${strategy} consolidation for ${memoryIds.length} memories`);
      await job.updateProgress(10);

      let result: Record<string, unknown>;
      switch (strategy) {
        case 'merge':
          result = await this.mergeMemories(memoryIds, job);
          break;

        case 'summarize':
          result = await this.summarizeMemories(memoryIds, job);
          break;

        case 'cluster':
          result = await this.clusterMemories(memoryIds, job);
          break;

        default:
          throw new Error(`Unknown consolidation strategy: ${strategy}`);
      }

      await job.updateProgress(90);

      const duration = Date.now() - startTime;
      await job.log(`Consolidation completed in ${duration}ms`);

      await job.updateProgress(100);

      return result;
    } catch (error) {
      await job.log(`Consolidation failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async mergeMemories(memoryIds: string[], job: Job): Promise<Record<string, unknown>> {
    await job.log('Fetching memories for merge...');

    // Fetch all memories
    const memories = await this.memoryService.getByIds(memoryIds);

    if (memories.length < 2) {
      throw new Error('Need at least 2 memories to merge');
    }

    await job.updateProgress(30);

    // Combine content
    const mergedContent = memories
      .map((m) => {
        if (typeof m.content === 'string') return m.content;
        return JSON.stringify(m.content);
      })
      .join('\n\n---\n\n');

    await job.updateProgress(50);

    // Create merged memory
    const mergedMemory = await this.memoryService.create({
      type: 'fact' as const, // Store merged memories as facts
      content: {
        merged: true,
        originalIds: memoryIds,
        mergedContent,
        mergeDate: new Date().toISOString(),
      },
      source: 'consolidation:merge',
      confidence: Math.max(...memories.map((m) => m.confidence)),
      importance_score: 0.8, // Higher importance for merged memories
      tags: [],
    });

    await job.updateProgress(70);

    // Archive original memories
    await this.memoryService.archiveMemories(memoryIds);

    await job.log(`Merged ${memories.length} memories into ${mergedMemory.id}`);

    return {
      mergedId: mergedMemory.id,
      originalCount: memories.length,
    };
  }

  private async summarizeMemories(memoryIds: string[], job: Job): Promise<Record<string, unknown>> {
    await job.log('Fetching memories for summarization...');

    const memories = await this.memoryService.getByIds(memoryIds);

    await job.updateProgress(30);

    // Group by type
    const grouped = memories.reduce(
      (acc, mem) => {
        if (!acc[mem.type]) acc[mem.type] = [];
        acc[mem.type]?.push(mem);
        return acc;
      },
      {} as Record<string, typeof memories>
    );

    await job.updateProgress(50);

    const summaries = [];

    for (const [type, typeMemories] of Object.entries(grouped)) {
      // Create a summary for each type
      const summary = {
        type,
        count: typeMemories.length,
        dateRange: {
          start: new Date(Math.min(...typeMemories.map((m) => m.created_at.getTime()))),
          end: new Date(Math.max(...typeMemories.map((m) => m.created_at.getTime()))),
        },
        // In production, you'd use an LLM to generate actual summaries
        content: `Summary of ${typeMemories.length} ${type} memories`,
      };

      summaries.push(summary);
    }

    await job.updateProgress(70);

    // Create summary memory
    const summaryMemory = await this.memoryService.create({
      type: 'insight' as const, // Store summaries as insights
      content: {
        summaries,
        originalIds: memoryIds,
        summarizedAt: new Date().toISOString(),
      },
      source: 'consolidation:summarize',
      confidence: 0.9,
      importance_score: 0.9, // Higher importance for summaries
      tags: [],
    });

    // Archive originals
    await this.memoryService.archiveMemories(memoryIds);

    await job.log(`Summarized ${memories.length} memories into ${summaryMemory.id}`);

    return {
      summaryId: summaryMemory.id,
      originalCount: memories.length,
      typesSummarized: Object.keys(grouped),
    };
  }

  private async clusterMemories(memoryIds: string[], job: Job): Promise<Record<string, unknown>> {
    await job.log('Starting DBSCAN clustering...');

    await job.updateProgress(20);

    // Use proper DBSCAN clustering
    const filters: Record<string, unknown> = {};
    const clusteringConfig = {
      epsilon: 0.3,
      minPoints: 3,
      minClusterSize: 2,
    };

    // If specific memory IDs provided, cluster just those
    // Otherwise cluster all memories with filters
    if (memoryIds.length > 0) {
      // Incremental clustering for specific memories
      await job.log(`Running incremental clustering for ${memoryIds.length} memories`);
      const stats = await this.clusteringService.clusterNewMemories(memoryIds, clusteringConfig);

      await job.updateProgress(70);

      await job.log(
        `Clustering complete: ${stats.clusterCount} clusters found, ` +
          `${stats.clusteredMemories} memories clustered, ` +
          `${stats.noiseMemories} noise points`
      );

      return {
        clusterCount: stats.clusterCount,
        clusteredMemories: stats.clusteredMemories,
        noiseMemories: stats.noiseMemories,
        silhouetteScore: stats.silhouetteScore,
        processingTimeMs: stats.processingTimeMs,
      };
    } else {
      // Full clustering of all memories
      await job.log('Running full DBSCAN clustering on all memories');
      const stats = await this.clusteringService.clusterMemories(filters, clusteringConfig);

      await job.updateProgress(70);

      // Merge similar clusters if needed
      const mergedCount = await this.clusteringService.mergeSimilarClusters(0.85);
      if (mergedCount > 0) {
        await job.log(`Merged ${mergedCount} similar clusters`);
      }

      // Split large incoherent clusters
      const splitCount = await this.clusteringService.splitLargeClusters(100, 0.4);
      if (splitCount > 0) {
        await job.log(`Split ${splitCount} large incoherent clusters`);
      }

      await job.updateProgress(90);

      await job.log(
        `Clustering complete: ${stats.clusterCount} clusters found, ` +
          `${stats.clusteredMemories} memories clustered, ` +
          `${stats.noiseMemories} noise points, ` +
          `silhouette score: ${stats.silhouetteScore.toFixed(3)}`
      );

      return {
        clusterCount: stats.clusterCount,
        clusteredMemories: stats.clusteredMemories,
        noiseMemories: stats.noiseMemories,
        silhouetteScore: stats.silhouetteScore,
        mergedClusters: mergedCount,
        splitClusters: splitCount,
        processingTimeMs: stats.processingTimeMs,
      };
    }
  }

  private async storeBatchResults(jobId: string, results: Record<string, unknown>): Promise<void> {
    if (!this.connection) return;

    const key = `batch-results:${jobId}`;
    await this.connection.setex(key, config.DEFAULT_CACHE_TTL, JSON.stringify(results));
  }

  private setupEventHandlers(): void {
    // Batch worker events
    this.batchWorker.on('completed', (job) => {
      console.log(`[BatchWorker] Batch job ${job.id} completed`);
    });

    this.batchWorker.on('failed', (job, error) => {
      console.error(`[BatchWorker] Batch job ${job?.id} failed:`, error.message);
    });

    // Consolidation worker events
    this.consolidationWorker.on('completed', (job) => {
      console.log(`[BatchWorker] Consolidation job ${job.id} completed`);
    });

    this.consolidationWorker.on('failed', (job, error) => {
      console.error(`[BatchWorker] Consolidation job ${job?.id} failed:`, error.message);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async pause(): Promise<void> {
    await Promise.all([this.batchWorker.pause(), this.consolidationWorker.pause()]);
    console.log('[BatchWorker] Workers paused');
  }

  async resume(): Promise<void> {
    await Promise.all([this.batchWorker.resume(), this.consolidationWorker.resume()]);
    console.log('[BatchWorker] Workers resumed');
  }

  async shutdown(): Promise<void> {
    console.log('[BatchWorker] Closing workers...');
    await Promise.all([this.batchWorker.close(), this.consolidationWorker.close()]);
    if (this.connection) {
      await this.connection.quit();
    }
    console.log('[BatchWorker] Workers closed');
  }
}

// Start worker if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  new BatchWorker();
  console.log('[BatchWorker] Workers started');
}
