#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { MemoryMcpServer } from './server.js';

dotenv.config();

async function main() {
  try {
    const transport = new StdioServerTransport();
    const memoryServer = new MemoryMcpServer();
    const server = memoryServer.getServer();

    await server.connect(transport);

    console.info('MCP AI Memory Server started successfully via stdio');

    process.on('SIGINT', async () => {
      await memoryServer.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await memoryServer.cleanup();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
