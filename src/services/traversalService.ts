import { type Kysely, sql } from 'kysely';
import { db } from '../database/index.js';
import type { Database, Memory } from '../types/database.js';
import { logger } from '../utils/logger.js';

export interface TraversalOptions {
  startMemoryId: string;
  userContext: string;
  algorithm: 'bfs' | 'dfs';
  maxDepth?: number;
  maxNodes?: number;
  relationTypes?: string[];
  memoryTypes?: string[];
  tags?: string[];
  includeParentLinks?: boolean;
  timeoutMs?: number;
}

export interface GraphNode {
  memory: Memory;
  depth: number;
  path: string[];
  relationFromParent?: string;
}

export class TraversalService {
  private db: Kysely<Database>;

  constructor(database?: Kysely<Database>) {
    this.db = database || db;
  }

  async traverse(options: TraversalOptions): Promise<GraphNode[]> {
    const {
      startMemoryId,
      userContext,
      algorithm = 'bfs',
      maxDepth = 5,
      maxNodes = 1000,
      relationTypes = [],
      memoryTypes = [],
      tags = [],
      includeParentLinks = false,
      timeoutMs = 5000,
    } = options;

    const startTime = Date.now();
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number; path: string[]; relation?: string }> = [
      { id: startMemoryId, depth: 0, path: [] },
    ];

    while (queue.length > 0 && result.length < maxNodes) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        logger.warn(`Traversal timeout after ${timeoutMs}ms`);
        break;
      }

      const current = algorithm === 'bfs' ? queue.shift() : queue.pop();
      if (!current) continue;

      if (visited.has(current.id) || current.depth > maxDepth) {
        continue;
      }

      visited.add(current.id);

      // Fetch memory with filters
      const memory = await this.getMemory(current.id, userContext, memoryTypes, tags);
      if (!memory) continue;

      result.push({
        memory,
        depth: current.depth,
        path: [...current.path, current.id],
        relationFromParent: current.relation,
      });

      // Only continue traversal if not at max depth
      if (current.depth < maxDepth) {
        // Get connected memories via edges
        const connections = await this.getConnections(current.id, userContext, relationTypes, includeParentLinks);

        for (const conn of connections) {
          if (!visited.has(conn.memoryId)) {
            queue.push({
              id: conn.memoryId,
              depth: current.depth + 1,
              path: [...current.path, current.id],
              relation: conn.relationType,
            });
          }
        }
      }
    }

    return result;
  }

  private async getMemory(
    memoryId: string,
    userContext: string,
    memoryTypes: string[],
    tags: string[]
  ): Promise<Memory | undefined> {
    let query = this.db
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', memoryId)
      .where('user_context', '=', userContext)
      .where('deleted_at', 'is', null);

    if (memoryTypes.length > 0) {
      query = query.where('type', 'in', memoryTypes);
    }

    if (tags.length > 0) {
      // Check if memory has any of the specified tags
      const tagArray = sql.raw(`ARRAY[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')}]::text[]`);
      query = query.$if(true, (qb) => qb.whereRef(sql`tags`, '&&', tagArray));
    }

    return await query.executeTakeFirst();
  }

  private async getConnections(
    memoryId: string,
    userContext: string,
    relationTypes: string[],
    includeParentLinks: boolean
  ): Promise<Array<{ memoryId: string; relationType: string }>> {
    const connections: Array<{ memoryId: string; relationType: string }> = [];

    // Get edge-based connections
    let fromQuery = this.db
      .selectFrom('memory_relations as mr')
      .innerJoin('memories as m', 'm.id', 'mr.to_memory_id')
      .select(['mr.to_memory_id as memoryId', 'mr.relation_type as relationType'])
      .where('mr.from_memory_id', '=', memoryId)
      .where('m.user_context', '=', userContext)
      .where('m.deleted_at', 'is', null);

    let toQuery = this.db
      .selectFrom('memory_relations as mr')
      .innerJoin('memories as m', 'm.id', 'mr.from_memory_id')
      .select(['mr.from_memory_id as memoryId', 'mr.relation_type as relationType'])
      .where('mr.to_memory_id', '=', memoryId)
      .where('m.user_context', '=', userContext)
      .where('m.deleted_at', 'is', null);

    if (relationTypes.length > 0) {
      const validTypes = relationTypes as (
        | 'references'
        | 'contradicts'
        | 'supports'
        | 'extends'
        | 'causes'
        | 'caused_by'
        | 'precedes'
        | 'follows'
        | 'part_of'
        | 'contains'
        | 'relates_to'
      )[];
      fromQuery = fromQuery.where('mr.relation_type', 'in', validTypes);
      toQuery = toQuery.where('mr.relation_type', 'in', validTypes);
    }

    const [fromConnections, toConnections] = await Promise.all([fromQuery.execute(), toQuery.execute()]);

    connections.push(...fromConnections, ...toConnections);

    // Include parent-child relationships if requested
    if (includeParentLinks) {
      // Get children
      const children = await this.db
        .selectFrom('memories')
        .select(['id as memoryId'])
        .where('parent_id', '=', memoryId)
        .where('user_context', '=', userContext)
        .where('deleted_at', 'is', null)
        .execute();

      const childConnections = children.map((c) => ({
        memoryId: c.memoryId,
        relationType: 'parent_of',
      }));

      // Get parent
      const parent = await this.db
        .selectFrom('memories')
        .select(['parent_id as memoryId'])
        .where('id', '=', memoryId)
        .where('parent_id', 'is not', null)
        .where('user_context', '=', userContext)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      connections.push(...childConnections);
      if (parent?.memoryId) {
        connections.push({ memoryId: parent.memoryId as string, relationType: 'child_of' });
      }
    }

    return connections;
  }

  async getGraphAnalysis(
    memoryId: string,
    userContext: string
  ): Promise<{
    inDegree: number;
    outDegree: number;
    totalConnections: number;
    relationTypes: Record<string, number>;
  }> {
    // Count incoming edges
    const inDegree = await this.db
      .selectFrom('memory_relations as mr')
      .innerJoin('memories as m', 'm.id', 'mr.from_memory_id')
      .select(({ fn }) => fn.count<number>('mr.id').as('count'))
      .where('mr.to_memory_id', '=', memoryId)
      .where('m.user_context', '=', userContext)
      .where('m.deleted_at', 'is', null)
      .executeTakeFirst();

    // Count outgoing edges
    const outDegree = await this.db
      .selectFrom('memory_relations as mr')
      .innerJoin('memories as m', 'm.id', 'mr.to_memory_id')
      .select(({ fn }) => fn.count<number>('mr.id').as('count'))
      .where('mr.from_memory_id', '=', memoryId)
      .where('m.user_context', '=', userContext)
      .where('m.deleted_at', 'is', null)
      .executeTakeFirst();

    // Get relation type distribution
    const relationDist = await this.db
      .selectFrom('memory_relations as mr')
      .innerJoin('memories as m1', 'm1.id', 'mr.from_memory_id')
      .innerJoin('memories as m2', 'm2.id', 'mr.to_memory_id')
      .select(['mr.relation_type', ({ fn }) => fn.count<number>('mr.id').as('count')])
      .where((eb) => eb.or([eb('mr.from_memory_id', '=', memoryId), eb('mr.to_memory_id', '=', memoryId)]))
      .where('m1.user_context', '=', userContext)
      .where('m2.user_context', '=', userContext)
      .where('m1.deleted_at', 'is', null)
      .where('m2.deleted_at', 'is', null)
      .groupBy('mr.relation_type')
      .execute();

    const relationTypes: Record<string, number> = {};
    relationDist.forEach((r) => {
      relationTypes[r.relation_type] = Number(r.count);
    });

    const inCount = Number(inDegree?.count || 0);
    const outCount = Number(outDegree?.count || 0);

    return {
      inDegree: inCount,
      outDegree: outCount,
      totalConnections: inCount + outCount,
      relationTypes,
    };
  }

  async findTopConnectors(
    userContext: string,
    limit: number = 10
  ): Promise<
    Array<{
      memoryId: string;
      connectionCount: number;
      type: string;
      tags: string[];
    }>
  > {
    const result = await this.db
      .selectFrom('memories as m')
      .leftJoin('memory_relations as mr1', 'mr1.from_memory_id', 'm.id')
      .leftJoin('memory_relations as mr2', 'mr2.to_memory_id', 'm.id')
      .select([
        'm.id as memoryId',
        'm.type',
        'm.tags',
        () => sql`COUNT(DISTINCT COALESCE(mr1.id, mr2.id))`.as('connectionCount'),
      ])
      .where('m.user_context', '=', userContext)
      .where('m.deleted_at', 'is', null)
      .groupBy(['m.id', 'm.type', 'm.tags'])
      .orderBy('connectionCount', 'desc')
      .limit(limit)
      .execute();

    return result.map((r) => ({
      memoryId: r.memoryId,
      connectionCount: Number(r.connectionCount),
      type: r.type,
      tags: r.tags || [],
    }));
  }
}

export const traversalService = new TraversalService();
