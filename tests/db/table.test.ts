import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableSchemaFields, openMemoryTable, sanitizeRecordsForSchema } from '../../src/db/table';

test('openMemoryTable creates table with correct schema and indices', async () => {
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
    assert.ok(fieldNames.includes('memory_type'), 'missing memory_type');
    assert.ok(fieldNames.includes('domains'), 'missing domains');
    assert.ok(fieldNames.includes('source_kind'), 'missing source_kind');
    assert.ok(fieldNames.includes('confidence'), 'missing confidence');
    assert.ok(fieldNames.includes('mem0_id'), 'missing mem0_id');
    assert.ok(fieldNames.includes('mem0_event_id'), 'missing mem0_event_id');
    assert.ok(fieldNames.includes('strength'), 'missing strength');
    assert.ok(fieldNames.includes('stability'), 'missing stability');
    assert.ok(fieldNames.includes('last_access_ts'), 'missing last_access_ts');
    assert.ok(fieldNames.includes('next_review_ts'), 'missing next_review_ts');
    assert.ok(fieldNames.includes('access_count'), 'missing access_count');
    assert.ok(fieldNames.includes('inhibition_weight'), 'missing inhibition_weight');
    assert.ok(fieldNames.includes('retention_deadline'), 'missing retention_deadline');
    assert.ok(fieldNames.includes('lifecycle_state'), 'missing lifecycle_state');
    assert.ok(fieldNames.includes('lancedb_row_key'), 'missing lancedb_row_key');
    assert.ok(fieldNames.includes('vector'), 'missing vector');

    const categoriesField = schema.fields.find((f: any) => f.name === 'categories');
    assert.ok(categoriesField, 'categories field should exist');
    assert.ok(categoriesField.type.toString().toLowerCase().includes('list'), 'categories should be a list type');

    const indices = await tbl.listIndices();
    const indexedColumns = indices.flatMap((idx: any) => idx.columns);
    assert.ok(indexedColumns.includes('user_id'), 'missing scalar index on user_id');
    assert.ok(indexedColumns.includes('lifecycle_state'), 'missing scalar index on lifecycle_state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeRecordsForSchema strips out unknown fields', () => {
  const records = [{ a: 1, b: 2, c: 3 }, { a: 4, d: 5 }];
  const allowed = new Set(['a', 'c']);

  const result = sanitizeRecordsForSchema(records, allowed);

  assert.deepEqual(result, [{ a: 1, c: 3 }, { a: 4 }]);
});

test('getTableSchemaFields returns the supported field names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-table-schema-'));
  try {
    const tbl = await openMemoryTable(dir);
    const fieldNames = await getTableSchemaFields(tbl);

    assert.ok(fieldNames.has('memory_uid'));
    assert.ok(fieldNames.has('memory_type'));
    assert.ok(fieldNames.has('vector'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryTable creates an FTS index that can answer text search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-table-fts-'));
  try {
    const tbl = await openMemoryTable(dir);
    await tbl.add([{
      memory_uid: 'fts-1',
      user_id: 'user-1',
      run_id: '',
      scope: 'long-term',
      text: 'User prefers grilled chicken burgers',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'user_explicit',
      confidence: 0.9,
      ts_event: new Date().toISOString(),
      source: 'openclaw',
      status: 'active',
      sensitivity: 'internal',
      openclaw_refs: '{}',
      mem0_id: '',
      mem0_event_id: '',
      mem0_hash: '',
      lancedb_row_key: 'fts-1',
      vector: new Array<number>(16).fill(0.1),
    }]);

    const rows = await (tbl as any)
      .search('grilled chicken', 'fts', 'text')
      .where(`user_id = 'user-1' AND status = 'active'`)
      .limit(5)
      .toArray();

    assert.ok(rows.some((row: any) => row.memory_uid === 'fts-1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
