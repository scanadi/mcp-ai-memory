import { type Kysely, sql } from 'kysely';
import type { Database } from '../../types/database';

export async function up(db: Kysely<Database>): Promise<void> {
  // 1. Add pgcrypto extension for gen_random_uuid()
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  // 2. Drop the global unique constraint on content_hash
  await db.schema.dropIndex('idx_memories_content_hash').execute();

  // 3. Create composite unique constraint on (user_context, content_hash)
  await db.schema
    .createIndex('idx_memories_user_context_content_hash')
    .on('memories')
    .columns(['user_context', 'content_hash'])
    .unique()
    .execute();

  // 4. Change cluster_id from uuid to text to support numeric IDs
  await sql`ALTER TABLE memories ALTER COLUMN cluster_id TYPE text USING cluster_id::text`.execute(db);
  // 5. Ensure embeddings can be NULL for async processing (noop if already nullable)
  // Some databases may already allow NULL, so ignore errors
  try {
    await sql`ALTER TABLE memories ALTER COLUMN embedding DROP NOT NULL`.execute(db);
  } catch {
    // Ignore if constraint does not exist
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Reverse the changes we made
  // Change cluster_id back to uuid
  await sql`ALTER TABLE memories ALTER COLUMN cluster_id TYPE uuid USING cluster_id::uuid`.execute(db);

  // Restore global unique constraint on content_hash
  await db.schema.dropIndex('idx_memories_user_context_content_hash').execute();
  await db.schema.createIndex('idx_memories_content_hash').on('memories').column('content_hash').unique().execute();

  // Note: We don't remove pgcrypto as it might be used elsewhere
}
