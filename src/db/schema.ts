export function getMemoryTableName(dim: number): string {
  return dim === 16 ? 'memory_records' : `memory_records_d${dim}`;
}

export interface MemoryRow {
  memory_uid: string;
  user_id: string;
  run_id: string;
  scope: string;
  text: string;
  categories: string[];    // Array of strings
  tags: string[];          // Array of strings
  memory_type: string;
  domains: string[];
  source_kind: string;
  confidence: number;
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
