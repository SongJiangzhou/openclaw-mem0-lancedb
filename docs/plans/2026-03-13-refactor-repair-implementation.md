# Refactor Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the unsafe auto-compaction behavior introduced in the refactor and restore lost `lancedb` provenance in shared record mapping.

**Architecture:** Keep the new shared mapper and audit store structure, but narrow the repair to two behavior fixes: make `FileAuditStore.append()` append-only again, and let `payloadToRecord()` accept optional record extensions so prior call-site semantics can be preserved without reintroducing duplicate helpers.

**Tech Stack:** TypeScript, Node.js test runner, JSONL audit store, LanceDB adapter metadata

---

### Task 1: Add mapper coverage for optional provenance

**Files:**
- Create: `tests/memory/mapper.test.ts`
- Modify: `src/memory/mapper.ts`
- Test: `tests/memory/mapper.test.ts`

**Step 1: Write the failing test**

Create `tests/memory/mapper.test.ts` with assertions that:

- `payloadToRecord(memoryUid, payload)` still returns the expected base `MemoryRecord`
- `payloadToRecord(memoryUid, payload, { lancedb: { ... } })` preserves the supplied `lancedb` metadata
- `recordToPayload(record)` still excludes `lancedb` and preserves existing payload fields

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-concurrency=1 dist/tests/memory/mapper.test.js`

Expected: FAIL because the mapper does not yet accept the optional extension argument.

**Step 3: Write minimal implementation**

Modify `src/memory/mapper.ts` so that:

- `payloadToRecord()` accepts an optional `overrides?: Partial<MemoryRecord>`
- the helper builds the base record first
- it returns a shallow merge of the base record with any explicit overrides

Keep the default field values unchanged from current behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- --test-concurrency=1 dist/tests/memory/mapper.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/mapper.ts tests/memory/mapper.test.ts
git commit -m "fix(memory): restore mapper provenance overrides"
```

### Task 2: Restore `lancedb` metadata at affected call sites

**Files:**
- Modify: `src/bridge/sync-engine.ts`
- Modify: `src/capture/sync.ts`
- Test: `tests/bridge/sync-engine.test.ts`
- Test: `tests/capture/sync.test.ts`

**Step 1: Write the failing tests**

Extend existing tests or add focused cases asserting that audit rows written by:

- `MemorySyncEngine.processEvent()`
- `syncCapturedMemories()`

still include the expected `lancedb` metadata fields in the stored `MemoryRecord`.

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- --test-concurrency=1 dist/tests/bridge/sync-engine.test.js
npm test -- --test-concurrency=1 dist/tests/capture/sync.test.js
```

Expected: FAIL because current mapper-based records omit the `lancedb` block.

**Step 3: Write minimal implementation**

Modify the two call sites so they call `payloadToRecord(memoryUid, payload, { lancedb: ... })` with the same values they emitted before the refactor.

Do not restore duplicated helper functions.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- --test-concurrency=1 dist/tests/bridge/sync-engine.test.js
npm test -- --test-concurrency=1 dist/tests/capture/sync.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/bridge/sync-engine.ts src/capture/sync.ts tests/bridge/sync-engine.test.ts tests/capture/sync.test.ts
git commit -m "fix(memory): restore audit lancedb provenance"
```

### Task 3: Remove implicit compaction from the append path

**Files:**
- Modify: `src/audit/store.ts`
- Test: `tests/audit/store.test.ts`

**Step 1: Write the failing test**

Add a test in `tests/audit/store.test.ts` that appends enough rows to cross the current threshold and verifies that all appended rows remain in the raw audit log rather than being silently compacted away.

Use `readAll()` to validate that the log remains append-only.

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-concurrency=1 dist/tests/audit/store.test.js`

Expected: FAIL because append currently triggers implicit compaction after the threshold is reached.

**Step 3: Write minimal implementation**

Modify `src/audit/store.ts` so that:

- `append()` no longer tracks `appendsSinceCompact`
- `append()` no longer calls `compact()`
- `compact()` remains available as an explicit method

Do not redesign compaction in this task.

**Step 4: Run test to verify it passes**

Run: `npm test -- --test-concurrency=1 dist/tests/audit/store.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/audit/store.ts tests/audit/store.test.ts
git commit -m "fix(audit): remove implicit log compaction"
```

### Task 4: Run full verification

**Files:**
- Modify: none
- Test: `tests/memory/mapper.test.ts`
- Test: `tests/bridge/sync-engine.test.ts`
- Test: `tests/capture/sync.test.ts`
- Test: `tests/audit/store.test.ts`

**Step 1: Run targeted tests**

Run:

```bash
npm test -- --test-concurrency=1 dist/tests/memory/mapper.test.js
npm test -- --test-concurrency=1 dist/tests/bridge/sync-engine.test.js
npm test -- --test-concurrency=1 dist/tests/capture/sync.test.js
npm test -- --test-concurrency=1 dist/tests/audit/store.test.js
```

Expected: PASS

**Step 2: Run full suite**

Run: `npm test`

Expected: PASS with no regressions in unrelated tests.

**Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- src/audit/store.ts src/memory/mapper.ts src/bridge/sync-engine.ts src/capture/sync.ts tests/audit/store.test.ts tests/bridge/sync-engine.test.ts tests/capture/sync.test.ts tests/memory/mapper.test.ts
```

Expected: only the intended repair scope is present.

**Step 4: Commit**

```bash
git add src/audit/store.ts src/memory/mapper.ts src/bridge/sync-engine.ts src/capture/sync.ts tests/audit/store.test.ts tests/bridge/sync-engine.test.ts tests/capture/sync.test.ts tests/memory/mapper.test.ts
git commit -m "fix: repair refactor regressions"
```
