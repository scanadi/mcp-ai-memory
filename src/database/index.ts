import { config } from '../config/index.js';
import { createDatabase } from './client.js';

// Create and export database instance
export const db = createDatabase(config.MEMORY_DB_URL);

// Export types and utilities
export * from './client.js';
