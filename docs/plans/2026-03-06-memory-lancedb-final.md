# Memory LanceDB 最终态实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有 JSONL 过渡版升级为真正的 LanceDB 表结构，实现 Markdown 真相源 + Mem0 控制面 + LanceDB 热检索面的最终形态。

**Architecture:** Markdown 继续作为人类可读真相源；Mem0 作为治理/控制面（无 API Key 时本地 fallback）；LanceDB 嵌入式作为向量 + FTS + hybrid search 检索热面。双写通过 outbox + 幂等主键保证一致性。

**Tech Stack:** Node.js/TypeScript, LanceDB (npm `vectordb`), Python (memory_bridge), SQLite (outbox), OpenClaw plugin API

---

### Task 1: 安装 LanceDB 依赖并验证可用

**Files:**
- Modify: `plugins/memory-mem0-lancedb/package.json`
- Test: `plugins/memory-mem0-lancedb/src/tools/lancedb_smoke.test.ts`

**Step 1: 写失败测试**

***REMOVED***typescript
// src/tools/lancedb_smoke.test.ts
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
***REMOVED***

**Step 2: 运行验证失败**
***REMOVED***bash
cd plugins/memory-mem0-lancedb && npm test
***REMOVED***
Expected: FAIL (module not found)

**Step 3: 安装 LanceDB**
***REMOVED***bash
cd plugins/memory-mem0-lancedb && npm install @lancedb/lancedb
***REMOVED***

**Step 4: 运行验证通过**
***REMOVED***bash
npm test
***REMOVED***
Expected: PASS

**Step 5: Commit**
***REMOVED***bash
git add plugins/memory-mem0-lancedb/package.json plugins/memory-mem0-lancedb/package-lock.json
git commit -m "feat: add @lancedb/lancedb dependency"
***REMOVED***

---

### Task 2: 定义 LanceDB 表 Schema 并实现建表

**Files:**
- Create: `plugins/memory-mem0-lancedb/src/db/schema.ts`
- Create: `plugins/memory-mem0-lancedb/src/db/table.ts`
- Test: `plugins/memory-mem0-lancedb/src/db/table.test.ts`

**Step 1: 写失败测试**

***REMOVED***typescript
// src/db/table.test.ts
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
    const schema = tbl.schema;
    const fieldNames = schema.fields.map((f: any) => f.name);
    assert.ok(fieldNames.includes('memory_uid'));
    assert.ok(fieldNames.includes('text'));
    assert.ok(fieldNames.includes('user_id'));
    assert.ok(fieldNames.includes('scope'));
    assert.ok(fieldNames.includes('ts_event'));
    assert.ok(fieldNames.includes('status'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
***REMOVED***

**Step 2: 运行验证失败**
***REMOVED***bash
npm test
***REMOVED***
Expected: FAIL

**Step 3: 实现 schema 与建表**

***REMOVED***typescript
// src/db/schema.ts
export const MEMORY_TABLE = 'memory_records';

export interface MemoryRow {
  memory_uid: string;
  user_id: string;
  run_id: string;
  scope: string;
  text: string;
  categories: string;    // JSON array string
  tags: string;          // JSON array string
  ts_event: string;      // ISO datetime
  source: string;
  status: string;        // active | superseded | deleted
  sensitivity: string;   // public | internal | confidential | restricted
  openclaw_refs: string; // JSON object string
  mem0_event_id: string;
  mem0_hash: string;
}

// src/db/table.ts
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
  // 建表，使用一条占位记录定义 schema
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
  // 创建 FTS 索引
  await tbl.createFtsIndex('text', { replace: true });
  return tbl;
}
***REMOVED***

**Step 4: 运行验证通过**
***REMOVED***bash
npm run build && npm test
***REMOVED***
Expected: PASS

**Step 5: Commit**
***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/db/
git commit -m "feat: define LanceDB memory table schema and openMemoryTable"
***REMOVED***

---

### Task 3: 实现 store（幂等写入 LanceDB）

**Files:**
- Modify: `plugins/memory-mem0-lancedb/src/tools/store.ts`
- Test: `plugins/memory-mem0-lancedb/src/tools/store_lancedb.test.ts`

**Step 1: 写失败测试**

***REMOVED***typescript
// src/tools/store_lancedb.test.ts
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
    assert.equal(rows.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
***REMOVED***

**Step 2: 运行验证失败**
***REMOVED***bash
npm run build && npm test
***REMOVED***
Expected: FAIL

**Step 3: 改写 store.ts，写入 LanceDB**

修改 `execute` 中的 `storeLocal`，改为：
1. `openMemoryTable(lancedbPath)`
2. 先查询 `memory_uid` 是否已存在
3. 不存在则 `add`，存在则跳过（幂等）

**Step 4: 运行验证通过**
***REMOVED***bash
npm run build && npm test
***REMOVED***
Expected: PASS

**Step 5: Commit**
***REMOVED***bash
git commit -am "feat: store writes to real LanceDB table with idempotency"
***REMOVED***

---

### Task 4: 实现 search（FTS + 过滤，hybrid 占位）

**Files:**
- Modify: `plugins/memory-mem0-lancedb/src/tools/search.ts`
- Test: `plugins/memory-mem0-lancedb/src/tools/search_lancedb.test.ts`

**Step 1: 写失败测试**

***REMOVED***typescript
// src/tools/search_lancedb.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStoreTool } from './store';
import { MemorySearchTool } from './search';

test('search finds stored memory by text (FTS)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldb-search-'));
  try {
    const cfg = { lancedbPath: dir, mem0BaseUrl: '', mem0ApiKey: '', outboxDbPath: join(dir, 'outbox.db') };
    const store = new MemoryStoreTool(cfg);
    const search = new MemorySearchTool(cfg);
    await store.execute({ text: '用户偏好：回复必须使用中文', userId: 'railgun', scope: 'long-term', categories: ['preference'] });
    const r = await search.execute({ query: '回复必须使用中文', userId: 'railgun', topK: 3 });
    assert.equal(r.source, 'lancedb');
    assert.ok(r.memories.length >= 1);
    assert.match(r.memories[0].text, /回复必须使用中文/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
***REMOVED***

**Step 2: 运行验证失败**
***REMOVED***bash
npm run build && npm test
***REMOVED***

**Step 3: 改写 search.ts，走 LanceDB FTS**

用 `tbl.search(query, 'fts', 'text').where(...).limit(topK).toArray()` 实现检索，`source` 返回 `'lancedb'`。

**Step 4: 运行验证通过**
***REMOVED***bash
npm run build && npm test
***REMOVED***

**Step 5: Commit**
***REMOVED***bash
git commit -am "feat: search uses LanceDB FTS index"
***REMOVED***

---

### Task 5: 把现有迁移数据从 JSONL 导入真实 LanceDB 表

**Files:**
- Create: `plugins/memory-mem0-lancedb/scripts/migrate_jsonl_to_lancedb.ts`

**Step 1: 写迁移脚本**

读取 `data/memory_lancedb/memory_records.jsonl`，逐行 parse，写入 LanceDB 表（幂等）。

**Step 2: 运行迁移**
***REMOVED***bash
cd plugins/memory-mem0-lancedb && npx ts-node scripts/migrate_jsonl_to_lancedb.ts
***REMOVED***
Expected: 输出迁移行数

**Step 3: 验证**
***REMOVED***bash
node -e "require('./dist/db/table.js').openMemoryTable('~/.openclaw/workspace/data/memory_lancedb').then(t=>t.countRows()).then(console.log)"
***REMOVED***
Expected: ≥ 9

**Step 4: Commit**
***REMOVED***bash
git commit -am "feat: migrate existing JSONL records to real LanceDB table"
***REMOVED***

---

### Task 6: 全量测试通过 + plugin 验证

**Step 1: 全量测试**
***REMOVED***bash
cd plugins/memory-mem0-lancedb && npm run build && npm test
***REMOVED***
Expected: 全部 PASS

**Step 2: plugin 状态验证**
***REMOVED***bash
openclaw plugins info memory-mem0-lancedb
***REMOVED***
Expected: `Status: loaded`

**Step 3: 端到端验证**
***REMOVED***bash
node -e "
const {MemoryStoreTool} = require('./dist/tools/store');
const {MemorySearchTool} = require('./dist/tools/search');
const cfg={lancedbPath:'~/.openclaw/workspace/data/memory_lancedb',mem0BaseUrl:'',mem0ApiKey:'',outboxDbPath:'/tmp/ob.db'};
(async()=>{
  await new MemoryStoreTool(cfg).execute({text:'final state test',userId:'railgun',scope:'long-term',categories:['test']});
  const r=await new MemorySearchTool(cfg).execute({query:'final state test',userId:'railgun',topK:1});
  console.log(JSON.stringify({source:r.source,hit:r.memories.length}));
})();
"
***REMOVED***
Expected: `{"source":"lancedb","hit":1}`

**Step 4: Commit**
***REMOVED***bash
git commit -am "chore: all tests pass, LanceDB final state verified"
***REMOVED***
