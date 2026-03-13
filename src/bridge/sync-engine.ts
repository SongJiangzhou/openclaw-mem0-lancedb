import { FileAuditStore } from '../audit/store';
import type { Mem0Client } from '../control/mem0';
import { buildMemoryUid } from './uid';
import { LanceDbMemoryAdapter, type MemoryAdapter } from './adapter';
import type { FileOutbox } from './outbox';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { payloadToRecord } from '../memory/mapper';
import type { PluginLogger } from '../debug/logger';
import type { MemorySyncPayload, MemorySyncResult } from '../types';

export class MemorySyncEngine {
  private readonly outbox: FileOutbox;
  private readonly auditStore?: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly mem0Client: Mem0Client;
  private readonly processInline: boolean;
  private readonly debug?: PluginLogger;

  constructor(
    outbox: FileOutbox,
    auditStore: FileAuditStore | undefined,
    adapter: MemoryAdapter,
    mem0Client: Mem0Client,
    options?: { processInline?: boolean; debug?: PluginLogger },
  ) {
    this.outbox = outbox;
    this.auditStore = auditStore;
    this.adapter = adapter;
    this.mem0Client = mem0Client;
    this.processInline = options?.processInline ?? true;
    this.debug = options?.debug;
  }

  async processEvent(eventId: string, memory: MemorySyncPayload): Promise<MemorySyncResult> {
    const category = (memory.categories || ['general'])[0];
    const memoryUid = buildMemoryUid(
      memory.user_id,
      memory.scope,
      memory.text,
      this.tsBucket(memory.ts_event),
      category,
      memory.scope === 'session' ? String(memory.session_id || '') : '',
    );
    const enrichedMemory = backfillLifecycleFields(memory);
    const record = payloadToRecord(memoryUid, enrichedMemory, {
      lancedb: buildLancedbMetadata(this.adapter, memoryUid),
    });

    if (this.auditStore) {
      try {
        await this.auditStore.append(record);
      } catch (err) {
        this.debug?.exception('memory_sync.audit_append_failed', err, {
          eventId,
          memoryUid,
        });
      }
    }

    const idempotencyKey = `${eventId}:${memoryUid}`;
    const payload = JSON.stringify({ event_id: eventId, memory_uid: memoryUid, memory: enrichedMemory });
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

    const mem0Store = await this.mem0Client.storeMemory(record);
    const mem0Event = mem0Store.status === 'submitted' && mem0Store.event_id
      ? await this.mem0Client.waitForEvent(mem0Store.event_id, { attempts: 10, delayMs: 500 })
      : { status: 'unavailable' as const };
    const withControlPlane: MemorySyncPayload = {
      ...enrichedMemory,
      mem0: mem0Store.status === 'submitted'
        ? {
            mem0_id: mem0Store.mem0_id,
            event_id: mem0Store.event_id,
            hash: mem0Store.hash,
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
      status: mem0Store.status === 'submitted' && mem0Event.status === 'confirmed' ? 'synced' : 'partial',
      memory_uid: memoryUid,
    };
  }

  private tsBucket(tsEvent: string): string {
    return new Date(tsEvent).toISOString().slice(0, 13);
  }
}

function buildLancedbMetadata(adapter: MemoryAdapter, memoryUid: string) {
  const dimension = adapter instanceof LanceDbMemoryAdapter ? ((adapter as any).config?.dimension || 16) : 16;
  return {
    table: dimension === 16 ? 'memory_records' : `memory_records_d${dimension}`,
    row_key: memoryUid,
    vector_dim: dimension,
    index_version: null,
  };
}
