import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // First, check if we have any existing data with embeddings
  const result = await sql<{ count: number }>`
    SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL
  `.execute(db);

  const hasData = (result.rows[0]?.count ?? 0) > 0;

  if (hasData) {
    console.warn(
      'Warning: Existing embeddings found. Migration will preserve data but dimension changes may require re-embedding.'
    );
  }

  // Drop the old HNSW index
  await sql`DROP INDEX IF EXISTS idx_memories_embedding`.execute(db);

  // For pgvector on Neon, we need to drop and recreate the column with no dimension limit
  // First drop the column
  await sql`ALTER TABLE memories DROP COLUMN IF EXISTS embedding`.execute(db);

  // Then add it back without dimension constraint
  await sql`ALTER TABLE memories ADD COLUMN embedding vector`.execute(db);

  // Recreate the HNSW index without dimension constraint
  await sql`CREATE INDEX idx_memories_embedding ON memories 
    USING hnsw (embedding vector_cosine_ops)`.execute(db);

  // Add a column to track the embedding dimension for each memory
  await db.schema.alterTable('memories').addColumn('embedding_dimension', 'integer').execute();

  console.log('Migration completed: Database now supports flexible embedding dimensions');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the embedding_dimension column
  await db.schema.alterTable('memories').dropColumn('embedding_dimension').execute();

  // Restore the fixed dimension vector column (defaulting to 768)
  await sql`DROP INDEX IF EXISTS idx_memories_embedding`.execute(db);
  await sql`ALTER TABLE memories ALTER COLUMN embedding TYPE vector(768)`.execute(db);
  await sql`CREATE INDEX idx_memories_embedding ON memories 
    USING hnsw (embedding vector_cosine_ops)`.execute(db);
}
