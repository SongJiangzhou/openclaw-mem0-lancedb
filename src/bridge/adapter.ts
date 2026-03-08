import { openMemoryTable } from '../db/table';
import type { MemoryRow } from '../db/schema';
import { embedText } from '../hot/embedder';
import type { MemorySyncPayload, EmbeddingConfig } from '../types';

export interface MemoryAdapterRecord {
  memory_uid: string;
  memory: MemorySyncPayload;
}

export interface MemoryAdapter {
  upsertMemory(record: MemoryAdapterRecord): Promise<void>;
  exists(memoryUid: string): Promise<boolean>;
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
}

export class LanceDbMemoryAdapter implements MemoryAdapter {
  private readonly lancedbPath: string;
  private readonly config?: EmbeddingConfig;

  constructor(lancedbPath: string, config?: EmbeddingConfig) {
    this.lancedbPath = lancedbPath;
    this.config = config;
  }

  async upsertMemory(record: MemoryAdapterRecord): Promise<void> {
    const dim = this.config?.dimension || 16;
    const table = await openMemoryTable(this.lancedbPath, dim);
    const row = await toLanceRow(record, this.config);
    
    await table.mergeInsert('memory_uid')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row as unknown as Record<string, unknown>]);
  }

  async exists(memoryUid: string): Promise<boolean> {
    const dim = this.config?.dimension || 16;
    const table = await openMemoryTable(this.lancedbPath, dim);
    const rows = await table.query().where(`memory_uid = '${memoryUid}'`).limit(1).toArray();
    return rows.length > 0;
  }
}

async function toLanceRow(record: MemoryAdapterRecord, config?: EmbeddingConfig): Promise<MemoryRow> {
  const memory = record.memory;

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
    lancedb_row_key: record.memory_uid,
    vector: await embedText(memory.text, config),
  };
}
