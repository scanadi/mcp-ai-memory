/**
 * Memory scoring algorithms for context window management
 * Determines which memories are most relevant to keep in the active window
 */

export interface ScoringConfig {
  recencyWeight: number; // Weight for how recent the memory is (0-1)
  importanceWeight: number; // Weight for memory importance score (0-1)
  accessWeight: number; // Weight for access frequency (0-1)
  relevanceWeight: number; // Weight for semantic relevance (0-1)
  decayRate: number; // Rate at which recency decays over time
}

export interface MemoryScore {
  memoryId: string;
  totalScore: number;
  recencyScore: number;
  importanceScore: number;
  accessScore: number;
  relevanceScore: number;
  metadata: {
    lastAccessed: Date;
    accessCount: number;
    age: number; // Age in hours
  };
}

export class MemoryScorer {
  private config: ScoringConfig;

  constructor(config?: Partial<ScoringConfig>) {
    this.config = {
      recencyWeight: config?.recencyWeight ?? 0.3,
      importanceWeight: config?.importanceWeight ?? 0.3,
      accessWeight: config?.accessWeight ?? 0.2,
      relevanceWeight: config?.relevanceWeight ?? 0.2,
      decayRate: config?.decayRate ?? 0.1,
    };

    // Normalize weights to sum to 1
    this.normalizeWeights();
  }

  private normalizeWeights(): void {
    const sum =
      this.config.recencyWeight + this.config.importanceWeight + this.config.accessWeight + this.config.relevanceWeight;

    if (sum > 0) {
      this.config.recencyWeight /= sum;
      this.config.importanceWeight /= sum;
      this.config.accessWeight /= sum;
      this.config.relevanceWeight /= sum;
    }
  }

  /**
   * Calculate recency score using exponential decay
   */
  calculateRecencyScore(createdAt: Date, accessedAt?: Date): number {
    const referenceTime = accessedAt || createdAt;
    const ageInHours = (Date.now() - referenceTime.getTime()) / (1000 * 60 * 60);

    // Exponential decay: score = e^(-decay * age)
    const score = Math.exp(-this.config.decayRate * ageInHours);
    return Math.max(0, Math.min(1, score)); // Clamp between 0 and 1
  }

  /**
   * Calculate access frequency score
   */
  calculateAccessScore(accessCount: number, totalMemories: number): number {
    if (totalMemories === 0) return 0;

    // Logarithmic scaling to prevent extreme values
    const normalizedCount = Math.log(accessCount + 1) / Math.log(totalMemories + 1);
    return Math.max(0, Math.min(1, normalizedCount));
  }

  /**
   * Calculate relevance score based on semantic similarity
   */
  calculateRelevanceScore(similarity: number): number {
    // Similarity is already between 0 and 1
    // Apply a slight curve to emphasize higher similarities
    return Math.max(0, similarity) ** 0.7;
  }

  /**
   * Calculate importance propagation through relationships
   */
  propagateImportance(baseImportance: number, relatedImportances: number[], relationStrengths: number[]): number {
    if (relatedImportances.length === 0) return baseImportance;

    // Weighted average of related importance scores
    let weightedSum = baseImportance;
    let totalWeight = 1;

    for (let i = 0; i < relatedImportances.length; i++) {
      const strength = relationStrengths[i] || 0;
      const importance = relatedImportances[i] || 0;
      weightedSum += strength * importance;
      totalWeight += strength;
    }

    return weightedSum / totalWeight;
  }

  /**
   * Score a single memory
   */
  scoreMemory(
    memory: {
      id: string;
      createdAt: Date;
      accessedAt?: Date;
      accessCount: number;
      importanceScore: number;
      similarity?: number;
    },
    totalMemories: number
  ): MemoryScore {
    const recencyScore = this.calculateRecencyScore(memory.createdAt, memory.accessedAt);
    const accessScore = this.calculateAccessScore(memory.accessCount, totalMemories);
    const relevanceScore = memory.similarity !== undefined ? this.calculateRelevanceScore(memory.similarity) : 0;
    const importanceScore = memory.importanceScore;

    const totalScore =
      this.config.recencyWeight * recencyScore +
      this.config.importanceWeight * importanceScore +
      this.config.accessWeight * accessScore +
      this.config.relevanceWeight * relevanceScore;

    const ageInHours = (Date.now() - memory.createdAt.getTime()) / (1000 * 60 * 60);

    return {
      memoryId: memory.id,
      totalScore,
      recencyScore,
      importanceScore,
      accessScore,
      relevanceScore,
      metadata: {
        lastAccessed: memory.accessedAt || memory.createdAt,
        accessCount: memory.accessCount,
        age: ageInHours,
      },
    };
  }

  /**
   * Score multiple memories and rank them
   */
  scoreAndRankMemories(
    memories: Array<{
      id: string;
      createdAt: Date;
      accessedAt?: Date;
      accessCount: number;
      importanceScore: number;
      similarity?: number;
    }>
  ): MemoryScore[] {
    const scores = memories.map((memory) => this.scoreMemory(memory, memories.length));

    // Sort by total score (descending)
    return scores.sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * Adaptive scoring based on context
   */
  adaptWeights(context: {
    isRecent?: boolean; // Prioritize recent memories
    isImportant?: boolean; // Prioritize important memories
    isFrequent?: boolean; // Prioritize frequently accessed
    isRelevant?: boolean; // Prioritize semantically relevant
  }): void {
    // Reset to defaults
    this.config = {
      recencyWeight: 0.3,
      importanceWeight: 0.3,
      accessWeight: 0.2,
      relevanceWeight: 0.2,
      decayRate: 0.1,
    };

    // Boost weights based on context
    if (context.isRecent) {
      this.config.recencyWeight *= 1.5;
      this.config.decayRate *= 0.5; // Slower decay
    }
    if (context.isImportant) {
      this.config.importanceWeight *= 1.5;
    }
    if (context.isFrequent) {
      this.config.accessWeight *= 1.5;
    }
    if (context.isRelevant) {
      this.config.relevanceWeight *= 1.5;
    }

    // Renormalize
    this.normalizeWeights();
  }

  /**
   * Calculate dynamic window size based on token count
   */
  calculateWindowSize(memories: Array<{ content: string | Record<string, unknown> }>, maxTokens: number): number {
    let totalTokens = 0;
    let count = 0;

    for (const memory of memories) {
      const contentStr = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);

      // Rough token estimation (4 chars ≈ 1 token)
      const estimatedTokens = Math.ceil(contentStr.length / 4);

      if (totalTokens + estimatedTokens > maxTokens) {
        break;
      }

      totalTokens += estimatedTokens;
      count++;
    }

    return count;
  }
}
