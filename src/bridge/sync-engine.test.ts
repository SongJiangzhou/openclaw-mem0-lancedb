import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../audit/store';
import { FakeMem0Client } from '../control/mem0';
import { FileOutbox } from './outbox';
import { InMemoryMemoryAdapter } from './adapter';
import { MemorySyncEngine } from './sync-engine';

function createMemory() {
  return {
    user_id: 'railgun',
    scope: 'long-term' as const,
    text: '用户偏好：回复必须使用中文',
    categories: ['preference'],
    tags: ['lang'],
    ts_event: '2026-03-07T10:15:00.000Z',
    source: 'openclaw' as const,
    status: 'active' as const,
    sensitivity: 'internal' as const,
    openclaw_refs: { file_path: 'MEMORY.md' },
  };
}

test('sync engine returns accepted when audit write succeeds and processing is deferred', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const outbox = new FileOutbox(join(dir, 'outbox.json'));
    const audit = new FileAuditStore(join(dir, 'audit.jsonl'));
    const mem0 = new FakeMem0Client({ status: 'unavailable' }, { status: 'unavailable' });
    const engine = new MemorySyncEngine(outbox, audit, adapter, mem0, { processInline: false });

    const result = await engine.processEvent('evt-1', createMemory());

    assert.equal(result.status, 'accepted');
    assert.ok(result.memory_uid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync engine returns duplicate when the same event is replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const outbox = new FileOutbox(join(dir, 'outbox.json'));
    const audit = new FileAuditStore(join(dir, 'audit.jsonl'));
    const mem0 = new FakeMem0Client(
      { status: 'submitted', mem0_id: 'm1', event_id: 'evt-dup', hash: 'h1' },
      { status: 'confirmed' },
    );
    const engine = new MemorySyncEngine(outbox, audit, adapter, mem0);
    const memory = createMemory();

    const first = await engine.processEvent('evt-dup', memory);
    const second = await engine.processEvent('evt-dup', memory);

    assert.equal(first.status, 'synced');
    assert.equal(second.status, 'duplicate');
    assert.equal(first.memory_uid, second.memory_uid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync engine returns partial when lance succeeds but mem0 is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const outbox = new FileOutbox(join(dir, 'outbox.json'));
    const audit = new FileAuditStore(join(dir, 'audit.jsonl'));
    const mem0 = new FakeMem0Client({ status: 'unavailable' }, { status: 'unavailable' });
    const engine = new MemorySyncEngine(outbox, audit, adapter, mem0);

    const result = await engine.processEvent('evt-fail', createMemory());

    assert.equal(result.status, 'partial');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync engine returns partial when mem0 submission succeeds but confirmation times out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const outbox = new FileOutbox(join(dir, 'outbox.json'));
    const audit = new FileAuditStore(join(dir, 'audit.jsonl'));
    const mem0 = new FakeMem0Client(
      { status: 'submitted', mem0_id: 'm1', event_id: 'evt-timeout', hash: 'h1' },
      { status: 'timeout' },
    );
    const engine = new MemorySyncEngine(outbox, audit, adapter, mem0);

    const result = await engine.processEvent('evt-timeout', createMemory());

    assert.equal(result.status, 'partial');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync engine returns synced when audit, mem0 and lance all succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));

  try {
    const adapter = new InMemoryMemoryAdapter();
    const outbox = new FileOutbox(join(dir, 'outbox.json'));
    const audit = new FileAuditStore(join(dir, 'audit.jsonl'));
    const mem0 = new FakeMem0Client(
      { status: 'submitted', mem0_id: 'm1', event_id: 'evt-ok', hash: 'h1' },
      { status: 'confirmed' },
    );
    const engine = new MemorySyncEngine(outbox, audit, adapter, mem0);

    const result = await engine.processEvent('evt-ok', createMemory());

    assert.equal(result.status, 'synced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
