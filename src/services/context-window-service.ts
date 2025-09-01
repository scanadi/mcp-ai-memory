import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { MemoryScorer } from '../algorithms/scoring.js';
import type { Database, Memory } from '../types/database.js';
import { CompressionService } from './compression-service.js';

export interface WindowConfig {
  maxWindowSize: number; // Maximum number of memories in window
  maxTokens: number; // Maximum token count for window
  compressionThreshold: number; // When to start compressing (0.7 = 70% full)
  scoringInterval: number; // How often to re-score memories (ms)
  ageThresholds: number[]; // Age thresholds for hierarchical compression (hours)
  dynamicSizing: boolean; // Enable dynamic window sizing based on context
}

export interface WindowState {
  windowId: string;
  userId: string;
  activeMemories: string[]; // Memory IDs in the window
  compressedMemories: string[]; // Compressed memory IDs
  totalTokens: number;
  lastUpdated: Date;
  metadata: {
    compressionRatio: number;
    averageScore: number;
    oldestMemory: Date;
    newestMemory: Date;
  };
}

export interface WindowStats {
  windowSize: number;
  compressedCount: number;
  totalTokens: number;
  utilizationRatio: number; // Current tokens / max tokens
  compressionRatio: number;
  averageMemoryScore: number;
  memoriesExpelled: number;
  memoriesAdded: number;
}

export class ContextWindowService {
  private db: Kysely<Database>;
  private scorer: MemoryScorer;
  private compressor: CompressionService;
  private config: WindowConfig;
  private windowStates: Map<string, WindowState> = new Map();
  private scoringTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(db: Kysely<Database>, config?: Partial<WindowConfig>) {
    this.db = db;
    this.scorer = new MemoryScorer();
    this.compressor = new CompressionService(db);
    this.config = {
      maxWindowSize: config?.maxWindowSize ?? 10,
      maxTokens: config?.maxTokens ?? 4000,
      compressionThreshold: config?.compressionThreshold ?? 0.7,
      scoringInterval: config?.scoringInterval ?? 60000, // 1 minute
      ageThresholds: config?.ageThresholds ?? [24, 168, 720], // 1 day, 1 week, 1 month
      dynamicSizing: config?.dynamicSizing ?? true,
    };
  }

  /**
   * Initialize or get context window for a user
   */
  async initializeWindow(userId: string): Promise<WindowState> {
    // Check if window already exists
    let windowState = this.windowStates.get(userId);
    if (windowState) {
      return windowState;
    }

    // Create new window state
    windowState = {
      windowId: `window-${userId}-${Date.now()}`,
      userId,
      activeMemories: [],
      compressedMemories: [],
      totalTokens: 0,
      lastUpdated: new Date(),
      metadata: {
        compressionRatio: 0,
        averageScore: 0,
        oldestMemory: new Date(),
        newestMemory: new Date(),
      },
    };

    // Load recent memories to populate window
    const recentMemories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('user_context', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('accessed_at', 'desc')
      .limit(this.config.maxWindowSize)
      .execute();

    if (recentMemories.length > 0) {
      await this.populateWindow(windowState, recentMemories as unknown as Memory[]);
    }

    this.windowStates.set(userId, windowState);
    this.startScoringTimer(userId);

    return windowState;
  }

  /**
   * Add memory to context window
   */
  async addToWindow(userId: string, memoryId: string): Promise<WindowStats> {
    const windowState = await this.initializeWindow(userId);

    // Get the memory
    const memory = await this.db.selectFrom('memories').selectAll().where('id', '=', memoryId).executeTakeFirst();

    if (!memory) {
      throw new Error(`Memory ${memoryId} not found`);
    }

    // Calculate token count
    const tokens = this.estimateTokens(memory.content);

    // Check if compression is needed
    if (this.needsCompression(windowState, tokens)) {
      await this.compressOldMemories(windowState);
    }

    // Check if we need to evict memories
    if (windowState.activeMemories.length >= this.config.maxWindowSize) {
      await this.evictLowestScoring(windowState);
    }

    // Add new memory
    windowState.activeMemories.push(memoryId);
    windowState.totalTokens += tokens;
    windowState.lastUpdated = new Date();

    // Update access tracking
    await this.updateMemoryAccess(memoryId);

    // Update window metadata
    await this.updateWindowMetadata(windowState);

    return this.getWindowStats(windowState);
  }

  /**
   * Remove memory from window
   */
  async removeFromWindow(userId: string, memoryId: string): Promise<WindowStats> {
    const windowState = await this.initializeWindow(userId);

    // Remove from active memories
    const index = windowState.activeMemories.indexOf(memoryId);
    if (index > -1) {
      windowState.activeMemories.splice(index, 1);
    }

    // Remove from compressed if present
    const compressedIndex = windowState.compressedMemories.indexOf(memoryId);
    if (compressedIndex > -1) {
      windowState.compressedMemories.splice(compressedIndex, 1);
    }

    // Recalculate tokens
    await this.recalculateTokens(windowState);
    windowState.lastUpdated = new Date();

    return this.getWindowStats(windowState);
  }

  /**
   * Get current window contents
   */
  async getWindowContents(userId: string): Promise<Memory[]> {
    const windowState = await this.initializeWindow(userId);

    if (windowState.activeMemories.length === 0) {
      return [];
    }

    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', windowState.activeMemories)
      .execute();

    return memories as unknown as Memory[];
  }

  /**
   * Populate window with initial memories
   */
  private async populateWindow(windowState: WindowState, memories: Memory[]): Promise<void> {
    // Score and rank memories
    const scored = this.scorer.scoreAndRankMemories(
      memories.map((m) => ({
        id: m.id,
        createdAt: m.created_at,
        accessedAt: m.accessed_at,
        accessCount: m.access_count,
        importanceScore: m.importance_score,
      }))
    );

    // Add top scoring memories up to window size
    let totalTokens = 0;
    for (const score of scored) {
      const memory = memories.find((m) => m.id === score.memoryId);
      if (!memory) continue;

      const tokens = this.estimateTokens(memory.content);
      if (totalTokens + tokens > this.config.maxTokens) {
        break;
      }

      windowState.activeMemories.push(memory.id);
      totalTokens += tokens;

      if (windowState.activeMemories.length >= this.config.maxWindowSize) {
        break;
      }
    }

    windowState.totalTokens = totalTokens;
  }

  /**
   * Check if compression is needed
   */
  private needsCompression(windowState: WindowState, additionalTokens: number): boolean {
    const projectedTokens = windowState.totalTokens + additionalTokens;
    const utilizationRatio = projectedTokens / this.config.maxTokens;
    return utilizationRatio > this.config.compressionThreshold;
  }

  /**
   * Compress old memories in the window
   */
  private async compressOldMemories(windowState: WindowState): Promise<void> {
    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', windowState.activeMemories)
      .orderBy('accessed_at', 'asc')
      .limit(Math.floor(windowState.activeMemories.length / 3)) // Compress oldest third
      .execute();

    const compressed = await this.compressor.hierarchicalCompress(
      memories as unknown as Memory[],
      this.config.ageThresholds
    );

    // Update window state
    for (const comp of compressed) {
      if (!windowState.compressedMemories.includes(comp.originalId)) {
        windowState.compressedMemories.push(comp.originalId);
      }
    }

    // Recalculate tokens after compression
    await this.recalculateTokens(windowState);
  }

  /**
   * Evict lowest scoring memory
   */
  private async evictLowestScoring(windowState: WindowState): Promise<void> {
    if (windowState.activeMemories.length === 0) return;

    // Get all memories in window
    const memories = await this.db
      .selectFrom('memories')
      .select(['id', 'created_at', 'accessed_at', 'access_count', 'importance_score'])
      .where('id', 'in', windowState.activeMemories)
      .execute();

    // Score and find lowest
    const scored = this.scorer.scoreAndRankMemories(
      memories.map((m) => ({
        id: m.id,
        createdAt: m.created_at,
        accessedAt: m.accessed_at || undefined,
        accessCount: m.access_count,
        importanceScore: m.importance_score,
      }))
    );

    if (scored.length > 0) {
      const lowestScoring = scored[scored.length - 1];
      if (lowestScoring) {
        const index = windowState.activeMemories.indexOf(lowestScoring.memoryId);
        if (index > -1) {
          windowState.activeMemories.splice(index, 1);
        }
      }
    }
  }

  /**
   * Update memory access tracking
   */
  private async updateMemoryAccess(memoryId: string): Promise<void> {
    await this.db
      .updateTable('memories')
      .set({
        accessed_at: new Date(),
        access_count: sql`access_count + 1`,
      })
      .where('id', '=', memoryId)
      .execute();
  }

  /**
   * Recalculate total tokens in window
   */
  private async recalculateTokens(windowState: WindowState): Promise<void> {
    const memories = await this.db
      .selectFrom('memories')
      .select('content')
      .where('id', 'in', windowState.activeMemories)
      .execute();

    let totalTokens = 0;
    for (const memory of memories) {
      totalTokens += this.estimateTokens(memory.content);
    }

    windowState.totalTokens = totalTokens;
  }

  /**
   * Update window metadata
   */
  private async updateWindowMetadata(windowState: WindowState): Promise<void> {
    if (windowState.activeMemories.length === 0) return;

    const memories = await this.db
      .selectFrom('memories')
      .select(['created_at', 'importance_score'])
      .where('id', 'in', windowState.activeMemories)
      .execute();

    if (memories.length > 0) {
      const dates = memories.map((m) => m.created_at.getTime());
      const scores = memories.map((m) => m.importance_score);

      windowState.metadata = {
        compressionRatio: windowState.compressedMemories.length / Math.max(windowState.activeMemories.length, 1),
        averageScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        oldestMemory: new Date(Math.min(...dates)),
        newestMemory: new Date(Math.max(...dates)),
      };
    }
  }

  /**
   * Estimate token count for content
   */
  private estimateTokens(content: string | Record<string, unknown>): number {
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(contentStr.length / 4);
  }

  /**
   * Get window statistics
   */
  private getWindowStats(windowState: WindowState): WindowStats {
    return {
      windowSize: windowState.activeMemories.length,
      compressedCount: windowState.compressedMemories.length,
      totalTokens: windowState.totalTokens,
      utilizationRatio: windowState.totalTokens / this.config.maxTokens,
      compressionRatio: windowState.metadata.compressionRatio,
      averageMemoryScore: windowState.metadata.averageScore,
      memoriesExpelled: 0, // Would track this separately
      memoriesAdded: 0, // Would track this separately
    };
  }

  /**
   * Start periodic scoring timer
   */
  private startScoringTimer(userId: string): void {
    // Clear existing timer
    const existingTimer = this.scoringTimers.get(userId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Set new timer
    const timer = setInterval(async () => {
      await this.rescoreWindow(userId);
    }, this.config.scoringInterval);

    this.scoringTimers.set(userId, timer);
  }

  /**
   * Rescore all memories in window
   */
  private async rescoreWindow(userId: string): Promise<void> {
    const windowState = this.windowStates.get(userId);
    if (!windowState || windowState.activeMemories.length === 0) return;

    // Get current memories
    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', windowState.activeMemories)
      .execute();

    // Re-populate window with new scores
    windowState.activeMemories = [];
    windowState.compressedMemories = [];
    await this.populateWindow(windowState, memories as unknown as Memory[]);
    await this.updateWindowMetadata(windowState);
  }

  /**
   * Adapt window configuration based on context
   */
  async adaptWindow(
    userId: string,
    context: {
      taskType?: 'coding' | 'conversation' | 'analysis' | 'creative';
      priority?: 'recency' | 'importance' | 'relevance';
      tokenBudget?: number;
    }
  ): Promise<void> {
    await this.initializeWindow(userId);

    // Adapt scorer weights based on context
    if (context.priority) {
      this.scorer.adaptWeights({
        isRecent: context.priority === 'recency',
        isImportant: context.priority === 'importance',
        isRelevant: context.priority === 'relevance',
        isFrequent: false,
      });
    }

    // Adjust window size based on task type
    if (context.taskType) {
      switch (context.taskType) {
        case 'coding':
          this.config.maxWindowSize = 15; // More context for coding
          break;
        case 'conversation':
          this.config.maxWindowSize = 10; // Moderate context
          break;
        case 'analysis':
          this.config.maxWindowSize = 20; // Maximum context
          break;
        case 'creative':
          this.config.maxWindowSize = 8; // Less context, more creativity
          break;
      }
    }

    // Adjust token budget
    if (context.tokenBudget) {
      this.config.maxTokens = context.tokenBudget;
    }

    // Re-populate window with new configuration
    await this.rescoreWindow(userId);
  }

  /**
   * Export window state for persistence
   */
  exportWindowState(userId: string): WindowState | undefined {
    return this.windowStates.get(userId);
  }

  /**
   * Import window state from persistence
   */
  importWindowState(windowState: WindowState): void {
    this.windowStates.set(windowState.userId, windowState);
    this.startScoringTimer(windowState.userId);
  }

  /**
   * Clean up resources
   */
  shutdown(): void {
    // Clear all timers
    for (const timer of this.scoringTimers.values()) {
      clearInterval(timer);
    }
    this.scoringTimers.clear();
    this.windowStates.clear();
  }
}
