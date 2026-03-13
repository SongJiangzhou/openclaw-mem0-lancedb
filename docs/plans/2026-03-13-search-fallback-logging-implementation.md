# Search Fallback Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix memory search so Mem0 fallback failures no longer discard local LanceDB results, and require structured exception logs at catch boundaries.

**Architecture:** Keep the existing local-first search pipeline, but split local search and remote fallback into separate failure boundaries. Log each caught exception structurally at the boundary where behavior changes, then preserve successful local results when fallback fails.

**Tech Stack:** TypeScript, Node test runner, LanceDB-backed local search, Mem0 HTTP fallback

---

### Task 1: Add the policy rule to AGENTS

**Files:**
- Modify: `AGENTS.md`

**Step 1: Add the rule**

Add a short section stating that any caught exception that is swallowed, downgraded, retried, or converted into fallback behavior must emit a structured log at that catch boundary.

**Step 2: Review wording**

Ensure the rule is specific to future implementation behavior and does not claim that the whole repo is already compliant.

**Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: require boundary exception logging"
```

### Task 2: Write the failing regression test

**Files:**
- Modify: `tests/tools/search.test.ts`

**Step 1: Add a regression test**

Write a test where:
- local LanceDB search returns fewer than `topK`
- Mem0 fallback throws
- the final result still returns the local memories

**Step 2: Add logging assertions**

Capture the warning/error output and assert that fallback failure emits a structured log signal.

**Step 3: Run the targeted test**

Run:

```bash
npm run build
node --test dist/tests/tools/search.test.js
```

Expected:
- the new test fails before implementation

### Task 3: Implement the minimal control-flow fix

**Files:**
- Modify: `src/tools/search.ts`

**Step 1: Split local and remote failure boundaries**

Refactor `MemorySearchTool.execute()` so:
- local search failure is handled separately
- Mem0 fallback failure after local success does not clear local results

**Step 2: Add structured logs**

Emit structured logs for:
- local LanceDB failure
- Mem0 fallback failure
- returning local results after fallback failure

Include fields such as:
- `query`
- `topK`
- `localCount`
- `mem0Mode`
- `message`

**Step 3: Keep behavior narrow**

Do not change merge logic, ranking logic, or fallback eligibility rules.

### Task 4: Verify the fix

**Files:**
- Modify: `src/tools/search.ts`
- Modify: `tests/tools/search.test.ts`

**Step 1: Run targeted tests**

```bash
npm run build
node --test dist/tests/tools/search.test.js
```

Expected:
- search tests pass

**Step 2: Run broader regression checks**

```bash
npm run build
node dist/tests/index.test.js
```

Expected:
- index tests pass

**Step 3: Commit**

```bash
git add AGENTS.md src/tools/search.ts tests/tools/search.test.ts
git commit -m "fix(search): preserve local results on fallback failure"
```
