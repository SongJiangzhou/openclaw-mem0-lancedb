# Logging Module Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified logging module on top of the existing debug logger and migrate the core operational modules away from direct `console.*` usage.

**Architecture:** Extend `PluginDebugLogger` with child loggers and structured exception helpers, then inject it into the highest-value runtime boundaries. Keep file logging and sink behavior unchanged while removing direct console logging from business modules.

**Tech Stack:** TypeScript, Node test runner, JSON structured logging, existing OpenClaw plugin logger sink

---

### Task 1: Extend the logger module

**Files:**
- Modify: `src/debug/logger.ts`
- Test: `tests/debug/logger.test.ts`

**Step 1: Write the failing logger tests**

Add tests for:
- `child(component, baseFields?)`
- `exception(event, error, fields?)`
- debug file logging still writing the same JSON line format

**Step 2: Run targeted logger tests**

```bash
npm run build
node dist/tests/debug/logger.test.js
```

Expected:
- new tests fail before implementation

**Step 3: Implement the minimal logger extension**

Add:
- child logger creation
- exception helper
- field merging for component/base fields

**Step 4: Re-run logger tests**

```bash
node dist/tests/debug/logger.test.js
```

Expected:
- logger tests pass

### Task 2: Add policy rules to AGENTS

**Files:**
- Modify: `AGENTS.md`

**Step 1: Add the logger policy**

Add concise rules covering:
- business modules should not use direct `console.*`
- prefer the unified logger
- avoid low-value logs

**Step 2: Keep wording scoped**

Make the rules forward-looking for new and modified code.

### Task 3: Migrate core modules to the unified logger

**Files:**
- Modify: `src/tools/search.ts`
- Modify: `src/tools/store.ts`
- Modify: `src/hot/embedder.ts`
- Modify: `src/hot/search.ts`
- Modify: `src/recall/reranker.ts`
- Modify: `src/bridge/poller.ts`
- Modify: `src/hot/migration-worker.ts`
- Modify: `src/index.ts` as needed for logger injection

**Step 1: Write failing integration tests where coverage is missing**

Add or extend tests so the migrated modules verify structured logging behavior at important exception boundaries.

**Step 2: Inject logger dependencies**

Update constructors or call sites to pass a root logger or child logger.

**Step 3: Replace direct `console.*` calls**

Move all direct console logging in the listed modules to:
- `info`
- `warn`
- `error`
- `exception`

**Step 4: Keep logging volume restrained**

Do not add step-by-step success chatter. Only log meaningful operational events.

### Task 4: Add a repository guard for direct console usage

**Files:**
- Create or modify an appropriate test under `tests/`

**Step 1: Add a guard test**

Check `src/` for direct `console.*` usage and fail if found outside the allowed logger module.

**Step 2: Run the guard**

```bash
npm run build
npm test
```

Expected:
- the guard fails until all targeted modules are migrated

### Task 5: Verify and commit

**Files:**
- Modify all files above as needed

**Step 1: Run focused tests**

```bash
npm run build
node dist/tests/debug/logger.test.js
node dist/tests/tools/local_fallback.test.js
node dist/tests/index.test.js
```

**Step 2: Run broader regression tests if needed**

```bash
npm test
```

**Step 3: Commit**

```bash
git add AGENTS.md src/debug/logger.ts src/index.ts src/tools/search.ts src/tools/store.ts src/hot/embedder.ts src/hot/search.ts src/recall/reranker.ts src/bridge/poller.ts src/hot/migration-worker.ts tests/debug/logger.test.ts tests/tools/local_fallback.test.ts docs/plans/2026-03-13-logging-module-design.md docs/plans/2026-03-13-logging-module-implementation.md
git commit -m "refactor(logging): unify runtime logging"
```
