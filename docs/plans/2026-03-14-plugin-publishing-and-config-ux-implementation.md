# Plugin Publishing And Config UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the published plugin surface with the current runtime so the plugin is easier to publish to ClawHub/OpenClaw and easier for users to configure correctly.

**Architecture:** Keep the runtime behavior intact while shrinking the public configuration surface. Treat `openclaw.plugin.json` as the user-facing contract, keep install scripts as optional bootstrap helpers, and align manifest defaults, installer defaults, and README guidance with the current local-first runtime.

**Tech Stack:** TypeScript, Node.js test runner, JSON manifest, OpenClaw plugin packaging, Markdown docs

---

### Task 1: Add a manifest consistency test

**Files:**
- Create: `tests/plugin/manifest_consistency.test.ts`
- Test: `tests/plugin/manifest_consistency.test.ts`

**Step 1: Write the failing test**

Write a test that loads:

- `openclaw.plugin.json`
- `buildDefaultPluginConfig()` from `scripts/install.mjs`
- `resolveConfig()` from `src/index.ts`

Verify:

- removed fields are absent from the manifest:
  - `auditStorePath`
  - `debug.logDir`
  - `embeddingMigration`
  - `memoryConsolidation`
- manifest defaults match current runtime expectations for:
  - `lancedbPath`
  - `outboxDbPath`
  - `debug.mode`
  - `autoRecall.enabled`
  - `autoRecall.topK`
  - `autoRecall.maxChars`
  - `autoRecall.scope`
  - `autoCapture.enabled`
  - `autoCapture.requireAssistantReply`
  - `autoCapture.maxCharsPerMessage`

**Step 2: Run test to verify it fails**

Run:

```bash
npm run build && node --test dist/tests/plugin/manifest_consistency.test.js
```

Expected: FAIL because the manifest still exposes stale fields and defaults.

**Step 3: Write minimal implementation**

No production change in this task. Only add the test.

**Step 4: Run test to verify the red state**

Run:

```bash
npm run build && node --test dist/tests/plugin/manifest_consistency.test.js
```

Expected: FAIL

**Step 5: Commit**

```bash
git add tests/plugin/manifest_consistency.test.ts
git commit -m "test: lock plugin manifest consistency"
```

### Task 2: Shrink the public plugin manifest

**Files:**
- Modify: `openclaw.plugin.json`
- Test: `tests/plugin/manifest_consistency.test.ts`

**Step 1: Update the manifest**

Edit `openclaw.plugin.json` so the public schema only exposes currently supported user-facing settings.

Remove:

- `auditStorePath`
- `debug.logDir`
- `embeddingMigration`
- `memoryConsolidation`

Adjust:

- `autoCapture.scope` should no longer present stale session-first defaults
- keep only user-facing config that still maps to the runtime

**Step 2: Run targeted test**

Run:

```bash
npm run build && node --test dist/tests/plugin/manifest_consistency.test.js
```

Expected: PASS

**Step 3: Run broader regression**

Run:

```bash
node dist/tests/index.test.js
```

Expected: PASS

**Step 4: Commit**

```bash
git add openclaw.plugin.json tests/plugin/manifest_consistency.test.ts
git commit -m "refactor(plugin): trim public manifest surface"
```

### Task 3: Align installer defaults with the published surface

**Files:**
- Modify: `scripts/install.mjs`
- Test: `tests/scripts/install_mjs.test.ts`
- Test: `tests/plugin/manifest_consistency.test.ts`

**Step 1: Write or update failing installer tests**

Add assertions that:

- default config omits removed fields
- generated defaults match manifest-facing behavior
- install bootstrap defaults still prefer:
  - `autoCapture.scope = long-term`
  - `debug.mode = off`
  - `autoRecall.scope = all`

**Step 2: Run targeted test to verify failure**

Run:

```bash
npm run build && node dist/tests/scripts/install_mjs.test.js
```

Expected: FAIL if installer output still includes or implies stale config.

**Step 3: Implement installer alignment**

Update `buildDefaultPluginConfig()` and prompt flow so the generated config only includes the intended published surface.

Keep the installer as a bootstrap helper, not as the primary distribution contract.

**Step 4: Re-run tests**

Run:

```bash
npm run build && node dist/tests/scripts/install_mjs.test.js && node --test dist/tests/plugin/manifest_consistency.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add scripts/install.mjs tests/scripts/install_mjs.test.ts tests/plugin/manifest_consistency.test.ts
git commit -m "refactor(installer): align bootstrap defaults with manifest"
```

### Task 4: Rewrite README installation guidance

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Update installation guidance**

Rewrite Quick Start so it is plugin-install first:

- explain plugin/ClawHub install as the main path
- move `install.sh` to an optional bootstrap section
- explain the three Mem0 modes:
  - `local`
  - `remote`
  - `disabled`

**Step 2: Update configuration examples**

Provide examples that match the trimmed manifest and current runtime behavior.

Remove stale references to removed config.

**Step 3: Verify docs sanity**

Run:

```bash
rg -n "auditStorePath|debug\\.logDir|EmbeddingMigrationWorker|MemoryConsolidationWorker" README.md README.zh-CN.md
```

Expected: no stale release-facing references that imply removed public config.

**Step 4: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: make plugin install the primary user path"
```

### Task 5: Add a short publishing note for release readiness

**Files:**
- Modify: `docs/current-architecture.md`
- Optional Modify: `README.md`

**Step 1: Add release-facing clarification**

Document that:

- the package is primarily an OpenClaw plugin
- ClawHub is a distribution channel
- install scripts are optional helpers

Keep this short and operational, not historical.

**Step 2: Verify no conflict with current architecture docs**

Run:

```bash
rg -n "install\\.sh|ClawHub|plugin install" docs/current-architecture.md README.md
```

Confirm the wording is consistent.

**Step 3: Commit**

```bash
git add docs/current-architecture.md README.md
git commit -m "docs: clarify plugin publishing model"
```

### Task 6: Final verification

**Files:**
- Verify existing changes only

**Step 1: Run full verification**

Run:

```bash
npm test
node dist/tests/index.test.js
```

Expected: PASS

**Step 2: Review diff**

Run:

```bash
git diff --stat main
```

Confirm the change set is limited to manifest, installer, docs, and tests for config consistency.

**Step 3: Final commit if needed**

If any last-minute fix was required during verification:

```bash
git add .
git commit -m "chore: finalize plugin publishing polish"
```
