#!/usr/bin/env bun

import { EmbeddingWorker } from '../src/workers/embedding-worker.js';
import { BatchWorker } from '../src/workers/batch-worker.js';
import { ClusteringWorker } from '../src/workers/clustering-worker.js';
import { queueService } from '../src/services/queue-service.js';

console.log('🚀 Starting MCP AI Memory Workers...\n');

// Share the connection from queue service
const sharedConnection = queueService.connection;

// Start workers with shared connection
const embeddingWorker = new EmbeddingWorker(sharedConnection);
console.log('✅ Embedding worker started');

const batchWorker = new BatchWorker(sharedConnection);
console.log('✅ Batch worker started');

const clusteringWorker = new ClusteringWorker(sharedConnection);
console.log('✅ Clustering worker started');

console.log('\n📊 Workers are running. Press Ctrl+C to stop.\n');

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⏹️  Shutting down workers...');
  await Promise.all([
    embeddingWorker.shutdown(),
    batchWorker.shutdown(),
    clusteringWorker.shutdown(),
  ]);
  console.log('✅ Workers stopped');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Shutting down workers...');
  await Promise.all([
    embeddingWorker.shutdown(),
    batchWorker.shutdown(),
    clusteringWorker.shutdown(),
  ]);
  console.log('✅ Workers stopped');
  process.exit(0);
});

// Keep process alive
setInterval(() => {
  // Optionally log metrics periodically
}, 60000);