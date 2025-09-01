import crypto from 'node:crypto';
import Redis from 'ioredis';
import NodeCache from 'node-cache';
import { config } from '../config/index.js';

export class CacheService {
  private redis: Redis | null = null;
  private localCache: NodeCache;
  private isRedisAvailable = false;

  constructor() {
    // Local in-memory cache as fallback
    this.localCache = new NodeCache({
      stdTTL: config.DEFAULT_CACHE_TTL,
      checkperiod: 600,
      useClones: false,
    });

    this.initRedis();
  }

  private async initRedis() {
    if (!config.REDIS_URL) {
      console.log('Redis URL not configured, using local cache only');
      return;
    }

    try {
      this.redis = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            console.error('Redis connection failed, falling back to local cache');
            this.isRedisAvailable = false;
            return null;
          }
          return Math.min(times * 100, 3000);
        },
        lazyConnect: true,
      });

      await this.redis.connect();
      this.isRedisAvailable = true;
      console.log('Redis cache connected successfully');

      // Handle Redis errors gracefully
      this.redis.on('error', (err) => {
        console.error('Redis error:', err);
        this.isRedisAvailable = false;
      });

      this.redis.on('connect', () => {
        this.isRedisAvailable = true;
      });
    } catch (error) {
      console.error('Failed to initialize Redis:', error);
      this.isRedisAvailable = false;
    }
  }

  // Generate cache key with namespace
  private generateKey(namespace: string, identifier: string): string {
    return `mcp:${namespace}:${identifier}`;
  }

  // Generate hash for complex objects
  generateHash(data: unknown): string {
    const stringified = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(stringified).digest('hex').substring(0, 16);
  }

  // Get from cache (Redis first, then local)
  async get<T>(namespace: string, identifier: string): Promise<T | null> {
    const key = this.generateKey(namespace, identifier);

    // Try Redis first if available
    if (this.isRedisAvailable && this.redis) {
      try {
        const value = await this.redis.get(key);
        if (value) {
          return JSON.parse(value) as T;
        }
      } catch (error) {
        console.error('Redis get error:', error);
      }
    }

    // Fallback to local cache
    const localValue = this.localCache.get<T>(key);
    return localValue || null;
  }

  // Set in cache (both Redis and local)
  async set<T>(namespace: string, identifier: string, value: T, ttl?: number): Promise<void> {
    const key = this.generateKey(namespace, identifier);
    const serialized = JSON.stringify(value);
    const cacheTTL = ttl || config.DEFAULT_CACHE_TTL;

    // Set in local cache
    this.localCache.set(key, value, cacheTTL);

    // Set in Redis if available
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.setex(key, cacheTTL, serialized);
      } catch (error) {
        console.error('Redis set error:', error);
      }
    }
  }

  // Delete from cache
  async delete(namespace: string, identifier: string): Promise<void> {
    const key = this.generateKey(namespace, identifier);

    // Delete from local cache
    this.localCache.del(key);

    // Delete from Redis if available
    if (this.isRedisAvailable && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        console.error('Redis delete error:', error);
      }
    }
  }

  // Clear entire namespace
  async clearNamespace(namespace: string): Promise<void> {
    const pattern = this.generateKey(namespace, '*');

    // Clear from local cache
    const localKeys = this.localCache.keys().filter((key) => key.startsWith(`mcp:${namespace}:`));
    this.localCache.del(localKeys);

    // Clear from Redis if available
    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        console.error('Redis clear namespace error:', error);
      }
    }
  }

  // Cache embeddings specifically
  async cacheEmbedding(text: string, embedding: number[]): Promise<void> {
    const hash = this.generateHash(text);
    await this.set('embeddings', hash, embedding, config.LONG_CACHE_TTL);
  }

  async getCachedEmbedding(text: string): Promise<number[] | null> {
    const hash = this.generateHash(text);
    return await this.get<number[]>('embeddings', hash);
  }

  // Cache search results
  async cacheSearchResult(query: string, filters: Record<string, unknown>, results: unknown[]): Promise<void> {
    const cacheKey = this.generateHash({ query, filters });
    await this.set('search', cacheKey, results, config.DEFAULT_CACHE_TTL);
  }

  async getCachedSearchResult(query: string, filters: Record<string, unknown>): Promise<unknown[] | null> {
    const cacheKey = this.generateHash({ query, filters });
    return await this.get<unknown[]>('search', cacheKey);
  }

  // Cache memory by ID
  async cacheMemory(id: string, memory: unknown): Promise<void> {
    await this.set('memory', id, memory, config.DEFAULT_CACHE_TTL * 2);
  }

  async getCachedMemory(id: string): Promise<unknown | null> {
    return await this.get('memory', id);
  }

  // Invalidate memory cache
  async invalidateMemory(id: string): Promise<void> {
    await this.delete('memory', id);
    // Also clear any search results (they might contain this memory)
    await this.clearNamespace('search');
  }

  // Get cache statistics
  async getStats(): Promise<{
    redis: boolean;
    localKeys: number;
    localHits: number;
    localMisses: number;
    redisKeys?: number;
  }> {
    const stats: {
      redis: boolean;
      localKeys: number;
      localHits: number;
      localMisses: number;
      redisKeys?: number;
    } = {
      redis: this.isRedisAvailable,
      localKeys: this.localCache.keys().length,
      localHits: this.localCache.getStats().hits,
      localMisses: this.localCache.getStats().misses,
    };

    if (this.isRedisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys('mcp:*');
        stats.redisKeys = keys.length;
      } catch (error) {
        console.error('Error getting Redis stats:', error);
      }
    }

    return stats;
  }

  // Warm up cache with frequently accessed data
  async warmUp(): Promise<void> {
    console.log('Warming up cache...');
    // This would be implemented to pre-load frequently accessed memories
    // For now, it's a placeholder for future optimization
  }

  // Close connections
  async close(): Promise<void> {
    this.localCache.close();
    if (this.redis) {
      await this.redis.quit();
    }
  }
}

// Singleton instance
let cacheInstance: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!cacheInstance) {
    cacheInstance = new CacheService();
  }
  return cacheInstance;
}
