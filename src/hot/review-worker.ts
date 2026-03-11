import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import { backfillLifecycleFields, refreshReviewLifecycle, shouldReviewLifecycle } from '../memory/lifecycle';
import type { MemoryRecord, MemorySyncPayload } from '../types';
import type { PluginDebugLogger } from '../debug/logger';

type ReviewWorkerDeps = {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  intervalMs: number;
  batchSize: number;
};

export class MemoryReviewWorker {
  private readonly auditStore: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ReviewWorkerDeps, debug?: PluginDebugLogger) {
    this.auditStore = deps.auditStore;
    this.adapter = deps.adapter;
    this.intervalMs = deps.intervalMs;
    this.batchSize = deps.batchSize;
    this.debug = debug;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(nowIso: string = new Date().toISOString()): Promise<{ scanned: number; reviewed: number }> {
    const latestRows = await readLatestRows(this.auditStore);
    const candidates = latestRows
      .map((row) => backfillLifecycleFields(row))
      .filter((row) => shouldReviewLifecycle(row, nowIso))
      .slice(0, this.batchSize);

    let reviewed = 0;
    for (const row of candidates) {
      const updated = refreshReviewLifecycle(row, nowIso);
      await this.auditStore.append(updated);
      await this.adapter.upsertMemory({
        memory_uid: updated.memory_uid,
        memory: toPayload(updated),
      });
      reviewed += 1;
      this.debug?.verbose('memory_review.reviewed', { memoryUid: updated.memory_uid });
    }

    this.debug?.basic('memory_review.done', { scanned: latestRows.length, reviewed });
    return { scanned: latestRows.length, reviewed };
  }
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
