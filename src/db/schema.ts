export const MEMORY_TABLE = 'memory_records';

export interface MemoryRow {
  memory_uid: string;
  user_id: string;
  run_id: string;
  scope: string;
  text: string;
  categories: string;    // JSON array string
  tags: string;          // JSON array string
  ts_event: string;      // ISO datetime
  source: string;
  status: string;        // active | superseded | deleted
  sensitivity: string;   // public | internal | confidential | restricted
  openclaw_refs: string; // JSON object string
  mem0_id: string;
  mem0_event_id: string;
  mem0_hash: string;
  lancedb_row_key: string;
  vector: number[];
}
