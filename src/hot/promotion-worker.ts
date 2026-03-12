import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import { buildMemoryUid } from '../bridge/uid';
import {
  backfillLifecycleFields,
  isRecallEligibleLifecycleState,
} from '../memory/lifecycle';
import { payloadToRecord } from '../memory/mapper';
import type { MemoryRecord, MemorySyncPayload } from '../types';
import type { PluginDebugLogger } from '../debug/logger';

type PromotionWorkerDeps = {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  intervalMs: number;
  batchSize: number;
};

type PromotionRunResult = {
  scanned: number;
  promoted: number;
  skipped: number;
};

const PROMOTION_UID_BUCKET = '1970-01-01T00';

export class MemoryPromotionWorker {
  private readonly auditStore: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: PromotionWorkerDeps, debug?: PluginDebugLogger) {
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

  async runOnce(nowIso: string = new Date().toISOString()): Promise<PromotionRunResult> {
    const latestRows = (await this.auditStore.readLatestRows()).map((row) => backfillLifecycleFields(row));
    let promoted = 0;
    let skipped = 0;
    let processed = 0;

    for (const row of latestRows) {
      if (processed >= this.batchSize) {
        break;
      }

      if (!shouldPromoteSessionMemory(row)) {
        skipped += 1;
        continue;
      }

      const payload = toLongTermPayload(row, nowIso);
      const duplicateMemoryUid = await this.adapter.findDuplicateMemoryUid(payload);
      if (duplicateMemoryUid && duplicateMemoryUid !== '') {
        await this.adapter.updateMemoryMetadata({
          memory_uid: duplicateMemoryUid,
          memory: payload,
        });
        promoted += 1;
        processed += 1;
        continue;
      }

      const category = (payload.categories || ['general'])[0] || 'general';
      const memoryUid = buildMemoryUid(
        payload.user_id,
        payload.scope,
        payload.text,
        PROMOTION_UID_BUCKET,
        category,
      );

      if (await this.adapter.exists(memoryUid)) {
        await this.adapter.updateMemoryMetadata({
          memory_uid: memoryUid,
          memory: payload,
        });
        promoted += 1;
        processed += 1;
        continue;
      }

      const record = payloadToRecord(memoryUid, payload);
      await this.auditStore.append(record);
      await this.adapter.upsertMemory({
        memory_uid: memoryUid,
        memory: payload,
      });
      promoted += 1;
      processed += 1;
      this.debug?.verbose('memory_promotion.promoted', { fromMemoryUid: row.memory_uid, toMemoryUid: memoryUid });
    }

    const summary = {
      scanned: latestRows.length,
      promoted,
      skipped,
    };
    this.debug?.basic('memory_promotion.done', summary);
    return summary;
  }
}

function shouldPromoteSessionMemory(row: MemoryRecord): boolean {
  if (row.scope !== 'session' || row.status !== 'active') {
    return false;
  }
  if (!isRecallEligibleLifecycleState(row.lifecycle_state)) {
    return false;
  }
  if (!row.text || !String(row.text).trim()) {
    return false;
  }
  if ((row.sensitivity || 'internal') === 'restricted' || (row.sensitivity || 'internal') === 'confidential') {
    return false;
  }
  if ((row.access_count || 0) < 2) {
    return false;
  }
  if ((row.strength || 0) < 0.72) {
    return false;
  }
  if ((row.utility_score || 0) < 0.65) {
    return false;
  }
  return true;
}

function toLongTermPayload(row: MemoryRecord, nowIso: string): MemorySyncPayload {
  const enriched = backfillLifecycleFields(row);
  return {
    user_id: enriched.user_id,
    session_id: '',
    agent_id: '',
    run_id: null,
    scope: 'long-term',
    text: enriched.text,
    categories: enriched.categories || [],
    tags: enriched.tags || [],
    memory_type: enriched.memory_type || 'generic',
    domains: enriched.domains || ['generic'],
    source_kind: enriched.source_kind || 'user_explicit',
    confidence: typeof enriched.confidence === 'number' ? enriched.confidence : 0.7,
    ts_event: nowIso,
    source: enriched.source,
    status: 'active',
    lifecycle_state: 'reinforced',
    strength: enriched.strength,
    stability: Math.max(enriched.stability || 1, 7),
    last_access_ts: enriched.last_access_ts || nowIso,
    next_review_ts: enriched.next_review_ts || nowIso,
    access_count: enriched.access_count || 0,
    inhibition_weight: 0,
    inhibition_until: '',
    utility_score: enriched.utility_score,
    risk_score: enriched.risk_score,
    retention_deadline: enriched.retention_deadline,
    sensitivity: enriched.sensitivity || 'internal',
    openclaw_refs: enriched.openclaw_refs || {},
    mem0: enriched.mem0 || {},
  };
}
