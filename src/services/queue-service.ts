import { type Job, Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';

// Job types
export interface EmbeddingJob {
  type: 'embedding';
  content: string;
  memoryId: string;
  priority?: number;
}

export interface BatchImportJob {
  type: 'batch-import';
  memories: Array<{
    type: string;
    content: any;
    source: string;
    confidence: number;
  }>;
  userId?: string;
}

export interface ConsolidationJob {
  type: 'consolidation';
  memoryIds: string[];
  strategy: 'merge' | 'summarize' | 'cluster';
}

export interface ClusteringJob {
  type: 'clustering';
  operation: 'full-clustering' | 'incremental' | 'merge-clusters' | 'split-clusters';
  filters?: any;
  memoryIds?: string[];
  config?: any;
}

export type JobData = EmbeddingJob | BatchImportJob | ConsolidationJob | ClusteringJob;

export class QueueService {
  public readonly connection: Redis;
  private embeddingQueue: Queue<EmbeddingJob>;
  private batchQueue: Queue<BatchImportJob>;
  private consolidationQueue: Queue<ConsolidationJob>;
  private clusteringQueue: Queue<ClusteringJob>;
  private events: QueueEvents;

  constructor() {
    // Create Redis connection
    this.connection = new Redis(config.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    // Initialize queues
    this.embeddingQueue = new Queue('embedding-generation', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: config.DEFAULT_CACHE_TTL,
          count: 100,
        },
        removeOnFail: {
          age: config.LONG_CACHE_TTL,
        },
      },
    });

    this.batchQueue = new Queue('batch-import', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'fixed',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * config.LONG_CACHE_TTL, // 7 days
        },
      },
    });

    this.consolidationQueue = new Queue('memory-consolidation', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: true,
      },
    });

    this.clusteringQueue = new Queue('clustering', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * config.LONG_CACHE_TTL, // 7 days
        },
      },
    });

    // Setup event monitoring
    this.events = new QueueEvents('embedding-generation', {
      connection: this.connection,
    });
  }

  // Add jobs to queues
  async addEmbeddingJob(data: Omit<EmbeddingJob, 'type'>): Promise<Job<EmbeddingJob>> {
    const job = await this.embeddingQueue.add(
      'generate-embedding',
      { ...data, type: 'embedding' },
      {
        priority: data.priority || 0,
        delay: 0,
      }
    );
    return job;
  }

  async addBatchImportJob(data: Omit<BatchImportJob, 'type'>): Promise<Job<BatchImportJob>> {
    const job = await this.batchQueue.add(
      'batch-import',
      { ...data, type: 'batch-import' },
      {
        priority: 1, // Higher priority for batch operations
      }
    );
    return job;
  }

  async addConsolidationJob(data: Omit<ConsolidationJob, 'type'>): Promise<Job<ConsolidationJob>> {
    const job = await this.consolidationQueue.add(
      'consolidate-memories',
      { ...data, type: 'consolidation' },
      {
        delay: 5000, // Delay consolidation to avoid conflicts
      }
    );
    return job;
  }

  async addClusteringJob(data: Omit<ClusteringJob, 'type'>): Promise<Job<ClusteringJob>> {
    const job = await this.clusteringQueue.add(
      'cluster-memories',
      { ...data, type: 'clustering' },
      {
        priority: data.operation === 'incremental' ? 1 : 0, // Higher priority for incremental
      }
    );
    return job;
  }

  // Get queue statistics
  async getQueueStats() {
    const [embeddingStats, batchStats, consolidationStats, clusteringStats] = await Promise.all([
      this.getQueueInfo(this.embeddingQueue),
      this.getQueueInfo(this.batchQueue),
      this.getQueueInfo(this.consolidationQueue),
      this.getQueueInfo(this.clusteringQueue),
    ]);

    return {
      embedding: embeddingStats,
      batch: batchStats,
      consolidation: consolidationStats,
      clustering: clusteringStats,
      timestamp: new Date().toISOString(),
    };
  }

  private async getQueueInfo(queue: Queue) {
    const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.isPaused(),
    ]);

    return {
      name: queue.name,
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused ? 1 : 0, // Convert boolean to count (0 or 1)
      total: waiting + active + delayed,
    };
  }

  // Move failed jobs to dead letter queue
  async moveToDeadLetter(job: Job, error: Error): Promise<void> {
    const deadLetterData = {
      originalQueue: job.queueName,
      jobId: job.id,
      jobData: job.data,
      error: error.message,
      stackTrace: error.stack,
      attempts: job.attemptsMade,
      timestamp: new Date().toISOString(),
    };

    // Store in a special dead letter collection or table
    console.error('Dead letter job:', deadLetterData);

    // In production, you'd store this in a database
    // await db.insertInto('dead_letter_queue').values(deadLetterData).execute();
  }

  // Pause/resume queues
  async pauseQueue(queueName: 'embedding' | 'batch' | 'consolidation' | 'clustering'): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.pause();
  }

  async resumeQueue(queueName: 'embedding' | 'batch' | 'consolidation' | 'clustering'): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.resume();
  }

  private getQueue(name: string): Queue {
    switch (name) {
      case 'embedding':
        return this.embeddingQueue;
      case 'batch':
        return this.batchQueue;
      case 'consolidation':
        return this.consolidationQueue;
      case 'clustering':
        return this.clusteringQueue;
      default:
        throw new Error(`Unknown queue: ${name}`);
    }
  }

  // Clean up old jobs
  async cleanOldJobs(): Promise<void> {
    const grace = 1000; // Grace period
    const limit = 100; // Jobs to remove per call

    await Promise.all([
      this.embeddingQueue.clean(grace, limit, 'completed'),
      this.embeddingQueue.clean(grace, limit, 'failed'),
      this.batchQueue.clean(grace, limit, 'completed'),
      this.consolidationQueue.clean(grace, limit, 'completed'),
      this.clusteringQueue.clean(grace, limit, 'completed'),
    ]);
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    await Promise.all([
      this.embeddingQueue.close(),
      this.batchQueue.close(),
      this.consolidationQueue.close(),
      this.clusteringQueue.close(),
      this.events.close(),
    ]);

    await this.connection.quit();
  }

  // Get job by ID
  async getJob(queueName: string, jobId: string): Promise<Job | undefined> {
    const queue = this.getQueue(queueName);
    return await queue.getJob(jobId);
  }

  // Retry failed jobs
  async retryFailedJobs(queueName: string, limit = 10): Promise<number> {
    const queue = this.getQueue(queueName);
    const failedJobs = await queue.getFailed(0, limit);

    let retried = 0;
    for (const job of failedJobs) {
      await job.retry();
      retried++;
    }

    return retried;
  }
}

// Export singleton instance
export const queueService = new QueueService();
