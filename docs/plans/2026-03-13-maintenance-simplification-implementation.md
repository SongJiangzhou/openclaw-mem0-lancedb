# Maintenance Simplification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove background maintenance from the default runtime path, make LanceDB the only maintenance state source, and introduce a unified explicit maintenance entrypoint.

**Architecture:** Replace `FileAuditStore`-driven maintenance state with direct LanceDB-backed reads and writes. Stop starting poller, migration, consolidation, and lifecycle workers by default, and route maintenance through one explicit `memory_maintain` action dispatcher plus startup preflight checks.

**Tech Stack:** TypeScript, Node.js, LanceDB, Node test runner (`node:test`)

---

### Task 1: Add Maintenance Dispatcher Skeleton

**Files:**
- Create: `src/maintenance/runner.ts`
- Test: `tests/maintenance/runner.test.ts`

**Step 1: Write the failing test**

```ts
test('maintenance runner executes selected actions serially in the expected order', async () => {
  const calls: string[] = [];
  const result = await runMaintenance({
    action: 'all',
    tasks: {
      sync: async () => { calls.push('sync'); return { synced: 1 }; },
      migrate: async () => { calls.push('migrate'); return { migrated: 2 }; },
      consolidate: async () => { calls.push('consolidate'); return { superseded: 3 }; },
      lifecycle: async () => { calls.push('lifecycle'); return { quarantined: 4 }; },
    },
  });

  assert.deepEqual(calls, ['sync', 'migrate', 'consolidate', 'lifecycle']);
  assert.equal(result.steps.length, 4);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tests/maintenance/runner.test.js`
Expected: FAIL because the runner does not exist yet.

**Step 3: Write minimal implementation**

Create a dispatcher that:

- accepts one `action`
- expands `all` into the canonical sequence
- runs each task serially
- returns a structured summary

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/tests/maintenance/runner.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/maintenance/runner.ts tests/maintenance/runner.test.ts
git commit -m "feat(maintenance): add unified runner"
```

### Task 2: Add Startup Preflight Checks

**Files:**
- Create: `src/maintenance/preflight.ts`
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add a registration test that verifies plugin startup logs preflight signals and does not start maintenance timers by default.

**Step 2: Run test to verify it fails**

Run: `npm run build && node dist/tests/index.test.js`
Expected: FAIL if registration still starts migration, poller, consolidation, and lifecycle timers.

**Step 3: Write minimal implementation**

- Add preflight helpers for:
  - pending sync detection
  - legacy embedding table detection
  - consolidation candidates detection
  - lifecycle candidates detection
- Emit structured debug/info signals
- Remove default `start()` calls from registration

**Step 4: Run test to verify it passes**

Run: `npm run build && node dist/tests/index.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/maintenance/preflight.ts src/index.ts tests/index.test.ts
git commit -m "refactor(runtime): replace background startup with maintenance preflight"
```

### Task 3: Remove `FileAuditStore` From Lifecycle Maintenance

**Files:**
- Modify: `src/hot/lifecycle-worker.ts`
- Modify: `src/bridge/adapter.ts`
- Modify: `tests/hot/lifecycle-worker.test.ts`

**Step 1: Write the failing test**

Add a lifecycle worker test that seeds LanceDB state directly and verifies lifecycle transitions without using `FileAuditStore`.

**Step 2: Run test to verify it fails**

Run: `npm run build && node dist/tests/hot/lifecycle-worker.test.js`
Expected: FAIL because lifecycle worker still depends on audit records.

**Step 3: Write minimal implementation**

- Replace audit-store reads with adapter/LanceDB reads
- Replace audit append writes with direct metadata updates
- Keep current lifecycle transition semantics unchanged

**Step 4: Run test to verify it passes**

Run: `npm run build && node dist/tests/hot/lifecycle-worker.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hot/lifecycle-worker.ts src/bridge/adapter.ts tests/hot/lifecycle-worker.test.ts
git commit -m "refactor(lifecycle): use lancedb as state source"
```

### Task 4: Remove `FileAuditStore` From Consolidation And Reinforcement

**Files:**
- Modify: `src/hot/consolidation-worker.ts`
- Modify: `src/hot/reinforcement.ts`
- Modify: `tests/hot/consolidation-worker.test.ts`
- Modify: `tests/hot/reinforcement.test.ts`

**Step 1: Write the failing tests**

Add or update tests so consolidation and reinforcement read current records from LanceDB-backed state rather than JSONL.

**Step 2: Run tests to verify they fail**

Run: `npm run build && node dist/tests/hot/consolidation-worker.test.js && node dist/tests/hot/reinforcement.test.js`
Expected: FAIL while audit-store coupling remains.

**Step 3: Write minimal implementation**

- route reads through adapter/LanceDB-backed queries
- update records through adapter writes only
- remove audit append dependency from maintenance logic

**Step 4: Run tests to verify they pass**

Run: `npm run build && node dist/tests/hot/consolidation-worker.test.js && node dist/tests/hot/reinforcement.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hot/consolidation-worker.ts src/hot/reinforcement.ts tests/hot/consolidation-worker.test.ts tests/hot/reinforcement.test.ts
git commit -m "refactor(maintenance): remove audit-store consolidation state"
```

### Task 5: Make Migration Explicit Only

**Files:**
- Modify: `src/hot/migration-worker.ts`
- Modify: `src/index.ts`
- Test: `tests/hot/migration-worker.test.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add a registration test that verifies migration does not start automatically and can only be reached through explicit maintenance invocation.

**Step 2: Run test to verify it fails**

Run: `npm run build && node dist/tests/index.test.js`
Expected: FAIL while migration still starts in registration.

**Step 3: Write minimal implementation**

- keep migration worker single-run logic
- stop calling `start()` from registration
- expose migration through maintenance dispatcher only

**Step 4: Run tests to verify they pass**

Run: `npm run build && node dist/tests/index.test.js && node dist/tests/hot/migration-worker.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hot/migration-worker.ts src/index.ts tests/index.test.ts tests/hot/migration-worker.test.ts
git commit -m "refactor(migration): require explicit maintenance trigger"
```

### Task 6: Make Mem0 Sync Explicit Only

**Files:**
- Modify: `src/bridge/poller.ts`
- Modify: `src/index.ts`
- Modify: `tests/bridge/poller.test.ts`
- Modify: `tests/index.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- plugin registration does not start polling automatically
- sync can still run as a single explicit action

**Step 2: Run test to verify it fails**

Run: `npm run build && node dist/tests/bridge/poller.test.js && node dist/tests/index.test.js`
Expected: FAIL while poller still starts by default.

**Step 3: Write minimal implementation**

- keep single poll execution logic
- remove automatic timer startup from registration
- make sync callable only through maintenance runner

**Step 4: Run tests to verify they pass**

Run: `npm run build && node dist/tests/bridge/poller.test.js && node dist/tests/index.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bridge/poller.ts src/index.ts tests/bridge/poller.test.ts tests/index.test.ts
git commit -m "refactor(sync): make mem0 sync explicit"
```

### Task 7: Expose `memory_maintain`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add a tool registration test for `memory_maintain` covering `sync`, `migrate`, `consolidate`, `lifecycle`, and `all`.

**Step 2: Run test to verify it fails**

Run: `npm run build && node dist/tests/index.test.js`
Expected: FAIL before the new tool exists.

**Step 3: Write minimal implementation**

- register `memory_maintain`
- wire it to the unified maintenance runner
- return structured summaries in text/tool result form

**Step 4: Run test to verify it passes**

Run: `npm run build && node dist/tests/index.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/types.ts tests/index.test.ts
git commit -m "feat(maintenance): expose explicit maintenance tool"
```

### Task 8: Remove Or Downgrade `FileAuditStore`

**Files:**
- Modify: `src/audit/store.ts`
- Modify: `src/tools/get.ts`
- Modify: `src/tools/store.ts`
- Modify: `src/capture/sync.ts`
- Modify: related tests that still assume JSONL is the state source

**Step 1: Write the failing tests**

Update remaining tests so they no longer require audit JSONL as the authoritative storage path.

**Step 2: Run tests to verify they fail**

Run: `npm run build && npm test`
Expected: FAIL while remaining flows still depend on audit JSONL semantics.

**Step 3: Write minimal implementation**

- remove audit-store assumptions from stateful logic
- keep the module only if a narrow debug/export use case still remains
- otherwise delete it and update callers

**Step 4: Run tests to verify they pass**

Run: `npm run build && npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/audit/store.ts src/tools/get.ts src/tools/store.ts src/capture/sync.ts tests
git commit -m "refactor(storage): remove audit-store state coupling"
```

### Task 9: Final Verification

**Files:**
- Verify: `src/index.ts`
- Verify: `src/maintenance/runner.ts`
- Verify: `src/maintenance/preflight.ts`
- Verify: `src/bridge/poller.ts`
- Verify: `src/hot/migration-worker.ts`
- Verify: `src/hot/consolidation-worker.ts`
- Verify: `src/hot/lifecycle-worker.ts`
- Verify: `src/hot/reinforcement.ts`

**Step 1: Run focused verification**

Run:
`npm run build && node dist/tests/index.test.js && node dist/tests/bridge/poller.test.js && node dist/tests/hot/migration-worker.test.js && node dist/tests/hot/consolidation-worker.test.js && node dist/tests/hot/lifecycle-worker.test.js`

Expected: PASS

**Step 2: Run full suite**

Run: `npm test`
Expected: PASS

**Step 3: Review final diff**

Run: `git status --short && git diff --stat`
Expected: only planned files changed

**Step 4: Commit final cleanup**

```bash
git add .
git commit -m "refactor(runtime): simplify maintenance architecture"
```
