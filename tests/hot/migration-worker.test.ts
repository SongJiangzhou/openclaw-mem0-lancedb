import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as lancedb from '@lancedb/lancedb';

import { openMemoryTable } from '../../src/db/table';
import { EmbeddingMigrationWorker } from '../../src/hot/migration-worker';

const baseConfig = {
  mem0BaseUrl: '',
  mem0ApiKey: '',
  outboxDbPath: '',
  auditStorePath: '',
  autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
  autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
  embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  embeddingMigration: { enabled: true, intervalMs: 60_000, batchSize: 20 },
};

function makeLegacyRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    memory_uid: 'memory-1',
    user_id: 'user-1',
    run_id: '',
    scope: 'long-term',
    text: 'User prefers concise answers',
    categories: ['preference'],
    tags: [],
    ts_event: new Date().toISOString(),
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: '{}',
    mem0_id: '',
    mem0_event_id: '',
    mem0_hash: '',
    lancedb_row_key: 'memory-1',
    vector: new Array<number>(768).fill(0),
    ...overrides,
  };
}

test('migration worker moves legacy rows into the current-dimension table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const legacyTable = await openMemoryTable(dir, 768);
    await legacyTable.add([makeLegacyRow()]);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await worker.runOnce();

    const currentTable = await openMemoryTable(dir, 16);
    const refreshedLegacyTable = await openMemoryTable(dir, 768);
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const legacyRows = await refreshedLegacyTable.query().where("memory_uid = 'memory-1'").toArray();

    assert.equal(migratedRows.length, 1);
    assert.equal(migratedRows[0]?.vector.length, 16);
    assert.equal(legacyRows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker drops a legacy table after all rows are migrated out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const legacyTable = await openMemoryTable(dir, 768);
    await legacyTable.add([makeLegacyRow()]);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await worker.runOnce();

    const db = await lancedb.connect(dir);
    const tableNames = await db.tableNames();

    assert.equal(tableNames.includes('memory_records_d768'), false);
    assert.equal(tableNames.includes('memory_records'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker keeps legacy rows when destination upsert fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const legacyTable = await openMemoryTable(dir, 768);
    await legacyTable.add([makeLegacyRow()]);

    class FailingWorker extends EmbeddingMigrationWorker {
      protected override async upsertCurrentRow(): Promise<void> {
        throw new Error('boom');
      }
    }

    const worker = new FailingWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await worker.runOnce();

    const currentTable = await openMemoryTable(dir, 16);
    const refreshedLegacyTable = await openMemoryTable(dir, 768);
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const legacyRows = await refreshedLegacyTable.query().where("memory_uid = 'memory-1'").toArray();

    assert.equal(migratedRows.length, 0);
    assert.equal(legacyRows.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker exits quietly when there are no legacy tables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    await openMemoryTable(dir, 16);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await assert.doesNotReject(async () => worker.runOnce());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker skips deleted and empty-text legacy rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const legacyTable = await openMemoryTable(dir, 768);
    await legacyTable.add([
      makeLegacyRow({ memory_uid: 'deleted-1', lancedb_row_key: 'deleted-1', status: 'deleted' }),
      makeLegacyRow({ memory_uid: 'empty-1', lancedb_row_key: 'empty-1', text: '   ' }),
    ]);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await worker.runOnce();

    const currentTable = await openMemoryTable(dir, 16);
    const refreshedLegacyTable = await openMemoryTable(dir, 768);
    const migratedRows = await currentTable.query().toArray();
    const legacyRows = await refreshedLegacyTable.query().toArray();

    assert.equal(migratedRows.length, 0);
    assert.equal(legacyRows.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
