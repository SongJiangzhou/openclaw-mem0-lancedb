import type { MemoryRecord, MemorySyncPayload } from '../types';

/**
 * Unified conversion: MemorySyncPayload + memory_uid → MemoryRecord.
 * Replaces the duplicated toRecord() functions previously spread across
 * sync-engine, capture/sync, poller, and promotion-worker.
 */
export function payloadToRecord(memoryUid: string, payload: MemorySyncPayload): MemoryRecord {
  return {
    memory_uid: memoryUid,
    user_id: payload.user_id,
    session_id: payload.session_id || '',
    agent_id: payload.agent_id || '',
    run_id: payload.run_id ?? null,
    scope: payload.scope,
    text: payload.text,
    categories: payload.categories ?? [],
    tags: payload.tags ?? [],
    memory_type: payload.memory_type ?? 'generic',
    domains: payload.domains ?? ['generic'],
    source_kind: payload.source_kind ?? 'user_explicit',
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.7,
    ts_event: payload.ts_event,
    source: payload.source,
    status: payload.status,
    lifecycle_state: payload.lifecycle_state,
    strength: payload.strength,
    stability: payload.stability,
    last_access_ts: payload.last_access_ts,
    next_review_ts: payload.next_review_ts,
    access_count: payload.access_count,
    inhibition_weight: payload.inhibition_weight,
    inhibition_until: payload.inhibition_until,
    utility_score: payload.utility_score,
    risk_score: payload.risk_score,
    retention_deadline: payload.retention_deadline,
    sensitivity: payload.sensitivity ?? 'internal',
    openclaw_refs: payload.openclaw_refs ?? {},
    mem0: payload.mem0 ?? {},
  };
}

/**
 * Unified conversion: MemoryRecord → MemorySyncPayload.
 * Replaces the duplicated toPayload() in reinforcement.ts.
 */
export function recordToPayload(record: MemoryRecord): MemorySyncPayload {
  return {
    user_id: record.user_id,
    session_id: record.session_id ?? '',
    agent_id: record.agent_id ?? '',
    run_id: record.run_id ?? null,
    scope: record.scope,
    text: record.text,
    categories: record.categories ?? [],
    tags: record.tags ?? [],
    memory_type: record.memory_type ?? 'generic',
    domains: record.domains ?? ['generic'],
    source_kind: record.source_kind ?? 'assistant_inferred',
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.7,
    ts_event: record.ts_event,
    source: record.source,
    status: record.status,
    lifecycle_state: record.lifecycle_state,
    strength: record.strength,
    stability: record.stability,
    last_access_ts: record.last_access_ts,
    next_review_ts: record.next_review_ts,
    access_count: record.access_count,
    inhibition_weight: record.inhibition_weight,
    inhibition_until: record.inhibition_until,
    utility_score: record.utility_score,
    risk_score: record.risk_score,
    retention_deadline: record.retention_deadline,
    sensitivity: record.sensitivity ?? 'internal',
    openclaw_refs: record.openclaw_refs ?? {},
    mem0: record.mem0 ?? {},
  };
}
