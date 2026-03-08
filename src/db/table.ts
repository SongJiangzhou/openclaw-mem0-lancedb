import * as lancedb from '@lancedb/lancedb';
import { getMemoryTableName } from './schema';
import * as os from 'os';
import * as path from 'path';

export async function openMemoryTable(dbPath: string, dim: number = 16) {
  const resolvedPath = dbPath.startsWith('~/')
    ? path.join(os.homedir(), dbPath.slice(2))
    : dbPath;

  const tableName = getMemoryTableName(dim);

  const db = await lancedb.connect(resolvedPath);
  const tables = await db.tableNames();

  if (tables.includes(tableName)) {
    return db.openTable(tableName);
  }

  // 建表，使用占位记录定义 schema
  const tbl = await db.createTable(tableName, [{
    memory_uid: '__init__',
    user_id: '',
    run_id: '',
    scope: 'long-term',
    text: '',
    categories: [''],
    tags: [''],
    memory_type: 'generic',
    domains: ['generic'],
    source_kind: 'user_explicit',
    confidence: 0.7,
    ts_event: new Date().toISOString(),
    source: 'openclaw',
    status: 'deleted',
    sensitivity: 'internal',
    openclaw_refs: '{}',
    mem0_id: '',
    mem0_event_id: '',
    mem0_hash: '',
    lancedb_row_key: '',
    vector: new Array<number>(dim).fill(0),
  }]);

  // 删掉占位记录
  await tbl.delete(`memory_uid = '__init__'`);

  try {
    await tbl.createIndex('user_id'); // Scalar index
    await tbl.createIndex('status'); // Scalar index
    await tbl.createIndex('scope'); // Scalar index
  } catch (err) {
    console.warn('Index creation failed or already exists', err);
  }

  return tbl;
}

export async function ensureFtsIndex(tbl: Awaited<ReturnType<typeof openMemoryTable>>) {
  try {
    await tbl.createIndex('text', { config: (lancedb as any).Index?.fts?.() });
  } catch (_) {
    // FTS 索引建立失败时静默，不影响基本检索
  }
}
