# Remove Debug LogDir Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove `debug.logDir` support so debug logging only emits structured lines to the host logger or console.

**Architecture:** Delete `logDir` from the debug config type, runtime config resolution, installer defaults, and file-writing logger code. Update tests to assert the reduced behavior surface and remove any assumptions about on-disk debug logs.

**Tech Stack:** TypeScript, Node.js, Node test runner, Clack installer script

---

### Task 1: Remove runtime config support

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Change debug-related config tests to assert `resolveConfig({ debug: { mode: 'debug' } })` does not expose `logDir`, and that register diagnostics no longer include `debugLogDir`.

**Step 2: Run test to verify it fails**

Run: `npm run build`
Then: `node dist/tests/index.test.js`

Expected: FAIL because runtime config still sets `logDir` and structured logs still include it.

**Step 3: Write minimal implementation**

Remove `logDir` from `DebugConfig`, delete default log-dir logic in `resolveConfig()`, and stop including `debugLogDir` in `plugin.register` diagnostics.

**Step 4: Run test to verify it passes**

Run the same commands and confirm the updated assertions pass.

### Task 2: Remove logger file output

**Files:**
- Modify: `src/debug/logger.ts`
- Test: `tests/debug/logger.test.ts`

**Step 1: Write the failing test**

Replace file-output tests with a test asserting that a `logDir` property, even if present at runtime, does not create files.

**Step 2: Run test to verify it fails**

Run: `npm run build`
Then: `node dist/tests/debug/logger.test.js`

Expected: FAIL because the logger still writes dated log files.

**Step 3: Write minimal implementation**

Delete the file append logic and path resolution helpers, leaving only sink/console emission.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

### Task 3: Remove installer support

**Files:**
- Modify: `scripts/install.mjs`
- Test: `tests/scripts/install_mjs.test.ts`

**Step 1: Write the failing test**

Update installer tests to assert default plugin config only stores `debug.mode` and ignores any legacy `debug.logDir` input.

**Step 2: Run test to verify it fails**

Run: `npm run build`
Then: `node dist/tests/scripts/install_mjs.test.js`

Expected: FAIL because installer defaults still emit `debug.logDir`.

**Step 3: Write minimal implementation**

Remove `DEFAULT_DEBUG_LOG_DIR`, stop carrying `debug.logDir` through installer defaults and prompt results, and keep `debug` as a mode-only config object.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

### Task 4: Verification

**Files:**
- Modify: none

**Step 1: Run focused verification**

Run:
- `npm run build`
- `node dist/tests/debug/logger.test.js`
- `node dist/tests/scripts/install_mjs.test.js`
- `node dist/tests/index.test.js`

Expected: Debug-related assertions PASS. If unrelated pre-existing tests fail, capture them explicitly.
