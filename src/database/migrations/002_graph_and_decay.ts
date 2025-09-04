import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add decay-related fields to memories table
  await db.schema
    .alterTable('memories')
    .addColumn('state', 'varchar(20)', (col) => col.defaultTo('active'))
    .addColumn('decay_score', 'real', (col) => col.defaultTo(1.0))
    .addColumn('last_decay_update', 'timestamptz', (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // Add CHECK constraint for relation_type in memory_relations
  await sql`
    ALTER TABLE memory_relations
    ADD CONSTRAINT check_relation_type CHECK (
      relation_type IN (
        'references', 'contradicts', 'supports', 'extends',
        'causes', 'caused_by', 'precedes', 'follows',
        'part_of', 'contains', 'relates_to'
      )
    )
  `.execute(db);

  // Add UNIQUE constraint to prevent duplicate edges
  await sql`
    ALTER TABLE memory_relations
    ADD CONSTRAINT unique_memory_relation 
    UNIQUE (from_memory_id, to_memory_id, relation_type)
  `.execute(db);

  // Add indexes for memory_relations
  await db.schema
    .createIndex('idx_memory_relations_from_type')
    .on('memory_relations')
    .columns(['from_memory_id', 'relation_type'])
    .execute();

  await db.schema
    .createIndex('idx_memory_relations_to_type')
    .on('memory_relations')
    .columns(['to_memory_id', 'relation_type'])
    .execute();

  // Add GIN index for tags
  await sql`CREATE INDEX idx_memories_tags ON memories USING GIN (tags)`.execute(db);

  // Normalize existing relation_type values
  await sql`
    UPDATE memory_relations
    SET relation_type = CASE
      WHEN relation_type IN ('references', 'contradicts', 'supports', 'extends') THEN relation_type
      ELSE 'relates_to'
    END
    WHERE relation_type NOT IN ('references', 'contradicts', 'supports', 'extends')
  `.execute(db);

  // Log unmapped relation types (for audit)
  await sql`
    DO $$
    DECLARE
      unmapped_count INTEGER;
    BEGIN
      SELECT COUNT(DISTINCT relation_type) INTO unmapped_count
      FROM memory_relations
      WHERE relation_type NOT IN (
        'references', 'contradicts', 'supports', 'extends',
        'causes', 'caused_by', 'precedes', 'follows',
        'part_of', 'contains', 'relates_to'
      );
      
      IF unmapped_count > 0 THEN
        RAISE NOTICE 'Normalized % unmapped relation types to relates_to', unmapped_count;
      END IF;
    END $$
  `.execute(db);

  // Backfill state for existing memories
  await sql`
    UPDATE memories
    SET state = 'active'
    WHERE state IS NULL
  `.execute(db);

  // Backfill last_decay_update
  await sql`
    UPDATE memories
    SET last_decay_update = CURRENT_TIMESTAMP
    WHERE last_decay_update IS NULL
  `.execute(db);

  // Backfill accessed_at with created_at if NULL
  await sql`
    UPDATE memories
    SET accessed_at = created_at
    WHERE accessed_at IS NULL
  `.execute(db);

  // Compute initial decay_score based on the plan's formula
  // Base: importance_score * exp(-effective_decay_rate * days_since_access)
  // Add log1p(access_count) * 0.1, multiply by confidence, clamp to [0,1]
  await sql`
    UPDATE memories
    SET decay_score = GREATEST(0, LEAST(1,
      importance_score * 
      EXP(-COALESCE(decay_rate, 0.01) * 
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(accessed_at, created_at))) / 86400.0) *
      confidence +
      LN(1 + access_count) * 0.1
    ))
    WHERE decay_score IS NULL OR decay_score = 1.0
  `.execute(db);

  // Set initial state based on decay_score thresholds
  await sql`
    UPDATE memories
    SET state = CASE
      WHEN decay_score >= 0.5 THEN 'active'
      WHEN decay_score >= 0.1 THEN 'dormant'
      WHEN decay_score >= 0.01 THEN 'archived'
      ELSE 'expired'
    END
    WHERE deleted_at IS NULL
  `.execute(db);

  // Backfill embedding_dimension from existing vectors
  await sql`
    UPDATE memories
    SET embedding_dimension = array_length(embedding::real[], 1)
    WHERE embedding IS NOT NULL AND embedding_dimension IS NULL
  `.execute(db);

  // Create a function to validate relation types during insert/update
  await sql`
    CREATE OR REPLACE FUNCTION validate_relation_type()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.relation_type NOT IN (
        'references', 'contradicts', 'supports', 'extends',
        'causes', 'caused_by', 'precedes', 'follows',
        'part_of', 'contains', 'relates_to'
      ) THEN
        NEW.relation_type = 'relates_to';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER validate_relation_type_trigger
    BEFORE INSERT OR UPDATE ON memory_relations
    FOR EACH ROW EXECUTE FUNCTION validate_relation_type();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop trigger and function
  await sql`DROP TRIGGER IF EXISTS validate_relation_type_trigger ON memory_relations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_relation_type()`.execute(db);

  // Drop indexes
  await sql`DROP INDEX IF EXISTS idx_memories_tags`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memory_relations_to_type`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memory_relations_from_type`.execute(db);

  // Drop constraints
  await sql`ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS unique_memory_relation`.execute(db);
  await sql`ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS check_relation_type`.execute(db);

  // Drop columns from memories table
  await db.schema
    .alterTable('memories')
    .dropColumn('state')
    .dropColumn('decay_score')
    .dropColumn('last_decay_update')
    .execute();
}
