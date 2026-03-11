import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileAuditStore } from '../../src/audit/store';
import { InMemoryMemoryAdapter } from '../../src/bridge/adapter';
import { MemoryReviewWorker } from '../../src/hot/review-worker';

test('review worker reinforces due memories and reschedules next review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-worker-'));
  try {
    const auditStore = new FileAuditStore(join(dir, 'audit.jsonl'));
    const adapter = new InMemoryMemoryAdapter();
    const worker = new MemoryReviewWorker({
      auditStore,
      adapter,
      intervalMs: 60_000,
      batchSize: 10,
    });

    await auditStore.append({
      memory_uid: 'review-1',
      user_id: 'user-1',
      run_id: null,
      scope: 'long-term',
      text: 'User prefers tea in the morning.',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'user_explicit',
      confidence: 0.9,
      ts_event: '2026-01-01T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      lifecycle_state: 'active',
      strength: 0.7,
      stability: 30,
      last_access_ts: '2026-01-01T00:00:00.000Z',
      next_review_ts: '2026-02-01T00:00:00.000Z',
      access_count: 0,
      inhibition_weight: 0,
      inhibition_until: '',
      utility_score: 0.8,
      risk_score: 0.5,
      retention_deadline: '2026-12-31T00:00:00.000Z',
      sensitivity: 'internal',
      openclaw_refs: {},
      mem0: {},
    });

    const result = await worker.runOnce('2026-03-11T00:00:00.000Z');
    assert.equal(result.reviewed, 1);

    const rows = await auditStore.readAll();
    const latest = rows.at(-1)!;
    assert.equal(latest.lifecycle_state, 'reinforced');
    assert.equal((latest.stability || 0) > 30, true);
    assert.equal(latest.next_review_ts! > '2026-03-11T00:00:00.000Z', true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
