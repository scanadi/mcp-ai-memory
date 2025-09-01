import { type Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { sql } from 'kysely';
import { config } from '../config/index.js';
import { db } from '../database/index.js';
import { EmbeddingService } from '../services/embedding-service.js';
import type { EmbeddingJob } from '../services/queue-service.js';

export class EmbeddingWorker {
  private worker: Worker<EmbeddingJob>;
  private embeddingService: EmbeddingService;
  private connection: Redis | null = null;

  constructor(connection?: Redis) {
    this.embeddingService = new EmbeddingService();

    // Use provided connection or create new one
    this.connection =
      connection ||
      new Redis(config.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

    // Initialize worker
    if (!this.connection) {
      throw new Error('Redis connection is required for embedding worker');
    }
    this.worker = new Worker<EmbeddingJob>('embedding-generation', this.processEmbedding.bind(this), {
      connection: this.connection,
      concurrency: config.WORKER_CONCURRENCY || 3, // Process 3 jobs concurrently
      limiter: {
        max: 10, // Max 10 jobs
        duration: 1000, // per second
      },
      autorun: true,
    });

    this.setupEventHandlers();
  }

  private async processEmbedding(job: Job<EmbeddingJob>): Promise<void> {
    const { content, memoryId } = job.data;
    const startTime = Date.now();

    try {
      // Log job start
      await job.log(`Starting embedding generation for memory ${memoryId}`);
      await job.updateProgress(10);

      // Check if embedding already exists (idempotency)
      const existingMemory = await db
        .selectFrom('memories')
        .select(['id', 'embedding'])
        .where('id', '=', memoryId)
        .executeTakeFirst();

      if (existingMemory?.embedding) {
        await job.log('Embedding already exists, skipping generation');
        return;
      }

      await job.updateProgress(30);

      // Generate embedding
      await job.log('Generating embedding...');
      const embedding = await this.embeddingService.generateEmbedding(content);

      await job.updateProgress(70);

      // Store embedding in database
      await job.log('Storing embedding in database...');
      await db
        .updateTable('memories')
        .set({
          embedding: JSON.stringify(embedding),
          updated_at: new Date(),
        })
        .where('id', '=', memoryId)
        .execute();

      await job.updateProgress(90);

      // Cache the embedding if Redis is available
      if (this.connection && config.REDIS_URL) {
        const cacheKey = `embedding:${memoryId}`;
        await this.connection.setex(cacheKey, config.LONG_CACHE_TTL, JSON.stringify(embedding));
      }

      await job.updateProgress(100);

      const duration = Date.now() - startTime;
      await job.log(`Embedding generated successfully in ${duration}ms`);

      // Update metrics
      await this.updateMetrics('success', duration);
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.updateMetrics('failure', duration);

      // Log error details
      await job.log(`Error: ${(error as Error).message}`);

      // Check if this is a retryable error
      if (this.isRetryableError(error)) {
        throw error; // BullMQ will retry
      } else {
        // Non-retryable error, move to failed state
        await this.handleNonRetryableError(job, error);
        return; // Don't throw, job is considered "completed" but flagged
      }
    }
  }

  private setupEventHandlers(): void {
    this.worker.on('completed', (job) => {
      console.log(`[EmbeddingWorker] Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, error) => {
      console.error(`[EmbeddingWorker] Job ${job?.id} failed:`, error.message);
    });

    this.worker.on('active', (job) => {
      console.log(`[EmbeddingWorker] Job ${job.id} started`);
    });

    this.worker.on('stalled', (jobId) => {
      console.warn(`[EmbeddingWorker] Job ${jobId} stalled`);
    });

    this.worker.on('error', (error) => {
      console.error('[EmbeddingWorker] Worker error:', error);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  private isRetryableError(error: unknown): boolean {
    // Network errors, timeouts, rate limits are retryable
    const retryableMessages = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'rate limit',
      'too many requests',
      '429',
      '503',
      '504',
    ];

    const errorMessage = (error as Error).message?.toLowerCase() || '';
    return retryableMessages.some((msg) => errorMessage.includes(msg.toLowerCase()));
  }

  private async handleNonRetryableError(job: Job<EmbeddingJob>, error: unknown): Promise<void> {
    // Sanitize error message to prevent injection
    const rawMsg = String((error as Error).message || 'Unknown error').slice(0, 500);
    const sanitizedError = rawMsg
      .split('')
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 32 && code !== 127; // strip control chars
      })
      .join('')
      .replace(/'/g, "''"); // Escape single quotes for SQL safety
    // Create safe error data object
    const errorData = JSON.stringify({
      embeddingError: sanitizedError,
      timestamp: new Date().toISOString(),
    });

    // Validate JSON before using in query
    try {
      JSON.parse(errorData); // Validate JSON structure
    } catch {
      console.error('[EmbeddingWorker] Invalid error data JSON');
      return;
    }

    await db
      .updateTable('memories')
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${errorData}::jsonb`,
        updated_at: new Date(),
      })
      .where('id', '=', job.data.memoryId)
      .execute();

    // Log to dead letter queue tracking with sanitized output
    console.error(`[EmbeddingWorker] Non-retryable error for job ${job.id}:`, {
      memoryId: job.data.memoryId,
      error: sanitizedError,
      // Omit stack trace in production to prevent information disclosure
      ...(process.env.NODE_ENV === 'development' ? { stack: (error as Error).stack } : {}),
    });
  }

  private async updateMetrics(status: 'success' | 'failure', duration: number): Promise<void> {
    if (!this.connection) return;

    const metricsKey = `metrics:embedding:${status}`;
    const countKey = `${metricsKey}:count`;
    const durationKey = `${metricsKey}:duration`;

    await this.connection.incr(countKey);
    await this.connection.lpush(durationKey, duration);
    await this.connection.ltrim(durationKey, 0, 99); // Keep last 100 durations
  }

  async getMetrics() {
    if (!this.connection) {
      return { success: { count: 0, avgDuration: 0 }, failure: { count: 0, avgDuration: 0 }, successRate: 100 };
    }

    const [successCount, failureCount, successDurations, failureDurations] = await Promise.all([
      this.connection.get('metrics:embedding:success:count'),
      this.connection.get('metrics:embedding:failure:count'),
      this.connection.lrange('metrics:embedding:success:duration', 0, -1),
      this.connection.lrange('metrics:embedding:failure:duration', 0, -1),
    ]);

    const calculateAverage = (durations: string[]) => {
      if (!durations.length) return 0;
      const sum = durations.reduce((acc, d) => acc + parseInt(d, 10), 0);
      return Math.round(sum / durations.length);
    };

    return {
      success: {
        count: parseInt(successCount || '0', 10),
        avgDuration: calculateAverage(successDurations),
      },
      failure: {
        count: parseInt(failureCount || '0', 10),
        avgDuration: calculateAverage(failureDurations),
      },
      successRate:
        successCount && failureCount
          ? (parseInt(successCount, 10) / (parseInt(successCount, 10) + parseInt(failureCount, 10))) * 100
          : 100,
    };
  }

  async pause(): Promise<void> {
    await this.worker.pause();
    console.log('[EmbeddingWorker] Worker paused');
  }

  async resume(): Promise<void> {
    await this.worker.resume();
    console.log('[EmbeddingWorker] Worker resumed');
  }

  async shutdown(): Promise<void> {
    console.log('[EmbeddingWorker] Closing worker...');
    await this.worker.close();
    if (this.connection) {
      await this.connection.quit();
    }
    console.log('[EmbeddingWorker] Worker closed');
  }
}

// Start worker if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  new EmbeddingWorker();
  console.log('[EmbeddingWorker] Worker started');
}
