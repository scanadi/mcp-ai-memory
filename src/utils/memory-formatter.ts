/**
 * Format memory data for AI agent consumption
 * Only returns the essential fields that are useful for AI context
 */

import type { Memory } from '../types/database.js';

export interface FormattedMemory {
  id: string;
  content: unknown;
  type: string;
  tags?: string[] | null;
  source: string;
  confidence: number;
  created_at?: Date;
  similarity_score?: number;
}

/**
 * Transform a memory object to only include useful fields for AI agents
 */
export function formatMemoryForAI(memory: Memory & { similarity_score?: number }): FormattedMemory {
  // Parse content if it's a JSON string
  let parsedContent: unknown;
  try {
    parsedContent = typeof memory.content === 'string' ? JSON.parse(memory.content as string) : memory.content;
  } catch {
    parsedContent = memory.content;
  }

  // Extract only the most relevant content
  const formattedContent = extractRelevantContent(parsedContent);

  return {
    id: memory.id,
    content: formattedContent,
    type: memory.type,
    tags: memory.tags,
    source: memory.source,
    confidence: memory.confidence,
    ...(memory.created_at && { created_at: memory.created_at }),
    ...(memory.similarity_score !== undefined && { similarity_score: memory.similarity_score }),
  };
}

/**
 * Extract only the relevant parts of content for AI consumption
 */
function extractRelevantContent(content: unknown): unknown {
  if (!content || typeof content !== 'object') {
    return content;
  }

  // If it's an array, process each item
  if (Array.isArray(content)) {
    return content.map((item) => extractRelevantContent(item));
  }

  // For objects, extract meaningful fields
  const obj = content as Record<string, unknown>;
  const relevantKeys = [
    'title',
    'name',
    'description',
    'summary',
    'text',
    'message',
    'content',
    'value',
    'result',
    'error',
    'status',
    'type',
    'pattern',
    'implementation',
    'solution',
    'problem',
    'context',
    'code',
    'query',
    'answer',
    'insight',
    'decision',
    'preference',
    'task',
    'action',
    'outcome',
    'learning',
    'observation',
  ];

  const result: Record<string, unknown> = {};

  // First add priority keys if they exist
  for (const key of relevantKeys) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) {
      result[key] = extractRelevantContent(obj[key]);
    }
  }

  // If we didn't find any relevant keys, include all non-metadata fields
  if (Object.keys(result).length === 0) {
    const metadataKeys = ['id', 'uuid', 'created_at', 'updated_at', '_id', 'timestamp', 'version'];
    for (const [key, value] of Object.entries(obj)) {
      if (!metadataKeys.includes(key) && value !== null && value !== undefined) {
        result[key] = extractRelevantContent(value);
      }
    }
  }

  return Object.keys(result).length > 0 ? result : content;
}

/**
 * Format multiple memories for AI consumption
 */
export function formatMemoriesForAI(memories: (Memory & { similarity_score?: number })[]): FormattedMemory[] {
  return memories.map(formatMemoryForAI);
}
