import crypto from 'node:crypto';
import { pipeline } from '@xenova/transformers';
import { config } from '../config/index.js';
import { getCacheService } from './cache-service.js';

// Type for the Xenova transformer pipeline
type TransformerPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ data: Float32Array }>;

export class EmbeddingService {
  private model: TransformerPipeline | null = null;
  private modelLoading = false;
  private modelName: string;
  private cache = getCacheService();
  private embeddingDimension: number | null = null;
  private static EXPECTED_DIMENSION: number | null = null;

  constructor(modelName: string = config.EMBEDDING_MODEL) {
    this.modelName = modelName;
  }

  private async getModel(): Promise<TransformerPipeline> {
    if (this.model) return this.model;

    if (!this.modelLoading) {
      this.modelLoading = true;
      try {
        this.model = (await pipeline('feature-extraction', this.modelName)) as TransformerPipeline;

        // Validate embedding dimensions on first load
        if (!this.embeddingDimension) {
          await this.validateEmbeddingDimensions();
        }
      } catch (error) {
        this.modelLoading = false;
        throw new Error(`Failed to load embedding model: ${error}`);
      }
    }

    while (!this.model) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.model;
  }

  private async validateEmbeddingDimensions(): Promise<void> {
    if (!this.model) {
      throw new Error('Model not loaded');
    }

    // Generate a test embedding to check dimensions
    const testText = 'test';
    const result = await this.model(testText, { pooling: 'mean', normalize: true });
    const dimension = result.data.length;

    this.embeddingDimension = dimension;

    // If EXPECTED_DIMENSION is not set, this is the first run - set it based on the model
    if (EmbeddingService.EXPECTED_DIMENSION === null) {
      EmbeddingService.EXPECTED_DIMENSION = dimension;
      console.log(`Setting expected embedding dimension to: ${dimension}`);
    } else if (dimension !== EmbeddingService.EXPECTED_DIMENSION) {
      // Only throw error if dimensions don't match an already established expectation
      throw new Error(
        `Embedding dimension mismatch: Model produces ${dimension}-dimensional embeddings, ` +
          `but database expects ${EmbeddingService.EXPECTED_DIMENSION}. ` +
          `Please ensure consistent model usage across sessions.`
      );
    }

    console.log(`Embedding dimension validated: ${dimension} dimensions`);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cachedEmbedding = await this.cache.getCachedEmbedding(text);
    if (cachedEmbedding) {
      return cachedEmbedding;
    }

    try {
      const model = await this.getModel();
      const output = await model(text, {
        pooling: 'mean',
        normalize: true,
      });

      const embedding = Array.from(output.data as Float32Array);

      // Cache the generated embedding
      await this.cache.cacheEmbedding(text, embedding);

      return embedding;
    } catch (error) {
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    const uncachedTexts: { text: string; index: number }[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!text) continue;

      const cached = await this.cache.getCachedEmbedding(text);
      if (cached) {
        embeddings[i] = cached;
      } else {
        uncachedTexts.push({ text, index: i });
      }
    }

    // Generate embeddings for uncached texts
    for (const { text, index } of uncachedTexts) {
      const embedding = await this.generateEmbedding(text);
      embeddings[index] = embedding;
    }

    return embeddings;
  }

  generateContentHash(content: unknown): string {
    const contentString = typeof content === 'string' ? content : JSON.stringify(content);

    return crypto.createHash('sha256').update(contentString).digest('hex');
  }

  getEmbeddingDimension(): number | null {
    return this.embeddingDimension;
  }

  static getExpectedDimension(): number | null {
    return EmbeddingService.EXPECTED_DIMENSION;
  }

  static setExpectedDimension(dimension: number): void {
    EmbeddingService.EXPECTED_DIMENSION = dimension;
  }
}
