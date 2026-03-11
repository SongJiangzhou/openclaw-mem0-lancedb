# Hook-First Memory Sidecar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make lifecycle hooks the primary operating path for `openclaw-mem0-lancedb`, while demoting tools to admin/debug roles and preserving poller/worker-based async convergence.

**Architecture:** Keep the existing Mem0, LanceDB, audit, outbox, poller, and worker layers. Reframe the plugin around `before_prompt_build` and `agent_end` as the only normal dialogue-time entrypoints. Update registration, docs, and tests so the codebase consistently treats hooks as the primary interface and tools as optional operator utilities.

**Tech Stack:** TypeScript, Node.js, OpenClaw plugin hooks, LanceDB, Mem0 HTTP client, Node test runner

---

### Task 1: Lock In Hook-First Registration Semantics

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add assertions in `tests/index.test.ts` that verify:

- `before_prompt_build` and `agent_end` hooks are always registered when enabled
- tool registration metadata marks retained tools as admin/debug only
- no test describes tools as the primary interface anymore

Example additions:

```ts
test('register exposes lifecycle hooks as the primary memory interface', () => {
  const hooks: Array<{ name: string }> = [];
  const tools: Array<{ name: string; description: string }> = [];

  register({
    pluginConfig: {},
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerHook(_event: string, _handler: any, opts?: any) {
      hooks.push({ name: String(opts?.name || '') });
    },
  } as any);

  assert.ok(hooks.some((hook) => hook.name === 'mem0-auto-recall'));
  assert.ok(hooks.some((hook) => hook.name === 'mem0-auto-capture'));
  assert.match(tools.find((tool) => tool.name === 'memorySearch')?.description || '', /debug|admin/i);
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- FAIL because current tool descriptions and registration semantics still present tools as first-class features

**Step 3: Write minimal implementation**

Update `src/index.ts` so that:

- hook registration remains unconditional when `autoRecall.enabled` / `autoCapture.enabled`
- retained tools use descriptions that clearly state `admin`, `debug`, `manual`, or `operator`
- a short inline comment explains that hooks are the normal path and tools are fallback/operator utilities

Concrete edits:

- change the `memory_search` description to operator/debug language
- change `memorySearch` description to operator/debug language
- change `memoryStore` description to manual recovery/import language
- change `memory_get` description to diagnostic language if retained

**Step 4: Run test to verify it passes**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- PASS for the new registration semantics assertions

**Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "refactor: make hooks the primary memory interface"
```

### Task 2: Add Explicit Hook-First Runtime Metadata

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add a test that verifies startup debug logs explicitly announce hook-first mode.

Example:

```ts
test('plugin.register logs hook-first operating mode', () => {
  let output = '';
  register({
    pluginConfig: {},
    logger: { info(msg: string) { output += msg; } },
    registerTool() {},
    registerHook() {},
  } as any);

  assert.match(output, /hook-first|hook driven|primary interface/i);
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- FAIL because startup logs do not currently expose hook-first positioning

**Step 3: Write minimal implementation**

Update `src/index.ts` registration logging so it emits a concise line such as:

```ts
api.logger?.info?.('[openclaw-mem0-lancedb] hook-first memory sidecar enabled');
```

Also include hook/tool role hints in the existing `plugin.register` debug payload if useful:

```ts
debug.basic('plugin.register', {
  interfaceMode: 'hook-first-sidecar',
  adminTools: ['memory_search', 'memorySearch', 'memoryStore', 'memory_get'],
});
```

Keep the log message stable and short.

**Step 4: Run test to verify it passes**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- PASS and startup log mentions hook-first sidecar mode

**Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: log hook-first sidecar mode"
```

### Task 3: Prove Hook Paths Cover Normal Memory Behavior

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `tests/capture/auto.test.ts`
- Modify: `tests/recall/auto.test.ts`

**Step 1: Write the failing test**

Add or tighten tests that validate the normal user journey without tool calls:

- a turn with a user query causes `before_prompt_build` recall injection
- a completed turn triggers `agent_end` capture submission
- a later turn sees the memory via hook-driven recall

Example acceptance shape:

```ts
test('hook-first flow captures on one turn and recalls on the next without tool calls', async () => {
  // Arrange hooks, fake Mem0 response, and fake search state
  // Execute capture hook
  // Execute recall hook on the next turn
  // Assert injected recall content exists without invoking any tool
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node --test dist/tests/index.test.js dist/tests/capture/auto.test.js dist/tests/recall/auto.test.js
```

Expected:
- FAIL because the suite does not yet frame the full happy path as hook-only behavior

**Step 3: Write minimal implementation**

If needed, adjust existing hook helpers in `src/index.ts` only enough to make the tests explicit and stable:

- keep pending capture notification behavior deterministic
- avoid relying on any tool execution side effects in the test setup
- keep recall/capture hook return payloads stable

Do not introduce new product features here. The purpose is to lock in the intended control flow.

**Step 4: Run test to verify it passes**

Run:
```bash
npm run build
node --test dist/tests/index.test.js dist/tests/capture/auto.test.js dist/tests/recall/auto.test.js
```

Expected:
- PASS with an explicit end-to-end hook-driven happy path

**Step 5: Commit**

```bash
git add tests/index.test.ts tests/capture/auto.test.ts tests/recall/auto.test.ts src/index.ts
git commit -m "test: lock in hook-first memory flow"
```

### Task 4: Reduce Tool Surface To Admin And Diagnostic Use

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `tests/index.test.ts`

**Step 1: Write the failing test**

Add tests that verify retained tools are documented in code as operator-facing utilities instead of standard agent workflow.

Example:

```ts
test('retained tools are described as operator utilities', () => {
  const tools: Array<{ name: string; description: string }> = [];
  register({
    pluginConfig: {},
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerHook() {},
  } as any);

  for (const name of ['memory_search', 'memorySearch', 'memoryStore']) {
    assert.match(tools.find((tool) => tool.name === name)?.description || '', /operator|manual|debug|admin/i);
  }
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- FAIL until descriptions are fully demoted

**Step 3: Write minimal implementation**

Update `src/index.ts` descriptions so they read like:

- `memory_search`: "Operator/debug search for migrated memories..."
- `memorySearch`: "Manual hybrid retrieval for operator verification..."
- `memoryStore`: "Manual admin write path for repair/import..."
- `memory_get`: "Diagnostic reader for audit snippets..."

Update both READMEs to:

- move hooks ahead of tools
- describe hooks as the normal runtime mode
- describe tools as optional admin/debug helpers

**Step 4: Run test to verify it passes**

Run:
```bash
npm run build
node --test dist/tests/index.test.js
```

Expected:
- PASS and docs reflect the same positioning

**Step 5: Commit**

```bash
git add src/index.ts README.md README.zh-CN.md tests/index.test.ts
git commit -m "docs: demote memory tools to admin utilities"
```

### Task 5: Document Poller And Worker As Async Convergence Components

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/plans/2026-03-12-hook-first-memory-sidecar-design.md`

**Step 1: Write the failing test**

This task is documentation-only. Instead of a code test, define a checklist and verify it manually.

Checklist:

- README explains why poller exists
- README explains why workers still exist in a hook-first design
- README states that hooks own the request path and poller/worker own eventual consistency

**Step 2: Run verification to confirm the gap exists**

Run:
```bash
rg -n "poller|worker|hook-first|admin|debug" README.md README.zh-CN.md docs/plans/2026-03-12-hook-first-memory-sidecar-design.md
```

Expected:
- current README coverage is incomplete or inconsistent

**Step 3: Write minimal implementation**

Update the docs so they clearly separate:

- hook-time behavior
- async reconciliation behavior
- operator/debug tools

Use short sections and keep terminology stable across English and Chinese docs:

- `hook-first`
- `sidecar`
- `admin/debug tools`
- `async convergence`

**Step 4: Run verification to confirm it is complete**

Run:
```bash
rg -n "hook-first|sidecar|poller|worker|admin|debug" README.md README.zh-CN.md docs/plans/2026-03-12-hook-first-memory-sidecar-design.md
```

Expected:
- all documents contain the new operating model language

**Step 5: Commit**

```bash
git add README.md README.zh-CN.md docs/plans/2026-03-12-hook-first-memory-sidecar-design.md
git commit -m "docs: explain hook-first async convergence model"
```

### Task 6: Run Final Verification For The Repositioned Plugin

**Files:**
- Modify: `docs/plans/2026-03-12-hook-first-memory-sidecar-implementation.md`

**Step 1: Run focused tests**

Run:
```bash
npm run build
node --test dist/tests/index.test.js dist/tests/capture/auto.test.js dist/tests/recall/auto.test.js
```

Expected:
- PASS for all hook-first path tests

**Step 2: Run broader regression suite**

Run:
```bash
npm test
```

Expected:
- PASS or a documented list of unrelated pre-existing failures

**Step 3: Run doc consistency check**

Run:
```bash
rg -n "memory tool|memory tools|hook-first|admin/debug|sidecar" README.md README.zh-CN.md src/index.ts docs/plans/2026-03-12-hook-first-memory-sidecar-design.md
```

Expected:
- docs and runtime wording consistently reflect hook-first positioning

**Step 4: Record final verification notes**

Append a short completion note to this plan with:

- commit SHAs produced by Tasks 1-5
- commands run
- any residual follow-up risks

Example:

```md
## Verification Notes

- `npm run build`: PASS
- `node --test dist/tests/index.test.js dist/tests/capture/auto.test.js dist/tests/recall/auto.test.js`: PASS
- `npm test`: PASS
- Residual risk: `memory_get` is still present and may need later removal
```

**Step 5: Commit**

```bash
git add docs/plans/2026-03-12-hook-first-memory-sidecar-implementation.md
git commit -m "docs: record hook-first verification results"
```

## Verification Notes

- Implementation commit: `dd369a7` (`refactor: make memory plugin hook-first`)
- `npm run build`: PASS
- `node --test dist/tests/index.test.js dist/tests/capture/auto.test.js dist/tests/recall/auto.test.js`: PASS
- `npm test`: PASS
- `rg -n "memory tool|memory tools|hook-first|admin/debug|sidecar" README.md README.zh-CN.md src/index.ts docs/plans/2026-03-12-hook-first-memory-sidecar-design.md`: PASS
- Residual risk: startup in tests still emits background worker/autostart logs because plugin registration boots poller/worker infrastructure immediately; coverage is green, but a future cleanup could make test registration lighter.
