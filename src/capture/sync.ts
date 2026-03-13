import { buildMemoryUid } from '../bridge/uid';
import type { MemoryAdapter } from '../bridge/adapter';
import type { Mem0ExtractedMemory } from '../control/mem0';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { stripPunctuation } from '../memory/text-utils';
import { inferMemoryAnnotations } from '../memory/typing';
import type { MemorySyncPayload } from '../types';

const CAPTURE_UID_BUCKET = '1970-01-01T00';

export async function syncCapturedMemories(params: {
  memories: Mem0ExtractedMemory[];
  userId: string;
  sessionId?: string;
  agentId?: string;
  runId?: string | null;
  scope: 'long-term' | 'session';
  eventId: string | null;
  adapter: MemoryAdapter;
  tsEvent?: string;
  debug?: PluginDebugLogger;
  captureContext?: {
    latestUserMessage?: string;
    latestAssistantMessage?: string;
  };
}): Promise<{ synced: number; memoryUids: string[] }> {
  const tsEvent = params.tsEvent || new Date().toISOString();
  const existingRows = await params.adapter.listMemories({ userId: params.userId });
  const existingUids = new Set(existingRows.map((record) => record.memory_uid));
  const existingDedupKeys = new Set(existingRows.flatMap((record) => buildMemoryDedupKeys({ text: record.memory.text, mem0: record.memory.mem0 })));
  const memoryUids: string[] = [];
  let synced = 0;
  params.debug?.basic('capture_sync.start', { eventId: params.eventId, count: params.memories.length, scope: params.scope });

  for (const memory of params.memories) {
    if (shouldRejectCapturedMemory(memory, params.captureContext)) {
      params.debug?.verbose('capture_sync.rejected', {
        eventId: params.eventId,
        reason: inferRejectReason(memory, params.captureContext),
        ...summarizeText(memory.text),
      });
      continue;
    }

    const memoryPayload = toMemoryPayload(memory, params, tsEvent);
    const category = (memoryPayload.categories || ['general'])[0];
    const memoryUid = buildMemoryUid(
      memoryPayload.user_id,
      memoryPayload.scope,
      memoryPayload.text,
      CAPTURE_UID_BUCKET,
      category,
      memoryPayload.scope === 'session' ? String(memoryPayload.session_id || '') : '',
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

function shouldRejectCapturedMemory(
  memory: Mem0ExtractedMemory,
  captureContext?: { latestUserMessage?: string; latestAssistantMessage?: string },
): boolean {
  const memoryText = stripPunctuation(memory.text);
  const latestUserMessage = stripPunctuation(captureContext?.latestUserMessage || '');

  if (!memoryText) {
    return true;
  }

  if (latestUserMessage && memoryText === latestUserMessage) {
    return true;
  }

  return false;
}

function inferRejectReason(
  memory: Mem0ExtractedMemory,
  captureContext?: { latestUserMessage?: string; latestAssistantMessage?: string },
): string {
  const memoryText = stripPunctuation(memory.text);
  const latestUserMessage = stripPunctuation(captureContext?.latestUserMessage || '');
  if (memoryText && latestUserMessage && memoryText === latestUserMessage) {
    return 'query_echo';
  }
  return 'empty';
}

function toMemoryPayload(
  memory: Mem0ExtractedMemory,
  params: {
    userId: string;
    sessionId?: string;
    agentId?: string;
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

  return backfillLifecycleFields({
    user_id: params.userId,
    session_id: params.sessionId || '',
    agent_id: params.agentId || '',
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
  });
}
