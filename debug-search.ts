import { db } from './src/database/index.js';
import { MemoryService } from './src/services/memory-service.js';
import { sql } from 'kysely';

async function debugSearch() {
  const memoryService = new MemoryService(db);
  
  console.log('=== DEBUGGING MEMORY SEARCH ===\n');
  
  // 1. Check if memory with KPI exists
  console.log('1. Checking for memories with "kpi" in tags or content:');
  const kpiMemories = await sql`
    SELECT id, tags, embedding IS NOT NULL as has_embedding, embedding_dimension, user_context
    FROM memories
    WHERE deleted_at IS NULL
    AND (
      array_to_string(tags, ',') ILIKE '%kpi%'
      OR content::text ILIKE '%kpi%'
    )
  `.execute(db);
  
  console.log(`Found ${kpiMemories.rows.length} memories with KPI:`);
  kpiMemories.rows.forEach((m: any) => {
    console.log(`  - ${m.id}: tags=${m.tags}, has_embedding=${m.has_embedding}, dim=${m.embedding_dimension}, context=${m.user_context}`);
  });
  
  // 2. Test direct search with different parameters
  console.log('\n2. Testing search with query "KPI":');
  try {
    const searchResults = await memoryService.search({
      query: 'KPI key performance indicator',
      threshold: 0.3,
      limit: 10,
      user_context: 'default'
    });
    console.log(`Found ${searchResults.length} results`);
    if (searchResults.length > 0) {
      searchResults.forEach(r => {
        console.log(`  - ${r.id}: ${(r as any).similarity}`);
      });
    }
  } catch (error) {
    console.error('Search error:', error);
  }
  
  // 3. Check embedding generation
  console.log('\n3. Testing embedding generation:');
  const { EmbeddingService } = await import('./src/services/embedding-service.js');
  const embeddingService = new EmbeddingService();
  const testEmbedding = await embeddingService.generateEmbedding('KPI key performance indicator');
  console.log(`Generated embedding dimension: ${testEmbedding.length}`);
  console.log(`First 5 values: [${testEmbedding.slice(0, 5).join(', ')}...]`);
  
  // 4. Test raw SQL search
  console.log('\n4. Testing raw SQL vector search:');
  const embeddingString = `[${testEmbedding.join(',')}]`;
  
  try {
    const rawSearch = await sql`
      SELECT 
        id,
        tags,
        user_context,
        1 - (embedding::vector <=> ${embeddingString}::vector) as similarity
      FROM memories
      WHERE deleted_at IS NULL
        AND embedding IS NOT NULL
        AND user_context = 'default'
      ORDER BY embedding::vector <=> ${embeddingString}::vector
      LIMIT 5
    `.execute(db);
    
    console.log(`Raw SQL found ${rawSearch.rows.length} results:`);
    rawSearch.rows.forEach((r: any) => {
      console.log(`  - ${r.id} (${r.tags}): similarity=${r.similarity.toFixed(4)}, context=${r.user_context}`);
    });
  } catch (error) {
    console.error('Raw SQL error:', error);
  }
  
  // 5. Check if there's a dimension mismatch
  console.log('\n5. Checking embedding dimensions:');
  const dimensions = await sql`
    SELECT DISTINCT embedding_dimension, COUNT(*) as count
    FROM memories
    WHERE embedding IS NOT NULL
    GROUP BY embedding_dimension
  `.execute(db);
  
  console.log('Embedding dimensions in database:');
  dimensions.rows.forEach((d: any) => {
    console.log(`  - ${d.embedding_dimension}: ${d.count} memories`);
  });
  
  await db.destroy();
}

debugSearch().catch(console.error);