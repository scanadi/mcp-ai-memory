import { db } from './src/database/index.js';
import { sql } from 'kysely';

async function testUserContext() {
  console.log('Checking user contexts in database:\n');
  
  // Check all unique user contexts
  const contexts = await sql`
    SELECT DISTINCT user_context, COUNT(*) as count
    FROM memories
    WHERE deleted_at IS NULL
    GROUP BY user_context
    ORDER BY count DESC
  `.execute(db);
  
  console.log('User contexts:');
  contexts.rows.forEach((c: any) => {
    console.log(`  - "${c.user_context}": ${c.count} memories`);
  });
  
  // Check memories with embeddings by context
  const withEmbeddings = await sql`
    SELECT user_context, COUNT(*) as count
    FROM memories
    WHERE deleted_at IS NULL
      AND embedding IS NOT NULL
    GROUP BY user_context
  `.execute(db);
  
  console.log('\nMemories with embeddings by context:');
  withEmbeddings.rows.forEach((c: any) => {
    console.log(`  - "${c.user_context}": ${c.count} memories with embeddings`);
  });
  
  // Check the KPI memory specifically
  const kpiMemory = await sql`
    SELECT id, user_context, tags, embedding IS NOT NULL as has_embedding
    FROM memories
    WHERE id = '46cf1533-72f3-4c0f-8273-6bf94dfc2181'
  `.execute(db);
  
  console.log('\nKPI memory details:');
  if (kpiMemory.rows.length > 0) {
    const m = kpiMemory.rows[0] as any;
    console.log(`  ID: ${m.id}`);
    console.log(`  User context: "${m.user_context}"`);
    console.log(`  Has embedding: ${m.has_embedding}`);
    console.log(`  Tags: ${m.tags}`);
  }
  
  await db.destroy();
}

testUserContext().catch(console.error);