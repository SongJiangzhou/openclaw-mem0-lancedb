import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import { backfillLifecycleFields, reinforceLifecycle } from '../memory/lifecycle';
import type { MemoryRecord, MemorySyncPayload, SearchResult } from '../types';

export async function reinforceRecalledMemories(params: {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  memories: SearchResult['memories'];
  nowIso?: string;
}): Promise<number> {
  const latestRows = await readLatestRows(params.auditStore);
  const latestByUid = new Map(latestRows.map((row) => [row.memory_uid, backfillLifecycleFields(row)]));
  const nowIso = params.nowIso || new Date().toISOString();
  let updatedCount = 0;

  for (const memory of params.memories) {
    const current = latestByUid.get(memory.memory_uid);
    if (!current) {
      continue;
    }
    const updated = reinforceLifecycle(current, nowIso);
    await params.auditStore.append(updated);
    await params.adapter.upsertMemory({
      memory_uid: updated.memory_uid,
      memory: toPayload(updated),
    });
    updatedCount += 1;
  }

  return updatedCount;
}

async function readLatestRows(auditStore: FileAuditStore): Promise<MemoryRecord[]> {
  const rows = await auditStore.readAll();
  const latestByUid = new Map<string, MemoryRecord>();

  for (const row of rows) {
    const existing = latestByUid.get(row.memory_uid);
    if (!existing || String(row.ts_event || '') > String(existing.ts_event || '')) {
      latestByUid.set(row.memory_uid, row);
    }
  }

  return Array.from(latestByUid.values());
}

function toPayload(record: MemoryRecord): MemorySyncPayload {
  const enriched = backfillLifecycleFields(record);
  return {
    user_id: enriched.user_id,
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
  };
}
