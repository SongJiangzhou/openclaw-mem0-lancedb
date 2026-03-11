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
  exists(memoryUid: string): Promise<boolean>;
  findDuplicateMemoryUid(memory: MemorySyncPayload): Promise<string | null>;
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
    const mem0Hash = String(memory.mem0?.hash || '').trim();
    const text = String(memory.text || '').trim();

    let rows: any[] = [];
    if (mem0Hash) {
      const escapedHash = escapeSqlString(mem0Hash);
      rows = await table.query()
        .where(`user_id = '${userId}' AND status = 'active' AND scope = '${scope}' AND mem0_hash = '${escapedHash}'`)
        .limit(5)
        .toArray();
    }

    if (rows.length === 0 && text) {
      const escapedText = escapeSqlString(text);
      rows = await table.query()
        .where(`user_id = '${userId}' AND status = 'active' AND scope = '${scope}' AND text = '${escapedText}'`)
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
