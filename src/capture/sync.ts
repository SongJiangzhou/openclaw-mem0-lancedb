import { buildMemoryUid } from '../bridge/uid';
import { LanceDbMemoryAdapter, type MemoryAdapter } from '../bridge/adapter';
import type { Mem0ExtractedMemory } from '../control/mem0';
import { FileAuditStore } from '../audit/store';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { inferMemoryAnnotations } from '../memory/typing';
import type { MemoryRecord, MemorySyncPayload } from '../types';

const CAPTURE_UID_BUCKET = '1970-01-01T00';

export async function syncCapturedMemories(params: {
  memories: Mem0ExtractedMemory[];
  userId: string;
  sessionId?: string;
  agentId?: string;
  runId?: string | null;
  scope: 'long-term' | 'session';
  eventId: string | null;
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  tsEvent?: string;
  debug?: PluginDebugLogger;
  captureContext?: {
    latestUserMessage?: string;
    latestAssistantMessage?: string;
  };
}): Promise<{ synced: number; memoryUids: string[] }> {
  const tsEvent = params.tsEvent || new Date().toISOString();
  const existingRows = await params.auditStore.readAll();
  const existingUids = new Set(existingRows.map((record) => record.memory_uid));
  const existingDedupKeys = new Set(existingRows.flatMap((record) => buildMemoryDedupKeys({ text: record.text, mem0: record.mem0 })));
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

function shouldRejectCapturedMemory(
  memory: Mem0ExtractedMemory,
  captureContext?: { latestUserMessage?: string; latestAssistantMessage?: string },
): boolean {
  if (isObviousOperationalNoise(String(memory.text || ''))) {
    return true;
  }

  const memoryText = normalizeCaptureText(memory.text);
  const latestUserMessage = normalizeCaptureText(captureContext?.latestUserMessage || '');
  const latestAssistantMessage = normalizeCaptureText(captureContext?.latestAssistantMessage || '');

  if (!memoryText) {
    return true;
  }

  if (latestUserMessage && memoryText === latestUserMessage) {
    return true;
  }

  const categories = new Set((memory.categories || []).map((item) => String(item || '').toLowerCase()));
  const looksLikePreference = categories.has('preference') || /prefer|favorite|likes|like|喜欢|偏好|爱吃|爱喝/i.test(String(memory.text || ''));
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
  if (isObviousOperationalNoise(String(memory.text || ''))) {
    return 'operational_noise';
  }

  const memoryText = normalizeCaptureText(memory.text);
  const latestUserMessage = normalizeCaptureText(captureContext?.latestUserMessage || '');
  if (memoryText && latestUserMessage && memoryText === latestUserMessage) {
    return 'query_echo';
  }
  return 'assistant_only_preference';
}

function isObviousOperationalNoise(text: string): boolean {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }

  const hasFilesystemPath = /(?:^|[\s`'"])(?:~\/|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+)(?:[\s`'"]|$)/.test(value);
  const hasShellCommand = /\b(?:npm|pnpm|yarn|bun|node|python|pip|uv|git|curl|wget|bash|sh|chmod|mkdir|rm|cp|mv)\s+[^\n]+/.test(value);
  const hasStackTrace = /\bat\s+[A-Za-z0-9_$.<>]+\s*\([^)]+:\d+:\d+\)|\b(?:Error|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES)\b.+:\d+:\d+/i.test(value);

  return hasFilesystemPath || hasShellCommand || hasStackTrace;
}

function normalizeCaptureText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function similarityScore(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const common = longestCommonSubstringLength(left, right);
  return common / Math.max(Math.min(left.length, right.length), 1);
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const dp = new Array(right.length + 1).fill(0);
  let maxLength = 0;

  for (let i = 1; i <= left.length; i++) {
    for (let j = right.length; j >= 1; j--) {
      if (left[i - 1] === right[j - 1]) {
        dp[j] = dp[j - 1] + 1;
        maxLength = Math.max(maxLength, dp[j]);
      } else {
        dp[j] = 0;
      }
    }
  }

  return maxLength;
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

function toRecord(memoryUid: string, memory: MemorySyncPayload, adapter: MemoryAdapter): MemoryRecord {
  const enriched = backfillLifecycleFields(memory);
  return {
    memory_uid: memoryUid,
    user_id: enriched.user_id,
    session_id: enriched.session_id || '',
    agent_id: enriched.agent_id || '',
    run_id: enriched.run_id || null,
    scope: enriched.scope,
    text: enriched.text,
    categories: enriched.categories || [],
    tags: enriched.tags || [],
    memory_type: enriched.memory_type || 'generic',
    domains: enriched.domains || ['generic'],
    source_kind: enriched.source_kind || 'assistant_inferred',
    confidence: typeof enriched.confidence === 'number' ? enriched.confidence : 0.7,
    ts_event: enriched.ts_event,
    source: enriched.source,
    status: enriched.status,
    lifecycle_state: enriched.lifecycle_state,
    strength: enriched.strength,
    stability: enriched.stability,
    last_access_ts: enriched.last_access_ts,
    next_review_ts: enriched.next_review_ts,
    access_count: enriched.access_count,
    inhibition_weight: enriched.inhibition_weight,
    inhibition_until: enriched.inhibition_until,
    utility_score: enriched.utility_score,
    risk_score: enriched.risk_score,
    retention_deadline: enriched.retention_deadline,
    sensitivity: enriched.sensitivity || 'internal',
    openclaw_refs: enriched.openclaw_refs || {},
    mem0: enriched.mem0 || {},
    lancedb: {
      table: adapter instanceof LanceDbMemoryAdapter ? (adapter as any).config?.dimension === 16 ? 'memory_records' : `memory_records_d${(adapter as any).config?.dimension || 16}` : 'memory_records',
      row_key: memoryUid,
      vector_dim: adapter instanceof LanceDbMemoryAdapter ? ((adapter as any).config?.dimension || 16) : 16,
      index_version: null,
    },
  };
}
