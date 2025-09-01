import { z } from 'zod';

const MAX_CONTENT_SIZE = 1048576; // 1MB
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_USER_CONTEXT_LENGTH = 100;

// Sanitization helpers
const sanitizeString = (str: string): string => {
  // Remove null bytes and control characters except newlines and tabs
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
};

const sanitizeTag = (tag: string): string => {
  // Allow only alphanumeric, spaces, hyphens, and underscores in tags
  return tag
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim()
    .substring(0, MAX_TAG_LENGTH);
};

// Base schemas for reusability
export const MemoryTypeSchema = z.enum([
  'fact',
  'conversation',
  'decision',
  'insight',
  'error',
  'context',
  'preference',
  'task',
]);

export const RelationTypeSchema = z.enum(['references', 'contradicts', 'supports', 'extends']);

// Input validation schemas
export const StoreMemorySchema = z.object({
  content: z.any().refine((data) => JSON.stringify(data).length <= MAX_CONTENT_SIZE, {
    message: `Content exceeds ${MAX_CONTENT_SIZE} bytes`,
  }),
  type: MemoryTypeSchema,
  tags: z
    .array(z.string().transform(sanitizeTag).pipe(z.string().min(1).max(MAX_TAG_LENGTH)))
    .max(MAX_TAGS)
    .optional()
    .default([]),
  source: z.string().min(1).max(200).transform(sanitizeString),
  confidence: z.number().min(0).max(1),
  parent_id: z.string().uuid().optional(),
  relation_type: RelationTypeSchema.optional(),
  importance_score: z.number().min(0).max(1).default(0.5),
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
  relate_to: z
    .array(
      z.object({
        memory_id: z.string().uuid(),
        relation_type: RelationTypeSchema,
        strength: z.number().min(0).max(1).default(0.5),
      })
    )
    .optional(),
});

export const SearchMemorySchema = z.object({
  query: z.string().min(1).max(1000).transform(sanitizeString),
  type: MemoryTypeSchema.optional(),
  tags: z.array(z.string().transform(sanitizeTag)).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  threshold: z.number().min(0).max(1).default(0.7),
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
  include_relations: z.boolean().default(false),
});

export const UpdateMemorySchema = z.object({
  id: z.string().uuid(),
  updates: z.object({
    tags: z
      .array(z.string().transform(sanitizeTag).pipe(z.string().min(1).max(MAX_TAG_LENGTH)))
      .max(MAX_TAGS)
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    importance_score: z.number().min(0).max(1).optional(),
    type: MemoryTypeSchema.optional(),
    source: z.string().min(1).max(200).transform(sanitizeString).optional(),
  }),
  preserve_timestamps: z.boolean().default(false),
});

export const DeleteMemorySchema = z
  .object({
    id: z.string().uuid().optional(),
    content_hash: z.string().optional(),
  })
  .refine((data) => data.id || data.content_hash, {
    message: 'Either id or content_hash must be provided',
  });

export const ListMemorySchema = z.object({
  type: MemoryTypeSchema.optional(),
  tags: z.array(z.string().transform(sanitizeTag)).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
});

export const BatchMemorySchema = z.object({
  memories: z.array(StoreMemorySchema).min(1).max(100),
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
});

export const GraphSearchSchema = SearchMemorySchema.extend({
  depth: z.number().int().min(1).max(3).default(1),
});

export const ConsolidateMemorySchema = z.object({
  threshold: z.number().min(0.5).max(0.95).default(0.8),
  min_cluster_size: z.number().int().min(2).default(3),
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
});

export const StatsSchema = z.object({
  user_context: z.string().max(MAX_USER_CONTEXT_LENGTH).transform(sanitizeString).optional(),
});

// Type inference
export type StoreMemoryInput = z.infer<typeof StoreMemorySchema>;
export type SearchMemoryInput = z.infer<typeof SearchMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof UpdateMemorySchema>;
export type DeleteMemoryInput = z.infer<typeof DeleteMemorySchema>;
export type ListMemoryInput = z.infer<typeof ListMemorySchema>;
export type BatchMemoryInput = z.infer<typeof BatchMemorySchema>;
export type GraphSearchInput = z.infer<typeof GraphSearchSchema>;
export type ConsolidateMemoryInput = z.infer<typeof ConsolidateMemorySchema>;
export type StatsInput = z.infer<typeof StatsSchema>;
