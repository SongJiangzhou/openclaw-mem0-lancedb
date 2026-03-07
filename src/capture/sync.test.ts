import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../audit/store';
import { InMemoryMemoryAdapter } from '../bridge/adapter';
import type { Mem0ExtractedMemory } from '../control/mem0';
import { syncCapturedMemories } from './sync';

function createExtractedMemory(overrides?: Partial<Mem0ExtractedMemory>): Mem0ExtractedMemory {
  return {
    id: 'mem0-captured-1',
    text: '用户偏好使用中文回复',
    categories: ['preference'],
    hash: 'hash-1',
    ...overrides,
  };
}

test('capture sync maps extracted memories into local audit store and hot plane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const auditStore = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const adapter = new InMemoryMemoryAdapter();

    const result = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'railgun',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      auditStore,
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });

    assert.equal(result.synced, 1);
    assert.equal(result.memoryUids.length, 1);

    const records = await auditStore.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, '用户偏好使用中文回复');
    assert.equal(records[0]?.mem0?.mem0_id, 'mem0-captured-1');
    assert.equal(records[0]?.mem0?.event_id, 'evt-capture');
    assert.equal(records[0]?.openclaw_refs?.file_path, 'AUTO_CAPTURE');

    const exists = await adapter.exists(result.memoryUids[0]!);
    assert.equal(exists, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync skips duplicate extracted memories by memory uid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const auditStore = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const adapter = new InMemoryMemoryAdapter();

    const first = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'railgun',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      auditStore,
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });
    const second = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'railgun',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      auditStore,
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });

    const records = await auditStore.readAll();

    assert.equal(first.synced, 1);
    assert.equal(second.synced, 0);
    assert.equal(records.length, 1);
    assert.deepEqual(first.memoryUids, second.memoryUids);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
