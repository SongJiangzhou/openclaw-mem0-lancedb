import { getTableSchemaFields, openMemoryTable, sanitizeRecordsForSchema } from '../db/table';
import type { MemoryRow } from '../db/schema';
import { embedText } from '../hot/embedder';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import type { MemorySyncPayload, EmbeddingConfig } from '../types';

export interface MemoryAdapterRecord {
  memory_uid: string;
  memory: MemorySyncPayload;
}

export interface MemoryAdapter {
  upsertMemory(record: MemoryAdapterRecord): Promise<void>;
  updateMemoryMetadata(record: MemoryAdapterRecord): Promise<void>;
  exists(memoryUid: string): Promise<boolean>;
  findDuplicateMemoryUid(memory: MemorySyncPayload): Promise<string | null>;
  getMemory(memoryUid: string): Promise<MemorySyncPayload | null>;
  listMemories(filters?: { userId?: string; scope?: string; status?: string }): Promise<Array<{ memory_uid: string; memory: MemorySyncPayload }>>;
}

export class InMemoryMemoryAdapter implements MemoryAdapter {
  private readonly rows = new Map<string, MemoryAdapterRecord>();
  private readonly visible: boolean;

  constructor(options?: { visible?: boolean }) {
    this.visible = options?.visible ?? true;
  }

  async upsertMemory(record: MemoryAdapterRecord): Promise<void> {
    this.rows.set(record.memory_uid, record);
  }

  async updateMemoryMetadata(record: MemoryAdapterRecord): Promise<void> {
    this.rows.set(record.memory_uid, record);
  }

  async exists(memoryUid: string): Promise<boolean> {
    if (!this.visible) {
      return false;
    }

    return this.rows.has(memoryUid);
  }

  async findDuplicateMemoryUid(memory: MemorySyncPayload): Promise<string | null> {
    const incomingKeys = new Set(buildMemoryDedupKeys({ text: memory.text, mem0: memory.mem0 }));
    if (incomingKeys.size === 0) {
      return null;
    }

    for (const [memoryUid, record] of this.rows.entries()) {
      const existingKeys = buildMemoryDedupKeys({ text: record.memory.text, mem0: record.memory.mem0 });
      if (existingKeys.some((key) => incomingKeys.has(key))) {
        return memoryUid;
      }
    }

    return null;
  }

  async getMemory(memoryUid: string): Promise<MemorySyncPayload | null> {
    const record = this.rows.get(memoryUid);
    return record?.memory || null;
  }

  async listMemories(filters?: { userId?: string; scope?: string; status?: string }): Promise<Array<{ memory_uid: string; memory: MemorySyncPayload }>> {
    return [...this.rows.values()].filter((record) => {
      if (filters?.userId && record.memory.user_id !== filters.userId) return false;
      if (filters?.scope && record.memory.scope !== filters.scope) return false;
      if (filters?.status && record.memory.status !== filters.status) return false;
      return true;
    });
  }
}

export class LanceDbMemoryAdapter implements MemoryAdapter {
  private readonly lancedbPath: string;
  private readonly config?: EmbeddingConfig;
  private tablePromise: Promise<Awaited<ReturnType<typeof openMemoryTable>>> | null = null;

  constructor(lancedbPath: string, config?: EmbeddingConfig) {
    this.lancedbPath = lancedbPath;
    this.config = config;
  }

  async upsertMemory(record: MemoryAdapterRecord): Promise<void> {
    const table = await this.getTable();
    const row = await toLanceRow(record, this.config);

    const allowedFields = await getTableSchemaFields(table);
    const safeRows = sanitizeRecordsForSchema([row as unknown as Record<string, unknown>], allowedFields);

    await table.mergeInsert('memory_uid')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(safeRows);
  }

  async updateMemoryMetadata(record: MemoryAdapterRecord): Promise<void> {
    const table = await this.getTable();
    const existingRows = await table.query()
      .where(`memory_uid = '${escapeSqlString(record.memory_uid)}'`)
      .limit(1)
      .toArray();

    if (existingRows.length === 0) {
      await this.upsertMemory(record);
      return;
    }

    const existingRow = existingRows[0] as Record<string, unknown>;
    const memory = backfillLifecycleFields(record.memory);
    const row = {
      ...existingRow,
      user_id: memory.user_id,
      session_id: memory.session_id || '',
      agent_id: memory.agent_id || '',
      run_id: memory.run_id || '',
      scope: memory.scope,
      text: memory.text,
      categories: Array.isArray(memory.categories) ? memory.categories : [],
      tags: Array.isArray(memory.tags) ? memory.tags : [],
      memory_type: memory.memory_type || 'generic',
      domains: Array.isArray(memory.domains) ? memory.domains : ['generic'],
      source_kind: memory.source_kind || 'user_explicit',
      confidence: typeof memory.confidence === 'number' ? memory.confidence : 0.7,
      ts_event: memory.ts_event,
      source: memory.source,
      status: memory.status,
      sensitivity: memory.sensitivity || 'internal',
      openclaw_refs: JSON.stringify(memory.openclaw_refs || {}),
      mem0_id: memory.mem0?.mem0_id || '',
      mem0_event_id: memory.mem0?.event_id || '',
      mem0_hash: memory.mem0?.hash || '',
      strength: memory.strength,
      stability: memory.stability,
      last_access_ts: memory.last_access_ts,
      next_review_ts: memory.next_review_ts,
      access_count: memory.access_count,
      inhibition_weight: memory.inhibition_weight,
      inhibition_until: memory.inhibition_until,
      utility_score: memory.utility_score,
      risk_score: memory.risk_score,
      retention_deadline: memory.retention_deadline,
      lifecycle_state: memory.lifecycle_state,
      lancedb_row_key: record.memory_uid,
      vector: existingRow.vector,
    };

    const allowedFields = await getTableSchemaFields(table);
    const safeRows = sanitizeRecordsForSchema([row], allowedFields);

    await table.mergeInsert('memory_uid')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(safeRows);
  }

  async exists(memoryUid: string): Promise<boolean> {
    const table = await this.getTable();
    const rows = await table.query().where(`memory_uid = '${memoryUid}'`).limit(1).toArray();
    return rows.length > 0;
  }

  async findDuplicateMemoryUid(memory: MemorySyncPayload): Promise<string | null> {
    const incomingKeys = new Set(buildMemoryDedupKeys({ text: memory.text, mem0: memory.mem0 }));
    if (incomingKeys.size === 0) {
      return null;
    }

    const table = await this.getTable();
    const userId = escapeSqlString(memory.user_id);
    const scope = escapeSqlString(memory.scope);
    const sessionId = escapeSqlString(String(memory.session_id || ''));
    const mem0Hash = String(memory.mem0?.hash || '').trim();
    const text = String(memory.text || '').trim();
    const scopeClause = scope === 'session'
      ? `user_id = '${userId}' AND status = 'active' AND scope = '${scope}' AND session_id = '${sessionId}'`
      : `user_id = '${userId}' AND status = 'active' AND scope = '${scope}'`;

    let rows: any[] = [];
    if (mem0Hash) {
      const escapedHash = escapeSqlString(mem0Hash);
      rows = await table.query()
        .where(`${scopeClause} AND mem0_hash = '${escapedHash}'`)
        .limit(5)
        .toArray();
    }

    if (rows.length === 0 && text) {
      const escapedText = escapeSqlString(text);
      rows = await table.query()
        .where(`${scopeClause} AND text = '${escapedText}'`)
        .limit(20)
        .toArray();
    }

    for (const row of rows) {
      const existingKeys = buildMemoryDedupKeys({ text: row.text, mem0_hash: row.mem0_hash });
      if (existingKeys.some((key) => incomingKeys.has(key))) {
        return String(row.memory_uid || '');
      }
    }

    return null;
  }

  async getMemory(memoryUid: string): Promise<MemorySyncPayload | null> {
    const table = await this.getTable();
    const rows = await table.query()
      .where(`memory_uid = '${escapeSqlString(memoryUid)}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    return rowToPayload(rows[0] as Record<string, unknown>);
  }

  async listMemories(filters?: { userId?: string; scope?: string; status?: string }): Promise<Array<{ memory_uid: string; memory: MemorySyncPayload }>> {
    const table = await this.getTable();
    const clauses: string[] = [];
    if (filters?.userId) clauses.push(`user_id = '${escapeSqlString(filters.userId)}'`);
    if (filters?.scope) clauses.push(`scope = '${escapeSqlString(filters.scope)}'`);
    if (filters?.status) clauses.push(`status = '${escapeSqlString(filters.status)}'`);
    let query = table.query();
    if (clauses.length > 0) {
      query = query.where(clauses.join(' AND '));
    }
    const rows = await query.toArray();
    return rows.map((row: Record<string, unknown>) => ({
      memory_uid: String(row.memory_uid || ''),
      memory: rowToPayload(row),
    }));
  }

  private async getTable(): Promise<Awaited<ReturnType<typeof openMemoryTable>>> {
    if (!this.tablePromise) {
      const dim = this.config?.dimension || 16;
      this.tablePromise = openMemoryTable(this.lancedbPath, dim);
    }
    return this.tablePromise;
  }
}

function escapeSqlString(value: string): string {
  return String(value || '').replace(/'/g, "''");
}

async function toLanceRow(record: MemoryAdapterRecord, config?: EmbeddingConfig): Promise<MemoryRow> {
  const memory = backfillLifecycleFields(record.memory);

  return {
    memory_uid: record.memory_uid,
    user_id: memory.user_id,
    session_id: memory.session_id || '',
    agent_id: memory.agent_id || '',
    run_id: memory.run_id || '',
    scope: memory.scope,
    text: memory.text,
    categories: Array.isArray(memory.categories) ? memory.categories : [],
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    memory_type: memory.memory_type || 'generic',
    domains: Array.isArray(memory.domains) ? memory.domains : ['generic'],
    source_kind: memory.source_kind || 'user_explicit',
    confidence: typeof memory.confidence === 'number' ? memory.confidence : 0.7,
    ts_event: memory.ts_event,
    source: memory.source,
    status: memory.status,
    sensitivity: memory.sensitivity || 'internal',
    openclaw_refs: JSON.stringify(memory.openclaw_refs || {}),
    mem0_id: memory.mem0?.mem0_id || '',
    mem0_event_id: memory.mem0?.event_id || '',
    mem0_hash: memory.mem0?.hash || '',
    strength: memory.strength,
    stability: memory.stability,
    last_access_ts: memory.last_access_ts,
    next_review_ts: memory.next_review_ts,
    access_count: memory.access_count,
    inhibition_weight: memory.inhibition_weight,
    inhibition_until: memory.inhibition_until,
    utility_score: memory.utility_score,
    risk_score: memory.risk_score,
    retention_deadline: memory.retention_deadline,
    lifecycle_state: memory.lifecycle_state,
    lancedb_row_key: record.memory_uid,
    vector: await embedText(memory.text, config),
  };
}

function rowToPayload(row: Record<string, unknown>): MemorySyncPayload {
  const payload: MemorySyncPayload = {
    user_id: String(row.user_id || ''),
    session_id: String(row.session_id || ''),
    agent_id: String(row.agent_id || ''),
    run_id: String(row.run_id || ''),
    scope: row.scope === 'session' ? 'session' : 'long-term',
    text: String(row.text || ''),
    categories: Array.isArray(row.categories) ? row.categories as string[] : [],
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
    memory_type: isMemoryType(row.memory_type) ? row.memory_type : 'generic',
    domains: Array.isArray(row.domains) ? row.domains.filter(isMemoryDomain) : ['generic'],
    source_kind: isMemorySourceKind(row.source_kind) ? row.source_kind : 'assistant_inferred',
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.7,
    ts_event: String(row.ts_event || new Date().toISOString()),
    source: 'openclaw',
    status: row.status === 'deleted' ? 'deleted' : row.status === 'superseded' ? 'superseded' : 'active',
    sensitivity: row.sensitivity === 'public' || row.sensitivity === 'confidential' || row.sensitivity === 'restricted'
      ? row.sensitivity
      : 'internal',
    openclaw_refs: parseOpenClawRefs(row.openclaw_refs),
    mem0: {
      mem0_id: String(row.mem0_id || ''),
      event_id: String(row.mem0_event_id || ''),
      hash: String(row.mem0_hash || ''),
    },
    lifecycle_state: typeof row.lifecycle_state === 'string' ? row.lifecycle_state as any : undefined,
    strength: typeof row.strength === 'number' ? row.strength : undefined,
    stability: typeof row.stability === 'number' ? row.stability : undefined,
    last_access_ts: typeof row.last_access_ts === 'string' ? row.last_access_ts : undefined,
    next_review_ts: typeof row.next_review_ts === 'string' ? row.next_review_ts : undefined,
    access_count: typeof row.access_count === 'number' ? row.access_count : undefined,
    inhibition_weight: typeof row.inhibition_weight === 'number' ? row.inhibition_weight : undefined,
    inhibition_until: typeof row.inhibition_until === 'string' ? row.inhibition_until : undefined,
    utility_score: typeof row.utility_score === 'number' ? row.utility_score : undefined,
    risk_score: typeof row.risk_score === 'number' ? row.risk_score : undefined,
    retention_deadline: typeof row.retention_deadline === 'string' ? row.retention_deadline : undefined,
  };

  return backfillLifecycleFields(payload);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseOpenClawRefs(value: unknown): MemorySyncPayload['openclaw_refs'] {
  const parsed = parseJsonObject(value);
  return {
    workspace_path: typeof parsed.workspace_path === 'string' ? parsed.workspace_path : null,
    file_path: typeof parsed.file_path === 'string' ? parsed.file_path : null,
    line_start: typeof parsed.line_start === 'number' ? parsed.line_start : null,
    line_end: typeof parsed.line_end === 'number' ? parsed.line_end : null,
  };
}

function isMemoryType(value: unknown): value is NonNullable<MemorySyncPayload['memory_type']> {
  return value === 'preference'
    || value === 'profile'
    || value === 'credential'
    || value === 'metadata'
    || value === 'system'
    || value === 'experience'
    || value === 'task_context'
    || value === 'generic';
}

function isMemoryDomain(value: unknown): value is NonNullable<MemorySyncPayload['domains']>[number] {
  return value === 'game'
    || value === 'food'
    || value === 'work'
    || value === 'travel'
    || value === 'tooling'
    || value === 'personal'
    || value === 'generic';
}

function isMemorySourceKind(value: unknown): value is NonNullable<MemorySyncPayload['source_kind']> {
  return value === 'user_explicit'
    || value === 'assistant_inferred'
    || value === 'system_generated'
    || value === 'imported';
}
