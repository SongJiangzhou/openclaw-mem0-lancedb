# Session-First Memory Promotion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move automatic capture to session-first storage, add deterministic promotion into long-term memory, and age session memory more aggressively without introducing graph-memory complexity.

**Architecture:** Reuse the existing lifecycle system, shared `user_id`, and `session_id` support. Automatic capture writes `scope=session`, manual store remains `long-term`, recall merges current-session memory with long-term memory, and a new `PromotionWorker` copies reinforced session memories into long-term memory when deterministic thresholds are met.

**Tech Stack:** TypeScript, Node.js, LanceDB, append-only audit store, Node test runner

---

### Task 1: Make Auto-Capture Session-First By Default

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `openclaw.plugin.json`
- Modify: `scripts/install.mjs`
- Test: `tests/index.test.ts`
- Test: `tests/scripts/install_mjs.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:

- resolved config defaults `autoCapture.scope` to `session`
- installer no longer prompts for auto-capture scope
- installer persists `session` for auto-capture when auto-capture is enabled

**Step 2: Run the tests to verify they fail**

Run:
```bash
npm run build
node --test dist/tests/index.test.js dist/tests/scripts/install_mjs.test.js
```

Expected:
- failures showing `long-term` is still the default or installer still exposes scope selection

**Step 3: Implement minimal config changes**

Update:

- runtime defaults in `src/index.ts`
- config schema defaults in `openclaw.plugin.json`
- installer prompts/defaults in `scripts/install.mjs`
- exposed config types in `src/types.ts`

Rules:

- automatic capture defaults to `session`
- manual store behavior remains unchanged
- users are not asked to choose auto-capture scope in installer

**Step 4: Run the tests to verify they pass**

Run:
```bash
npm run build
node --test dist/tests/index.test.js dist/tests/scripts/install_mjs.test.js
```

Expected:
- all targeted tests pass

**Step 5: Commit**

```bash
git add src/index.ts src/types.ts openclaw.plugin.json scripts/install.mjs tests/index.test.ts tests/scripts/install_mjs.test.ts
git commit -m "feat(memory): default auto capture to session scope"
```

### Task 2: Ensure Automatic Write Paths Persist Session Metadata

**Files:**
- Modify: `src/capture/sync.ts`
- Modify: `src/bridge/sync-engine.ts`
- Modify: `src/bridge/poller.ts`
- Modify: `src/tools/store.ts`
- Modify: `src/bridge/adapter.ts`
- Test: `tests/bridge/adapter.test.ts`
- Test: `tests/capture/sync.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:

- session-scoped auto-capture writes include `session_id`
- duplicate detection uses `session_id` for `scope=session`
- manual long-term store keeps shared long-term behavior

**Step 2: Run the tests to verify they fail**

Run:
```bash
npm run build
node --test dist/tests/bridge/adapter.test.js dist/tests/capture/sync.test.js
```

Expected:
- session rows are missing `session_id`, or duplicate checks ignore it

**Step 3: Implement write-path updates**

Rules:

- automatic capture writes `scope=session`, `session_id=current session`, `agent_id=current agent`
- manual store remains `long-term` unless explicitly overridden
- session duplicate keys must include `session_id`

**Step 4: Run the tests to verify they pass**

Run:
```bash
npm run build
node --test dist/tests/bridge/adapter.test.js dist/tests/capture/sync.test.js
```

Expected:
- targeted tests pass

**Step 5: Commit**

```bash
git add src/capture/sync.ts src/bridge/sync-engine.ts src/bridge/poller.ts src/tools/store.ts src/bridge/adapter.ts tests/bridge/adapter.test.ts tests/capture/sync.test.ts
git commit -m "feat(memory): persist session metadata in auto capture"
```

### Task 3: Merge Long-Term And Current-Session Recall

**Files:**
- Modify: `src/hot/search.ts`
- Modify: `src/recall/auto.ts`
- Test: `tests/hot/search.test.ts`
- Test: `tests/recall/auto.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:

- recall includes current-session session memory
- recall excludes session memory from a different session
- long-term memory remains globally available

**Step 2: Run the tests to verify they fail**

Run:
```bash
npm run build
node --test dist/tests/hot/search.test.js dist/tests/recall/auto.test.js
```

Expected:
- current-session rows are missing or cross-session rows leak into results

**Step 3: Implement recall filtering**

Rules:

- `scope=long-term` searches shared rows
- `scope=session` searches only matching `session_id`
- merged result ranking continues to use existing lifecycle-aware scoring

**Step 4: Run the tests to verify they pass**

Run:
```bash
npm run build
node --test dist/tests/hot/search.test.js dist/tests/recall/auto.test.js
```

Expected:
- targeted tests pass

**Step 5: Commit**

```bash
git add src/hot/search.ts src/recall/auto.ts tests/hot/search.test.ts tests/recall/auto.test.ts
git commit -m "feat(recall): merge current session and long-term memory"
```

### Task 4: Add Promotion Worker

**Files:**
- Create: `src/hot/promotion-worker.ts`
- Modify: `src/index.ts`
- Modify: `src/memory/lifecycle.ts`
- Test: `tests/hot/promotion-worker.test.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:

- eligible session memories are copied into long-term memory
- low-value session memories are not promoted
- assistant-only or query-echo rows are not promoted
- worker is started with the plugin

**Step 2: Run the tests to verify they fail**

Run:
```bash
npm run build
node --test dist/tests/hot/promotion-worker.test.js dist/tests/index.test.js
```

Expected:
- missing worker or missing promotion logic

**Step 3: Implement deterministic promotion**

Rules:

- only inspect `scope=session`
- require all hard gates:
  - not sensitive
  - not query echo
  - not assistant-only inferred
  - not quarantined/deleted
- require positive thresholds:
  - `access_count >= 2`
  - `strength >= 0.72`
  - `utility_score >= 0.65`
- write promoted copy into `scope=long-term`
- avoid duplicates by reusing existing dedup logic

**Step 4: Run the tests to verify they pass**

Run:
```bash
npm run build
node --test dist/tests/hot/promotion-worker.test.js dist/tests/index.test.js
```

Expected:
- targeted tests pass

**Step 5: Commit**

```bash
git add src/hot/promotion-worker.ts src/index.ts src/memory/lifecycle.ts tests/hot/promotion-worker.test.ts tests/index.test.ts
git commit -m "feat(memory): promote stable session memories to long term"
```

### Task 5: Age Session Memory Aggressively

**Files:**
- Modify: `src/hot/lifecycle-worker.ts`
- Modify: `src/memory/lifecycle.ts`
- Test: `tests/hot/lifecycle-worker.test.ts`
- Test: `tests/memory/lifecycle.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:

- session memories decay with a shorter half-life
- session memories are quarantined after 24 hours idle
- session memories are deleted after 7 days
- long-term rows keep existing lifecycle behavior

**Step 2: Run the tests to verify they fail**

Run:
```bash
npm run build
node --test dist/tests/hot/lifecycle-worker.test.js dist/tests/memory/lifecycle.test.js
```

Expected:
- session and long-term memories still follow the same aging path

**Step 3: Implement session-specific aging**

Rules:

- session half-life = 12 hours
- quarantine after 24 hours idle
- delete after 7 days
- long-term retention behavior remains unchanged

**Step 4: Run the tests to verify they pass**

Run:
```bash
npm run build
node --test dist/tests/hot/lifecycle-worker.test.js dist/tests/memory/lifecycle.test.js
```

Expected:
- targeted tests pass

**Step 5: Commit**

```bash
git add src/hot/lifecycle-worker.ts src/memory/lifecycle.ts tests/hot/lifecycle-worker.test.ts tests/memory/lifecycle.test.ts
git commit -m "feat(memory): age session memories aggressively"
```

### Task 6: Verify End-To-End Behavior

**Files:**
- Modify: `docs/plans/2026-03-12-session-first-memory-promotion-design.md`
- Modify: `docs/plans/2026-03-12-session-first-memory-promotion-implementation.md`

**Step 1: Run the full verification suite**

Run:
```bash
npm run build
npm test
```

Expected:
- all tests pass

**Step 2: Manual smoke checks**

Use the local plugin in debug mode and verify:

- auto-captured transient task content lands in current session only
- current-session recall sees fresh session content
- another session does not see that session content
- repeated useful content can later appear in long-term recall after promotion

**Step 3: Update docs if behavior changed during implementation**

Document:

- session-first auto-capture
- promotion thresholds
- session aging windows

**Step 4: Commit**

```bash
git add docs/plans/2026-03-12-session-first-memory-promotion-design.md docs/plans/2026-03-12-session-first-memory-promotion-implementation.md
git commit -m "docs(memory): document session-first promotion flow"
```

Plan complete and saved to `docs/plans/2026-03-12-session-first-memory-promotion-implementation.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints

Which approach?
