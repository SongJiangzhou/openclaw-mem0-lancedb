# AGENTS.md - openclaw-mem0-lancedb

## Build / Test / Lint Commands

***REMOVED***bash
# Build TypeScript to dist/
npm run build

# Watch mode for development
npm run dev

# Run all tests
npm test

# Run a single test file
node --test dist/tests/control/mem0.test.js

# Install plugin locally
npm run install-plugin
***REMOVED***

## Project Structure

***REMOVED***
src/
  index.ts          # Plugin entry point - exports default register function
  types.ts          # Shared TypeScript interfaces
  control/          # Mem0 client and auth
    auth.ts         # Shared auth helpers (isLocalMem0BaseUrl, hasMem0Auth, buildMem0Headers)
    mem0.ts         # HttpMem0Client / FakeMem0Client
  db/               # LanceDB table operations
    schema.ts       # Table name and row interface
    table.ts        # openMemoryTable() helper
  tools/            # Tool implementations
    search.ts       # MemorySearchTool class
    store.ts        # MemoryStoreTool class
    get.ts          # MemoryGetTool class
tests/              # All test files (mirrors src/ structure)
  control/          # auth.test.ts, mem0.test.ts
  bridge/           # outbox.test.ts, poller.test.ts, sync-engine.test.ts, uid.test.ts
  tools/            # local_fallback.test.ts, store_lancedb.test.ts, lancedb_smoke.test.ts
  ...               # Other subdirectories mirror src/
***REMOVED***

## Code Style Guidelines

### TypeScript Configuration
- Target: ES2022, CommonJS output
- Strict mode enabled
- Source in `src/`, output to `dist/`
- Generate declaration files (.d.ts)

### Imports
***REMOVED***typescript
// Node built-ins: use 'node:' prefix
import * as crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';

// External packages
import * as lancedb from '@lancedb/lancedb';

// Local modules: relative paths
import { PluginConfig } from '../types';
import { openMemoryTable } from '../db/table';
***REMOVED***

### Naming Conventions
- **Classes**: PascalCase (e.g., `MemorySearchTool`)
- **Interfaces/Types**: PascalCase (e.g., `PluginConfig`, `SearchResult`)
- **Variables/Functions**: camelCase (e.g., `openMemoryTable`, `memoryUid`)
- **Database fields**: snake_case (e.g., `memory_uid`, `user_id`, `ts_event`)
- **Constants**: UPPER_SNAKE_CASE for true constants (e.g., `MEMORY_TABLE`)

### Type Definitions
- Use explicit return types on public methods
- Use `interface` for object shapes that may be extended
- Use `type` for unions/complex types
- Database row fields are strings (JSON serialized for arrays/objects)

### Error Handling
***REMOVED***typescript
try {
  const result = await operation();
  return result;
} catch (err) {
  console.error('[toolName] Operation failed:', err);
  return { success: false, error: err.message };
}
***REMOVED***

### Testing (Node Test Runner)
***REMOVED***typescript
import test from 'node:test';
import assert from 'node:assert/strict';

test('descriptive test name', async () => {
  const result = await operation();
  assert.equal(result.value, expected);
});
***REMOVED***

### Tool Class Pattern
***REMOVED***typescript
export class ToolName {
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async execute(params: ParamsType): Promise<ResultType> {
    // Implementation
  }

  private helperMethod(): void {
    // Private implementation
  }
}
***REMOVED***

## Plugin Architecture

- Entry point must be a function or object with `register()` method
- Tools registered via `api.registerTool({ name, description, parameters, execute })`
- Configuration resolved in register function with defaults
- Logger available at `api.logger?.info?.('message')`

## Memory Filtering Rule

- Never use word-level rules or token-level keyword matching as a memory admission, rejection, promotion, or recall-quality decision mechanism.
- Do not implement heuristics that decide memory value based only on the presence of specific words, command names, file path fragments, or similar lexical cues.
- If filtering is required, it must rely on stronger structural signals or broader semantic reasoning, not word-trigger rules.

## Exception Logging Rule

- Any exception that is caught and then swallowed, downgraded, retried, converted into fallback behavior, or transformed into a non-throwing return value must emit a structured log at that catch boundary.
- Boundary-level exception logs must be added before the code continues with fallback, retry, partial success, or empty-result behavior.
- This rule applies to new and modified code. It does not imply the whole repository is already fully aligned.

## Logging Rule

- Business modules should not use direct `console.*` calls. Prefer the unified logger module.
- New and modified runtime code should use structured logger events instead of hand-built console strings.
- Avoid large amounts of low-value logs. Log exceptions, fallbacks, retries, major state changes, and important branch decisions only.

## Key Dependencies

- `@lancedb/lancedb`: Vector database for local memory storage
- `node:test`, `node:assert`: Built-in testing (no jest/vitest)
- Native `fetch()` for HTTP requests (Node 18+)

## Privacy And Test Data

- Never commit personal sensitive information, real API keys, usernames, home paths, or user-specific preferences into source, tests, docs, or fixtures.
- When replacing sensitive examples, use generic English placeholder content by default.
- New and updated tests must use English sample text unless a multilingual behavior is the thing under test.
- If debugging requires live user data, keep it out of the repo and summarize it in sanitized form before writing code or docs.
