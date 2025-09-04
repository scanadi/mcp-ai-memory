import { type Kysely, sql } from 'kysely';
import type { Database } from '../../types/database.js';

export async function up(db: Kysely<Database>): Promise<void> {
  console.log('[Migration 003] Starting to fix existing embeddings...');

  // First, let's check if there are any embeddings stored as JSON strings
  // We need to cast to text first to use LIKE operator
  const checkResult = await sql`
    SELECT COUNT(*) as count 
    FROM memories 
    WHERE embedding IS NOT NULL 
      AND embedding::text NOT LIKE '[%'
      AND deleted_at IS NULL
  `.execute(db);

  const jsonEmbeddingsCount = Number((checkResult.rows[0] as any)?.count || 0);

  if (jsonEmbeddingsCount > 0) {
    console.log(`[Migration 003] Found ${jsonEmbeddingsCount} embeddings stored as JSON strings. Converting...`);

    // Convert JSON-stored embeddings to PostgreSQL vector format
    // This handles embeddings that were stored as JSON arrays like "[1,2,3]" or JSON strings like '"[1,2,3]"'
    await sql`
      UPDATE memories
      SET embedding = 
        CASE
          -- Handle double-encoded JSON strings (starts with '"[' and ends with ']"')
          WHEN embedding::text LIKE '"%[%]%"' THEN
            TRIM(BOTH '"' FROM embedding::text)::vector
          -- Handle JSON arrays stored as text (starts with '[' directly)
          WHEN embedding::text LIKE '[%]' THEN
            embedding::text::vector
          -- Handle other JSON formats (parse JSON then convert)
          ELSE
            ('['|| TRIM(BOTH '[]' FROM TRIM(BOTH '"' FROM embedding::text)) ||']')::vector
        END
      WHERE embedding IS NOT NULL
        AND embedding::text NOT LIKE '[%'
        AND deleted_at IS NULL
    `
      .execute(db)
      .catch(async (error) => {
        console.error('[Migration 003] Batch update failed, trying row-by-row conversion:', error);

        // If batch update fails, try converting row by row
        const memories = await sql`
        SELECT id, embedding::text as embedding 
        FROM memories 
        WHERE embedding IS NOT NULL 
          AND embedding::text NOT LIKE '[%'
          AND deleted_at IS NULL
      `.execute(db);

        for (const row of memories.rows) {
          const memory = row as { id: string; embedding: string };
          try {
            let embeddingArray: number[] = [];

            // Try to parse the embedding
            try {
              const parsed = JSON.parse(memory.embedding);
              if (Array.isArray(parsed)) {
                embeddingArray = parsed;
              } else if (typeof parsed === 'string') {
                // Double-encoded JSON
                embeddingArray = JSON.parse(parsed);
              }
            } catch {
              console.warn(`[Migration 003] Could not parse embedding for memory ${memory.id}, skipping`);
              continue;
            }

            if (embeddingArray.length > 0) {
              const vectorString = `[${embeddingArray.join(',')}]`;
              await sql`
              UPDATE memories 
              SET embedding = ${vectorString}::vector 
              WHERE id = ${memory.id}
            `.execute(db);
              console.log(`[Migration 003] Fixed embedding for memory ${memory.id}`);
            }
          } catch (error) {
            console.error(`[Migration 003] Failed to fix embedding for memory ${memory.id}:`, error);
          }
        }
      });

    console.log('[Migration 003] Embeddings conversion completed');
  } else {
    console.log('[Migration 003] No JSON-stored embeddings found. All embeddings are already in vector format.');
  }

  // Verify the fix by checking if embeddings are now searchable
  try {
    const testResult = await sql`
      SELECT COUNT(*) as count
      FROM memories
      WHERE embedding IS NOT NULL
        AND deleted_at IS NULL
        AND embedding::text LIKE '[%'
    `.execute(db);

    console.log(`[Migration 003] Verified ${(testResult.rows[0] as any)?.count || 0} embeddings are now in vector format`);
  } catch (error) {
    console.error('[Migration 003] Could not verify embeddings:', error);
  }
}

export async function down(_db: Kysely<Database>): Promise<void> {
  // This migration is not reversible as we're converting from JSON to vector format
  // and we don't want to convert back to the broken format
  console.log('[Migration 003] This migration cannot be reversed (embeddings remain in vector format)');
}
