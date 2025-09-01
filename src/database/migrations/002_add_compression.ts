import type { Kysely } from 'kysely';
import type { Database } from '../../types/database';

export async function up(db: Kysely<Database>): Promise<void> {
  // Add is_compressed column to memories table
  await db.schema
    .alterTable('memories')
    .addColumn('is_compressed', 'boolean', (col) => col.defaultTo(false).notNull())
    .execute();

  // Add index for compressed memories
  await db.schema.createIndex('idx_memories_is_compressed').on('memories').column('is_compressed').execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Drop index
  await db.schema.dropIndex('idx_memories_is_compressed').execute();

  // Remove is_compressed column
  await db.schema.alterTable('memories').dropColumn('is_compressed').execute();
}
