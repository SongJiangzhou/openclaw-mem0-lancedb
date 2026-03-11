import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields } from '../memory/lifecycle';
import type { MemoryRecord, MemorySyncPayload } from '../types';
import type { PluginDebugLogger } from '../debug/logger';

type ConsolidationWorkerDeps = {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  intervalMs: number;
  batchSize: number;
};

export class MemoryConsolidationWorker {
  private readonly auditStore: FileAuditStore;
  private readonly adapter: MemoryAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ConsolidationWorkerDeps, debug?: PluginDebugLogger) {
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
    const rows = await this.auditStore.readAll();
    const latestByUid = new Map<string, MemoryRecord>();

    for (const row of rows) {
      const existing = latestByUid.get(row.memory_uid);
      if (!existing || String(row.ts_event || '') > String(existing.ts_event || '')) {
        latestByUid.set(row.memory_uid, row);
      }
    }

    const activeRows = Array.from(latestByUid.values())
      .map((row) => backfillLifecycleFields(row))
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
      await this.auditStore.append(updated);
      await this.adapter.upsertMemory({
        memory_uid: updated.memory_uid,
        memory: toPayload(updated),
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

function toPayload(record: MemoryRecord): MemorySyncPayload {
  return backfillLifecycleFields({
    user_id: record.user_id,
    run_id: record.run_id || null,
    scope: record.scope,
    text: record.text,
    categories: record.categories || [],
    tags: record.tags || [],
    memory_type: record.memory_type || 'generic',
    domains: record.domains || ['generic'],
    source_kind: record.source_kind || 'assistant_inferred',
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.7,
    ts_event: record.ts_event,
    source: record.source,
    status: record.status,
    sensitivity: record.sensitivity || 'internal',
    openclaw_refs: record.openclaw_refs || {},
    mem0: record.mem0 || {},
  });
}
