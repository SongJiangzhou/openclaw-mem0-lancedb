import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../../src/audit/store';
import type { MemoryRecord } from '../../src/types';

function buildRecord(): MemoryRecord {
  return {
    memory_uid: 'm-1',
    user_id: 'user-1',
    run_id: null,
    scope: 'long-term',
    text: 'User preference: reply in English',
    categories: ['preference'],
    tags: ['lang'],
    ts_event: '2026-03-07T12:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: {
      file_path: 'MEMORY.md',
      line_start: 1,
      line_end: 1,
    },
    mem0: {
      mem0_id: null,
      hash: null,
      event_id: null,
    },
    lancedb: {
      table: 'memory_records',
      row_key: 'm-1',
      vector_dim: null,
      index_version: null,
    },
  };
}

test('audit store persists records and looks them up by file path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));

  try {
    const audit = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const record = buildRecord();

    await audit.append(record);

    const latest = await audit.findLatestByFilePath('MEMORY.md');

    assert.ok(latest);
    assert.equal(latest?.memory_uid, 'm-1');
    assert.equal(latest?.openclaw_refs?.file_path, 'MEMORY.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit store can stream latest rows by memory uid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-store-latest-'));

  try {
    const audit = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const first = buildRecord();
    const second = {
      ...buildRecord(),
      memory_uid: 'm-1',
      text: 'User preference: reply concisely',
      ts_event: '2026-03-08T12:00:00.000Z',
    };
    const other = {
      ...buildRecord(),
      memory_uid: 'm-2',
      text: 'User prefers sparkling water',
      ts_event: '2026-03-07T13:00:00.000Z',
    };

    await audit.append(first);
    await audit.append(other);
    await audit.append(second);

    const latest = await audit.readLatestRows();
    const latestByUid = new Map(latest.map((row) => [row.memory_uid, row]));

    assert.equal(latestByUid.size, 2);
    assert.equal(latestByUid.get('m-1')?.text, 'User preference: reply concisely');
    assert.equal(latestByUid.get('m-2')?.text, 'User prefers sparkling water');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit store append remains append-only even after many writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-store-append-only-'));

  try {
    const audit = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));

    for (let index = 0; index < 5000; index += 1) {
      await audit.append({
        ...buildRecord(),
        memory_uid: 'm-append-only',
        text: `version-${index}`,
        ts_event: `2026-03-07T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    const rows = await audit.readAll();

    assert.equal(rows.length, 5000);
    assert.equal(rows[0]?.memory_uid, 'm-append-only');
    assert.equal(rows[rows.length - 1]?.text, 'version-4999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
