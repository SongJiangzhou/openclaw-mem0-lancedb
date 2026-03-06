/**
 * Memory record structure aligned with the migrated TS bridge schema
 */
export interface MemoryRecord {
  memory_uid: string;
  user_id: string;
  run_id?: string | null;
  scope: 'long-term' | 'session';
  text: string;
  categories?: string[];
  tags?: string[];
  ts_event: string;
  ts_ingest?: string;
  source: 'openclaw';
  openclaw_refs?: {
    workspace_path?: string | null;
    file_path?: string | null;
    line_start?: number | null;
    line_end?: number | null;
  };
  mem0?: {
    mem0_id?: string | null;
    hash?: string | null;
    event_id?: string | null;
  };
  lancedb?: {
    table?: string | null;
    row_key?: string | null;
    vector_dim?: number | null;
    index_version?: string | null;
  };
  status: 'active' | 'superseded' | 'deleted';
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  lancedbPath: string;
  mem0BaseUrl: string;
  mem0ApiKey: string;
  outboxDbPath: string;
  auditStorePath: string;
  autoRecall: AutoRecallConfig;
}

export interface AutoRecallConfig {
  enabled: boolean;
  topK: number;
  maxChars: number;
  scope: 'long-term' | 'all';
}

/**
 * Search parameters
 */
export interface SearchParams {
  query: string;
  userId: string;
  topK?: number;
  filters?: {
    scope?: string;
    status?: string;
    categories?: string[];
  };
}

/**
 * Store parameters
 */
export interface StoreParams {
  text: string;
  userId: string;
  scope?: 'long-term' | 'session';
  metadata?: Record<string, any>;
  categories?: string[];
}

/**
 * Search result
 */
export interface SearchResult {
  memories: MemoryRecord[];
  source: 'lancedb' | 'mem0' | 'none';
}

/**
 * Store result
 */
export interface StoreResult {
  success: boolean;
  memoryUid?: string;
  eventId?: string;
  syncStatus?: MemorySyncStatus;
  error?: string;
}

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface OutboxItem {
  id: number;
  idempotencyKey: string;
  payload: string;
  status: OutboxStatus;
}

export interface MemorySyncPayload {
  user_id: string;
  run_id?: string | null;
  scope: 'long-term' | 'session';
  text: string;
  categories?: string[];
  tags?: string[];
  ts_event: string;
  source: 'openclaw';
  status: 'active' | 'superseded' | 'deleted';
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  openclaw_refs?: {
    workspace_path?: string | null;
    file_path?: string | null;
    line_start?: number | null;
    line_end?: number | null;
  };
  mem0?: {
    mem0_id?: string | null;
    hash?: string | null;
    event_id?: string | null;
  };
}

export type MemorySyncStatus = 'accepted' | 'synced' | 'partial' | 'failed' | 'duplicate';

export interface MemorySyncResult {
  status: MemorySyncStatus;
  memory_uid: string;
}
