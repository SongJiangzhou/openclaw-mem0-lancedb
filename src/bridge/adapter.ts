import { openMemoryTable } from '../db/table';
import type { MemoryRow } from '../db/schema';
import { embedText } from '../hot/embedder';
import type { MemorySyncPayload } from '../types';

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

  constructor(lancedbPath: string) {
    this.lancedbPath = lancedbPath;
  }

  async upsertMemory(record: MemoryAdapterRecord): Promise<void> {
    const table = await openMemoryTable(this.lancedbPath);
    const row = toLanceRow(record);
    const existing = await table.query().where(`memory_uid = '${row.memory_uid}'`).limit(1).toArray();

    if (existing.length > 0) {
      await table.delete(`memory_uid = '${row.memory_uid}'`);
    }

    await table.add([row as unknown as Record<string, unknown>]);
  }

  async exists(memoryUid: string): Promise<boolean> {
    const table = await openMemoryTable(this.lancedbPath);
    const rows = await table.query().where(`memory_uid = '${memoryUid}'`).limit(1).toArray();
    return rows.length > 0;
  }
}

function toLanceRow(record: MemoryAdapterRecord): MemoryRow {
  const memory = record.memory;

  return {
    memory_uid: record.memory_uid,
    user_id: memory.user_id,
    run_id: memory.run_id || '',
    scope: memory.scope,
    text: memory.text,
    categories: JSON.stringify(memory.categories || []),
    tags: JSON.stringify(memory.tags || []),
    ts_event: memory.ts_event,
    source: memory.source,
    status: memory.status,
    sensitivity: memory.sensitivity || 'internal',
    openclaw_refs: JSON.stringify(memory.openclaw_refs || {}),
    mem0_id: memory.mem0?.mem0_id || '',
    mem0_event_id: memory.mem0?.event_id || '',
    mem0_hash: memory.mem0?.hash || '',
    lancedb_row_key: record.memory_uid,
    vector: embedText(memory.text),
  };
}
