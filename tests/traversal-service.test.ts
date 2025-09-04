import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { createTestDatabase } from './test-setup.js';
import { TraversalService } from '../src/services/traversalService.js';
import type { Database } from '../src/types/database.js';

describe('TraversalService', () => {
  let db: Kysely<Database>;
  let traversalService: TraversalService;
  let memoryIds: string[] = [];

  beforeAll(async () => {
    db = createTestDatabase();
    traversalService = new TraversalService(db);
    
    // Create a graph of test memories
    const memories = await db
      .insertInto('memories')
      .values([
        {
          user_context: 'test-traversal',
          content: JSON.stringify({ text: 'Root memory' }),
          content_hash: 'root-hash',
          type: 'fact',
          source: 'test',
          confidence: 0.9,
          importance_score: 0.8,
          tags: ['root', 'test'],
        },
        {
          user_context: 'test-traversal',
          content: JSON.stringify({ text: 'Child memory 1' }),
          content_hash: 'child1-hash',
          type: 'fact',
          source: 'test',
          confidence: 0.9,
          importance_score: 0.7,
          tags: ['child', 'test'],
        },
        {
          user_context: 'test-traversal',
          content: JSON.stringify({ text: 'Child memory 2' }),
          content_hash: 'child2-hash',
          type: 'decision',
          source: 'test',
          confidence: 0.8,
          importance_score: 0.6,
          tags: ['child'],
        },
        {
          user_context: 'test-traversal',
          content: JSON.stringify({ text: 'Grandchild memory' }),
          content_hash: 'grandchild-hash',
          type: 'fact',
          source: 'test',
          confidence: 0.7,
          importance_score: 0.5,
          tags: ['grandchild'],
        },
      ])
      .returning('id')
      .execute();
    
    memoryIds = memories.map(m => m.id);
    
    // Create relationships
    await db
      .insertInto('memory_relations')
      .values([
        {
          from_memory_id: memoryIds[0],
          to_memory_id: memoryIds[1],
          relation_type: 'references',
          strength: 0.9,
        },
        {
          from_memory_id: memoryIds[0],
          to_memory_id: memoryIds[2],
          relation_type: 'extends',
          strength: 0.8,
        },
        {
          from_memory_id: memoryIds[1],
          to_memory_id: memoryIds[3],
          relation_type: 'supports',
          strength: 0.7,
        },
      ])
      .execute();
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .deleteFrom('memory_relations')
      .where('from_memory_id', 'in', memoryIds)
      .execute();
    
    await db
      .deleteFrom('memories')
      .where('user_context', '=', 'test-traversal')
      .execute();
    
    await db.destroy();
  });

  test('traverse with BFS should return nodes in breadth-first order', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
      maxNodes: 10,
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].memory.id).toBe(memoryIds[0]);
    expect(result[0].depth).toBe(0);
    
    // Check that children come before grandchildren (BFS)
    const depths = result.map(r => r.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }
  });

  test('traverse with DFS should explore depth first', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'dfs',
      maxDepth: 2,
      maxNodes: 10,
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].memory.id).toBe(memoryIds[0]);
  });

  test('traverse with relation type filter should only follow specific relations', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
      relationTypes: ['references'],
    });
    
    // Should only traverse through 'references' relationships
    const connectedIds = result.map(r => r.memory.id);
    expect(connectedIds).toContain(memoryIds[0]); // Root
    expect(connectedIds).toContain(memoryIds[1]); // Connected via 'references'
  });

  test('traverse with memory type filter should only include specific types', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
      memoryTypes: ['fact'],
    });
    
    // Should only include memories of type 'fact'
    result.forEach(node => {
      expect(node.memory.type).toBe('fact');
    });
  });

  test('traverse with tag filter should only include memories with specific tags', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
      tags: ['test'],
    });
    
    // Should only include memories with 'test' tag
    result.forEach(node => {
      expect(node.memory.tags).toContain('test');
    });
  });

  test('traverse with max depth should limit traversal depth', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 1,
    });
    
    // Should not include grandchild (depth 2)
    const depths = result.map(r => r.depth);
    depths.forEach(depth => {
      expect(depth).toBeLessThanOrEqual(1);
    });
  });

  test('traverse with max nodes should limit result count', async () => {
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 3,
      maxNodes: 2,
    });
    
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test('getGraphAnalysis should return connectivity metrics', async () => {
    const analysis = await traversalService.getGraphAnalysis(memoryIds[0], 'test-traversal');
    
    expect(analysis.inDegree).toBeGreaterThanOrEqual(0);
    expect(analysis.outDegree).toBeGreaterThanOrEqual(0);
    expect(analysis.totalConnections).toBe(analysis.inDegree + analysis.outDegree);
    expect(analysis.relationTypes).toBeDefined();
  });

  test('findTopConnectors should return most connected memories', async () => {
    const connectors = await traversalService.findTopConnectors('test-traversal', 5);
    
    expect(Array.isArray(connectors)).toBe(true);
    connectors.forEach(connector => {
      expect(connector.memoryId).toBeDefined();
      expect(connector.connectionCount).toBeGreaterThanOrEqual(0);
      expect(connector.type).toBeDefined();
      expect(Array.isArray(connector.tags)).toBe(true);
    });
    
    // Should be sorted by connection count
    for (let i = 1; i < connectors.length; i++) {
      expect(connectors[i].connectionCount).toBeLessThanOrEqual(connectors[i - 1].connectionCount);
    }
  });

  test('traverse should respect user context boundaries', async () => {
    // Try to traverse with wrong user context
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'different-user',
      algorithm: 'bfs',
      maxDepth: 2,
    });
    
    // Should return empty or only accessible memories
    expect(result.length).toBe(0);
  });

  test('traverse should exclude soft-deleted memories', async () => {
    // Soft delete a memory
    await db
      .updateTable('memories')
      .set({ deleted_at: new Date() })
      .where('id', '=', memoryIds[2])
      .execute();
    
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
    });
    
    // Should not include the soft-deleted memory
    const resultIds = result.map(r => r.memory.id);
    expect(resultIds).not.toContain(memoryIds[2]);
    
    // Restore the memory for other tests
    await db
      .updateTable('memories')
      .set({ deleted_at: null })
      .where('id', '=', memoryIds[2])
      .execute();
  });

  test('traverse should respect timeout limit', async () => {
    const startTime = Date.now();
    
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 10,
      maxNodes: 1000,
      timeoutMs: 100, // Very short timeout
    });
    
    const elapsed = Date.now() - startTime;
    
    // Should timeout quickly
    expect(elapsed).toBeLessThan(200);
  });

  test('traverse should include parent-child relationships when requested', async () => {
    // Create a new memory with parent_id to avoid conflicts with existing relations
    const childMemory = await db
      .insertInto('memories')
      .values({
        user_context: 'test-traversal',
        content: JSON.stringify({ text: 'Test child with parent' }),
        content_hash: 'test-parent-child-hash',
        type: 'fact',
        source: 'test',
        confidence: 0.9,
        importance_score: 0.5,
        parent_id: memoryIds[0], // Set parent_id directly
        tags: ['test-parent-child'],
      })
      .returning('id')
      .executeTakeFirst();
    
    const result = await traversalService.traverse({
      startMemoryId: memoryIds[0],
      userContext: 'test-traversal',
      algorithm: 'bfs',
      maxDepth: 2,
      includeParentLinks: true,
    });
    
    // Should include the child memory traversed via parent_of relation
    const childNode = result.find(r => r.memory.id === childMemory!.id);
    expect(childNode).toBeDefined();
    expect(childNode?.relationFromParent).toBe('parent_of');
    
    // Clean up
    await db
      .deleteFrom('memories')
      .where('id', '=', childMemory!.id)
      .execute();
  });

  test('rate limiting should prevent excessive requests', async () => {
    const userContext = 'rate-limit-test';
    
    // Create a memory for testing
    const testMemory = await db
      .insertInto('memories')
      .values({
        user_context: userContext,
        content: JSON.stringify({ text: 'Rate limit test' }),
        content_hash: 'rate-limit-hash',
        type: 'fact',
        source: 'test',
        confidence: 0.9,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    
    // Make many rapid requests to trigger rate limiting
    const promises = [];
    for (let i = 0; i < 110; i++) {
      promises.push(
        traversalService.traverse({
          startMemoryId: testMemory.id,
          userContext,
          algorithm: 'bfs',
          maxDepth: 1,
        })
      );
    }
    
    // Some requests should fail due to rate limiting
    const results = await Promise.allSettled(promises);
    const failures = results.filter(r => r.status === 'rejected');
    
    expect(failures.length).toBeGreaterThan(0);
    
    // Clean up
    await db
      .deleteFrom('memories')
      .where('id', '=', testMemory.id)
      .execute();
  });
});