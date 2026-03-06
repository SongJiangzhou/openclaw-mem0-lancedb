# Mem0 + LanceDB Final State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把当前过渡版 JSONL 记忆机制升级为“Markdown 真相源 + Mem0 控制面 + LanceDB 真表检索面”的最终形态，并保留幂等、同步、可见性确认与回滚能力。

**Architecture:** OpenClaw 的 `memory-mem0-lancedb` 插件继续占用独占 `memory` 槽位；`MEMORY.md` 与 `memory/*.md` 保持人类可读真相源；插件内实现本地 outbox + LanceDB 真表 + FTS/向量/混合检索；Mem0 作为控制面与异步事件源，当前先按“接口完整、无 key 可本地运行、有 key 可接云端/OSS”落地。

**Tech Stack:** TypeScript, Node.js, LanceDB Node SDK, OpenClaw plugin API, node:test, JSONL migration utility, SQLite/outbox（最小实现可先文件型，再切 SQLite）。

---

### Task 1: 固化目标设计与现状基线

**Files:**
- Read: `docs/plans/2026-03-06-mem0-lancedb-slot-switch-design.md`
- Read: `docs/plans/2026-03-06-mem0-lancedb-openclaw-plugin-phase2.md`
- Read: `docs/plans/2026-03-06-mem0-lancedb-memory-mvp.md`
- Read: `plugins/memory-mem0-lancedb/src/index.ts`
- Read: `plugins/memory-mem0-lancedb/src/tools/search.ts`
- Read: `plugins/memory-mem0-lancedb/src/tools/store.ts`
- Read: `plugins/memory-mem0-lancedb/src/types.ts`

**Step 1: 记录当前插件基线**

Run:
***REMOVED***bash
openclaw plugins info memory-mem0-lancedb
npm run build && npm test
***REMOVED***

Expected: 插件 `loaded`，当前测试全绿。

**Step 2: 记录当前数据基线**

Run:
***REMOVED***bash
python - <<'PY'
import json
p='data/memory_lancedb/memory_records.jsonl'
rows=sum(1 for l in open(p,encoding='utf-8') if l.strip()) if __import__('os').path.exists(p) else 0
print({'jsonl_rows': rows})
PY
***REMOVED***

Expected: 输出现有 JSONL 行数，作为迁移前基线。

**Step 3: Commit**

***REMOVED***bash
git add docs/plans/2026-03-06-mem0-lancedb-final-state-implementation.md
git commit -m "docs: add final-state memory implementation plan"
***REMOVED***

### Task 2: 先写失败测试，定义 LanceDB 真表最小行为

**Files:**
- Create: `plugins/memory-mem0-lancedb/src/store/lancedb_table.test.ts`
- Read: `plugins/memory-mem0-lancedb/package.json`

**Step 1: Write the failing test**

***REMOVED***ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTable, upsertMemoryRecord, searchMemoryHybrid } from './lancedb_table';

test('creates LanceDB table and reads back inserted memory', async () => {
  const ctx = await createMemoryTable('/tmp/memory-final-test');
  await upsertMemoryRecord(ctx, {
    memory_uid: 'm1',
    user_id: 'railgun',
    scope: 'long-term',
    text: '回复必须使用中文',
    categories: ['preference'],
    ts_event: new Date().toISOString(),
    source: 'openclaw',
    status: 'active',
  });
  const rows = await searchMemoryHybrid(ctx, { query: '中文', userId: 'railgun', topK: 3 });
  assert.equal(rows.length > 0, true);
});
***REMOVED***

**Step 2: Run test to verify it fails**

Run:
***REMOVED***bash
npm run build && node --test dist/store/lancedb_table.test.js
***REMOVED***

Expected: FAIL，因为 `lancedb_table` 还不存在。

**Step 3: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/store/lancedb_table.test.ts
git commit -m "test: define LanceDB table contract"
***REMOVED***

### Task 3: 实现 LanceDB 真表访问层（最小可用）

**Files:**
- Create: `plugins/memory-mem0-lancedb/src/store/lancedb_table.ts`
- Modify: `plugins/memory-mem0-lancedb/src/types.ts`
- Test: `plugins/memory-mem0-lancedb/src/store/lancedb_table.test.ts`

**Step 1: Write minimal implementation**

实现这些导出：
- `createMemoryTable(dbPath)`
- `upsertMemoryRecord(ctx, record)`
- `searchMemoryHybrid(ctx, { query, userId, topK, filters })`

最小实现要求：
- 真正连接 LanceDB 路径
- 创建 `memories` 表
- 表中至少包含：`memory_uid`, `user_id`, `scope`, `text`, `categories`, `ts_event`, `status`
- 第一版允许“先用 FTS/文本检索跑通”，但必须落到 LanceDB 表，不再写 JSONL 作为主路径

**Step 2: Run targeted test**

Run:
***REMOVED***bash
npm run build && node --test dist/store/lancedb_table.test.js
***REMOVED***

Expected: PASS。

**Step 3: Refactor**
- 补齐 schema 说明
- 把路径解析、表名、索引准备抽成小函数

**Step 4: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/store/lancedb_table.ts plugins/memory-mem0-lancedb/src/types.ts plugins/memory-mem0-lancedb/src/store/lancedb_table.test.ts
git commit -m "feat: add LanceDB table store for memory plugin"
***REMOVED***

### Task 4: 用 LanceDB 真表替换当前 JSONL 写入路径

**Files:**
- Modify: `plugins/memory-mem0-lancedb/src/tools/store.ts`
- Modify: `plugins/memory-mem0-lancedb/src/tools/search.ts`
- Modify: `plugins/memory-mem0-lancedb/src/tools/get.ts`
- Test: `plugins/memory-mem0-lancedb/src/tools/local_fallback.test.ts`

**Step 1: Write the failing test**

把现有 local fallback 测试改成“无 key 时写 LanceDB 真表并检索命中”，不再接受 JSONL 作为主存。

**Step 2: Run test to verify it fails**

Run:
***REMOVED***bash
npm run build && npm test
***REMOVED***

Expected: FAIL，直到工具层切到 LanceDB 真表。

**Step 3: Write minimal implementation**
- `memoryStore` 无 key 时：写 LanceDB 真表 + 可选 outbox 记录
- `memorySearch`：从 LanceDB 真表查，支持 user_id / scope / status / categories 过滤
- `memoryGet`：根据 `openclaw_refs.file_path` 回读最近版本
- JSONL 只保留为迁移输入，不再作为主存

**Step 4: Run full plugin tests**

Run:
***REMOVED***bash
npm run build && npm test
***REMOVED***

Expected: PASS。

**Step 5: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/tools/store.ts plugins/memory-mem0-lancedb/src/tools/search.ts plugins/memory-mem0-lancedb/src/tools/get.ts plugins/memory-mem0-lancedb/src/tools/local_fallback.test.ts
git commit -m "feat: switch memory tools to LanceDB table backend"
***REMOVED***

### Task 5: 加入向量列与 FTS / hybrid search 骨架

**Files:**
- Modify: `plugins/memory-mem0-lancedb/src/store/lancedb_table.ts`
- Create: `plugins/memory-mem0-lancedb/src/store/embedder.ts`
- Create: `plugins/memory-mem0-lancedb/src/store/hybrid_search.test.ts`

**Step 1: Write the failing test**

测试要求：
- 写入 2 条文本
- 一条关键词命中、一条语义近似命中
- `searchMemoryHybrid` 返回去重后的 Top-K

**Step 2: Run test to verify it fails**

Run:
***REMOVED***bash
npm run build && node --test dist/store/hybrid_search.test.js
***REMOVED***

Expected: FAIL。

**Step 3: Implement minimal code**
- 加入 `vector` 列（维度可配置）
- `embedder.ts` 提供统一 embedding 接口：
  - 有外部 provider 时真实嵌入
  - 无 provider 时可退化为 deterministic dummy vector（仅测试/开发）
- 建 FTS 索引
- `searchMemoryHybrid` 支持：FTS + 向量查询 + 简单 RRF 融合

**Step 4: Run targeted test**

Run:
***REMOVED***bash
npm run build && node --test dist/store/hybrid_search.test.js
***REMOVED***

Expected: PASS。

**Step 5: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/store/lancedb_table.ts plugins/memory-mem0-lancedb/src/store/embedder.ts plugins/memory-mem0-lancedb/src/store/hybrid_search.test.ts
git commit -m "feat: add hybrid LanceDB search with vector and FTS"
***REMOVED***

### Task 6: 实现 outbox / 幂等 / 可见性确认

**Files:**
- Create: `plugins/memory-mem0-lancedb/src/store/outbox.ts`
- Create: `plugins/memory-mem0-lancedb/src/store/outbox.test.ts`
- Modify: `plugins/memory-mem0-lancedb/src/tools/store.ts`

**Step 1: Write the failing test**

测试要求：
- 同一 `memory_uid` 重放两次只保留一条有效写入
- store 完成后能通过 `memory_uid` 查到记录

**Step 2: Run test to verify it fails**

Run:
***REMOVED***bash
npm run build && node --test dist/store/outbox.test.js
***REMOVED***

Expected: FAIL。

**Step 3: Write minimal implementation**
- 本地 outbox 可先用 SQLite 或单文件日志
- 记录 `memory_uid`, `event_id`, `state`, `visible_at`
- 写后读确认：按 `memory_uid` 查询 LanceDB 真表

**Step 4: Run test**

Run:
***REMOVED***bash
npm run build && node --test dist/store/outbox.test.js
***REMOVED***

Expected: PASS。

**Step 5: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/store/outbox.ts plugins/memory-mem0-lancedb/src/store/outbox.test.ts plugins/memory-mem0-lancedb/src/tools/store.ts
git commit -m "feat: add memory outbox and visibility confirmation"
***REMOVED***

### Task 7: 把 Markdown 真相源迁入 LanceDB 真表

**Files:**
- Create: `plugins/memory-mem0-lancedb/scripts/migrate_markdown_to_lancedb.ts`
- Create: `plugins/memory-mem0-lancedb/src/store/migration.test.ts`
- Modify: `plugins/memory-mem0-lancedb/README.md`

**Step 1: Write the failing test**

测试要求：
- 输入 `MEMORY.md` 与一份 `memory/*.md`
- 迁移后 LanceDB 表中至少生成 2 条记录
- 记录里保留 `openclaw_refs.file_path`

**Step 2: Run test to verify it fails**

Run:
***REMOVED***bash
npm run build && node --test dist/store/migration.test.js
***REMOVED***

Expected: FAIL。

**Step 3: Implement minimal migration utility**
- 读取 `MEMORY.md`、`memory/*.md`
- 生成 `memory_uid`
- upsert 到 LanceDB 真表
- 可选读取旧 JSONL 并转存后删除/归档

**Step 4: Run migration tests**

Run:
***REMOVED***bash
npm run build && node --test dist/store/migration.test.js
***REMOVED***

Expected: PASS。

**Step 5: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/scripts/migrate_markdown_to_lancedb.ts plugins/memory-mem0-lancedb/src/store/migration.test.ts plugins/memory-mem0-lancedb/README.md
git commit -m "feat: add Markdown to LanceDB migration utility"
***REMOVED***

### Task 8: 接通插件工具层与最终验收

**Files:**
- Modify: `plugins/memory-mem0-lancedb/src/index.ts`
- Modify: `docs/plans/2026-03-06-memory-enhancement-finalize.md`

**Step 1: Write the failing integration test**

要求：
- `memory_search` / `memory_get` / `memoryStore` 走 LanceDB 真表
- `openclaw plugins info memory-mem0-lancedb` 仍为 `loaded`

**Step 2: Run verification to fail if still on legacy path**

Run:
***REMOVED***bash
npm run build && npm test
openclaw plugins info memory-mem0-lancedb
***REMOVED***

Expected: 若仍依赖 JSONL 主路径则视为未完成。

**Step 3: Implement minimal integration**
- 工具名保持不变
- 删除对 memory-core 的桥接依赖
- 默认走新机制

**Step 4: Final verification**

Run:
***REMOVED***bash
npm run build && npm test
openclaw plugins info memory-mem0-lancedb
node plugins/memory-mem0-lancedb/scripts/migrate_markdown_to_lancedb.ts
openclaw doctor
***REMOVED***

Expected:
- 构建与测试通过
- 插件 `loaded`
- 迁移脚本成功
- doctor 无新增致命告警

**Step 5: Commit**

***REMOVED***bash
git add plugins/memory-mem0-lancedb/src/index.ts docs/plans/2026-03-06-memory-enhancement-finalize.md
git commit -m "feat: complete final-state memory plugin integration"
***REMOVED***
