import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const db = await lancedb.connect(dir);
    const tableNames = await db.tableNames();

    assert.equal(migratedRows.length, 1);
    assert.equal(migratedRows[0]?.vector.length, 16);
    assert.equal(tableNames.includes('memory_records_d768'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker renames a fully migrated legacy table to .bak and removes the .lance directory', async () => {
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
    assert.equal(existsSync(join(dir, 'memory_records_d768.lance')), false);
    assert.equal(existsSync(join(dir, 'memory_records_d768.bak')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration worker migrates the legacy main table into the current embedding dimension and backs it up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const legacyMainTable = await openMemoryTable(dir, 16);
    await legacyMainTable.add([makeLegacyRow({ vector: new Array<number>(16).fill(0) })]);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 768 },
    });

    await worker.runOnce();

    const currentTable = await openMemoryTable(dir, 768);
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const db = await lancedb.connect(dir);
    const tableNames = await db.tableNames();

    assert.equal(migratedRows.length, 1);
    assert.equal(migratedRows[0]?.vector.length, 768);
    assert.equal(tableNames.includes('memory_records'), false);
    assert.equal(tableNames.includes('memory_records_d768'), true);
    assert.equal(existsSync(join(dir, 'memory_records.lance')), false);
    assert.equal(existsSync(join(dir, 'memory_records.bak')), true);
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
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const db = await lancedb.connect(dir);
    const legacyTableAfter = await db.openTable('memory_records_d768');
    const legacyRows = await legacyTableAfter.query().where("memory_uid = 'memory-1'").toArray();

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

test('migration worker renames an outdated active table, recreates the current schema, and migrates rows back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-worker-'));

  try {
    const db = await lancedb.connect(dir);
    await db.createTable('memory_records', [{
      memory_uid: 'memory-1',
      user_id: 'user-1',
      run_id: '',
      scope: 'long-term',
      text: 'User prefers concise answers',
      categories: ['preference'],
      tags: ['style'],
      ts_event: new Date().toISOString(),
      source: 'openclaw',
      status: 'active',
      sensitivity: 'internal',
      openclaw_refs: '{}',
      mem0_id: '',
      mem0_event_id: '',
      mem0_hash: '',
      lancedb_row_key: 'memory-1',
      vector: new Array<number>(16).fill(0),
    }]);

    const worker = new EmbeddingMigrationWorker({
      ...baseConfig,
      lancedbPath: dir,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    });

    await worker.runOnce();

    const currentTable = await openMemoryTable(dir, 16);
    const migratedRows = await currentTable.query().where("memory_uid = 'memory-1'").toArray();
    const schema = await currentTable.schema();
    const fieldNames = schema.fields.map((field: any) => String(field.name));
    const files = readdirSync(dir);

    assert.equal(migratedRows.length, 1);
    assert.equal(migratedRows[0]?.memory_type, 'generic');
    assert.ok(fieldNames.includes('memory_type'));
    assert.ok(fieldNames.includes('domains'));
    assert.equal(existsSync(join(dir, 'memory_records.lance')), true);
    assert.ok(files.some((file) => /^memory_records_legacy_\d+\.bak$/.test(file)));
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
