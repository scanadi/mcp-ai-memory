import { config } from '../src/config/index.js';
import { createDatabase } from '../src/database/client.js';

// Export a function to create test database connection
// WARNING: This should use a separate test database!
// For now, use the main database but with extreme caution
export function createTestDatabase() {
  // Check if we have a test database URL
  const testDbUrl = process.env.TEST_DATABASE_URL || process.env.MEMORY_DB_URL;
  
  if (!process.env.TEST_DATABASE_URL) {
    console.warn('⚠️  WARNING: Using production database for tests! Set TEST_DATABASE_URL to use a separate test database.');
  }
  
  return createDatabase(testDbUrl);
}