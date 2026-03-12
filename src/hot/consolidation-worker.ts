import type { MemoryAdapter } from '../bridge/adapter';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { recordToPayload } from '../memory/mapper';
import type { MemoryRecord, MemorySyncPayload } from '../types';
import type { PluginDebugLogger } from '../debug/logger';

type ConsolidationWorkerDeps = {
  adapter: MemoryAdapter;
  intervalMs: number;
  batchSize: number;
};

export class MemoryConsolidationWorker {
  private readonly adapter: MemoryAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ConsolidationWorkerDeps, debug?: PluginDebugLogger) {
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
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<{ scanned: number; superseded: number }> {
    const activeRows = (await this.adapter.listMemories({ status: 'active', scope: 'long-term' }))
      .map((row) => backfillLifecycleFields({ memory_uid: row.memory_uid, ...toRecord(row.memory) }))
      .filter((row) => row.status === 'active' && row.scope === 'long-term');
    const aliasToCanonical = new Map<string, string>();
    const canonicalRows = new Map<string, MemoryRecord>();
    const duplicates: Array<{ duplicate: MemoryRecord; canonical: MemoryRecord }> = [];

    for (const row of activeRows) {
      const dedupKeys = buildMemoryDedupKeys({ text: row.text, mem0: row.mem0 });
      const existingCanonicalId = dedupKeys.map((key) => aliasToCanonical.get(key)).find(Boolean);
      const canonicalId = existingCanonicalId || row.memory_uid;
      const existing = canonicalRows.get(canonicalId);

      if (!existing) {
        canonicalRows.set(canonicalId, row);
        dedupKeys.forEach((key) => aliasToCanonical.set(key, canonicalId));
        continue;
      }

      const winner = compareRecords(row, existing) > 0 ? row : existing;
      const loser = winner === row ? existing : row;
      canonicalRows.set(canonicalId, winner);
      dedupKeys.forEach((key) => aliasToCanonical.set(key, canonicalId));
      duplicates.push({ duplicate: loser, canonical: winner });
    }

    let superseded = 0;
    const seen = new Set<string>();
    for (const item of duplicates) {
      if (superseded >= this.batchSize || seen.has(item.duplicate.memory_uid)) {
        continue;
      }
      seen.add(item.duplicate.memory_uid);
      const updated = supersedeRecord(item.duplicate);
      await this.adapter.updateMemoryMetadata({
        memory_uid: updated.memory_uid,
        memory: recordToPayload(updated),
      });
      superseded += 1;
      this.debug?.verbose('memory_consolidation.superseded', {
        memoryUid: updated.memory_uid,
        canonicalMemoryUid: item.canonical.memory_uid,
      });
    }

    this.debug?.basic('memory_consolidation.done', { scanned: activeRows.length, superseded });
    return { scanned: activeRows.length, superseded };
  }
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  const sourceDelta = sourceWeight(left.source_kind) - sourceWeight(right.source_kind);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  const confidenceDelta = (left.confidence || 0) - (right.confidence || 0);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return String(left.ts_event || '').localeCompare(String(right.ts_event || ''));
}

function sourceWeight(sourceKind?: string): number {
  switch (sourceKind) {
    case 'user_explicit':
      return 3;
    case 'imported':
      return 2;
    case 'assistant_inferred':
      return 1;
    default:
      return 0;
  }
}

function supersedeRecord(record: MemoryRecord): MemoryRecord {
  return backfillLifecycleFields({
    ...record,
    status: 'superseded',
    lifecycle_state: 'superseded',
    ts_event: new Date().toISOString(),
  });
}

function toRecord(memory: MemorySyncPayload): Omit<MemoryRecord, 'memory_uid'> {
  return {
    user_id: memory.user_id,
    session_id: memory.session_id || '',
    agent_id: memory.agent_id || '',
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
    lifecycle_state: memory.lifecycle_state,
    strength: memory.strength,
    stability: memory.stability,
    last_access_ts: memory.last_access_ts,
    next_review_ts: memory.next_review_ts,
    access_count: memory.access_count,
    inhibition_weight: memory.inhibition_weight,
    inhibition_until: memory.inhibition_until,
    utility_score: memory.utility_score,
    risk_score: memory.risk_score,
    retention_deadline: memory.retention_deadline,
    sensitivity: memory.sensitivity || 'internal',
    openclaw_refs: memory.openclaw_refs || {},
    mem0: memory.mem0 || {},
  };
}
