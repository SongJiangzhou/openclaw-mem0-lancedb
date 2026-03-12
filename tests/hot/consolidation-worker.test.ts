import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InMemoryMemoryAdapter } from '../../src/bridge/adapter';
import { MemoryConsolidationWorker } from '../../src/hot/consolidation-worker';
import { recordToPayload } from '../../src/memory/mapper';
import type { MemoryRecord } from '../../src/types';

function buildRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    memory_uid: overrides?.memory_uid || 'mem-1',
    user_id: 'user-1',
    run_id: null,
    scope: 'long-term',
    text: 'User prefers Coke over Pepsi',
    categories: ['preference'],
    tags: [],
    memory_type: 'preference',
    domains: ['food'],
    source_kind: 'assistant_inferred',
    confidence: 0.7,
    ts_event: '2026-03-07T12:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: { file_path: 'AUTO_CAPTURE' },
    mem0: {},
    lancedb: {},
    ...overrides,
  };
}

test('consolidation worker supersedes duplicate active memories that share a semantic dedup key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-worker-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const first = buildRecord({
      memory_uid: 'mem-1',
      text: 'User prefers Coke over Pepsi',
      source_kind: 'user_explicit',
      confidence: 0.9,
      mem0: { hash: 'hash-coke' },
    });
    const second = buildRecord({
      memory_uid: 'mem-2',
      text: 'User prefers Coke over Pepsi.',
      source_kind: 'assistant_inferred',
      confidence: 0.7,
      ts_event: '2026-03-07T12:05:00.000Z',
      mem0: { hash: 'hash-coke' },
    });

    await adapter.upsertMemory({ memory_uid: first.memory_uid, memory: recordToPayload(first) });
    await adapter.upsertMemory({ memory_uid: second.memory_uid, memory: recordToPayload(second) });

    const worker = new MemoryConsolidationWorker({
      adapter,
      intervalMs: 60_000,
      batchSize: 50,
    });

    const result = await worker.runOnce();
    const latestMem2 = await adapter.getMemory('mem-2');

    assert.equal(result.superseded, 1);
    assert.equal(latestMem2?.status, 'superseded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidation worker prefers stronger evidence when choosing the canonical memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-worker-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const weaker = buildRecord({
      memory_uid: 'mem-weak',
      text: 'User prefers Coke over Pepsi',
      source_kind: 'assistant_inferred',
      confidence: 0.6,
      mem0: { hash: 'hash-coke' },
    });
    const stronger = buildRecord({
      memory_uid: 'mem-strong',
      text: 'User prefers Coke over Pepsi',
      source_kind: 'user_explicit',
      confidence: 0.95,
      ts_event: '2026-03-07T12:05:00.000Z',
      mem0: { hash: 'hash-coke' },
    });

    await adapter.upsertMemory({ memory_uid: weaker.memory_uid, memory: recordToPayload(weaker) });
    await adapter.upsertMemory({ memory_uid: stronger.memory_uid, memory: recordToPayload(stronger) });

    const worker = new MemoryConsolidationWorker({
      adapter,
      intervalMs: 60_000,
      batchSize: 50,
    });

    await worker.runOnce();
    const latestWeak = await adapter.getMemory('mem-weak');
    const latestStrong = await adapter.getMemory('mem-strong');

    assert.equal(latestWeak?.status, 'superseded');
    assert.equal(latestStrong?.status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
