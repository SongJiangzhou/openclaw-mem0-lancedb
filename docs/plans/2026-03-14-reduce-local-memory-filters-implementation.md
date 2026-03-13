# Reduce Local Memory Filters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the two local rules that most directly override Mem0 capture and recall decisions.

**Architecture:** Keep Mem0 as the primary extractor and the existing rerank stack as the primary recall path. Retain only minimal local guardrails: empty-text rejection, query-echo rejection, and light temporal/source blending.

**Tech Stack:** TypeScript, Node test runner, LanceDB-backed memory adapter

---

### Task 1: Capture rejection regression test

**Files:**
- Modify: `tests/capture/sync.test.ts`

**Step 1: Write the failing test**

Change the assistant-only preference test to assert that the extracted memory is stored instead of rejected.

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tests/capture/sync.test.js`

Expected: FAIL because the current code still rejects the memory.

### Task 2: Reranker lexical penalty regression test

**Files:**
- Modify: `tests/recall/reranker.test.ts`

**Step 1: Write the failing test**

Add a test proving a relevant memory mentioning `workspace` should outrank a less relevant memory without that term.

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tests/recall/reranker.test.js`

Expected: FAIL because the current code still applies the operational-noise penalty.

### Task 3: Remove assistant-only capture rejection

**Files:**
- Modify: `src/capture/sync.ts`

**Step 1: Write minimal implementation**

Remove assistant-similarity-based capture rejection and keep only empty-text and query-echo rejection.

**Step 2: Run targeted test**

Run: `npm run build && node --test dist/tests/capture/sync.test.js`

Expected: PASS

### Task 4: Remove lexical operational-noise penalty

**Files:**
- Modify: `src/recall/reranker.ts`

**Step 1: Write minimal implementation**

Delete the `looksOperationalNoise()` penalty and keep the rest of the local recall scoring unchanged.

**Step 2: Run targeted test**

Run: `npm run build && node --test dist/tests/recall/reranker.test.js`

Expected: PASS

### Task 5: Full verification

**Files:**
- Verify only

**Step 1: Run full test suite**

Run: `npm test`

Expected: all tests pass

**Step 2: Run integration regression**

Run: `node dist/tests/index.test.js`

Expected: all tests pass
