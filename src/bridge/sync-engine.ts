import { FileAuditStore } from '../audit/store';
import type { Mem0Client } from '../control/mem0';
import { buildMemoryUid } from './uid';
import type { MemoryAdapter } from './adapter';
import type { FileOutbox } from './outbox';
import type { MemoryRecord, MemorySyncPayload, MemorySyncResult } from '../types';

export class MemorySyncEngine {
  private readonly outbox: FileOutbox;
  private readonly auditStore: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly mem0Client: Mem0Client;
  private readonly processInline: boolean;

  constructor(
    outbox: FileOutbox,
    auditStore: FileAuditStore,
    adapter: MemoryAdapter,
    mem0Client: Mem0Client,
    options?: { processInline?: boolean },
  ) {
    this.outbox = outbox;
    this.auditStore = auditStore;
    this.adapter = adapter;
    this.mem0Client = mem0Client;
    this.processInline = options?.processInline ?? true;
  }

  async processEvent(eventId: string, memory: MemorySyncPayload): Promise<MemorySyncResult> {
    const category = (memory.categories || ['general'])[0];
    const memoryUid = buildMemoryUid(
      memory.user_id,
      memory.scope,
      memory.text,
      this.tsBucket(memory.ts_event),
      category,
    );
    const record = this.toRecord(memoryUid, memory);

    try {
      await this.auditStore.append(record);
    } catch {
      return { status: 'failed', memory_uid: memoryUid };
    }

    const idempotencyKey = `${eventId}:${memoryUid}`;
    const payload = JSON.stringify({ event_id: eventId, memory_uid: memoryUid, memory });
    const inserted = await this.outbox.enqueue(idempotencyKey, payload);

    if (!inserted) {
      return { status: 'duplicate', memory_uid: memoryUid };
    }

    if (!this.processInline) {
      return { status: 'accepted', memory_uid: memoryUid };
    }

    const item = await this.outbox.claimNext();
    if (!item) {
      return { status: 'failed', memory_uid: memoryUid };
    }

    const mem0 = await this.mem0Client.syncMemory(record);
    const withControlPlane: MemorySyncPayload = {
      ...memory,
      mem0: mem0.status === 'synced'
        ? {
            mem0_id: mem0.mem0_id,
            event_id: mem0.event_id,
            hash: mem0.hash,
          }
        : memory.mem0,
    };

    await this.adapter.upsertMemory({ memory_uid: memoryUid, memory: withControlPlane });

    if (!(await this.adapter.exists(memoryUid))) {
      await this.outbox.markFailed(item.id);
      return { status: 'failed', memory_uid: memoryUid };
    }

    await this.outbox.markDone(item.id);
    return {
      status: mem0.status === 'synced' ? 'synced' : 'partial',
      memory_uid: memoryUid,
    };
  }

  private tsBucket(tsEvent: string): string {
    return new Date(tsEvent).toISOString().slice(0, 13);
  }

  private toRecord(memoryUid: string, memory: MemorySyncPayload): MemoryRecord {
    return {
      memory_uid: memoryUid,
      user_id: memory.user_id,
      run_id: memory.run_id || null,
      scope: memory.scope,
      text: memory.text,
      categories: memory.categories || [],
      tags: memory.tags || [],
      ts_event: memory.ts_event,
      source: memory.source,
      status: memory.status,
      sensitivity: memory.sensitivity || 'internal',
      openclaw_refs: memory.openclaw_refs || {},
      mem0: memory.mem0 || {},
      lancedb: {
        table: 'memory_records',
        row_key: memoryUid,
        vector_dim: null,
        index_version: null,
      },
    };
  }
}
