import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Memories, MemoryRelations } from './database-generated.js';

// Re-export the generated database interface
export type { DB as Database } from './database-generated.js';

// Map generated types to our naming convention
export type MemoryTable = Memories;
export type MemoryRelationTable = MemoryRelations;

// Type aliases for common operations
export type Memory = Selectable<MemoryTable>;
export type NewMemory = Insertable<MemoryTable>;
export type MemoryUpdate = Updateable<MemoryTable>;
export type MemoryRelation = Selectable<MemoryRelationTable>;
export type NewMemoryRelation = Insertable<MemoryRelationTable>;
export type MemoryRelationUpdate = Updateable<MemoryRelationTable>;

// Specific type exports for better type safety
export type MemoryState = 'active' | 'dormant' | 'archived' | 'expired';
export type RelationType =
  | 'references'
  | 'contradicts'
  | 'supports'
  | 'extends'
  | 'causes'
  | 'caused_by'
  | 'precedes'
  | 'follows'
  | 'part_of'
  | 'contains'
  | 'relates_to';
export type MemoryType =
  | 'fact'
  | 'conversation'
  | 'decision'
  | 'insight'
  | 'context'
  | 'preference'
  | 'task'
  | 'error'
  | 'merged'
  | 'summary';
