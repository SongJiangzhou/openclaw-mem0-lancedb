import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStoreTool } from './store';
import { openMemoryTable } from '../db/table';

test('store writes to LanceDB and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-store-'));
  try {
    const cfg = { lancedbPath: dir, mem0BaseUrl: '', mem0ApiKey: '', outboxDbPath: join(dir, 'outbox.db') };
    const store = new MemoryStoreTool(cfg);

    const r1 = await store.execute({ text: '用户偏好：中文回复', userId: 'railgun', scope: 'long-term', categories: ['preference'] });
    assert.equal(r1.success, true);

    // 幂等：同一条写两次，LanceDB 里只应有一条
    await store.execute({ text: '用户偏好：中文回复', userId: 'railgun', scope: 'long-term', categories: ['preference'] });

    const tbl = await openMemoryTable(dir);
    const rows = await tbl.query().where(`user_id = 'railgun'`).toArray();
    assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
