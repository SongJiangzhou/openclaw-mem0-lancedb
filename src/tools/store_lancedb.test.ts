import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStoreTool } from './store';
import { openMemoryTable } from '../db/table';

test('store writes to LanceDB and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-store-'));
  try {
    const outboxDbPath = join(dir, 'outbox.json');
    const auditStorePath = join(dir, 'audit', 'memory_records.jsonl');
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath,
      auditStorePath,
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
    };
    const store = new MemoryStoreTool(cfg);

    const r1 = await store.execute({ text: '用户偏好：中文回复', userId: 'railgun', scope: 'long-term', categories: ['preference'] });
    assert.equal(r1.success, true);
    assert.equal(r1.syncStatus, 'partial');

    // 幂等：同一条写两次，LanceDB 里只应有一条
    const r2 = await store.execute({ text: '用户偏好：中文回复', userId: 'railgun', scope: 'long-term', categories: ['preference'] });
    assert.equal(r2.syncStatus, 'partial');

    const tbl = await openMemoryTable(dir);
    const rows = await tbl.query().where(`user_id = 'railgun'`).toArray();
    assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
    assert.ok(rows[0]?.vector && typeof rows[0].vector.length === 'number', 'expected stored vector-like field');
    assert.equal(rows[0]?.vector.length, 16);

    const outbox = JSON.parse(readFileSync(outboxDbPath, 'utf-8')) as {
      items: Array<{ status: string }>;
    };
    assert.ok(outbox.items.length >= 2);
    assert.equal(outbox.items[0]?.status, 'done');
    assert.equal(outbox.items[1]?.status, 'done');

    const auditLines = readFileSync(auditStorePath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.ok(auditLines.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
