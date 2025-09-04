import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { db } from '../database/index.js';
import { decayService } from '../services/decayService.js';
import { logger } from '../utils/logger.js';

export interface DecayJob {
  userContext: string;
  batchSize?: number;
  type: 'scheduled' | 'manual';
}

export class DecayWorker {
  private worker: Worker<DecayJob>;
  private queue: Queue<DecayJob>;
  private connection: Redis;

  constructor(connection?: Redis) {
    // Use provided connection or create new one
    this.connection =
      connection ||
      new Redis(config.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

    // Initialize queue for scheduling
    this.queue = new Queue<DecayJob>('memory-decay', {
      connection: this.connection,
    });

    // Initialize worker
    this.worker = new Worker<DecayJob>('memory-decay', this.processDecay.bind(this), {
      connection: this.connection,
      concurrency: config.DECAY_WORKER_CONCURRENCY || 2,
      limiter: {
        max: 5, // Max 5 jobs
        duration: 60000, // per minute
      },
      autorun: true,
    });

    this.setupEventHandlers();
    this.scheduleRecurringJobs();
  }

  private async processDecay(job: Job<DecayJob>): Promise<void> {
    const { userContext, batchSize = 100, type } = job.data;
    const startTime = Date.now();

    try {
      await job.log(`Starting decay processing for context ${userContext} (${type})`);
      await job.updateProgress(10);

      // Check if decay is enabled for this context
      if (await this.isDecayDisabled(userContext)) {
        await job.log('Decay is disabled for this context');
        return;
      }

      await job.updateProgress(20);

      // Process batch of memories
      const stats = await decayService.processBatch(userContext, batchSize);

      await job.updateProgress(80);

      // Log statistics
      await job.log(`Processed: ${stats.processed}, Transitioned: ${stats.transitioned}, Errors: ${stats.errors}`);

      // Update metrics
      await this.updateMetrics(stats, Date.now() - startTime);

      await job.updateProgress(100);

      const duration = Date.now() - startTime;
      await job.log(`Decay processing completed in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.updateMetrics({ processed: 0, transitioned: 0, errors: 1 }, duration);
      await job.log(`Error: ${(error as Error).message}`);
      throw error; // Let BullMQ handle retry
    }
  }

  private async isDecayDisabled(_userContext: string): Promise<boolean> {
    // Check if decay is disabled via feature flag or configuration
    const featureFlags = config.FEATURE_FLAGS || {};
    if (featureFlags.DECAY_DISABLED) {
      return true;
    }

    // Check user-specific settings (could be stored in database)
    // For now, return false to enable decay for all contexts
    return false;
  }

  private async scheduleRecurringJobs(): Promise<void> {
    try {
      // Get all unique user contexts
      const contexts = await db
        .selectFrom('memories')
        .select('user_context')
        .distinct()
        .where('deleted_at', 'is', null)
        .execute();

      for (const { user_context } of contexts) {
        // Schedule hourly decay processing for each context
        await this.queue.add(
          `decay-${user_context}`,
          { userContext: user_context, type: 'scheduled' as const },
          {
            repeat: {
              pattern: '0 * * * *', // Every hour at minute 0
            },
            removeOnComplete: {
              age: 86400, // Keep completed jobs for 24 hours
              count: 100, // Keep last 100 completed jobs
            },
            removeOnFail: {
              age: 604800, // Keep failed jobs for 7 days
            },
          }
        );

        logger.info(`Scheduled decay job for context: ${user_context}`);
      }
    } catch (error) {
      logger.error('Failed to schedule recurring decay jobs:', error);
    }
  }

  private setupEventHandlers(): void {
    this.worker.on('completed', (job) => {
      logger.info(`[DecayWorker] Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, error) => {
      logger.error(`[DecayWorker] Job ${job?.id} failed:`, error.message);
    });

    this.worker.on('active', (job) => {
      logger.info(`[DecayWorker] Job ${job.id} started`);
    });

    this.worker.on('stalled', (jobId) => {
      logger.warn(`[DecayWorker] Job ${jobId} stalled`);
    });

    this.worker.on('error', (error) => {
      logger.error('[DecayWorker] Worker error:', error);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  private async updateMetrics(
    stats: { processed: number; transitioned: number; errors: number },
    duration: number
  ): Promise<void> {
    if (!this.connection) return;

    const timestamp = Date.now();
    const metricsData = {
      ...stats,
      duration,
      timestamp,
    };

    // Store metrics in Redis with expiry
    await this.connection.setex(
      `metrics:decay:${timestamp}`,
      86400, // Expire after 24 hours
      JSON.stringify(metricsData)
    );

    // Update aggregated counters
    await this.connection.incrby('metrics:decay:total:processed', stats.processed);
    await this.connection.incrby('metrics:decay:total:transitioned', stats.transitioned);
    await this.connection.incrby('metrics:decay:total:errors', stats.errors);
  }

  async getMetrics(): Promise<{
    total: { processed: number; transitioned: number; errors: number };
    recent: Array<{ processed: number; transitioned: number; errors: number; duration: number; timestamp: number }>;
  }> {
    if (!this.connection) {
      return { total: { processed: 0, transitioned: 0, errors: 0 }, recent: [] };
    }

    const [processed, transitioned, errors] = await Promise.all([
      this.connection.get('metrics:decay:total:processed'),
      this.connection.get('metrics:decay:total:transitioned'),
      this.connection.get('metrics:decay:total:errors'),
    ]);

    // Get recent metrics (last 24 hours)
    const keys = await this.connection.keys('metrics:decay:*');
    const recentKeys = keys
      .filter((k) => k.match(/metrics:decay:\d+$/))
      .sort()
      .slice(-100); // Last 100 entries

    const recent = await Promise.all(
      recentKeys.map(async (key) => {
        const data = await this.connection.get(key);
        return data ? JSON.parse(data) : null;
      })
    );

    return {
      total: {
        processed: parseInt(processed || '0', 10),
        transitioned: parseInt(transitioned || '0', 10),
        errors: parseInt(errors || '0', 10),
      },
      recent: recent.filter(Boolean),
    };
  }

  async pause(): Promise<void> {
    await this.worker.pause();
    logger.info('[DecayWorker] Worker paused');
  }

  async resume(): Promise<void> {
    await this.worker.resume();
    logger.info('[DecayWorker] Worker resumed');
  }

  async triggerManualDecay(userContext: string, batchSize?: number): Promise<void> {
    await this.queue.add('manual-decay', {
      userContext,
      batchSize,
      type: 'manual' as const,
    });
    logger.info(`[DecayWorker] Manual decay triggered for context: ${userContext}`);
  }

  async getScheduledJobs(): Promise<unknown[]> {
    const repeatableJobs = await this.queue.getRepeatableJobs();
    return repeatableJobs;
  }

  async removeScheduledJob(jobKey: string): Promise<void> {
    await this.queue.removeRepeatableByKey(jobKey);
    logger.info(`[DecayWorker] Removed scheduled job: ${jobKey}`);
  }

  async shutdown(): Promise<void> {
    logger.info('[DecayWorker] Closing worker...');
    await this.worker.close();
    await this.queue.close();
    if (this.connection) {
      await this.connection.quit();
    }
    logger.info('[DecayWorker] Worker closed');
  }
}

// Start worker if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  new DecayWorker();
  logger.info('[DecayWorker] Worker started');
}
