import { type Kysely, sql } from 'kysely';
import type { Database } from '../../types/database.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Check what columns already exist to make migration idempotent
  const checkColumnExists = async (table: string, column: string) => {
    const result = await sql`
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = ${table} AND column_name = ${column}
    `.execute(db);
    return result.rows.length > 0;
  };

  const checkConstraintExists = async (constraint: string) => {
    const result = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = ${constraint}
    `.execute(db);
    return result.rows.length > 0;
  };

  const checkIndexExists = async (index: string) => {
    const result = await sql`
      SELECT 1 FROM pg_indexes WHERE indexname = ${index}
    `.execute(db);
    return result.rows.length > 0;
  };

  // 1. Add decay-related fields to memories table (if missing)
  if (!(await checkColumnExists('memories', 'state'))) {
    await sql`ALTER TABLE memories ADD COLUMN state varchar(20) DEFAULT 'active'`.execute(db);
  }

  if (!(await checkColumnExists('memories', 'decay_score'))) {
    await sql`ALTER TABLE memories ADD COLUMN decay_score real DEFAULT 1.0`.execute(db);
  }

  if (!(await checkColumnExists('memories', 'last_decay_update'))) {
    await sql`ALTER TABLE memories ADD COLUMN last_decay_update timestamptz DEFAULT CURRENT_TIMESTAMP`.execute(db);
  }

  // 2. Add updated_at to memory_relations (if missing)
  if (!(await checkColumnExists('memory_relations', 'updated_at'))) {
    await sql`ALTER TABLE memory_relations ADD COLUMN updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL`.execute(
      db
    );

    // Create trigger for updated_at
    await sql`
      CREATE OR REPLACE FUNCTION update_memory_relations_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db);

    await sql`
      CREATE TRIGGER update_memory_relations_updated_at
      BEFORE UPDATE ON memory_relations
      FOR EACH ROW
      EXECUTE FUNCTION update_memory_relations_updated_at();
    `.execute(db);
  }

  // 3. Add CHECK constraint for relation types (if missing)
  if (!(await checkConstraintExists('chk_relation_type'))) {
    await sql`
      ALTER TABLE memory_relations
      ADD CONSTRAINT chk_relation_type CHECK (
        relation_type IN (
          'references', 'contradicts', 'supports', 'extends',
          'causes', 'caused_by', 'precedes', 'follows',
          'part_of', 'contains', 'relates_to'
        )
      )
    `.execute(db);
  }

  // 4. Fix UNIQUE constraint on memory_relations
  // Drop old constraint if it exists
  if (await checkConstraintExists('unique_memory_relation')) {
    await sql`ALTER TABLE memory_relations DROP CONSTRAINT unique_memory_relation`.execute(db);
  }

  // Add correct unique constraint (only from_memory_id, to_memory_id)
  if (!(await checkConstraintExists('unique_memory_pair'))) {
    await sql`
      ALTER TABLE memory_relations 
      ADD CONSTRAINT unique_memory_pair UNIQUE (from_memory_id, to_memory_id)
    `.execute(db);
  }

  // 5. Create composite indexes for efficient traversal (if missing)
  if (!(await checkIndexExists('idx_memory_relations_from_type'))) {
    await sql`
      CREATE INDEX idx_memory_relations_from_type 
      ON memory_relations(from_memory_id, relation_type)
    `.execute(db);
  }

  if (!(await checkIndexExists('idx_memory_relations_to_type'))) {
    await sql`
      CREATE INDEX idx_memory_relations_to_type 
      ON memory_relations(to_memory_id, relation_type)
    `.execute(db);
  }

  if (!(await checkIndexExists('idx_memory_relations_strength'))) {
    await sql`
      CREATE INDEX idx_memory_relations_strength 
      ON memory_relations(strength DESC)
    `.execute(db);
  }

  // 6. Add GIN index for tags (if missing)
  if (!(await checkIndexExists('idx_memories_tags'))) {
    await sql`CREATE INDEX idx_memories_tags ON memories USING GIN (tags)`.execute(db);
  }

  // 7. Add indexes for decay queries (if missing)
  if (!(await checkIndexExists('idx_memories_state'))) {
    await sql`CREATE INDEX idx_memories_state ON memories(state)`.execute(db);
  }

  if (!(await checkIndexExists('idx_memories_decay_score'))) {
    await sql`CREATE INDEX idx_memories_decay_score ON memories(decay_score)`.execute(db);
  }

  // 8. Make embedding column nullable (for test data)
  await sql`ALTER TABLE memories ALTER COLUMN embedding DROP NOT NULL`.execute(db).catch(() => {
    // Column might already be nullable
  });

  // 9. Normalize existing relation types
  await sql`
    UPDATE memory_relations
    SET relation_type = 'relates_to'
    WHERE relation_type NOT IN (
      'references', 'contradicts', 'supports', 'extends',
      'causes', 'caused_by', 'precedes', 'follows',
      'part_of', 'contains', 'relates_to'
    )
  `.execute(db);

  // 10. Backfill data for existing records

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

  // Compute initial decay_score based on importance and time
  await sql`
    UPDATE memories
    SET decay_score = GREATEST(0, LEAST(1,
      COALESCE(importance_score, 0.5) * 
      EXP(-COALESCE(decay_rate, 0.01) * 
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(accessed_at, created_at))) / 86400.0) *
      COALESCE(confidence, 1.0) +
      LN(1 + COALESCE(access_count, 0)) * 0.1
    ))
    WHERE (decay_score IS NULL OR decay_score = 1.0) AND deleted_at IS NULL
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
    WHERE deleted_at IS NULL AND state = 'active'
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Drop triggers
  await sql`DROP TRIGGER IF EXISTS update_memory_relations_updated_at ON memory_relations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS update_memory_relations_updated_at()`.execute(db);

  // Drop indexes
  await sql`DROP INDEX IF EXISTS idx_memories_tags`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memories_state`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memories_decay_score`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memory_relations_from_type`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memory_relations_to_type`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memory_relations_strength`.execute(db);

  // Drop constraints
  await sql`ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS unique_memory_pair`.execute(db);
  await sql`ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS chk_relation_type`.execute(db);

  // Drop columns (be careful - this loses data!)
  await sql`ALTER TABLE memories DROP COLUMN IF EXISTS state`.execute(db);
  await sql`ALTER TABLE memories DROP COLUMN IF EXISTS decay_score`.execute(db);
  await sql`ALTER TABLE memories DROP COLUMN IF EXISTS last_decay_update`.execute(db);
  await sql`ALTER TABLE memory_relations DROP COLUMN IF EXISTS updated_at`.execute(db);
}
