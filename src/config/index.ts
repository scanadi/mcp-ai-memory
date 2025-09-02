import dotenv from 'dotenv';
import { z } from 'zod';

// Suppress dotenv debug output
const originalLog = console.log;
console.log = () => {};
dotenv.config();
console.log = originalLog;

const EnvSchema = z.object({
  MEMORY_DB_URL: z.string(),
  REDIS_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('Xenova/all-mpnet-base-v2'),
  MAX_EMBEDDING_CONCURRENCY: z.coerce.number().default(3),
  // Simplified cache TTL settings
  DEFAULT_CACHE_TTL: z.coerce.number().default(3600), // 1 hour for general cache
  LONG_CACHE_TTL: z.coerce.number().default(86400), // 24 hours for embeddings
  // Core settings - default to false for local-first operation
  ENABLE_CLUSTERING: z.coerce.boolean().default(false),
  CLUSTER_THRESHOLD: z.coerce.number().default(0.8),
  CONTEXT_WINDOW_SIZE: z.coerce.number().default(10),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  MAX_CONTENT_SIZE: z.coerce.number().default(1048576), // 1MB
  DEFAULT_SEARCH_LIMIT: z.coerce.number().default(20),
  DEFAULT_SIMILARITY_THRESHOLD: z.coerce.number().default(0.7),
  MAX_TAGS: z.coerce.number().default(20),
  MAX_TAG_LENGTH: z.coerce.number().default(50),
  // Async processing - default to false for local-first operation
  ENABLE_ASYNC_PROCESSING: z.coerce.boolean().default(false),
  WORKER_CONCURRENCY: z.coerce.number().default(3),
});

export const config = EnvSchema.parse(process.env);

export type Config = z.infer<typeof EnvSchema>;
