import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { FileMigrationProvider, Migrator } from 'kysely';
import { createDatabase } from './client.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrateDatabase() {
  const databaseUrl = process.env.MEMORY_DB_URL;

  if (!databaseUrl) {
    console.error('MEMORY_DB_URL environment variable is not set');
    process.exit(1);
  }

  const db = createDatabase(databaseUrl);

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  const direction = process.argv[2];

  try {
    if (direction === 'down') {
      const { error, results } = await migrator.migrateDown();

      results?.forEach((it) => {
        if (it.status === 'Success') {
          console.log(`Migration "${it.migrationName}" rolled back successfully`);
        } else if (it.status === 'Error') {
          console.error(`Failed to roll back migration "${it.migrationName}"`);
        }
      });

      if (error) {
        console.error('Failed to roll back migrations');
        console.error('Migration error:', (error as Error).message);
        process.exit(1);
      }
    } else {
      const { error, results } = await migrator.migrateToLatest();

      results?.forEach((it) => {
        if (it.status === 'Success') {
          console.log(`Migration "${it.migrationName}" executed successfully`);
        } else if (it.status === 'Error') {
          console.error(`Failed to execute migration "${it.migrationName}"`);
        }
      });

      if (error) {
        console.error('Failed to migrate');
        console.error('Migration error:', (error as Error).message);
        process.exit(1);
      }
    }

    await db.destroy();
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', (error as Error).message);
    await db.destroy();
    process.exit(1);
  }
}

migrateDatabase();
