import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Enable pgvector extension
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.execute(db);

  // Create memories table
  await db.schema
    .createTable('memories')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_context', 'varchar(255)', (col) => col.notNull())
    .addColumn('content', 'jsonb', (col) => col.notNull())
    .addColumn('content_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('embedding', sql`vector(768)`)
    .addColumn('tags', sql`text[]`, (col) => col.defaultTo(sql`ARRAY[]::text[]`))
    .addColumn('type', 'varchar(50)', (col) => col.notNull())
    .addColumn('source', 'varchar(200)', (col) => col.notNull())
    .addColumn('confidence', 'real', (col) => col.notNull())
    .addColumn('similarity_threshold', 'real', (col) => col.defaultTo(0.7))
    .addColumn('parent_id', 'uuid')
    .addColumn('relation_type', 'varchar(20)')
    .addColumn('cluster_id', 'uuid')
    .addColumn('importance_score', 'real', (col) => col.defaultTo(0.5))
    .addColumn('decay_rate', 'real', (col) => col.defaultTo(0.01))
    .addColumn('access_count', 'integer', (col) => col.defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .addColumn('accessed_at', 'timestamptz')
    .addColumn('deleted_at', 'timestamptz')
    .addColumn('metadata', 'jsonb')
    .execute();

  // Create indexes
  await db.schema.createIndex('idx_memories_user_context').on('memories').column('user_context').execute();

  await db.schema.createIndex('idx_memories_content_hash').on('memories').column('content_hash').unique().execute();

  await db.schema.createIndex('idx_memories_type').on('memories').column('type').execute();

  await db.schema.createIndex('idx_memories_cluster_id').on('memories').column('cluster_id').execute();

  // Add index for soft deletes
  await db.schema.createIndex('idx_memories_deleted_at').on('memories').column('deleted_at').execute();

  // Use HNSW index for better performance with pgvector 0.5+
  await sql`CREATE INDEX idx_memories_embedding ON memories 
    USING hnsw (embedding vector_cosine_ops)`.execute(db);

  // Create memory relations table
  await db.schema
    .createTable('memory_relations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('from_memory_id', 'uuid', (col) => col.notNull().references('memories.id').onDelete('cascade'))
    .addColumn('to_memory_id', 'uuid', (col) => col.notNull().references('memories.id').onDelete('cascade'))
    .addColumn('relation_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('strength', 'real', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .execute();

  // Create indexes for relations
  await db.schema.createIndex('idx_memory_relations_from').on('memory_relations').column('from_memory_id').execute();

  await db.schema.createIndex('idx_memory_relations_to').on('memory_relations').column('to_memory_id').execute();

  // Create trigger for updated_at
  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db);

  await sql`
    CREATE TRIGGER update_memories_updated_at 
    BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS update_memories_updated_at ON memories`.execute(db);
  await sql`DROP FUNCTION IF EXISTS update_updated_at_column()`.execute(db);
  await db.schema.dropTable('memory_relations').execute();
  await db.schema.dropTable('memories').execute();
}
