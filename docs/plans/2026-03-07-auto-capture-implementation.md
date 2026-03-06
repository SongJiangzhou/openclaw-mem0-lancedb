# Auto Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 `memory-mem0-lancedb` 插件增加“配置开启时生效”的 auto-capture，默认提交最新一轮 `user + assistant` 到 Mem0，并做幂等与事件确认。

**Architecture:** 保持现有 file-first 三平面架构不变，新增 `src/capture/auto.ts` 作为 capture 编排层。插件在兼容的回合结束 hook 上触发 auto-capture；抽取由 Mem0 负责，插件只做消息打包、幂等和确认。

**Tech Stack:** TypeScript, Node.js, node:test, Mem0 HTTP API, current sync/control primitives

---

### Task 1: 新增 auto-capture payload builder 与幂等键

**Files:**
- Create: `src/capture/auto.ts`
- Create: `src/capture/auto.test.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Create tests that verify:

- only the latest `user + assistant` pair is included
- `requireAssistantReply=true` suppresses capture when assistant output is missing
- identical turn content produces identical `idempotency_key`
- messages are truncated to `maxCharsPerMessage`

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/capture/auto.test.js`
Expected: FAIL because `src/capture/auto.ts` does not exist yet.

**Step 3: Write minimal implementation**

- Add `AutoCaptureConfig` to `src/types.ts`
- Implement capture payload creation
- Implement deterministic `idempotency_key`

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/capture/auto.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/capture/auto.ts src/capture/auto.test.ts src/types.ts
git commit -m "feat: add auto capture payload builder"
***REMOVED***

### Task 2: 扩展 Mem0 client 为 capture 提交接口

**Files:**
- Modify: `src/control/mem0.ts`
- Modify: `src/control/mem0.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- capture submission uses a `messages` payload
- unavailable mode still returns a safe fallback
- submitted capture events can be confirmed

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/control/mem0.test.js`
Expected: FAIL because the client currently focuses on record-style store submission.

**Step 3: Write minimal implementation**

- Add a capture submission method to the Mem0 client
- Reuse the current event confirmation flow
- Keep offline-safe behavior

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/control/mem0.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/control/mem0.ts src/control/mem0.test.ts
git commit -m "feat: add mem0 auto capture submission client"
***REMOVED***

### Task 3: 接入插件注册层

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`
- Modify: `openclaw.plugin.json`

**Step 1: Write the failing test**

Add tests that verify:

- `autoCapture.enabled=true` registers a compatible end-of-turn hook
- hook absence does not throw
- `autoRecall` and `autoCapture` can coexist in config

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/index.test.js`
Expected: FAIL because the plugin currently only supports auto-recall hook registration.

**Step 3: Write minimal implementation**

- Add `autoCapture` config defaults
- Register auto-capture when enabled and hook support exists
- Keep behavior silent when hooks are unavailable

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/index.test.js`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add src/index.ts src/index.test.ts openclaw.plugin.json
git commit -m "feat: add optional auto capture hook integration"
***REMOVED***

### Task 4: Full verification and docs update

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Write the failing test**

No new code test here. The full suite is the regression target.

**Step 2: Run test to verify it fails**

Run: `npm run build && npm test`
Expected: FAIL if auto-capture integration regresses current behavior.

**Step 3: Write minimal implementation**

- Update docs to describe `autoCapture`
- Fix any regression surfaced by the suite

**Step 4: Run full verification**

Run: `npm run build && npm test`
Expected: PASS.

**Step 5: Commit**

***REMOVED***bash
git add README.md README.zh-CN.md src openclaw.plugin.json
git commit -m "docs: describe configurable auto capture"
***REMOVED***
