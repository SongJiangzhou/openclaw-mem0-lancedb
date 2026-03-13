import { buildMemoryUid } from '../bridge/uid';
import { LanceDbMemoryAdapter, type MemoryAdapter } from '../bridge/adapter';
import type { Mem0ExtractedMemory } from '../control/mem0';
import { FileAuditStore } from '../audit/store';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { payloadToRecord } from '../memory/mapper';
import { stripPunctuation, longestCommonSubstringLength } from '../memory/text-utils';
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
  auditStore?: FileAuditStore;
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

    const record = payloadToRecord(memoryUid, memoryPayload, {
      lancedb: buildLancedbMetadata(params.adapter, memoryUid),
    });
    if (params.auditStore) {
      try {
        await params.auditStore.append(record);
      } catch (err) {
        params.debug?.exception('capture_sync.audit_append_failed', err, {
          eventId: params.eventId,
          memoryUid,
        });
      }
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
  const latestAssistantMessage = stripPunctuation(captureContext?.latestAssistantMessage || '');

  if (!memoryText) {
    return true;
  }

  if (latestUserMessage && memoryText === latestUserMessage) {
    return true;
  }

  const categories = new Set((memory.categories || []).map((item) => String(item || '').toLowerCase()));
  const looksLikePreference = categories.has('preference');
  const assistantSimilarity = similarityScore(memoryText, latestAssistantMessage);
  const userSimilarity = similarityScore(memoryText, latestUserMessage);
  const supportedByAssistantOnly = Boolean(
    looksLikePreference &&
    latestAssistantMessage &&
    assistantSimilarity >= 0.5 &&
    userSimilarity < 0.4,
  );

  return supportedByAssistantOnly;
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
  return 'assistant_only_preference';
}

function similarityScore(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const common = longestCommonSubstringLength(left, right);
  return common / Math.max(Math.min(left.length, right.length), 1);
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

function buildLancedbMetadata(adapter: MemoryAdapter, memoryUid: string) {
  const dimension = adapter instanceof LanceDbMemoryAdapter ? ((adapter as any).config?.dimension || 16) : 16;
  return {
    table: dimension === 16 ? 'memory_records' : `memory_records_d${dimension}`,
    row_key: memoryUid,
    vector_dim: dimension,
    index_version: null,
  };
}
