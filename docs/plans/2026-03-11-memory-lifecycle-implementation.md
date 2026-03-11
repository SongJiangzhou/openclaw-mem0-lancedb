# Memory Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the plugin from recency-only memory freshness to a lifecycle-aware memory system with reinforcement, review, inhibition, quarantine, retention, and audit-friendly state transitions.

**Architecture:** Extend the LanceDB row schema with lifecycle fields, backfill old rows during schema migration and write paths, integrate lifecycle into recall ranking and filtering, then add asynchronous reinforcement, review, eviction, and consolidation workers. Keep the implementation deterministic and avoid word-level heuristic rules.

**Tech Stack:** TypeScript, Node.js, LanceDB, append-only audit store, Node test runner

---

## Current Status

The implementation is partially complete in code and tests. The schema, write paths, recall integration, and lifecycle maintenance workers are already present. The remaining work is to finish end-to-end verification and decide whether historical polluted rows need a one-shot cleanup script beyond the existing workers.

Completed areas:
- lifecycle schema fields added
- lifecycle defaults and backfill helpers added
- write paths now persist lifecycle data
- recall filtering and ranking use lifecycle fields
- migration worker upgrades old tables missing lifecycle fields
- reinforcement, review, eviction, and consolidation workers are wired into plugin startup
- unit tests cover lifecycle helpers, search filtering, review, eviction, and reinforcement

Open follow-up areas:
- run full verification after the latest lifecycle changes
- decide whether to add a dedicated one-shot cleanup command for legacy polluted rows
- optionally document operational guidance for lifecycle maintenance logs and troubleshooting

### Task 1: Finalize Lifecycle Schema And Defaults

**Files:**
- Create: `src/memory/lifecycle.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/types.ts`
- Modify: `src/db/table.ts`
- Test: `tests/memory/lifecycle.test.ts`
- Test: `tests/db/table.test.ts`

**Step 1: Confirm lifecycle schema fields exist**

Required row fields:
- `strength`
- `stability`
- `last_access_ts`
- `next_review_ts`
- `access_count`
- `inhibition_weight`
- `inhibition_until`
- `utility_score`
- `risk_score`
- `retention_deadline`
- `lifecycle_state`

Expected file state:
- `src/db/schema.ts` declares these on `MemoryRow`
- `src/types.ts` exposes them on `MemoryRecord` and sync payload types
- `src/memory/lifecycle.ts` exposes backfill and state transition helpers

**Step 2: Confirm new tables initialize lifecycle values**

Implementation details:
- `src/db/table.ts` must seed a row using `initializeLifecycleFields(...)`
- new indices should include:
  - `lifecycle_state`
  - `retention_deadline`

**Step 3: Confirm tests cover defaults and schema**

Expected tests:
- `tests/memory/lifecycle.test.ts`
  - initializes defaults
  - backfills missing fields
  - computes retention deadline
  - maps status to lifecycle state
- `tests/db/table.test.ts`
  - schema fields include lifecycle fields
  - lifecycle index exists

**Step 4: Verify**

Run:
```bash
npm run build
node --test dist/tests/memory/lifecycle.test.js dist/tests/db/table.test.js
```

Expected:
- all tests pass

### Task 2: Persist Lifecycle Data Through All Write Paths

**Files:**
- Modify: `src/bridge/adapter.ts`
- Modify: `src/capture/sync.ts`
- Modify: `src/bridge/sync-engine.ts`
- Modify: `src/bridge/poller.ts`
- Modify: `src/tools/store.ts`

**Step 1: Backfill lifecycle before writing to audit or LanceDB**

Implementation details:
- every path that creates or transforms `MemoryRecord` or `MemorySyncPayload` must call `backfillLifecycleFields(...)`
- adapter row conversion must write lifecycle fields into Lance rows

Expected touched flows:
- direct store tool
- auto capture sync
- outbox sync engine
- Mem0 poller
- LanceDB adapter upsert

**Step 2: Preserve lifecycle fields during duplicate or migration updates**

Implementation details:
- avoid dropping lifecycle fields when converting to payloads
- continue to serialize `openclaw_refs` and `mem0` as before

**Step 3: Verify**

Run:
```bash
npm run build
npm test
```

Expected:
- write path tests remain green

### Task 3: Integrate Lifecycle Into Recall Ranking

**Files:**
- Modify: `src/hot/search.ts`
- Modify: `src/recall/auto.ts`
- Test: `tests/hot/search.test.ts`

**Step 1: Add lifecycle hard filters**

Rules:
- exclude rows where `lifecycle_state` is:
  - `deleted`
  - `quarantined`
  - `superseded`
- exclude rows where `retention_deadline < now`

**Step 2: Add lifecycle scoring**

Required score signals:
- `strength`
- `stability`
- `last_access_ts`
- `inhibition_weight`
- `inhibition_until`
- `utility_score`
- `lifecycle_state`

Expected behavior:
- `reinforced` receives mild positive bias
- `inhibited` receives strong temporary penalty
- expired inhibition falls back to normal scoring
- old rows without lifecycle data remain compatible through backfill

**Step 3: Preserve existing hybrid retrieval behavior**

Do not remove:
- vector search
- FTS search
- RRF merging
- MMR diversification
- provider failure fallback logging

**Step 4: Verify**

Run:
```bash
npm run build
node --test dist/tests/hot/search.test.js
```

Expected:
- quarantined and expired rows are excluded
- active rows still rank
- existing search regression tests remain green

### Task 4: Upgrade Schema Migration For Lifecycle Fields

**Files:**
- Modify: `src/hot/migration-worker.ts`
- Test: `tests/hot/migration-worker.test.ts`

**Step 1: Treat missing lifecycle fields as outdated schema**

Implementation details:
- required schema set must now include:
  - `memory_type`
  - all lifecycle fields
- old active tables missing lifecycle fields must be renamed to legacy and migrated

**Step 2: Backfill lifecycle during migration row conversion**

Implementation details:
- migrated rows must pass through `backfillLifecycleFields(...)`
- preserve existing mem0 and OpenClaw reference fields

**Step 3: Verify**

Run:
```bash
npm run build
node --test dist/tests/hot/migration-worker.test.js
```

Expected:
- old schema detection still works
- migrated rows include lifecycle fields

### Task 5: Reinforce Recalled Memories

**Files:**
- Create: `src/hot/reinforcement.ts`
- Modify: `src/index.ts`
- Modify: `src/recall/auto.ts`
- Test: `tests/hot/reinforcement.test.ts`
- Test: `tests/index.test.ts`

**Step 1: Return recalled memories from auto recall**

Implementation details:
- `runAutoRecall(...)` should return:
  - recall block
  - source
  - final recalled memories

**Step 2: Add reinforcement worker helper**

Implementation details:
- read latest audit row per `memory_uid`
- apply `reinforceLifecycle(...)`
- append updated record to audit
- upsert updated record to LanceDB

**Step 3: Trigger reinforcement asynchronously after successful recall**

Implementation details:
- plugin `before_prompt_build` should fire-and-forget reinforcement
- failures should log but not break prompt building

**Step 4: Verify**

Run:
```bash
npm run build
node --test dist/tests/hot/reinforcement.test.js dist/tests/index.test.js
```

Expected:
- reinforcement appends updated audit rows
- plugin hook logs but does not crash on reinforcement failure

### Task 6: Add Review Worker

**Files:**
- Create: `src/hot/review-worker.ts`
- Modify: `src/index.ts`
- Test: `tests/hot/review-worker.test.ts`

**Step 1: Scan latest audit state per memory**

Implementation details:
- load latest row per `memory_uid`
- backfill lifecycle
- select rows where `shouldReviewLifecycle(...)` is true

**Step 2: Refresh review state**

Implementation details:
- apply `refreshReviewLifecycle(...)`
- append updated record to audit
- upsert updated record to LanceDB

**Step 3: Start worker with maintenance interval**

Implementation details:
- reuse existing maintenance toggle path alongside consolidation
- log worker start and completion counts

**Step 4: Verify**

Run:
```bash
npm run build
node --test dist/tests/hot/review-worker.test.js
```

Expected:
- due rows are reviewed
- low-value or quarantined rows are skipped

### Task 7: Add Eviction Worker

**Files:**
- Create: `src/hot/eviction-worker.ts`
- Modify: `src/index.ts`
- Test: `tests/hot/eviction-worker.test.ts`

**Step 1: Evaluate latest audit state per memory**

Rules:
- expired retention -> `delete`
- stale assistant-inferred low-value memory -> `quarantine`
- expired inhibition -> `restore`
- low-utility weak active memory -> `inhibit`

**Step 2: Persist resulting lifecycle transitions**

Implementation details:
- append to audit
- upsert back into LanceDB
- log counts for:
  - inhibited
  - quarantined
  - deleted
  - restored

**Step 3: Verify**

Run:
```bash
npm run build
node --test dist/tests/hot/eviction-worker.test.js
```

Expected:
- retention deletion works
- quarantine works for weak assistant-inferred memories
- inhibition restore works when timer expires

### Task 8: Extend Consolidation To Lifecycle Canonicalization

**Files:**
- Modify: `src/hot/consolidation-worker.ts`
- Test: existing consolidation tests plus lifecycle-aware expectations

**Step 1: Backfill lifecycle before consolidation decisions**

Implementation details:
- all candidate rows should pass through `backfillLifecycleFields(...)`

**Step 2: Mark losers as superseded in lifecycle**

Implementation details:
- canonical winner remains `active` or `reinforced`
- duplicate losers become:
  - `status = superseded`
  - `lifecycle_state = superseded`

**Step 3: Verify**

Run:
```bash
npm run build
npm test
```

Expected:
- duplicate consolidation still works
- superseded rows are removed from recall through lifecycle filtering

### Task 9: Full Verification And Operational Follow-up

**Files:**
- Modify: `docs/plans/2026-03-11-memory-lifecycle-design.md` only if actual implementation diverges
- Create: `docs/plans/2026-03-11-memory-lifecycle-implementation.md`

**Step 1: Run full verification**

Run:
```bash
npm run build
npm test
```

Expected:
- all tests pass

**Step 2: Smoke-check lifecycle integration**

Manual checks:
- old rows still searchable after backfill
- quarantined rows do not appear in recall
- reinforced rows gain recall preference
- expired retention rows transition to deleted

**Step 3: Record remaining gaps**

Known follow-up candidates:
- one-shot cleanup command for historical polluted rows
- lifecycle maintenance status logging or metrics
- operator docs for audit growth and retention tuning

**Step 4: Commit**

Suggested split:
```bash
git add src/db/schema.ts src/types.ts src/db/table.ts src/memory/lifecycle.ts tests/memory/lifecycle.test.ts tests/db/table.test.ts
git commit -m "feat(memory): add lifecycle schema and defaults"

git add src/hot/search.ts src/recall/auto.ts src/hot/reinforcement.ts src/hot/review-worker.ts src/hot/eviction-worker.ts src/hot/consolidation-worker.ts src/index.ts tests/hot/search.test.ts tests/hot/reinforcement.test.ts tests/hot/review-worker.test.ts tests/hot/eviction-worker.test.ts
git commit -m "feat(memory): add lifecycle maintenance workers"

git add src/bridge/adapter.ts src/bridge/poller.ts src/bridge/sync-engine.ts src/capture/sync.ts src/tools/store.ts src/hot/migration-worker.ts docs/plans/2026-03-11-memory-lifecycle-implementation.md
git commit -m "feat(memory): backfill lifecycle across write paths"
```

---

## Actual Code State At Time Of Writing

Already implemented in the working tree:
- lifecycle fields and helpers
- lifecycle-aware search filtering and scoring
- write-path lifecycle backfill
- migration upgrade for missing lifecycle fields
- reinforcement hook after recall
- review worker
- eviction worker
- lifecycle-aware consolidation

Not yet verified in this document:
- final full `npm test` run after the latest lifecycle worker changes
- operational smoke check against a live OpenClaw session

Plan complete and saved to `docs/plans/2026-03-11-memory-lifecycle-implementation.md`.
