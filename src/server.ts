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
  GraphSearchSchema,
  ListMemorySchema,
  SearchMemorySchema,
  StatsSchema,
  StoreMemorySchema,
  UpdateMemorySchema,
} from './schemas/validation.js';
import { MemoryService } from './services/memory-service.js';

export class MemoryMcpServer {
  private server: Server;
  private memoryService: MemoryService;

  constructor() {
    this.server = new Server(
      {
        name: 'memory-server',
        version: '2.0.0',
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
          description: 'Store a memory with semantic embeddings and optional relationships',
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
          description: 'Semantic search through memories with similarity scoring',
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
          description: 'List all memories with optional filtering by type and tags',
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
          description: 'Update memory metadata, tags, or importance',
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
          description: 'Delete a memory by content hash or ID',
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
          description: 'Store multiple memories in a single operation',
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
          description: 'Delete multiple memories by their IDs in a single operation',
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
          description: 'Search memories with relationship traversal',
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
          description: 'Consolidate similar memories into clusters',
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
          description: 'Get database statistics and health metrics',
          inputSchema: {
            type: 'object',
            properties: {
              user_context: { type: 'string' },
            },
          },
        },
        {
          name: 'memory_relate',
          description: 'Create a relationship between two memories',
          inputSchema: {
            type: 'object',
            properties: {
              from_memory_id: { type: 'string' },
              to_memory_id: { type: 'string' },
              relation_type: {
                type: 'string',
                enum: ['references', 'contradicts', 'supports', 'extends'],
              },
              strength: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['from_memory_id', 'to_memory_id', 'relation_type'],
          },
        },
        {
          name: 'memory_unrelate',
          description: 'Remove a relationship between two memories',
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
          description: 'Get all relationships for a specific memory',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string' },
            },
            required: ['memory_id'],
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
            const resultsWithoutEmbeddings = results.map(({ embedding, ...rest }) => rest);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(resultsWithoutEmbeddings, null, 2),
                },
              ],
            };
          }

          case 'memory_list': {
            const validated = ListMemorySchema.parse(args);
            const results = await this.memoryService.list(validated);
            const resultsWithoutEmbeddings = results.map(({ embedding, ...rest }) => rest);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(resultsWithoutEmbeddings, null, 2),
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

          case 'memory_graph_search': {
            const validated = GraphSearchSchema.parse(args);
            const results = await this.memoryService.graphSearch(validated);
            const resultsWithoutEmbeddings = results.map(({ embedding, ...rest }) => rest);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(resultsWithoutEmbeddings, null, 2),
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
              relation_type: 'references' | 'contradicts' | 'supports' | 'extends';
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
                          `   Tags: ${s.tags.join(', ')}\n` +
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
