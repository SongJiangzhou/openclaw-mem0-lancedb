# Long-Term Direct Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change automatic memory capture to use deterministic noise filtering and direct long-term persistence instead of the session-first promotion path.

**Architecture:** Keep the existing session and promotion code in the repository, but remove it from the default auto-capture path. Runtime config and installer defaults move auto-capture back to `long-term`, the capture sync path rejects only high-confidence noise, and plugin startup stops launching the promotion worker by default.

**Tech Stack:** TypeScript, Node.js, LanceDB, append-only audit store, Node test runner

---

### Task 1: Restore Long-Term Auto-Capture Defaults

**Files:**
- Modify: `src/index.ts`
- Modify: `scripts/install.mjs`
- Test: `tests/index.test.ts`
- Test: `tests/scripts/install_mjs.test.ts`

**Step 1: Write the failing test**

Add tests asserting:
- `resolveConfig()` defaults `autoCapture.scope` to `long-term`
- installer-generated default config stores `autoCapture.scope = 'long-term'`

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node dist/tests/index.test.js
node dist/tests/scripts/install_mjs.test.js
```

Expected:
- failures showing `session` is still the default

**Step 3: Write minimal implementation**

Change:
- runtime config default in `src/index.ts`
- installer defaults in `scripts/install.mjs`

Do not remove `session` from the schema or tool parameter enums.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

### Task 2: Add Deterministic Noise Rejection Before Persistence

**Files:**
- Modify: `src/capture/sync.ts`
- Modify: `src/capture/auto.ts` if helper reuse is cleaner
- Test: `tests/capture/sync.test.ts`

**Step 1: Write the failing test**

Add tests asserting:
- obvious command/path/log noise is rejected before persistence
- a valid durable fact still persists successfully into long-term memory

Use examples like:
- rejected: stack trace or shell command output
- accepted: user preference or stable profile fact

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node dist/tests/capture/sync.test.js
```

Expected:
- noise rows still persist

**Step 3: Write minimal implementation**

Implement a deterministic filter that rejects only high-confidence noise categories:
- filesystem paths
- command fragments
- stack traces and raw error logs
- host/debug metadata
- obvious operational echoes

Do not add model-based classification or broad heuristic blocking.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 3: Route Auto-Capture Directly To Long-Term

**Files:**
- Modify: `src/index.ts`
- Modify: `src/capture/sync.ts`
- Test: `tests/index.test.ts`
- Test: `tests/capture/sync.test.ts`

**Step 1: Write the failing test**

Add tests asserting:
- automatic capture writes accepted memories with `scope = 'long-term'`
- next-turn recall works from long-term storage without depending on promotion

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node dist/tests/index.test.js
node dist/tests/capture/sync.test.js
```

Expected:
- captured rows still land in session scope

**Step 3: Write minimal implementation**

Update the auto-capture sync invocation so the default path passes `long-term`.

Do not change manual store behavior.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

### Task 4: Remove Promotion Worker From Default Startup Path

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Update startup tests to assert:
- plugin no longer emits `plugin.promotion_worker_started`

Keep unit tests for the promotion worker itself unchanged unless they depend on default startup.

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node dist/tests/index.test.js
```

Expected:
- startup still launches the promotion worker

**Step 3: Write minimal implementation**

Stop instantiating and starting `MemoryPromotionWorker` in normal plugin registration.

Do not delete the worker implementation in this task.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 5: End-to-End Verification

**Files:**
- Modify: none

**Step 1: Run focused verification**

Run:
```bash
npm run build
node dist/tests/capture/sync.test.js
node dist/tests/debug/logger.test.js
node dist/tests/scripts/install_mjs.test.js
node dist/tests/index.test.js
```

Expected:
- build passes
- all targeted tests pass

**Step 2: Run broader verification if needed**

Run:
```bash
npm test
```

Expected:
- pass, or explicitly capture unrelated pre-existing failures
