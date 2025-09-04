import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from './config/index.js';
import { runMigrations } from './database/auto-migrate.js';
import { createDatabase } from './database/client.js';
import {
  BatchMemorySchema,
  ConsolidateMemorySchema,
  DeleteMemorySchema,
  ListMemorySchema,
  SearchMemorySchema,
  StatsSchema,
  StoreMemorySchema,
  UpdateMemorySchema,
} from './schemas/validation.js';
import { decayService } from './services/decayService.js';
import { MemoryService } from './services/memory-service.js';
import { traversalService } from './services/traversalService.js';
import { formatMemoriesForAI } from './utils/memory-formatter.js';

export class MemoryMcpServer {
  private server: Server;
  private memoryService: MemoryService;

  constructor() {
    this.server = new Server(
      {
        name: 'memory-server',
        version: '1.1.1',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    const db = createDatabase(config.MEMORY_DB_URL);
    this.memoryService = new MemoryService(db);

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'memory_store',
          description:
            'STORE SAVE REMEMBER CREATE - Store new information, facts, preferences, conversations, or knowledge. Use after searching to avoid duplicates. Keywords: save, remember, store, record, memorize, learn, retain, persist, create memory, add knowledge, save fact, store preference, remember conversation',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'object' },
              type: {
                type: 'string',
                enum: ['fact', 'conversation', 'decision', 'insight', 'error', 'context', 'preference', 'task'],
              },
              tags: { type: 'array', items: { type: 'string' } },
              source: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              parent_id: { type: 'string' },
              relation_type: { type: 'string', enum: ['references', 'contradicts', 'supports', 'extends'] },
              importance_score: { type: 'number', minimum: 0, maximum: 1 },
              user_context: { type: 'string' },
              relate_to: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    memory_id: { type: 'string' },
                    relation_type: {
                      type: 'string',
                      enum: ['references', 'contradicts', 'supports', 'extends'],
                    },
                    strength: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['memory_id', 'relation_type'],
                },
              },
            },
            required: ['content', 'type', 'source', 'confidence'],
          },
        },
        {
          name: 'memory_search',
          description:
            'SEARCH FIND RECALL RETRIEVE QUERY LOOKUP - Search for stored information using natural language. USE THIS FIRST before any memory operation. Keywords: search, find, recall, retrieve, query, lookup, remember, fetch, get, access, locate, discover, check memory, find information, recall fact, retrieve data, search knowledge, what do I know, user preferences, user name, previous conversation',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              type: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number', minimum: 1, maximum: 100 },
              threshold: { type: 'number', minimum: 0, maximum: 1 },
              user_context: { type: 'string' },
              include_relations: { type: 'boolean' },
            },
            required: ['query'],
          },
        },
        {
          name: 'memory_list',
          description:
            'LIST BROWSE SHOW ALL - List all stored memories chronologically. Use when search returns nothing or to explore what is stored. Keywords: list, browse, show, display, view all, get all, see memories, show history, list facts, display knowledge, browse storage, what is stored, show everything, recent memories',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number', minimum: 1, maximum: 100 },
              offset: { type: 'number', minimum: 0 },
              user_context: { type: 'string' },
            },
          },
        },
        {
          name: 'memory_update',
          description:
            'UPDATE MODIFY EDIT CHANGE - Update existing memory metadata, tags, confidence, or importance. Keywords: update, modify, edit, change, revise, amend, alter, adjust, correct, fix, improve memory, update fact, change information',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              updates: {
                type: 'object',
                properties: {
                  tags: { type: 'array', items: { type: 'string' } },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  importance_score: { type: 'number', minimum: 0, maximum: 1 },
                  type: { type: 'string' },
                  source: { type: 'string' },
                },
              },
              preserve_timestamps: { type: 'boolean' },
            },
            required: ['id', 'updates'],
          },
        },
        {
          name: 'memory_delete',
          description:
            'DELETE REMOVE FORGET ERASE - Delete a specific memory by ID. Keywords: delete, remove, forget, erase, clear, purge, discard, eliminate, destroy memory, remove fact, forget information',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content_hash: { type: 'string' },
            },
          },
        },
        {
          name: 'memory_batch',
          description:
            'BATCH BULK MULTIPLE IMPORT - Store multiple memories at once for efficiency. Keywords: batch, bulk, multiple, import, mass store, save many, store all, bulk import, batch save',
          inputSchema: {
            type: 'object',
            properties: {
              memories: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'object' },
                    type: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    source: { type: 'string' },
                    confidence: { type: 'number' },
                    importance_score: { type: 'number' },
                  },
                  required: ['content', 'type', 'source', 'confidence'],
                },
              },
              user_context: { type: 'string' },
            },
            required: ['memories'],
          },
        },
        {
          name: 'memory_batch_delete',
          description:
            'BATCH DELETE BULK REMOVE - Delete multiple memories at once. Keywords: batch delete, bulk remove, mass delete, delete many, remove all, clear multiple',
          inputSchema: {
            type: 'object',
            properties: {
              ids: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
              },
            },
            required: ['ids'],
          },
        },
        {
          name: 'memory_graph_search',
          description:
            'GRAPH RELATED CONNECTED NETWORK - Search memories and traverse relationships to find connected information. Keywords: graph, related, connected, network, relationships, linked, associated, traverse connections',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              depth: { type: 'number', minimum: 1, maximum: 3 },
              type: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number' },
              threshold: { type: 'number' },
              user_context: { type: 'string' },
            },
            required: ['query'],
          },
        },
        {
          name: 'memory_consolidate',
          description:
            'CONSOLIDATE MERGE CLUSTER DEDUPLICATE - Group and merge similar memories to reduce redundancy. Keywords: consolidate, merge, cluster, deduplicate, group, combine, compress, organize',
          inputSchema: {
            type: 'object',
            properties: {
              threshold: { type: 'number', minimum: 0.5, maximum: 0.95 },
              min_cluster_size: { type: 'number', minimum: 2 },
              user_context: { type: 'string' },
            },
          },
        },
        {
          name: 'memory_stats',
          description:
            'STATS STATUS INFO METRICS - Get database statistics, counts, and health metrics. Keywords: stats, status, info, metrics, statistics, counts, summary, overview, database info',
          inputSchema: {
            type: 'object',
            properties: {
              user_context: { type: 'string' },
            },
          },
        },
        {
          name: 'memory_relate',
          description:
            'RELATE LINK CONNECT ASSOCIATE - Create a relationship between two memories. Keywords: relate, link, connect, associate, join, bind, reference, attach',
          inputSchema: {
            type: 'object',
            properties: {
              from_memory_id: { type: 'string' },
              to_memory_id: { type: 'string' },
              relation_type: {
                type: 'string',
                enum: [
                  'references',
                  'contradicts',
                  'supports',
                  'extends',
                  'causes',
                  'caused_by',
                  'precedes',
                  'follows',
                  'part_of',
                  'contains',
                  'relates_to',
                ],
              },
              strength: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['from_memory_id', 'to_memory_id', 'relation_type'],
          },
        },
        {
          name: 'memory_unrelate',
          description:
            'UNRELATE UNLINK DISCONNECT - Remove a relationship between two memories. Keywords: unrelate, unlink, disconnect, detach, unbind, separate',
          inputSchema: {
            type: 'object',
            properties: {
              from_memory_id: { type: 'string' },
              to_memory_id: { type: 'string' },
            },
            required: ['from_memory_id', 'to_memory_id'],
          },
        },
        {
          name: 'memory_get_relations',
          description:
            'GET RELATIONS SHOW LINKS - Get all relationships for a specific memory. Keywords: get relations, show links, list connections, view relationships, find associations',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string' },
            },
            required: ['memory_id'],
          },
        },
        {
          name: 'memory_traverse',
          description:
            'TRAVERSE EXPLORE GRAPH WALK - Traverse memory graph using BFS/DFS from a starting memory. Includes filtering by relation types, memory types, tags, and depth limits. Keywords: traverse, explore, graph, walk, navigate, follow, path, connections, network',
          inputSchema: {
            type: 'object',
            properties: {
              start_memory_id: { type: 'string' },
              user_context: { type: 'string' },
              algorithm: { type: 'string', enum: ['bfs', 'dfs'], default: 'bfs' },
              max_depth: { type: 'number', minimum: 1, maximum: 5, default: 3 },
              max_nodes: { type: 'number', minimum: 1, maximum: 1000, default: 100 },
              relation_types: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'references',
                    'contradicts',
                    'supports',
                    'extends',
                    'causes',
                    'caused_by',
                    'precedes',
                    'follows',
                    'part_of',
                    'contains',
                    'relates_to',
                  ],
                },
              },
              memory_types: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
              include_parent_links: { type: 'boolean', default: false },
            },
            required: ['start_memory_id', 'user_context'],
          },
        },
        {
          name: 'memory_decay_status',
          description:
            'DECAY STATUS LIFECYCLE STATE - Get decay status and lifecycle information for a memory including state, decay score, and preservation status. Keywords: decay, status, lifecycle, state, age, freshness, preservation, expiry',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string' },
            },
            required: ['memory_id'],
          },
        },
        {
          name: 'memory_preserve',
          description:
            'PRESERVE PROTECT KEEP PIN - Preserve a memory from decay, optionally until a specific date. Keywords: preserve, protect, keep, pin, save, retain, bookmark, favorite',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string' },
              until: { type: 'string', format: 'date-time' },
            },
            required: ['memory_id'],
          },
        },
        {
          name: 'memory_graph_analysis',
          description:
            'GRAPH ANALYSIS CONNECTIVITY DEGREE - Analyze graph connectivity for a memory including degree metrics and relation type distribution. Keywords: graph analysis, connectivity, degree, network metrics, connections count',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string' },
              user_context: { type: 'string' },
            },
            required: ['memory_id', 'user_context'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'memory_store': {
            const validated = StoreMemorySchema.parse(args);
            const result = await this.memoryService.store(validated);
            const { embedding: _embedding, ...memoryWithoutEmbedding } = result;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(memoryWithoutEmbedding, null, 2),
                },
              ],
            };
          }

          case 'memory_search': {
            const validated = SearchMemorySchema.parse(args);
            const results = await this.memoryService.search(validated);
            const formattedResults = formatMemoriesForAI(results);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(formattedResults, null, 2),
                },
              ],
            };
          }

          case 'memory_list': {
            const validated = ListMemorySchema.parse(args);
            const results = await this.memoryService.list(validated);
            const formattedResults = formatMemoriesForAI(results);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(formattedResults, null, 2),
                },
              ],
            };
          }

          case 'memory_update': {
            const validated = UpdateMemorySchema.parse(args);
            const result = await this.memoryService.update(validated);
            const { embedding: _embedding, ...memoryWithoutEmbedding } = result;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(memoryWithoutEmbedding, null, 2),
                },
              ],
            };
          }

          case 'memory_delete': {
            const validated = DeleteMemorySchema.parse(args);
            const result = await this.memoryService.delete(validated);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'memory_batch_delete': {
            const validated = z.object({ ids: z.array(z.string()).min(1) }).parse(args);
            const result = await this.memoryService.batchDelete(validated.ids);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'memory_batch': {
            const validated = BatchMemorySchema.parse(args);
            const results = await this.memoryService.batchStore(validated);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      stored: results.success.length,
                      failed: results.failed.length,
                      details: results,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case 'memory_consolidate': {
            const validated = ConsolidateMemorySchema.parse(args);
            const result = await this.memoryService.consolidate(validated);
            return {
              content: [
                {
                  type: 'text',
                  text: `Consolidated ${result.clustersCreated} clusters, archived ${result.memoriesArchived} memories`,
                },
              ],
            };
          }

          case 'memory_stats': {
            const validated = StatsSchema.parse(args);
            const stats = await this.memoryService.getStats(validated.user_context);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(stats, null, 2),
                },
              ],
            };
          }

          case 'memory_relate': {
            const { from_memory_id, to_memory_id, relation_type, strength } = args as {
              from_memory_id: string;
              to_memory_id: string;
              relation_type:
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
                | 'relates_to';
              strength?: number;
            };
            const result = await this.memoryService.createRelation(
              from_memory_id,
              to_memory_id,
              relation_type,
              strength || 0.5
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'memory_unrelate': {
            const { from_memory_id, to_memory_id } = args as {
              from_memory_id: string;
              to_memory_id: string;
            };
            const result = await this.memoryService.deleteRelation(from_memory_id, to_memory_id);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: result }, null, 2),
                },
              ],
            };
          }

          case 'memory_get_relations': {
            const { memory_id } = args as { memory_id: string };
            const relations = await this.memoryService.getMemoryRelations(memory_id);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(relations, null, 2),
                },
              ],
            };
          }

          case 'memory_traverse': {
            const {
              start_memory_id,
              user_context,
              algorithm = 'bfs',
              max_depth = 3,
              max_nodes = 100,
              relation_types = [],
              memory_types = [],
              tags = [],
              include_parent_links = false,
            } = args as {
              start_memory_id: string;
              user_context: string;
              algorithm?: 'bfs' | 'dfs';
              max_depth?: number;
              max_nodes?: number;
              relation_types?: string[];
              memory_types?: string[];
              tags?: string[];
              include_parent_links?: boolean;
            };

            const result = await traversalService.traverse({
              startMemoryId: start_memory_id,
              userContext: user_context,
              algorithm,
              maxDepth: max_depth,
              maxNodes: max_nodes,
              relationTypes: relation_types,
              memoryTypes: memory_types,
              tags,
              includeParentLinks: include_parent_links,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'memory_decay_status': {
            const { memory_id } = args as { memory_id: string };
            const status = await decayService.getDecayStatus(memory_id);

            if (!status) {
              throw new McpError(ErrorCode.InvalidParams, `Memory ${memory_id} not found`);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(status, null, 2),
                },
              ],
            };
          }

          case 'memory_preserve': {
            const { memory_id, until } = args as { memory_id: string; until?: string };
            const untilDate = until ? new Date(until) : undefined;

            await decayService.preserveMemory(memory_id, untilDate);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      memory_id,
                      preserved_until: untilDate?.toISOString() || 'indefinite',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case 'memory_graph_analysis': {
            const { memory_id, user_context } = args as { memory_id: string; user_context: string };
            const analysis = await traversalService.getGraphAnalysis(memory_id, user_context);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(analysis, null, 2),
                },
              ],
            };
          }

          // Alias for backward compatibility
          case 'memory_graph_search': {
            // Redirect to memory_traverse
            const {
              start_memory_id,
              user_context,
              algorithm = 'bfs',
              max_depth = 3,
              max_nodes = 100,
              relation_types = [],
              memory_types = [],
              tags = [],
              include_parent_links = false,
            } = args as {
              start_memory_id: string;
              user_context: string;
              algorithm?: 'bfs' | 'dfs';
              max_depth?: number;
              max_nodes?: number;
              relation_types?: string[];
              memory_types?: string[];
              tags?: string[];
              include_parent_links?: boolean;
            };

            const result = await traversalService.traverse({
              startMemoryId: start_memory_id,
              userContext: user_context,
              algorithm,
              maxDepth: max_depth,
              maxNodes: max_nodes,
              relationTypes: relation_types,
              memoryTypes: memory_types,
              tags,
              includeParentLinks: include_parent_links,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid parameters: ${error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
          );
        }
        throw error;
      }
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'memory://stats',
          name: 'Memory Statistics',
          description: 'Database statistics and health metrics',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://types',
          name: 'Memory Types',
          description: 'Available memory types in the database',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://tags',
          name: 'Memory Tags',
          description: 'All unique tags used across memories',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://relationships',
          name: 'Memory Relationships',
          description: 'Graph of memory relationships',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://clusters',
          name: 'Memory Clusters',
          description: 'Consolidated memory clusters',
          mimeType: 'application/json',
        },
      ],
    }));

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      switch (uri) {
        case 'memory://stats': {
          const stats = await this.memoryService.getStats();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        case 'memory://types': {
          const types = await this.memoryService.getTypes();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(types, null, 2),
              },
            ],
          };
        }

        case 'memory://tags': {
          const tags = await this.memoryService.getTags();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(tags, null, 2),
              },
            ],
          };
        }

        case 'memory://relationships': {
          const relationships = await this.memoryService.getRelationships();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(relationships, null, 2),
              },
            ],
          };
        }

        case 'memory://clusters': {
          const clusters = await this.memoryService.getClusters();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(clusters, null, 2),
              },
            ],
          };
        }

        default:
          throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
      }
    });

    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'load-context',
          description: 'Load relevant context for a task',
          arguments: [
            { name: 'task', description: 'The task to load context for', required: true },
            { name: 'limit', description: 'Maximum number of memories to load', required: false },
            { name: 'user_context', description: 'User context to filter memories', required: false },
          ],
        },
        {
          name: 'memory-summary',
          description: 'Generate a summary of memories for a topic',
          arguments: [
            { name: 'topic', description: 'The topic to summarize', required: true },
            { name: 'max_memories', description: 'Maximum number of memories to include', required: false },
            { name: 'user_context', description: 'User context to filter memories', required: false },
          ],
        },
        {
          name: 'conversation-context',
          description: 'Load conversation history and context',
          arguments: [
            { name: 'session_id', description: 'The session ID to load', required: true },
            { name: 'last_n', description: 'Number of recent messages to load', required: false },
          ],
        },
      ],
    }));

    // Handle prompt requests
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'load-context': {
          const task = args?.task as string;
          const limit = Number(args?.limit) || 10;
          const userContext = args?.user_context as string;

          const memories = await this.memoryService.search({
            query: task,
            limit,
            user_context: userContext,
            include_relations: true,
            threshold: 0.7,
          });

          return {
            description: `Context loaded for task: ${task}`,
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text:
                    `Context loaded: ${memories.length} relevant memories found:\n\n` +
                    memories.map((m) => `- ${JSON.stringify(m.content)}`).join('\n'),
                },
              },
            ],
          };
        }

        case 'memory-summary': {
          const topic = args?.topic as string;
          const maxMemories = Number(args?.max_memories) || 20;
          const userContext = args?.user_context as string;

          const memories = await this.memoryService.search({
            query: topic,
            limit: maxMemories,
            user_context: userContext,
            include_relations: true,
            threshold: 0.7,
          });

          const summary = memories.map((m) => ({
            type: m.type,
            confidence: m.confidence,
            tags: m.tags,
            summary: JSON.stringify(m.content).substring(0, 100),
          }));

          return {
            description: `Summary for topic: ${topic}`,
            messages: [
              {
                role: 'assistant',
                content: {
                  type: 'text',
                  text:
                    `Found ${memories.length} memories about "${topic}":\n\n` +
                    summary
                      .map(
                        (s, i) =>
                          `${i + 1}. [${s.type}] (confidence: ${s.confidence})\n` +
                          `   Tags: ${(s.tags || []).join(', ')}\n` +
                          `   ${s.summary}...`
                      )
                      .join('\n\n'),
                },
              },
            ],
          };
        }

        case 'conversation-context': {
          const sessionId = args?.session_id as string;
          const lastN = Number(args?.last_n) || 10;

          const memories = await this.memoryService.list({
            type: 'conversation',
            tags: [sessionId],
            limit: lastN,
            offset: 0,
          });

          return {
            description: `Conversation context for session: ${sessionId}`,
            messages: memories.map((m) => ({
              role: 'user',
              content: {
                type: 'text',
                text: JSON.stringify(m.content),
              },
            })),
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${name}`);
      }
    });
  }

  getServer() {
    return this.server;
  }

  async cleanup() {
    await this.memoryService.cleanup();
  }

  async start() {
    const db = createDatabase(config.MEMORY_DB_URL);

    try {
      await runMigrations(db);
    } catch (error) {
      console.error('[Server] Failed to run migrations:', error);
      await db.destroy();
      process.exit(1);
    }

    await db.destroy();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP AI Memory Server started');
  }
}

// Main entry point - only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new MemoryMcpServer();
  server.start().catch(console.error);
}
