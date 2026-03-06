# AGENTS.md - memory-mem0-lancedb

## Build / Test / Lint Commands

***REMOVED***bash
# Build TypeScript to dist/
npm run build

# Watch mode for development
npm run dev

# Run all tests
npm test

# Run a single test file
node --test dist/path/to/file.test.js

# Install plugin locally
npm run install-plugin
***REMOVED***

## Project Structure

***REMOVED***
src/
  index.ts          # Plugin entry point - exports default register function
  types.ts          # Shared TypeScript interfaces
  db/               # LanceDB table operations
    schema.ts       # Table name and row interface
    table.ts        # openMemoryTable() helper
  tools/            # Tool implementations
    search.ts       # MemorySearchTool class
    store.ts        # MemoryStoreTool class
    get.ts          # MemoryGetTool class
    *.test.ts       # Test files alongside source
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

## Key Dependencies

- `@lancedb/lancedb`: Vector database for local memory storage
- `node:test`, `node:assert`: Built-in testing (no jest/vitest)
- Native `fetch()` for HTTP requests (Node 18+)
