import * as lancedb from '@lancedb/lancedb';
import { getMemoryTableName } from './schema';
import * as os from 'os';
import * as path from 'path';
import { PluginDebugLogger } from '../debug/logger';
import { initializeLifecycleFields } from '../memory/lifecycle';

const dbCache = new Map<string, Promise<any>>();

export function clearDbCache(): void {
  dbCache.clear();
}

export function clearDbCacheForPath(dbPath: string): void {
  dbCache.delete(resolveDbPath(dbPath));
}

export async function openMemoryTable(dbPath: string, dim: number = 16) {
  const resolvedPath = resolveDbPath(dbPath);

  const tableName = getMemoryTableName(dim);

  const db = await getDb(resolvedPath);
  const tables = await db.tableNames();

  if (tables.includes(tableName)) {
    const tbl = await db.openTable(tableName);
    await ensureFtsIndex(tbl);
    return tbl;
  }

  // 建表，使用占位记录定义 schema
  const tsEvent = new Date().toISOString();
  const lifecycle = initializeLifecycleFields({
    tsEvent,
    status: 'deleted',
    scope: 'long-term',
    sensitivity: 'internal',
  });
  const tbl = await db.createTable(tableName, [{
    memory_uid: '__init__',
    user_id: '',
    session_id: '',
    agent_id: '',
    run_id: '',
    scope: 'long-term',
    text: '',
    categories: [''],
    tags: [''],
    memory_type: 'generic',
    domains: ['generic'],
    source_kind: 'user_explicit',
    confidence: 0.7,
    ts_event: tsEvent,
    source: 'openclaw',
    status: 'deleted',
    sensitivity: 'internal',
    openclaw_refs: '{}',
    mem0_id: '',
    mem0_event_id: '',
    mem0_hash: '',
    strength: lifecycle.strength,
    stability: lifecycle.stability,
    last_access_ts: lifecycle.last_access_ts,
    next_review_ts: lifecycle.next_review_ts,
    access_count: lifecycle.access_count,
    inhibition_weight: lifecycle.inhibition_weight,
    inhibition_until: lifecycle.inhibition_until,
    utility_score: lifecycle.utility_score,
    risk_score: lifecycle.risk_score,
    retention_deadline: lifecycle.retention_deadline,
    lifecycle_state: lifecycle.lifecycle_state,
    lancedb_row_key: '',
    vector: new Array<number>(dim).fill(0),
  }]);

  // 删掉占位记录
  await tbl.delete(`memory_uid = '__init__'`);

  try {
    await tbl.createIndex('user_id'); // Scalar index
    await tbl.createIndex('session_id'); // Scalar index
    await tbl.createIndex('status'); // Scalar index
    await tbl.createIndex('scope'); // Scalar index
    await tbl.createIndex('mem0_hash'); // Scalar index
    await tbl.createIndex('lifecycle_state'); // Scalar index
    await tbl.createIndex('retention_deadline'); // Scalar index
  } catch (err) {
    new PluginDebugLogger({ mode: 'off' })
      .child('memory.db')
      .exception('memory_db.index_creation_failed', err);
  }

  await ensureFtsIndex(tbl);

  return tbl;
}

export async function openMemoryTableByName(dbPath: string, tableName: string) {
  const resolvedPath = resolveDbPath(dbPath);

  const db = await getDb(resolvedPath);
  return db.openTable(tableName);
}

export async function ensureFtsIndex(tbl: Awaited<ReturnType<typeof openMemoryTable>>) {
  try {
    await tbl.createIndex('text', { config: (lancedb as any).Index?.fts?.() });
  } catch (_) {
    // FTS 索引建立失败时静默，不影响基本检索
  }
}

export async function getTableSchemaFields(tbl: Awaited<ReturnType<typeof openMemoryTable>>): Promise<Set<string>> {
  const schema = await tbl.schema();
  return new Set(schema.fields.map((field: any) => String(field.name)));
}

export function sanitizeRecordsForSchema(
  records: Record<string, unknown>[],
  allowedFields: Set<string>,
): Record<string, unknown>[] {
  return records.map((record) => {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (allowedFields.has(key)) {
        sanitized[key] = record[key];
      }
    }
    return sanitized;
  });
}

function resolveDbPath(dbPath: string): string {
  return dbPath.startsWith('~/')
    ? path.join(os.homedir(), dbPath.slice(2))
    : dbPath;
}

async function getDb(resolvedPath: string): Promise<any> {
  const cached = dbCache.get(resolvedPath);
  if (cached) {
    return cached;
  }

  const connectionPromise = lancedb.connect(resolvedPath);
  dbCache.set(resolvedPath, connectionPromise);
  return connectionPromise;
}
