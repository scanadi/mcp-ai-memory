import { db } from './src/database/index.js';
import { sql } from 'kysely';

async function checkEmbeddings() {
  console.log('Checking embedding storage format...\n');
  
  try {
    // Check embedding format
    const sample = await sql`
      SELECT 
        id, 
        substring(embedding::text, 1, 100) as embedding_preview,
        embedding_dimension,
        tags
      FROM memories
      WHERE embedding IS NOT NULL
        AND deleted_at IS NULL
      LIMIT 5
    `.execute(db);
    
    console.log('\n\nSample embeddings:');
    sample.rows.forEach((row: any) => {
      console.log(`\nID: ${row.id}`);
      console.log(`Tags: ${row.tags?.join(', ') || 'none'}`);
      console.log(`Dimension: ${row.embedding_dimension}`);
      console.log(`Format: ${row.embedding_preview}...`);
    });
    
    // Check if embeddings are searchable
    console.log('\n\nTesting vector search:');
    
    // Get one embedding and use it as a query
    const testMemory = await sql`
      SELECT embedding::text as embedding
      FROM memories
      WHERE embedding IS NOT NULL
        AND deleted_at IS NULL
      LIMIT 1
    `.execute(db);
    
    if (testMemory.rows.length > 0) {
      const embeddingStr = (testMemory.rows[0] as any).embedding;
      
      // Test similarity search
      const searchResult = await sql`
        SELECT 
          id,
          1 - (embedding::vector <=> ${embeddingStr}::vector) as similarity
        FROM memories
        WHERE embedding IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY embedding::vector <=> ${embeddingStr}::vector
        LIMIT 3
      `.execute(db);
      
      console.log('Vector similarity search results:');
      searchResult.rows.forEach((row: any) => {
        console.log(`  ID: ${row.id}, Similarity: ${row.similarity.toFixed(4)}`);
      });
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await db.destroy();
  }
}

checkEmbeddings();