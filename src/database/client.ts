import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../types/database.js';

export function createDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000,
      }),
    }),
  });
}

export class DatabaseClient {
  private db: Kysely<Database>;

  constructor(connectionString: string) {
    this.db = createDatabase(connectionString);
  }

  get instance(): Kysely<Database> {
    return this.db;
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }
}
