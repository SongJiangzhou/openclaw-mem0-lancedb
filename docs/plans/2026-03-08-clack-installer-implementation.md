# Unified Node Installer with @clack/prompts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the duplicated shell-based interactive installers with a single Node installer using `@clack/prompts`, while preserving `install.sh` and `install_zh.sh` as thin language-specific wrapper entrypoints.

**Architecture:** Add `scripts/install.mjs` as the only installer implementation. Move all installation, prompting, and OpenClaw config merge logic into Node. Keep `install.sh` and `install_zh.sh` as wrappers that pass `--lang en` or `--lang zh`. Test the installer directly in Node and keep only minimal wrapper tests for forwarding behavior.

**Tech Stack:** Node.js, JavaScript ESM, `@clack/prompts`, shell wrappers, Node test runner

---

### Task 1: Add failing tests for the unified installer

**Files:**
- Create: `tests/scripts/install_mjs.test.ts`
- Modify: `tests/scripts/install.test.ts`

**Step 1: Add failing direct-installer tests**

Create `tests/scripts/install_mjs.test.ts` covering:

- wrapper-independent config merge into `openclaw.json`
- `--yes` installs defaults
- `--skip-config` leaves `openclaw.json` unchanged
- selecting debug verbose + file writes `debug.logDir`

The test should execute `node scripts/install.mjs` in a temporary HOME with a stubbed `openclaw.json`.

**Step 2: Simplify wrapper tests**

Update `tests/scripts/install.test.ts` so it no longer depends on full interactive shell logic. Instead, assert that:

- `install.sh` forwards to `node scripts/install.mjs --lang en`
- `install_zh.sh` forwards to `node scripts/install.mjs --lang zh`

This may be done by temporarily stubbing `node` in `PATH` and capturing argv.

**Step 3: Run tests to confirm failure**

Run: `npm run build && node --test dist/tests/scripts/install.test.js dist/tests/scripts/install_mjs.test.js`

Expected: FAIL because `scripts/install.mjs` does not exist and wrappers still contain full shell logic.

**Step 4: Commit**

***REMOVED***bash
git add tests/scripts/install.test.ts tests/scripts/install_mjs.test.ts
git commit -m "test: add failing coverage for unified node installer"
***REMOVED***

### Task 2: Add installer dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Install `@clack/prompts`**

Run:

***REMOVED***bash
npm install @clack/prompts
***REMOVED***

**Step 2: Verify dependency presence**

Run:

***REMOVED***bash
node -e "const p=require('./package.json'); console.log(Boolean(p.dependencies['@clack/prompts']))"
***REMOVED***

Expected: `true`

**Step 3: Commit**

***REMOVED***bash
git add package.json package-lock.json
git commit -m "build: add clack prompts for installer"
***REMOVED***

### Task 3: Implement the unified installer core

**Files:**
- Create: `scripts/install.mjs`

**Step 1: Add argument parsing**

Support:

- `--yes`, `-y`
- `--skip-config`
- `--help`, `-h`
- `--lang en|zh`

**Step 2: Add language dictionaries**

Define a `STRINGS` object for:

- headings
- step labels
- prompt labels
- option text
- summaries

**Step 3: Implement non-interactive install steps**

Use Node child-process APIs for:

- `npm install`
- `npm run build`
- symlink creation

Keep behavior equivalent to the current scripts.

**Step 4: Implement interactive config prompts with `@clack/prompts`**

Collect:

- Mem0 mode
- Mem0 URL/API key
- autoRecall config
- autoCapture config
- debug mode
- optional debug log directory

**Step 5: Implement JSON merge**

Read `~/.openclaw/openclaw.json`, merge plugin config into:

- `plugins.entries["openclaw-mem0-lancedb"].config`
- `plugins.allow`
- `plugins.load.paths`
- `plugins.slots.memory`

**Step 6: Run the installer tests**

Run: `npm run build && node --test dist/tests/scripts/install_mjs.test.js`

Expected: PASS for direct installer behavior.

**Step 7: Commit**

***REMOVED***bash
git add scripts/install.mjs
git commit -m "feat: add unified node installer with clack prompts"
***REMOVED***

### Task 4: Convert shell scripts into thin wrappers

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/install_zh.sh`

**Step 1: Replace installer logic**

Reduce each file to a thin wrapper that:

- resolves repo root
- executes the Node installer
- forwards all args

Example:

***REMOVED***bash
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
exec node "${ROOT_DIR}/scripts/install.mjs" --lang en "$@"
***REMOVED***

and Chinese variant:

***REMOVED***bash
exec node "${ROOT_DIR}/scripts/install.mjs" --lang zh "$@"
***REMOVED***

**Step 2: Run wrapper tests**

Run: `npm run build && node --test dist/tests/scripts/install.test.js`

Expected: PASS

**Step 3: Commit**

***REMOVED***bash
git add scripts/install.sh scripts/install_zh.sh tests/scripts/install.test.ts
git commit -m "refactor: turn shell installers into thin wrappers"
***REMOVED***

### Task 5: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Document the unchanged user entrypoints**

Clarify that users still run:

***REMOVED***bash
bash scripts/install.sh
***REMOVED***

or:

***REMOVED***bash
bash scripts/install_zh.sh
***REMOVED***

but interactive UX is now powered by the unified Node installer.

**Step 2: Document supported flags**

Include:

- `--yes`
- `--skip-config`

**Step 3: Commit**

***REMOVED***bash
git add README.md README.zh-CN.md
git commit -m "docs: describe unified installer entrypoints"
***REMOVED***

### Task 6: Verify the full suite

**Step 1: Run build**

Run:

***REMOVED***bash
npm run build
***REMOVED***

Expected: PASS

**Step 2: Run tests**

Run:

***REMOVED***bash
npm test
***REMOVED***

Expected: all installer tests plus existing plugin tests pass

**Step 3: Spot-check both wrappers manually**

Run:

***REMOVED***bash
bash scripts/install.sh --help
bash scripts/install_zh.sh --help
***REMOVED***

Expected: both delegate correctly and print language-appropriate help.

**Step 4: Commit final verification state**

***REMOVED***bash
git add .
git commit -m "test: verify unified clack installer end-to-end"
***REMOVED***
