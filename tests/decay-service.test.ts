import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { createDatabase } from '../src/database/client.js';
import { DecayService } from '../src/services/decayService.js';
import type { Database, Memory } from '../src/types/database.js';

describe('DecayService', () => {
  let db: Kysely<Database>;
  let decayService: DecayService;
  let testMemoryId: string;

  beforeAll(async () => {
    db = createDatabase();
    decayService = new DecayService({}, db);
    
    // Create a test memory
    const result = await db
      .insertInto('memories')
      .values({
        user_context: 'test-user',
        content: JSON.stringify({ text: 'Test memory for decay' }),
        content_hash: 'test-hash-decay',
        type: 'fact',
        source: 'test',
        confidence: 0.9,
        importance_score: 0.7,
        decay_rate: 0.01,
        tags: ['test'],
        state: 'active',
        decay_score: 1.0,
        access_count: 0,
      })
      .returning('id')
      .executeTakeFirst();
    
    testMemoryId = result!.id;
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .deleteFrom('memories')
      .where('user_context', '=', 'test-user')
      .execute();
    
    await db.destroy();
  });

  test('calculateDecayScore should decrease over time', async () => {
    const memory = await db
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', testMemoryId)
      .executeTakeFirst();
    
    expect(memory).toBeDefined();
    
    const score = await decayService.calculateDecayScore(memory!);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    
    // Score should be less than 1 since some time has passed
    expect(score).toBeLessThan(1);
  });

  test('determineState should return correct state based on score', () => {
    expect(decayService.determineState(0.8)).toBe('active');
    expect(decayService.determineState(0.3)).toBe('dormant');
    expect(decayService.determineState(0.05)).toBe('archived');
    expect(decayService.determineState(0.005)).toBe('expired');
  });

  test('preserveMemory should reset decay score and add preservation tag', async () => {
    await decayService.preserveMemory(testMemoryId);
    
    const memory = await db
      .selectFrom('memories')
      .select(['decay_score', 'state', 'tags'])
      .where('id', '=', testMemoryId)
      .executeTakeFirst();
    
    expect(memory?.decay_score).toBe(1.0);
    expect(memory?.state).toBe('active');
    expect(memory?.tags).toContain('preserved');
  });

  test('preserveMemory with until date should set expiration', async () => {
    const futureDate = new Date(Date.now() + 86400000); // 24 hours from now
    await decayService.preserveMemory(testMemoryId, futureDate);
    
    const memory = await db
      .selectFrom('memories')
      .select('metadata')
      .where('id', '=', testMemoryId)
      .executeTakeFirst();
    
    expect(memory?.metadata).toBeDefined();
    if (memory?.metadata && typeof memory.metadata === 'object') {
      expect('preservedUntil' in memory.metadata).toBe(true);
    }
  });

  test('getDecayStatus should return status information', async () => {
    const status = await decayService.getDecayStatus(testMemoryId);
    
    expect(status).toBeDefined();
    expect(status?.state).toBeDefined();
    expect(status?.decayScore).toBeGreaterThanOrEqual(0);
    expect(status?.decayScore).toBeLessThanOrEqual(1);
    expect(status?.lastDecayUpdate).toBeInstanceOf(Date);
    expect(status?.predictedNextState).toBeDefined();
    expect(typeof status?.isPreserved).toBe('boolean');
  });

  test('processBatch should process memories in batch', async () => {
    // Create additional test memories
    await db
      .insertInto('memories')
      .values([
        {
          user_context: 'test-user',
          content: JSON.stringify({ text: 'Batch test 1' }),
          content_hash: 'batch-hash-1',
          type: 'fact',
          source: 'test',
          confidence: 0.8,
          importance_score: 0.5,
          tags: [],
          state: 'active',
          decay_score: 0.6,
          last_decay_update: new Date(Date.now() - 7200000), // 2 hours ago
        },
        {
          user_context: 'test-user',
          content: JSON.stringify({ text: 'Batch test 2' }),
          content_hash: 'batch-hash-2',
          type: 'fact',
          source: 'test',
          confidence: 0.7,
          importance_score: 0.4,
          tags: [],
          state: 'dormant',
          decay_score: 0.3,
          last_decay_update: new Date(Date.now() - 7200000), // 2 hours ago
        },
      ])
      .execute();
    
    const stats = await decayService.processBatch('test-user', 10);
    
    expect(stats.processed).toBeGreaterThanOrEqual(0);
    expect(stats.transitioned).toBeGreaterThanOrEqual(0);
    expect(stats.errors).toBe(0);
  });
});