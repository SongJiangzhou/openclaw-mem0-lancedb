import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('lancedb can create table and insert row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-smoke-'));
  try {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dir);
    const tbl = await db.createTable('test', [{ id: 'a', text: 'hello' }]);
    const rows = await tbl.query().limit(1).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
