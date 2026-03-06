# OpenClaw Mem0 LanceDB Embedded Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在当前 `memory-mem0-lancedb` 插件内实现 file-first audit plane、Mem0 control plane、LanceDB hot plane 的嵌入式长期记忆架构。

**Architecture:** 保持单插件对外形态不变，在 `src/` 内拆分 `audit`、`control`、`hot`、`bridge` 四层。写入先落审计面，再经 outbox/sync engine 同步到 Mem0 和 LanceDB；检索默认由 LanceDB 承担，Mem0 作为补充与兜底。

**Tech Stack:** TypeScript, Node.js, node:test, LanceDB Node SDK, OpenClaw plugin API, local file persistence, Mem0 HTTP API

---

### Task 1: 将统一 schema 并入 `src/`

**Files:**
- Create: `src/schema/memory_record.schema.json`
- Modify: `src/types.ts`
- Modify: `src/db/schema.ts`
- Test: `src/db/table.test.ts`

**Step 1: Write the failing test**

Add assertions that the TypeScript row/type shape and DB row fields include the metadata needed by the unified memory schema, especially:

- `memory_uid`
- `user_id`
- `scope`
- `text`
- `ts_event`
- `status`
- `openclaw_refs`

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/db/table.test.js`
Expected: FAIL if the schema copy and type alignment are missing.

**Step 3: Write minimal implementation**

- Copy `memory_bridge/schema/memory_record.schema.json` into `src/schema/`
- Align `src/types.ts` and `src/db/schema.ts` with the canonical schema
- Keep JSON Schema as a runtime/documentation asset under `src/`

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/db/table.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/schema/memory_record.schema.json src/types.ts src/db/schema.ts src/db/table.test.ts
git commit -m "feat: add canonical memory schema under src"
***REMOVED***

### Task 2: 新增 file-first audit plane

**Files:**
- Create: `src/audit/store.ts`
- Create: `src/audit/store.test.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Create a test that writes a memory record into the audit plane and verifies:

- the audit file is created
- the stored record contains `memory_uid`
- the stored record can be read back by file path reference

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/audit/store.test.js`
Expected: FAIL because the audit plane does not exist yet.

**Step 3: Write minimal implementation**

Implement a file-backed audit store that:

- persists `MemoryRecord`
- keeps append-only audit history
- supports lookup by `openclaw_refs.file_path`

Use local files only. Do not introduce a database here.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/audit/store.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/audit/store.ts src/audit/store.test.ts src/index.ts src/types.ts
git commit -m "feat: add file first audit plane for memory records"
***REMOVED***

### Task 3: 扩展 sync engine 为三平面写入协调器

**Files:**
- Modify: `src/bridge/sync-engine.ts`
- Modify: `src/bridge/sync-engine.test.ts`
- Create: `src/control/mem0.ts`
- Create: `src/control/mem0.test.ts`
- Modify: `src/bridge/adapter.ts`

**Step 1: Write the failing test**

Add sync-engine tests that verify:

- audit write succeeds and returns `accepted`
- audit + LanceDB success but Mem0 unavailable returns `partial`
- audit + LanceDB + Mem0 success returns `synced`

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/bridge/sync-engine.test.js`
Expected: FAIL because current sync-engine only models `done/duplicate/failed_visibility`.

**Step 3: Write minimal implementation**

- Make audit plane the first durable write
- Add a Mem0 client abstraction in `src/control/mem0.ts`
- Extend sync-engine result mapping to:
  - `accepted`
  - `synced`
  - `partial`
  - `failed`
- Keep idempotency behavior

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/bridge/sync-engine.test.js && node --test dist/control/mem0.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/bridge/sync-engine.ts src/bridge/sync-engine.test.ts src/control/mem0.ts src/control/mem0.test.ts src/bridge/adapter.ts
git commit -m "feat: extend sync engine to coordinate audit mem0 and lancedb"
***REMOVED***

### Task 4: 将 `memoryStore` 切到 file-first 三平面写入

**Files:**
- Modify: `src/tools/store.ts`
- Modify: `src/tools/store_lancedb.test.ts`
- Modify: `src/tools/local_fallback.test.ts`

**Step 1: Write the failing test**

Update store tests so they assert:

- the audit plane receives the record
- LanceDB receives the record
- the tool returns one of the new write states consistent with the sync outcome

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tools/store_lancedb.test.js && node --test dist/tools/local_fallback.test.js`
Expected: FAIL until `memoryStore` uses the new write coordinator.

**Step 3: Write minimal implementation**

Refactor `src/tools/store.ts` to:

- build a canonical `MemoryRecord`
- write audit first
- invoke the new sync engine
- preserve current external tool input shape

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/tools/store_lancedb.test.js && node --test dist/tools/local_fallback.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/tools/store.ts src/tools/store_lancedb.test.ts src/tools/local_fallback.test.ts
git commit -m "feat: route memory store through file first embedded memory pipeline"
***REMOVED***

### Task 5: 抽离 hot plane 检索层

**Files:**
- Create: `src/hot/search.ts`
- Create: `src/hot/search.test.ts`
- Modify: `src/tools/search.ts`
- Modify: `src/tools/get.ts`

**Step 1: Write the failing test**

Create tests that verify:

- hot plane can run FTS + filters
- results are returned in canonical memory shape
- `memory_get` can resolve latest content via unified record storage

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/hot/search.test.js`
Expected: FAIL because the hot-plane abstraction does not exist yet.

**Step 3: Write minimal implementation**

- Move LanceDB retrieval logic into `src/hot/search.ts`
- Keep phase 1 scope to FTS + filters + Mem0 fallback
- Make `src/tools/search.ts` and `src/tools/get.ts` thin wrappers over shared hot/audit logic

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/hot/search.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/hot/search.ts src/hot/search.test.ts src/tools/search.ts src/tools/get.ts
git commit -m "refactor: extract hot plane retrieval for memory plugin"
***REMOVED***

### Task 6: 补齐文档与迁移清理

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `memory_bridge/README.md`
- Delete: `memory_bridge/schema/memory_record.schema.json`

**Step 1: Write the failing test**

No code test here. The repository-level expectation is that `src/` becomes the canonical location for the schema and runtime design.

**Step 2: Run verification before cleanup**

Run: `rg -n "memory_bridge/schema|audit plane|control plane|hot plane|file-first" README.md README.zh-CN.md memory_bridge/README.md src docs`
Expected: current documentation still reflects the old location or incomplete architecture.

**Step 3: Write minimal implementation**

- Update docs to point to `src/schema/`
- Rewrite `memory_bridge/README.md` to state that runtime and schema are now under `src/`
- Remove the old schema file from `memory_bridge/schema/`

**Step 4: Run full verification**

Run: `npm run build && npm test`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add README.md README.zh-CN.md memory_bridge/README.md src
git commit -m "docs: document embedded three plane memory architecture"
***REMOVED***
