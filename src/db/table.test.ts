import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryTable } from './table';

test('openMemoryTable creates table with correct schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-table-'));
  try {
    const tbl = await openMemoryTable(dir);
    const schema = await tbl.schema();
    const fieldNames = schema.fields.map((f: any) => f.name);
    assert.ok(fieldNames.includes('memory_uid'), 'missing memory_uid');
    assert.ok(fieldNames.includes('text'), 'missing text');
    assert.ok(fieldNames.includes('user_id'), 'missing user_id');
    assert.ok(fieldNames.includes('scope'), 'missing scope');
    assert.ok(fieldNames.includes('ts_event'), 'missing ts_event');
    assert.ok(fieldNames.includes('status'), 'missing status');
    assert.ok(fieldNames.includes('source'), 'missing source');
    assert.ok(fieldNames.includes('openclaw_refs'), 'missing openclaw_refs');
    assert.ok(fieldNames.includes('sensitivity'), 'missing sensitivity');
    assert.ok(fieldNames.includes('mem0_id'), 'missing mem0_id');
    assert.ok(fieldNames.includes('mem0_event_id'), 'missing mem0_event_id');
    assert.ok(fieldNames.includes('lancedb_row_key'), 'missing lancedb_row_key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
