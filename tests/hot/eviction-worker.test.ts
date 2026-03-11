import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileAuditStore } from '../../src/audit/store';
import { InMemoryMemoryAdapter } from '../../src/bridge/adapter';
import { MemoryEvictionWorker } from '../../src/hot/eviction-worker';

test('eviction worker deletes expired memories, quarantines stale inferred memories, and inhibits low-utility memories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eviction-worker-'));
  try {
    const auditStore = new FileAuditStore(join(dir, 'audit.jsonl'));
    const adapter = new InMemoryMemoryAdapter();
    const worker = new MemoryEvictionWorker({
      auditStore,
      adapter,
      intervalMs: 60_000,
      batchSize: 10,
    });

    await auditStore.append({
      memory_uid: 'expired-1',
      user_id: 'user-1',
      run_id: null,
      scope: 'long-term',
      text: 'Old temporary preference.',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'user_explicit',
      confidence: 0.7,
      ts_event: '2026-01-01T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      lifecycle_state: 'active',
      strength: 0.4,
      stability: 30,
      last_access_ts: '2026-01-01T00:00:00.000Z',
      next_review_ts: '2026-02-01T00:00:00.000Z',
      access_count: 0,
      inhibition_weight: 0,
      inhibition_until: '',
      utility_score: 0.2,
      risk_score: 0.5,
      retention_deadline: '2026-02-01T00:00:00.000Z',
      sensitivity: 'internal',
      openclaw_refs: {},
      mem0: {},
    });

    await auditStore.append({
      memory_uid: 'quarantine-1',
      user_id: 'user-1',
      run_id: null,
      scope: 'long-term',
      text: 'Assistant inferred a weak preference.',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'assistant_inferred',
      confidence: 0.4,
      ts_event: '2026-01-15T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      lifecycle_state: 'active',
      strength: 0.3,
      stability: 30,
      last_access_ts: '2026-01-15T00:00:00.000Z',
      next_review_ts: '2026-02-15T00:00:00.000Z',
      access_count: 0,
      inhibition_weight: 0,
      inhibition_until: '',
      utility_score: 0.2,
      risk_score: 0.5,
      retention_deadline: '2026-12-31T00:00:00.000Z',
      sensitivity: 'internal',
      openclaw_refs: {},
      mem0: {},
    });

    await auditStore.append({
      memory_uid: 'inhibit-1',
      user_id: 'user-1',
      run_id: null,
      scope: 'long-term',
      text: 'Low utility but not expired.',
      categories: ['generic'],
      tags: [],
      memory_type: 'generic',
      domains: ['generic'],
      source_kind: 'user_explicit',
      confidence: 0.5,
      ts_event: '2026-02-20T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      lifecycle_state: 'active',
      strength: 0.2,
      stability: 30,
      last_access_ts: '2026-02-20T00:00:00.000Z',
      next_review_ts: '2026-03-20T00:00:00.000Z',
      access_count: 0,
      inhibition_weight: 0,
      inhibition_until: '',
      utility_score: 0.1,
      risk_score: 0.5,
      retention_deadline: '2026-12-31T00:00:00.000Z',
      sensitivity: 'internal',
      openclaw_refs: {},
      mem0: {},
    });

    const result = await worker.runOnce('2026-03-11T00:00:00.000Z');
    assert.equal(result.deleted, 1);
    assert.equal(result.quarantined, 1);
    assert.equal(result.inhibited, 1);

    const rows = await auditStore.readAll();
    const latestByUid = new Map(rows.map((row) => [row.memory_uid, row]));
    assert.equal(latestByUid.get('expired-1')?.lifecycle_state, 'deleted');
    assert.equal(latestByUid.get('quarantine-1')?.lifecycle_state, 'quarantined');
    assert.equal(latestByUid.get('inhibit-1')?.lifecycle_state, 'inhibited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
