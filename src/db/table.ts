import * as lancedb from '@lancedb/lancedb';
import { MEMORY_TABLE } from './schema';
import * as os from 'os';
import * as path from 'path';

export async function openMemoryTable(dbPath: string) {
  const resolvedPath = dbPath.startsWith('~/')
    ? path.join(os.homedir(), dbPath.slice(2))
    : dbPath;

  const db = await lancedb.connect(resolvedPath);
  const tables = await db.tableNames();

  if (tables.includes(MEMORY_TABLE)) {
    return db.openTable(MEMORY_TABLE);
  }

  // 建表，使用占位记录定义 schema
  const tbl = await db.createTable(MEMORY_TABLE, [{
    memory_uid: '__init__',
    user_id: '',
    run_id: '',
    scope: 'long-term',
    text: '',
    categories: '[]',
    tags: '[]',
    ts_event: new Date().toISOString(),
    source: 'openclaw',
    status: 'deleted',
    sensitivity: 'internal',
    openclaw_refs: '{}',
    mem0_event_id: '',
    mem0_hash: '',
  }]);

  // 删掉占位记录
  await tbl.delete(`memory_uid = '__init__'`);

  return tbl;
}

export async function ensureFtsIndex(tbl: Awaited<ReturnType<typeof openMemoryTable>>) {
  try {
    await tbl.createIndex('text', { config: (lancedb as any).Index?.fts?.() });
  } catch (_) {
    // FTS 索引建立失败时静默，不影响基本检索
  }
}
