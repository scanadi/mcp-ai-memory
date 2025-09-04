import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../types/database-generated.js';

export function createDatabase(connectionString: string): Kysely<DB> {
  return new Kysely<DB>({
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
  private db: Kysely<DB>;

  constructor(connectionString: string) {
    this.db = createDatabase(connectionString);
  }

  get instance(): Kysely<DB> {
    return this.db;
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }
}
