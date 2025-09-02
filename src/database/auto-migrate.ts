import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, type MigrationResultSet, Migrator, sql } from 'kysely';
import type { Database } from '../types/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function checkSchemaExists(db: Kysely<Database>): Promise<boolean> {
  try {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'memories'
      ) as exists
    `.execute(db);

    return result.rows[0]?.exists || false;
  } catch (error) {
    console.error('[Migration] Error checking schema existence:', error);
    return false;
  }
}

async function checkMigrationTableExists(db: Kysely<Database>): Promise<boolean> {
  try {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'kysely_migration'
      ) as exists
    `.execute(db);

    return result.rows[0]?.exists || false;
  } catch (error) {
    console.error('[Migration] Error checking migration table existence:', error);
    return false;
  }
}

export async function runMigrations(db: Kysely<Database>): Promise<MigrationResultSet> {
  const schemaExists = await checkSchemaExists(db);
  const migrationTableExists = await checkMigrationTableExists(db);

  if (schemaExists && migrationTableExists) {
    console.error('[Migration] Schema exists, checking for pending migrations...');
  } else if (schemaExists && !migrationTableExists) {
    console.error(
      '[Migration] Schema exists but migration table is missing. Running migrations to ensure consistency...'
    );
  } else {
    console.error('[Migration] Database is empty. Initializing schema...');
  }

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.error(`[Migration] ✓ Migration "${it.migrationName}" executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`[Migration] ✗ Failed to execute migration "${it.migrationName}"`);
    } else if (it.status === 'NotExecuted') {
      console.error(`[Migration] - Migration "${it.migrationName}" already executed`);
    }
  });

  if (error) {
    console.error('[Migration] Failed to run migrations:', error);
    throw error;
  }

  const migrationsRun = results?.filter((r) => r.status === 'Success').length || 0;
  if (migrationsRun > 0) {
    console.error(`[Migration] ✓ ${migrationsRun} migration(s) completed successfully`);
  } else {
    console.error('[Migration] ✓ Database is already up to date');
  }

  return { error, results };
}
