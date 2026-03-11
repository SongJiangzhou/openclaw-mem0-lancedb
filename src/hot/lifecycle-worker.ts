import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import {
  backfillLifecycleFields,
  deleteLifecycle,
  inhibitLifecycle,
  inhibitionExpired,
  quarantineLifecycle,
  refreshReviewLifecycle,
  restoreLifecycle,
  shouldDeleteForRetention,
  shouldInhibitLifecycle,
  shouldQuarantineLifecycle,
  shouldReviewLifecycle,
} from '../memory/lifecycle';
import type { MemoryRecord, MemorySyncPayload } from '../types';
import type { PluginDebugLogger } from '../debug/logger';

type LifecycleWorkerDeps = {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  intervalMs: number;
  batchSize: number;
};

export class MemoryLifecycleWorker {
  private readonly auditStore: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: LifecycleWorkerDeps, debug?: PluginDebugLogger) {
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

  async runOnce(nowIso: string = new Date().toISOString()): Promise<LifecycleRunResult> {
    const latestRows = await readLatestRows(this.auditStore);
    let reviewed = 0;
    let inhibited = 0;
    let quarantined = 0;
    let deleted = 0;
    let restored = 0;
    let processed = 0;

    for (const row of latestRows.map((item) => backfillLifecycleFields(item))) {
      if (processed >= this.batchSize) {
        break;
      }

      let updated: MemoryRecord | null = null;
      let event: LifecycleEvent | null = null;

      if (shouldReviewLifecycle(row, nowIso)) {
        updated = refreshReviewLifecycle(row, nowIso);
        event = 'reviewed';
        reviewed += 1;
      } else if (inhibitionExpired(row, nowIso)) {
        updated = restoreLifecycle(row, nowIso);
        event = 'restored';
        restored += 1;
      } else if (shouldDeleteForRetention(row, nowIso)) {
        updated = deleteLifecycle(row, nowIso);
        event = 'deleted';
        deleted += 1;
      } else if (shouldQuarantineLifecycle(row, nowIso)) {
        updated = quarantineLifecycle(row, nowIso);
        event = 'quarantined';
        quarantined += 1;
      } else if (shouldInhibitLifecycle(row, nowIso)) {
        updated = inhibitLifecycle(row, nowIso);
        event = 'inhibited';
        inhibited += 1;
      }

      if (!updated || !event) {
        continue;
      }

      await this.auditStore.append(updated);
      await this.adapter.updateMemoryMetadata({
        memory_uid: updated.memory_uid,
        memory: toPayload(updated),
      });
      processed += 1;
      this.debug?.verbose(`memory_lifecycle.${event}`, { memoryUid: updated.memory_uid });
    }

    const summary = {
      scanned: latestRows.length,
      reviewed,
      inhibited,
      quarantined,
      deleted,
      restored,
    };
    this.debug?.basic('memory_lifecycle.done', summary);
    return summary;
  }
}

type LifecycleEvent = 'reviewed' | 'inhibited' | 'quarantined' | 'deleted' | 'restored';

type LifecycleRunResult = {
  scanned: number;
  reviewed: number;
  inhibited: number;
  quarantined: number;
  deleted: number;
  restored: number;
};

async function readLatestRows(auditStore: FileAuditStore): Promise<MemoryRecord[]> {
  return auditStore.readLatestRows();
}

function toPayload(record: MemoryRecord): MemorySyncPayload {
  const enriched = backfillLifecycleFields(record);
  return {
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
  };
}
