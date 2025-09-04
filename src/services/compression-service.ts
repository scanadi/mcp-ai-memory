import type { Kysely } from 'kysely';
import { db } from '../database/index.js';
import type { Database, Memory } from '../types/database.js';
import type { JsonValue } from '../types/database-generated.js';

export interface CompressionConfig {
  compressionRatio: number; // Target compression ratio (e.g., 0.3 = 30% of original)
  minLength: number; // Minimum content length to compress
  preserveMetadata: boolean; // Whether to preserve metadata in compressed form
  hierarchicalLevels: number; // Number of compression levels (day, week, month)
}

export interface CompressedMemory {
  originalId: string;
  originalContent: JsonValue;
  compressedContent: string;
  compressionLevel: number;
  compressionRatio: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  memoriesCompressed: number;
  compressionTime: number;
}

export class CompressionService {
  private db: Kysely<Database>;
  private config: CompressionConfig;

  constructor(db: Kysely<Database>, config?: Partial<CompressionConfig>) {
    this.db = db;
    this.config = {
      compressionRatio: config?.compressionRatio ?? 0.3,
      minLength: config?.minLength ?? 100,
      preserveMetadata: config?.preserveMetadata ?? true,
      hierarchicalLevels: config?.hierarchicalLevels ?? 3,
    };
  }

  /**
   * Compress a memory's content
   */
  async compressMemory(memory: Memory): Promise<CompressedMemory> {
    const contentStr = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);

    // Skip compression for short content
    if (contentStr.length < this.config.minLength) {
      return {
        originalId: memory.id,
        originalContent: memory.content,
        compressedContent: contentStr,
        compressionLevel: 0,
        compressionRatio: 1.0,
        timestamp: new Date(),
        metadata:
          typeof memory.metadata === 'object' && memory.metadata !== null && !Array.isArray(memory.metadata)
            ? (memory.metadata as Record<string, unknown>)
            : undefined,
      };
    }

    // Perform compression based on type
    const compressed = await this.performCompression(contentStr, memory.type);

    return {
      originalId: memory.id,
      originalContent: memory.content,
      compressedContent: compressed,
      compressionLevel: 1,
      compressionRatio: compressed.length / contentStr.length,
      timestamp: new Date(),
      metadata:
        this.config.preserveMetadata &&
        typeof memory.metadata === 'object' &&
        memory.metadata !== null &&
        !Array.isArray(memory.metadata)
          ? (memory.metadata as Record<string, unknown>)
          : undefined,
    };
  }

  /**
   * Perform actual compression based on content type
   */
  private async performCompression(content: string, type: string): Promise<string> {
    // Different compression strategies based on type
    switch (type as string) {
      case 'code':
        return this.compressCode(content);
      case 'conversation':
        return this.compressConversation(content);
      case 'document':
        return this.compressDocument(content);
      default:
        return this.compressGeneric(content);
    }
  }

  /**
   * Compress code by removing comments and whitespace
   */
  private compressCode(code: string): string {
    // Remove comments (simple approach)
    let compressed = code
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
      .replace(/\/\/.*$/gm, '') // Remove line comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();

    // Further compress if needed
    if (compressed.length > code.length * this.config.compressionRatio) {
      // Extract key identifiers and structure
      const functions = code.match(/function\s+\w+|const\s+\w+|class\s+\w+/g) || [];
      const imports = code.match(/import\s+.*?from\s+['"].*?['"]/g) || [];

      compressed = [
        '// Code summary',
        ...imports.slice(0, 5),
        '// Functions/Classes:',
        ...functions.slice(0, 10),
        `// ... ${functions.length} total definitions`,
      ].join('\n');
    }

    return compressed;
  }

  /**
   * Compress conversation by extracting key points
   */
  private compressConversation(conversation: string): string {
    const lines = conversation.split('\n');
    const keyLines: string[] = [];

    // Extract questions and key statements
    for (const line of lines) {
      if (
        line.includes('?') || // Questions
        line.match(/^(user|assistant|system):/i) || // Role indicators
        line.match(/\b(important|critical|must|should|need)\b/i) // Key words
      ) {
        keyLines.push(line.trim());
      }
    }

    // If still too long, take first and last portions
    const targetLength = Math.floor(conversation.length * this.config.compressionRatio);
    if (keyLines.join('\n').length > targetLength) {
      const halfTarget = Math.floor(targetLength / 2);
      const start = keyLines
        .slice(0, Math.ceil(keyLines.length / 3))
        .join('\n')
        .substring(0, halfTarget);
      const end = keyLines
        .slice(-Math.ceil(keyLines.length / 3))
        .join('\n')
        .substring(0, halfTarget);
      return `${start}\n[...compressed...]\n${end}`;
    }

    return keyLines.join('\n');
  }

  /**
   * Compress document by extracting summary
   */
  private compressDocument(document: string): string {
    // Extract first paragraph, headers, and key sentences
    const paragraphs = document.split(/\n\n+/);
    const headers = document.match(/^#+\s+.+$/gm) || [];
    const keyWords = ['summary', 'conclusion', 'important', 'key', 'main'];

    const compressed = [
      paragraphs[0]?.substring(0, 200) || '', // First paragraph
      ...headers.slice(0, 5), // Main headers
    ];

    // Add key sentences
    for (const paragraph of paragraphs) {
      if (keyWords.some((word) => paragraph.toLowerCase().includes(word))) {
        compressed.push(`${paragraph.substring(0, 100)}...`);
      }
    }

    const result = compressed.filter(Boolean).join('\n');
    const targetLength = Math.floor(document.length * this.config.compressionRatio);

    return result.substring(0, targetLength);
  }

  /**
   * Generic compression using text summarization
   */
  private compressGeneric(text: string): string {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const targetSentences = Math.max(1, Math.floor(sentences.length * this.config.compressionRatio));

    // Simple extraction: take first, middle, and last sentences
    if (sentences.length <= 3) {
      return sentences.join(' ');
    }

    const result: string[] = [];
    const step = Math.floor(sentences.length / targetSentences);

    for (let i = 0; i < sentences.length; i += step) {
      const sentence = sentences[i]?.trim();
      if (sentence) {
        result.push(sentence);
      }
      if (result.length >= targetSentences) break;
    }

    return result.join(' ');
  }

  /**
   * Hierarchical compression for older memories
   */
  async hierarchicalCompress(memories: Memory[], ageThresholds: number[]): Promise<CompressedMemory[]> {
    const compressed: CompressedMemory[] = [];
    const now = Date.now();

    for (const memory of memories) {
      const ageHours = (now - memory.created_at.getTime()) / (1000 * 60 * 60);
      let compressionLevel = 0;

      // Determine compression level based on age
      for (let i = 0; i < ageThresholds.length; i++) {
        const threshold = ageThresholds[i];
        if (threshold !== undefined && ageHours > threshold) {
          compressionLevel = i + 1;
        }
      }

      if (compressionLevel > 0) {
        // Apply increasingly aggressive compression
        const originalConfig = this.config.compressionRatio;
        this.config.compressionRatio = originalConfig * 0.7 ** compressionLevel;

        const compressedMemory = await this.compressMemory(memory);
        compressedMemory.compressionLevel = compressionLevel;

        this.config.compressionRatio = originalConfig;
        compressed.push(compressedMemory);
      }
    }

    return compressed;
  }

  /**
   * Batch compress memories
   */
  async batchCompress(memoryIds: string[]): Promise<CompressionStats> {
    const startTime = Date.now();

    const memories = await this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', 'in', memoryIds)
      .where('deleted_at', 'is', null)
      .execute();

    let originalSize = 0;
    let compressedSize = 0;
    const compressed: CompressedMemory[] = [];

    for (const memory of memories) {
      const contentStr = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);

      originalSize += contentStr.length;

      const compressedMemory = await this.compressMemory(memory);
      compressedSize += compressedMemory.compressedContent.length;
      compressed.push(compressedMemory);
    }

    // Store compressed versions
    await this.storeCompressed(compressed);

    return {
      originalSize,
      compressedSize,
      compressionRatio: compressedSize / Math.max(originalSize, 1),
      memoriesCompressed: compressed.length,
      compressionTime: Date.now() - startTime,
    };
  }

  /**
   * Decompress a single memory
   */
  async decompressMemory(memory: Memory): Promise<{ decompressedContent: string }> {
    if (!memory.is_compressed) {
      const content = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);
      return { decompressedContent: content };
    }

    // For now, return the content as-is since we're storing JSON
    // In a real implementation, you'd apply the reverse of compression algorithms
    const content = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);

    // If metadata indicates compression, we'd decompress here
    // For now, the compression is mainly summarization, so we return the compressed version
    // which is already human-readable
    return { decompressedContent: content };
  }

  /**
   * Store compressed memories
   */
  private async storeCompressed(compressed: CompressedMemory[]): Promise<void> {
    for (const comp of compressed) {
      // Update memory with compressed content
      await this.db
        .updateTable('memories')
        .set({
          content: comp.compressedContent,
          metadata: JSON.parse(
            JSON.stringify({
              ...comp.metadata,
              compressed: true,
              compressionLevel: comp.compressionLevel,
              compressionRatio: comp.compressionRatio,
              originalSize: JSON.stringify(comp.originalContent).length,
            })
          ) as JsonValue,
          updated_at: new Date(),
        })
        .where('id', '=', comp.originalId)
        .execute();
    }
  }

  /**
   * Restore compressed memory to original
   */
  async restoreMemory(memoryId: string): Promise<boolean> {
    // In a real implementation, you'd store the original content
    // For now, we'll mark it as needing restoration
    await this.db
      .updateTable('memories')
      .set({
        metadata: JSON.parse(
          JSON.stringify({
            compressed: false,
            needsRestoration: true,
          })
        ) as JsonValue,
        updated_at: new Date(),
      })
      .where('id', '=', memoryId)
      .execute();

    return true;
  }

  /**
   * Calculate compression quality metrics
   */
  calculateQualityMetrics(
    original: string,
    compressed: string
  ): {
    informationRetention: number;
    readability: number;
    keywordPreservation: number;
  } {
    // Extract keywords (simple approach)
    const getKeywords = (text: string) => {
      const words = text.toLowerCase().match(/\b\w{4,}\b/g) || [];
      return new Set(words);
    };

    const originalKeywords = getKeywords(original);
    const compressedKeywords = getKeywords(compressed);

    // Calculate metrics
    const keywordPreservation = compressedKeywords.size / Math.max(originalKeywords.size, 1);
    const informationRetention = compressed.length / original.length;

    // Simple readability based on sentence structure preservation
    const originalSentences = (original.match(/[.!?]+/g) || []).length;
    const compressedSentences = (compressed.match(/[.!?]+/g) || []).length;
    const readability = compressedSentences / Math.max(originalSentences, 1);

    return {
      informationRetention: Math.min(1, informationRetention),
      readability: Math.min(1, readability),
      keywordPreservation: Math.min(1, keywordPreservation),
    };
  }
}

export const compressionService = new CompressionService(db);
