/**
 * Memory record structure aligned with the migrated TS bridge schema
 */
export interface MemoryRecord {
  memory_uid: string;
  user_id: string;
  session_id?: string;
  agent_id?: string;
  run_id?: string | null;
  scope: 'long-term' | 'session';
  text: string;
  categories?: string[];
  tags?: string[];
  memory_type?: MemoryType;
  domains?: MemoryDomain[];
  source_kind?: MemorySourceKind;
  confidence?: number;
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
  lifecycle_state?: LifecycleState;
  strength?: number;
  stability?: number;
  last_access_ts?: string;
  next_review_ts?: string;
  access_count?: number;
  inhibition_weight?: number;
  inhibition_until?: string;
  utility_score?: number;
  risk_score?: number;
  retention_deadline?: string;
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  lancedbPath: string;
  mem0?: Mem0Config;
  mem0Mode?: Mem0Mode;
  mem0BaseUrl: string;
  mem0ApiKey: string;
  outboxDbPath: string;
  auditStorePath: string;
  autoRecall: AutoRecallConfig;
  autoCapture: AutoCaptureConfig;
  embedding: EmbeddingConfig;
  embeddingMigration?: EmbeddingMigrationConfig;
  memoryConsolidation?: MemoryConsolidationConfig;
  debug?: DebugConfig;
}

export interface EmbeddingConfig {
  provider: 'openai' | 'gemini' | 'ollama' | 'voyage' | 'fake';
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
}

export type Mem0Mode = 'local' | 'remote' | 'disabled';

export interface Mem0Config {
  mode: Mem0Mode;
  baseUrl: string;
  apiKey: string;
  autoStartLocal?: boolean;
  llm?: Mem0LlmConfig;
}

export interface Mem0LlmConfig {
  provider: 'openai' | 'gemini' | 'ollama' | 'deepseek';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface EmbeddingMigrationConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export interface MemoryConsolidationConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export type DebugMode = 'off' | 'debug';

export interface DebugConfig {
  mode: DebugMode;
}

export interface AutoRecallConfig {
  enabled: boolean;
  topK: number;
  maxChars: number;
  scope: 'long-term' | 'all';
  reranker?: RecallRerankerConfig;
}

export interface RecallRerankerConfig {
  provider: 'local' | 'voyage' | 'none';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AutoCaptureConfig {
  enabled: boolean;
  scope: 'long-term' | 'session';
  requireAssistantReply: boolean;
  maxCharsPerMessage: number;
}

/**
 * Search parameters
 */
export interface SearchParams {
  query: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  topK?: number;
  filters?: {
    scope?: string;
    status?: string;
    categories?: string[];
    memoryType?: MemoryType;
    domains?: MemoryDomain[];
  };
}

/**
 * Store parameters
 */
export interface StoreParams {
  text: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  scope?: 'long-term' | 'session';
  metadata?: Record<string, any>;
  categories?: string[];
  memoryType?: MemoryType;
  domains?: MemoryDomain[];
  sourceKind?: MemorySourceKind;
  confidence?: number;
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
  session_id?: string;
  agent_id?: string;
  run_id?: string | null;
  scope: 'long-term' | 'session';
  text: string;
  categories?: string[];
  tags?: string[];
  memory_type?: MemoryType;
  domains?: MemoryDomain[];
  source_kind?: MemorySourceKind;
  confidence?: number;
  ts_event: string;
  source: 'openclaw';
  status: 'active' | 'superseded' | 'deleted';
  lifecycle_state?: LifecycleState;
  strength?: number;
  stability?: number;
  last_access_ts?: string;
  next_review_ts?: string;
  access_count?: number;
  inhibition_weight?: number;
  inhibition_until?: string;
  utility_score?: number;
  risk_score?: number;
  retention_deadline?: string;
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

export type LifecycleState = 'active' | 'reinforced' | 'inhibited' | 'superseded' | 'quarantined' | 'deleted';

export interface MemorySyncResult {
  status: MemorySyncStatus;
  memory_uid: string;
}

export type MemoryType = 'preference' | 'profile' | 'credential' | 'metadata' | 'system' | 'experience' | 'task_context' | 'generic';
export type MemoryDomain = 'game' | 'food' | 'work' | 'travel' | 'tooling' | 'personal' | 'generic';
export type MemorySourceKind = 'user_explicit' | 'assistant_inferred' | 'system_generated' | 'imported';
