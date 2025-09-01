import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface MemoryTable {
  id: Generated<string>;
  user_context: string;
  content: ColumnType<Record<string, unknown>, string, string>; // JSONB
  content_hash: string;
  embedding: ColumnType<number[] | null, string | null, string | null>; // vector type (nullable for async)
  embedding_dimension: ColumnType<number | null, number | undefined, number | undefined>; // Track dimension of each embedding
  tags: string[];
  type: string;
  source: string;
  confidence: number;
  similarity_threshold: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  accessed_at: ColumnType<Date, Date | undefined, Date>;
  deleted_at: ColumnType<Date | null, Date | undefined, Date | undefined>;
  access_count: Generated<number>;

  // New fields for v2
  parent_id: string | null;
  relation_type: 'extends' | 'contradicts' | 'supports' | 'references' | null;
  cluster_id: string | null; // Changed from uuid to text to support numeric IDs
  importance_score: number;
  decay_rate: number;
  metadata: ColumnType<Record<string, unknown> | null, string | null, string | null>; // JSONB for additional data
  is_compressed: Generated<boolean>; // Whether content is compressed
}

export interface MemoryRelationTable {
  id: Generated<string>;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: 'references' | 'contradicts' | 'supports' | 'extends';
  strength: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface Database {
  memories: MemoryTable;
  memory_relations: MemoryRelationTable;
}

export type Memory = Selectable<MemoryTable>;
export type NewMemory = Insertable<MemoryTable>;
export type MemoryUpdate = Updateable<MemoryTable>;
export type MemoryRelation = Selectable<MemoryRelationTable>;
export type NewMemoryRelation = Insertable<MemoryRelationTable>;
export type MemoryRelationUpdate = Updateable<MemoryRelationTable>;
