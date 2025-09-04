#!/usr/bin/env bun
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const execAsync = promisify(exec);

async function generateTypes() {
  const dbUrl = process.env.MEMORY_DB_URL;
  
  if (!dbUrl) {
    console.error('MEMORY_DB_URL environment variable is not set');
    process.exit(1);
  }

  // Set DATABASE_URL for kysely-codegen
  process.env.DATABASE_URL = dbUrl;
  
  try {
    console.log('Generating Kysely types from database...');
    const { stdout, stderr } = await execAsync('npx kysely-codegen --dialect postgres --out-file src/types/database-generated.ts');
    
    if (stderr) {
      console.error('Error output:', stderr);
    }
    
    if (stdout) {
      console.log(stdout);
    }
    
    console.log('✅ Types generated successfully at src/types/database-generated.ts');
  } catch (error) {
    console.error('Failed to generate types:', error);
    process.exit(1);
  }
}

generateTypes();