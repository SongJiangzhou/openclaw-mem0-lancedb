import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InMemoryMemoryAdapter } from '../../src/bridge/adapter';
import { FileAuditStore } from '../../src/audit/store';
import type { Mem0ExtractedMemory } from '../../src/control/mem0';
import { PluginDebugLogger } from '../../src/debug/logger';
import { syncCapturedMemories } from '../../src/capture/sync';

function createExtractedMemory(overrides?: Partial<Mem0ExtractedMemory>): Mem0ExtractedMemory {
  return {
    id: 'mem0-captured-1',
    text: 'User prefers replies in English',
    categories: ['preference'],
    hash: 'hash-1',
    ...overrides,
  };
}

test('capture sync maps extracted memories into the adapter-backed store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const result = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });

    assert.equal(result.synced, 1);
    assert.equal(result.memoryUids.length, 1);

    const stored = await adapter.getMemory(result.memoryUids[0]!);
    assert.equal(stored?.text, 'User prefers replies in English');
    assert.equal(stored?.mem0?.mem0_id, 'mem0-captured-1');
    assert.equal(stored?.mem0?.event_id, 'evt-capture');
    assert.equal(stored?.openclaw_refs?.file_path, 'AUTO_CAPTURE');
    assert.equal(stored?.memory_type, 'preference');
    assert.equal(stored?.source_kind, 'assistant_inferred');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync writes lancedb provenance into audit records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-audit-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const auditStore = new FileAuditStore(join(dir, 'audit.jsonl'));

    const result = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      auditStore,
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });

    const latestRows = await auditStore.readLatestRows();

    assert.equal(result.synced, 1);
    assert.equal(latestRows.length, 1);
    assert.deepEqual(latestRows[0]?.lancedb, {
      table: 'memory_records',
      row_key: result.memoryUids[0],
      vector_dim: 16,
      index_version: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync skips duplicate extracted memories by memory uid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const first = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });
    const second = await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });

    assert.equal(first.synced, 1);
    assert.equal(second.synced, 0);
    assert.equal((await adapter.listMemories({ userId: 'user-1' })).length, 1);
    assert.deepEqual(first.memoryUids, second.memoryUids);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync emits debug events for synced and duplicate memories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const messages: string[] = [];
    const debug = new PluginDebugLogger(
      { mode: 'debug' },
      { info: (msg: string) => messages.push(msg), warn: (msg: string) => messages.push(msg), error: (msg: string) => messages.push(msg) },
    );
    const adapter = new InMemoryMemoryAdapter();

    await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
      debug,
    });
    await syncCapturedMemories({
      memories: [createExtractedMemory()],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
      debug,
    });

    const output = messages.join('\n');
    assert.match(output, /capture_sync\.start/);
    assert.match(output, /capture_sync\.synced_memory/);
    assert.match(output, /capture_sync\.duplicate/);
    assert.match(output, /capture_sync\.done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync skips semantic duplicates that share mem0 hash with a different id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const first = await syncCapturedMemories({
      memories: [createExtractedMemory({ id: 'mem0-captured-1', text: 'User prefers Coke over Pepsi', hash: 'hash-coke' })],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture-1',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
    });
    const second = await syncCapturedMemories({
      memories: [createExtractedMemory({ id: 'mem0-captured-2', text: 'User prefers Coke over Pepsi.', hash: 'hash-coke' })],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture-2',
      adapter,
      tsEvent: '2026-03-07T12:05:00.000Z',
    });

    assert.equal(first.synced, 1);
    assert.equal(second.synced, 0);
    assert.equal((await adapter.listMemories({ userId: 'user-1' })).length, 1);
    assert.equal(await adapter.exists(first.memoryUids[0]!), true);
    assert.equal(await adapter.exists(second.memoryUids[0]!), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync rejects query-echo memories that only restate the latest user question', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const result = await syncCapturedMemories({
      memories: [createExtractedMemory({ text: 'What do I like at McDonalds?', categories: ['preference'], hash: 'hash-query-echo' })],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture-echo',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
      captureContext: {
        latestUserMessage: 'What do I like at McDonalds?',
        latestAssistantMessage: 'You like McFlurry.',
      },
    });

    assert.equal(result.synced, 0);
    assert.equal((await adapter.listMemories({ userId: 'user-1' })).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture sync rejects preference memories supported only by assistant output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));

  try {
    const adapter = new InMemoryMemoryAdapter();

    const result = await syncCapturedMemories({
      memories: [createExtractedMemory({ text: 'User likes McFlurry.', categories: ['preference'], hash: 'hash-mcflurry' })],
      userId: 'user-1',
      runId: 'run-1',
      scope: 'long-term',
      eventId: 'evt-capture-assistant-only',
      adapter,
      tsEvent: '2026-03-07T12:00:00.000Z',
      captureContext: {
        latestUserMessage: 'What do I like at McDonalds?',
        latestAssistantMessage: 'You like McFlurry.',
      },
    });

    assert.equal(result.synced, 0);
    assert.equal((await adapter.listMemories({ userId: 'user-1' })).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
