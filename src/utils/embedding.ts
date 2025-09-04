/**
 * Utility functions for handling pgvector embeddings
 */

/**
 * Parse a pgvector string representation to a number array
 * @param embeddingStr - String like "[1.2,3.4,5.6]" or null
 * @returns Parsed number array or null
 */
export function parseEmbedding(embeddingStr: string | null): number[] | null {
  if (!embeddingStr) return null;

  try {
    // Remove the brackets and split by comma
    const cleaned = embeddingStr.replace(/^\[/, '').replace(/\]$/, '');
    if (!cleaned) return null;

    const parts = cleaned.split(',');
    const result = parts.map((part) => parseFloat(part.trim()));

    // Check if all values are valid numbers
    if (result.some(Number.isNaN)) return null;

    return result;
  } catch {
    return null;
  }
}

/**
 * Format a number array to pgvector string representation
 * @param embedding - Array of numbers
 * @returns String like "[1.2,3.4,5.6]"
 */
export function formatEmbedding(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
