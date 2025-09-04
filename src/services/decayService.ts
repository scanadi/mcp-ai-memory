import { type Kysely, sql } from 'kysely';
import { db } from '../database/index.js';
import type { Database, Memory } from '../types/database.js';
import { logger } from '../utils/logger.js';
import { compressionService } from './compression-service.js';

export interface DecayConfig {
  baseDecayRate: number;
  accessBoost: number;
  archivalThreshold: number;
  expirationThreshold: number;
  preservationTags: string[];
  relationshipBoost?: number;
}

const DEFAULT_CONFIG: DecayConfig = {
  baseDecayRate: 0.01,
  accessBoost: 0.1,
  archivalThreshold: 0.1,
  expirationThreshold: 0.01,
  preservationTags: ['permanent', 'important', 'bookmark', 'favorite', 'pinned', 'preserved'],
  relationshipBoost: 0.05,
};

export class DecayService {
  private config: DecayConfig;
  private db: Kysely<Database>;

  constructor(config: Partial<DecayConfig> = {}, database?: Kysely<Database>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = database || db;
  }

  async calculateDecayScore(memory: Memory): Promise<number> {
    const daysSinceAccess =
      (Date.now() - new Date(memory.accessed_at || memory.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const effectiveDecayRate = memory.decay_rate || this.config.baseDecayRate;

    // Base exponential decay
    let score = (memory.importance_score || 0.5) * Math.exp(-effectiveDecayRate * daysSinceAccess);

    // Boost by access frequency
    score += Math.log1p(memory.access_count || 0) * this.config.accessBoost;

    // Scale by confidence
    score *= memory.confidence;

    // Optional boost by relationship degree (connections)
    if (this.config.relationshipBoost) {
      const connections = await this.getConnectionCount(memory.id);
      score += Math.log1p(connections) * this.config.relationshipBoost;
    }

    // Check for preservation
    if (await this.isPreserved(memory)) {
      score = Math.max(score, 0.95); // Keep preserved memories near 1.0
    }

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  private async isPreserved(memory: Memory): Promise<boolean> {
    // Check for preservation tags
    const hasPreservationTag = (memory.tags || []).some((tag) =>
      this.config.preservationTags.includes(tag.toLowerCase())
    );

    if (hasPreservationTag) {
      // Check for expiration date in metadata
      if (memory.metadata && typeof memory.metadata === 'object' && 'preservedUntil' in memory.metadata) {
        const until = new Date(memory.metadata.preservedUntil as string);
        return until > new Date();
      }
      return true;
    }

    return false;
  }

  private async getConnectionCount(memoryId: string): Promise<number> {
    const result = await this.db
      .selectFrom('memory_relations')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .where((eb) => eb.or([eb('from_memory_id', '=', memoryId), eb('to_memory_id', '=', memoryId)]))
      .executeTakeFirst();

    return Number(result?.count || 0);
  }

  determineState(decayScore: number): 'active' | 'dormant' | 'archived' | 'expired' {
    if (decayScore >= 0.5) return 'active';
    if (decayScore >= this.config.archivalThreshold) return 'dormant';
    if (decayScore >= this.config.expirationThreshold) return 'archived';
    return 'expired';
  }

  async updateMemoryDecay(memoryId: string): Promise<void> {
    const memory = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', memoryId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!memory) return;

    const decayScore = await this.calculateDecayScore(memory);
    const newState = this.determineState(decayScore);

    // Update memory with new decay score and state
    await this.db
      .updateTable('memories')
      .set({
        decay_score: decayScore,
        state: newState,
        last_decay_update: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', memoryId)
      .execute();

    // Handle state transitions
    await this.handleStateTransition(memory, newState);
  }

  private async handleStateTransition(memory: Memory, newState: string): Promise<void> {
    const currentState = memory.state || 'active';
    if (currentState === newState) return;

    logger.info(`Memory ${memory.id} transitioning from ${currentState} to ${newState}`);

    // Log transition in metadata
    const metadata = memory.metadata || {};
    const transitions = (
      typeof metadata === 'object' && metadata && 'transitions' in metadata ? metadata.transitions : []
    ) as Array<{ from: string; to: string; timestamp: string }>;
    transitions.push({
      from: currentState,
      to: newState,
      timestamp: new Date().toISOString(),
    });

    await this.db
      .updateTable('memories')
      .set({
        metadata: sql`jsonb_set(COALESCE(metadata, '{}'), '{transitions}', ${JSON.stringify(transitions)}::jsonb)`,
      })
      .where('id', '=', memory.id)
      .execute();

    // Handle specific transitions
    if (newState === 'archived' && !memory.is_compressed) {
      // Trigger compression for archived memories
      await compressionService.compressMemory(memory);
    } else if (newState === 'expired') {
      // Soft delete expired memories
      await this.db
        .updateTable('memories')
        .set({
          deleted_at: new Date(),
        })
        .where('id', '=', memory.id)
        .execute();
    }
  }

  async processBatch(
    userContext: string,
    batchSize: number = 100,
    excludeStates: string[] = ['expired']
  ): Promise<{ processed: number; transitioned: number; errors: number }> {
    const stats = { processed: 0, transitioned: 0, errors: 0 };

    // Get memories that need decay update
    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('user_context', '=', userContext)
      .where('deleted_at', 'is', null)
      .$if(excludeStates.length > 0, (qb) =>
        qb.where('state', 'not in', excludeStates as ('active' | 'dormant' | 'archived' | 'expired')[])
      )
      .$if(true, (qb) => qb.whereRef('last_decay_update', '<', sql`CURRENT_TIMESTAMP - INTERVAL '1 hour'`))
      .orderBy('last_decay_update', 'asc')
      .limit(batchSize)
      .execute();

    for (const memory of memories) {
      try {
        const oldState = memory.state;
        await this.updateMemoryDecay(memory.id);

        // Check if state changed
        const updated = await this.db
          .selectFrom('memories')
          .select('state')
          .where('id', '=', memory.id)
          .executeTakeFirst();

        if (updated && updated.state !== oldState) {
          stats.transitioned++;
        }

        stats.processed++;
      } catch (error) {
        logger.error(`Error processing decay for memory ${memory.id}:`, error);
        stats.errors++;
      }
    }

    return stats;
  }

  async preserveMemory(memoryId: string, until?: Date): Promise<void> {
    const updates = {
      decay_score: 1.0,
      state: 'active',
      last_decay_update: new Date(),
      updated_at: new Date(),
    };

    // Add preservation tag if not present
    await this.db
      .updateTable('memories')
      .set({
        ...updates,
        tags: sql`array_append(tags, 'preserved')`,
      })
      .where('id', '=', memoryId)
      .$if(true, (qb) => qb.whereRef(sql`NOT ('preserved' = ANY(tags))`, 'is', sql`true`))
      .execute();

    // Set preservation expiration if provided
    if (until) {
      await this.db
        .updateTable('memories')
        .set({
          metadata: sql`jsonb_set(COALESCE(metadata, '{}'), '{preservedUntil}', ${JSON.stringify(until.toISOString())}::jsonb)`,
        })
        .where('id', '=', memoryId)
        .execute();
    }
  }

  async getDecayStatus(memoryId: string): Promise<{
    state: string;
    decayScore: number;
    lastDecayUpdate: Date;
    predictedNextState: string;
    isPreserved: boolean;
  } | null> {
    const memory = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', memoryId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!memory) return null;

    const currentScore = memory.decay_score || 1.0;
    const futureScore = await this.calculateDecayScore(memory);
    const predictedNextState = this.determineState(futureScore);
    const isPreserved = await this.isPreserved(memory);

    return {
      state: memory.state || 'active',
      decayScore: currentScore,
      lastDecayUpdate: memory.last_decay_update || new Date(),
      predictedNextState,
      isPreserved,
    };
  }

  /**
   * Permanently delete soft-deleted memories after retention period
   */
  async cleanupExpiredMemories(retentionDays = 30, batchSize = 100): Promise<{ deleted: number; errors: number }> {
    const stats = { deleted: 0, errors: 0 };
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    try {
      // First, get the IDs of memories to delete
      const expiredMemories = await this.db
        .selectFrom('memories')
        .select(['id'])
        .where('deleted_at', 'is not', null)
        .where('deleted_at', '<', cutoffDate)
        .where('state', '=', 'expired')
        .limit(batchSize)
        .execute();

      if (expiredMemories.length === 0) {
        return stats;
      }

      const memoryIds = expiredMemories.map((m) => m.id);

      // Delete related records first (due to foreign key constraints)
      await this.db
        .deleteFrom('memory_relations')
        .where((eb) => eb.or([eb('from_memory_id', 'in', memoryIds), eb('to_memory_id', 'in', memoryIds)]))
        .execute();

      // Delete the memories
      await this.db.deleteFrom('memories').where('id', 'in', memoryIds).execute();

      stats.deleted = memoryIds.length;

      logger.info(`Permanently deleted ${stats.deleted} expired memories`);
    } catch (error) {
      logger.error('Error cleaning up expired memories:', error);
      stats.errors++;
    }

    return stats;
  }

  /**
   * Schedule periodic cleanup of expired memories
   */
  async scheduleCleanup(intervalHours = 24): Promise<void> {
    // Run cleanup immediately
    await this.cleanupExpiredMemories();

    // Schedule periodic cleanup
    setInterval(
      async () => {
        try {
          const result = await this.cleanupExpiredMemories();
          logger.info(`Cleanup completed: ${result.deleted} deleted, ${result.errors} errors`);
        } catch (error) {
          logger.error('Scheduled cleanup failed:', error);
        }
      },
      intervalHours * 60 * 60 * 1000
    );
  }
}

export const decayService = new DecayService();
