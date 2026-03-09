import { buildMemoryUid } from '../bridge/uid';
import { LanceDbMemoryAdapter, type MemoryAdapter } from '../bridge/adapter';
import type { Mem0ExtractedMemory } from '../control/mem0';
import { FileAuditStore } from '../audit/store';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { inferMemoryAnnotations } from '../memory/typing';
import type { MemoryRecord, MemorySyncPayload } from '../types';

const CAPTURE_UID_BUCKET = '1970-01-01T00';

export async function syncCapturedMemories(params: {
  memories: Mem0ExtractedMemory[];
  userId: string;
  runId?: string | null;
  scope: 'long-term' | 'session';
  eventId: string | null;
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  tsEvent?: string;
  debug?: PluginDebugLogger;
}): Promise<{ synced: number; memoryUids: string[] }> {
  const tsEvent = params.tsEvent || new Date().toISOString();
  const existingRows = await params.auditStore.readAll();
  const existingUids = new Set(existingRows.map((record) => record.memory_uid));
  const existingDedupKeys = new Set(existingRows.flatMap((record) => buildMemoryDedupKeys({ text: record.text, mem0: record.mem0 })));
  const memoryUids: string[] = [];
  let synced = 0;
  params.debug?.basic('capture_sync.start', { eventId: params.eventId, count: params.memories.length, scope: params.scope });

  for (const memory of params.memories) {
    const memoryPayload = toMemoryPayload(memory, params, tsEvent);
    const category = (memoryPayload.categories || ['general'])[0];
    const memoryUid = buildMemoryUid(
      memoryPayload.user_id,
      memoryPayload.scope,
      memoryPayload.text,
      CAPTURE_UID_BUCKET,
      category,
    );
    memoryUids.push(memoryUid);
    const dedupKeys = buildMemoryDedupKeys({ text: memoryPayload.text, mem0: memoryPayload.mem0 });
    const duplicateMemoryUid = await params.adapter.findDuplicateMemoryUid(memoryPayload);

    if (
      existingUids.has(memoryUid) ||
      dedupKeys.some((key) => existingDedupKeys.has(key)) ||
      (duplicateMemoryUid !== null && duplicateMemoryUid !== '') ||
      (await params.adapter.exists(memoryUid))
    ) {
      if (duplicateMemoryUid && duplicateMemoryUid !== memoryUid) {
        await params.adapter.upsertMemory({
          memory_uid: duplicateMemoryUid,
          memory: memoryPayload,
        });
      }
      dedupKeys.forEach((key) => existingDedupKeys.add(key));
      params.debug?.verbose('capture_sync.duplicate', { eventId: params.eventId, memoryUid, ...summarizeText(memory.text) });
      continue;
    }

    const record = toRecord(memoryUid, memoryPayload, params.adapter);
    await params.auditStore.append(record);
    await params.adapter.upsertMemory({
      memory_uid: memoryUid,
      memory: memoryPayload,
    });
    existingUids.add(memoryUid);
    dedupKeys.forEach((key) => existingDedupKeys.add(key));
    synced += 1;
    params.debug?.verbose('capture_sync.synced_memory', { eventId: params.eventId, memoryUid, ...summarizeText(memory.text) });
  }

  params.debug?.basic('capture_sync.done', { eventId: params.eventId, synced, total: params.memories.length });
  return { synced, memoryUids };
}

function toMemoryPayload(
  memory: Mem0ExtractedMemory,
  params: {
    userId: string;
    runId?: string | null;
    scope: 'long-term' | 'session';
    eventId: string | null;
  },
  tsEvent: string,
): MemorySyncPayload {
  const annotations = inferMemoryAnnotations({
    text: memory.text,
    categories: memory.categories,
    sourceKind: 'assistant_inferred',
  });

  return {
    user_id: params.userId,
    run_id: params.runId || null,
    scope: params.scope,
    text: memory.text,
    categories: memory.categories,
    tags: [],
    memory_type: annotations.memoryType,
    domains: annotations.domains,
    source_kind: annotations.sourceKind,
    confidence: annotations.confidence,
    ts_event: tsEvent,
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: {
      file_path: 'AUTO_CAPTURE',
    },
    mem0: {
      mem0_id: memory.id,
      event_id: params.eventId,
      hash: memory.hash,
    },
  };
}

function toRecord(memoryUid: string, memory: MemorySyncPayload, adapter: MemoryAdapter): MemoryRecord {
  return {
    memory_uid: memoryUid,
    user_id: memory.user_id,
    run_id: memory.run_id || null,
    scope: memory.scope,
    text: memory.text,
    categories: memory.categories || [],
    tags: memory.tags || [],
    memory_type: memory.memory_type || 'generic',
    domains: memory.domains || ['generic'],
    source_kind: memory.source_kind || 'assistant_inferred',
    confidence: typeof memory.confidence === 'number' ? memory.confidence : 0.7,
    ts_event: memory.ts_event,
    source: memory.source,
    status: memory.status,
    sensitivity: memory.sensitivity || 'internal',
    openclaw_refs: memory.openclaw_refs || {},
    mem0: memory.mem0 || {},
    lancedb: {
      table: adapter instanceof LanceDbMemoryAdapter ? (adapter as any).config?.dimension === 16 ? 'memory_records' : `memory_records_d${(adapter as any).config?.dimension || 16}` : 'memory_records',
      row_key: memoryUid,
      vector_dim: adapter instanceof LanceDbMemoryAdapter ? ((adapter as any).config?.dimension || 16) : 16,
      index_version: null,
    },
  };
}
