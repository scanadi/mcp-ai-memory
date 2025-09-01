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

  constructor(modelName: string = config.EMBEDDING_MODEL) {
    this.modelName = modelName;
  }

  private async getModel(): Promise<TransformerPipeline> {
    if (this.model) return this.model;

    if (!this.modelLoading) {
      this.modelLoading = true;
      try {
        this.model = (await pipeline('feature-extraction', this.modelName)) as TransformerPipeline;
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
}
