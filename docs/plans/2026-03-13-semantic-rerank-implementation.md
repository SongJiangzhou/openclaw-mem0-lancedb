# Semantic Rerank Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve recall ranking for preference and time-sensitive memory queries by enriching rerank inputs and applying a lightweight final blend.

**Architecture:** Keep the current reranker interface and storage model unchanged. Build a semantic ranking view from existing memory metadata, use it during rerank, then apply a small post-rerank blend so current explicit memories outrank weaker or older candidates.

**Tech Stack:** TypeScript, Node test runner, existing recall pipeline, existing reranker integration

---

### Task 1: Write failing reranker tests

**Files:**
- Modify: `tests/recall/reranker.test.ts`
- Modify: `tests/recall/auto.test.ts`

**Step 1: Add a test for semantic rerank view construction**

Cover a preference/food memory where the outgoing rerank document is enriched with metadata-derived context.

**Step 2: Add a test for temporal preference ordering**

Cover a case where a more current explicit preference should outrank an older or weaker competing candidate.

**Step 3: Run targeted tests and verify red**

```bash
npm run build
node dist/tests/recall/reranker.test.js
node dist/tests/recall/auto.test.js
```

Expected:
- the new tests fail for the intended behavior gap

### Task 2: Implement semantic rerank view generation

**Files:**
- Modify: `src/recall/reranker.ts`

**Step 1: Build a lightweight ranking view**

Derive rerank documents from:
- text
- memory type
- domains
- source kind
- lightweight temporal hint

**Step 2: Keep original memory objects intact**

Only rerank on the derived documents. Return the original memory objects in the final result.

### Task 3: Implement a lightweight final blend

**Files:**
- Modify: `src/recall/reranker.ts`
- Modify: `src/recall/auto.ts` if needed

**Step 1: Add a shallow post-rerank blend**

Blend:
- rerank order
- source-kind preference
- temporal hint preference

Keep the blend intentionally small and conservative.

**Step 2: Avoid new abstractions**

Do not add new storage fields, background flows, or extra remote calls.

### Task 4: Verify

**Files:**
- Modify files above as needed

**Step 1: Run focused tests**

```bash
npm run build
node dist/tests/recall/reranker.test.js
node dist/tests/recall/auto.test.js
```

**Step 2: Run broader regression**

```bash
npm test
node dist/tests/index.test.js
```

Expected:
- all pass

### Task 5: Commit

**Step 1: Commit the implementation**

```bash
git add src/recall/reranker.ts src/recall/auto.ts tests/recall/reranker.test.ts tests/recall/auto.test.ts docs/plans/2026-03-13-semantic-rerank-design.md docs/plans/2026-03-13-semantic-rerank-implementation.md
git commit -m "feat(recall): add semantic rerank enrichment"
```
