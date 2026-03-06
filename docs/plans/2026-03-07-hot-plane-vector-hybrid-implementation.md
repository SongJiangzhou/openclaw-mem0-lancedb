# Hot Plane Vector Hybrid Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为当前 `memory-mem0-lancedb` 插件的 `hot plane` 增加 deterministic embedding、vector 检索、hybrid 检索和显式 RRF 融合。

**Architecture:** 保持现有 file-first 三平面架构不变，仅增强 `hot plane`。写入 LanceDB 时增加 `vector` 列，查询时同时执行 FTS 与 vector 两路检索，再在 `src/hot/search.ts` 中做显式 RRF 融合。

**Tech Stack:** TypeScript, Node.js, node:test, LanceDB Node SDK, deterministic local embedder

---

### Task 1: 新增 deterministic embedder

**Files:**
- Create: `src/hot/embedder.ts`
- Create: `src/hot/embedder.test.ts`

**Step 1: Write the failing test**

Create tests that verify:

- identical input returns identical vectors
- different inputs do not return the exact same vector
- vector dimension is fixed

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/hot/embedder.test.js`
Expected: FAIL because `embedder.ts` does not exist yet.

**Step 3: Write minimal implementation**

Implement:

- `EMBEDDING_DIM`
- `embedText(text: string): number[]`

Use a deterministic local strategy only. Do not call external services.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/hot/embedder.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/hot/embedder.ts src/hot/embedder.test.ts
git commit -m "feat: add deterministic local embedder for hot plane"
***REMOVED***

### Task 2: 扩展 LanceDB 表 schema 为 vector-aware

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/table.ts`
- Modify: `src/db/table.test.ts`

**Step 1: Write the failing test**

Extend `src/db/table.test.ts` to assert the table includes a `vector` field.

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/db/table.test.js`
Expected: FAIL because the table does not yet expose `vector`.

**Step 3: Write minimal implementation**

- Add `vector` to `MemoryRow`
- Include `vector` in the placeholder row used to create the LanceDB table

Keep the representation minimal and compatible with the current SDK usage.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/db/table.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/db/schema.ts src/db/table.ts src/db/table.test.ts
git commit -m "feat: add vector column to memory table schema"
***REMOVED***

### Task 3: 在 LanceDB adapter 写入路径中加入 embedding

**Files:**
- Modify: `src/bridge/adapter.ts`
- Modify: `src/bridge/sync-engine.test.ts`
- Test: `src/tools/store_lancedb.test.ts`

**Step 1: Write the failing test**

Add assertions that stored LanceDB rows now include a populated `vector` field with the expected fixed dimension.

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tools/store_lancedb.test.js`
Expected: FAIL because rows currently do not carry vectors.

**Step 3: Write minimal implementation**

- Import the embedder in the adapter
- Compute `vector` from `memory.text`
- Persist it in the LanceDB row

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/tools/store_lancedb.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/bridge/adapter.ts src/bridge/sync-engine.test.ts src/tools/store_lancedb.test.ts
git commit -m "feat: persist deterministic vectors in lancedb rows"
***REMOVED***

### Task 4: 实现 vector search 与显式 RRF 融合

**Files:**
- Modify: `src/hot/search.ts`
- Modify: `src/hot/search.test.ts`

**Step 1: Write the failing test**

Expand `src/hot/search.test.ts` so it verifies:

- one memory is retrieved by FTS
- another semantically similar memory is retrieved by vector search
- hybrid results contain both rows
- ordering is produced by explicit RRF merge logic

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/hot/search.test.js`
Expected: FAIL because the current hot-plane search only supports FTS/text fallback.

**Step 3: Write minimal implementation**

In `src/hot/search.ts`:

- split search into `searchFts()`, `searchVector()`, and `mergeRrf()`
- query both routes when possible
- merge on `memory_uid`
- fallback gracefully if one route fails

Keep RRF minimal:

- fixed constant `RRF_K`
- `1 / (RRF_K + rank)`

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/hot/search.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/hot/search.ts src/hot/search.test.ts
git commit -m "feat: add hybrid hot-plane retrieval with explicit rrf"
***REMOVED***

### Task 5: 回归验证与文档更新

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `src/tools/local_fallback.test.ts`

**Step 1: Write the failing test**

If needed, extend regression tests to assert the search path still works when hybrid/vector logic is enabled.

**Step 2: Run test to verify it fails**

Run: `npm run build && npm test`
Expected: FAIL if the new vector/hybrid path regresses existing search/store flows.

**Step 3: Write minimal implementation**

- Update docs to mention vector + hybrid + RRF
- Fix any regression surfaced by the full suite

**Step 4: Run full verification**

Run: `npm run build && npm test`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add README.md README.zh-CN.md src
git commit -m "docs: describe vector hybrid hot-plane retrieval"
***REMOVED***
