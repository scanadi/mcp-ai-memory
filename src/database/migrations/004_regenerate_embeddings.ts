import { type Kysely, sql } from 'kysely';
import { EmbeddingService } from '../../services/embedding-service.js';
import type { Database } from '../../types/database.js';
import { extractTextForEmbedding } from '../../utils/text-extraction.js';

export async function up(db: Kysely<Database>): Promise<void> {
  console.log('[Migration 004] Starting to regenerate embeddings with text extraction...');

  const embeddingService = new EmbeddingService();

  // Get all memories that have embeddings
  const memories = await db
    .selectFrom('memories')
    .select(['id', 'content', 'tags', 'type', 'source'])
    .where('deleted_at', 'is', null)
    .where('embedding', 'is not', null)
    .execute();

  console.log(`[Migration 004] Found ${memories.length} memories to regenerate embeddings for`);

  let successCount = 0;
  let errorCount = 0;

  for (const memory of memories) {
    try {
      // Parse content if it's a JSON string
      let parsedContent: unknown;
      try {
        parsedContent = typeof memory.content === 'string' ? JSON.parse(memory.content as string) : memory.content;
      } catch {
        parsedContent = memory.content;
      }

      // Extract meaningful text
      const textForEmbedding = extractTextForEmbedding(parsedContent, memory.tags || undefined, memory.type);

      // Generate new embedding
      const embedding = await embeddingService.generateEmbedding(textForEmbedding);
      const embeddingString = `[${embedding.join(',')}]`;

      // Update the memory with new embedding
      await db
        .updateTable('memories')
        .set({
          embedding: sql`${embeddingString}::vector`,
          embedding_dimension: embedding.length,
          updated_at: new Date(),
        })
        .where('id', '=', memory.id)
        .execute();

      successCount++;

      if (successCount % 10 === 0) {
        console.log(`[Migration 004] Progress: ${successCount}/${memories.length} embeddings regenerated`);
      }
    } catch (error) {
      console.error(`[Migration 004] Failed to regenerate embedding for memory ${memory.id}:`, error);
      errorCount++;
    }
  }

  console.log(`[Migration 004] Completed: ${successCount} successful, ${errorCount} errors`);

  // Clear the embedding cache since we've regenerated everything
  await sql`TRUNCATE TABLE IF EXISTS embedding_cache`.execute(db).catch(() => {
    // Table might not exist, that's ok
  });
}

export async function down(_db: Kysely<Database>): Promise<void> {
  // This migration cannot be reversed - we can't restore the old embeddings
  console.log('[Migration 004] This migration cannot be reversed (embeddings have been regenerated)');
}
