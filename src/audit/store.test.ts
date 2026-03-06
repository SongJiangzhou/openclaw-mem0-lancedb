import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from './store';
import type { MemoryRecord } from '../types';

function buildRecord(): MemoryRecord {
  return {
    memory_uid: 'm-1',
    user_id: 'railgun',
    run_id: null,
    scope: 'long-term',
    text: '用户偏好：回复必须使用中文',
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
