import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryMemoryAdapter, type MemoryAdapterRecord } from '../../src/bridge/adapter';
import { reinforceRecalledMemories } from '../../src/hot/reinforcement';
import { recordToPayload } from '../../src/memory/mapper';
import type { MemoryRecord } from '../../src/types';

class TrackingMemoryAdapter extends InMemoryMemoryAdapter {
  metadataUpdates = 0;
  upserts = 0;

  override async upsertMemory(record: MemoryAdapterRecord): Promise<void> {
    this.upserts += 1;
    return super.upsertMemory(record);
  }

  override async updateMemoryMetadata(record: MemoryAdapterRecord): Promise<void> {
    this.metadataUpdates += 1;
    return super.updateMemoryMetadata(record);
  }
}

test('reinforceRecalledMemories upgrades recalled memories in the adapter-backed store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reinforcement-'));
  try {
    const adapter = new TrackingMemoryAdapter();

    const seeded: MemoryRecord = {
      memory_uid: 'recall-1',
      user_id: 'user-1',
      run_id: null,
      scope: 'long-term',
      text: 'User likes black coffee.',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'user_explicit',
      confidence: 0.9,
      ts_event: '2026-03-01T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      lifecycle_state: 'active',
      strength: 0.6,
      stability: 30,
      last_access_ts: '2026-03-01T00:00:00.000Z',
      next_review_ts: '2026-03-31T00:00:00.000Z',
      access_count: 0,
      inhibition_weight: 0,
      inhibition_until: '',
      utility_score: 0.5,
      risk_score: 0.5,
      retention_deadline: '2026-12-31T00:00:00.000Z',
      sensitivity: 'internal',
      openclaw_refs: {},
      mem0: {},
    };
    await adapter.upsertMemory({ memory_uid: seeded.memory_uid, memory: recordToPayload(seeded) });

    const updated = await reinforceRecalledMemories({
      adapter,
      memories: [{
        memory_uid: 'recall-1',
        user_id: 'user-1',
        run_id: null,
        scope: 'long-term',
        text: 'User likes black coffee.',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'user_explicit',
        confidence: 0.9,
        ts_event: '2026-03-01T00:00:00.000Z',
        source: 'openclaw',
        status: 'active',
      }],
      nowIso: '2026-03-11T00:00:00.000Z',
    });

    assert.equal(updated, 1);
    const latest = await adapter.getMemory('recall-1');
    assert.equal(latest?.lifecycle_state, 'reinforced');
    assert.equal((latest?.access_count || 0) > 0, true);
    assert.equal((latest?.stability || 0) > 30, true);
    assert.equal((latest?.utility_score || 0) > 0.5, true);
    assert.equal(adapter.metadataUpdates, 1);
    assert.equal(adapter.upserts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
