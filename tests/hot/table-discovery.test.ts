import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as lancedb from '@lancedb/lancedb';

import { discoverMemoryTables } from '../../src/hot/table-discovery';

test('discoverMemoryTables includes legacy-suffixed tables as legacy sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'table-discovery-'));

  try {
    const db = await lancedb.connect(dir);
    await db.createTable('memory_records', [{ memory_uid: 'a', text: 'current' }]);
    await db.createTable('memory_records_d768_legacy_123', [{ memory_uid: 'b', text: 'legacy' }]);

    const tables = await discoverMemoryTables(dir, 16);

    assert.deepEqual(
      tables.map((table) => ({ name: table.name, dimension: table.dimension })),
      [
        { name: 'memory_records', dimension: 16 },
        { name: 'memory_records_d768_legacy_123', dimension: 0 },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
