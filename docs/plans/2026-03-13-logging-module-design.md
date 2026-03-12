# Logging Module Design

## Goal

Design a unified logging module for the plugin so business modules stop using direct `console.*` calls, exceptions are logged structurally at the catch boundary, and debug mode continues to write logs to the existing file sink.

## Design Direction

This change extends the existing `PluginDebugLogger` in `src/debug/logger.ts` instead of introducing a new logging framework. The logger remains responsible for:

- writing structured JSON lines to the host sink or `console`
- appending the same lines to `~/.openclaw/workspace/logs/openclaw-mem0-lancedb/YYYY-MM-DD.log` when `debug.mode === "debug"`
- sanitizing fields before output

Business modules stop calling `console.warn`, `console.error`, or `console.log` directly. They use the unified logger instead.

## Module Shape

The logger module will expose:

- `info(event, fields?)`
- `warn(event, fields?)`
- `error(event, fields?)`
- `exception(event, error, fields?)`
- `child(component, baseFields?)`

`child()` creates component-scoped loggers so callers do not have to repeat module identity on every call. `exception()` provides a single structured path for swallowed, downgraded, retried, or fallback-triggering exceptions.

## First-Phase Integration Scope

Phase 1 integrates the unified logger into these core paths:

- `src/tools/search.ts`
- `src/tools/store.ts`
- `src/hot/embedder.ts`
- `src/hot/search.ts`
- `src/recall/reranker.ts`
- `src/bridge/poller.ts`
- `src/hot/migration-worker.ts`

These modules cover the current mix of direct `console.*` usage in the most operationally important boundaries.

## Injection Strategy

Do not introduce a global singleton.

- entrypoints create a root logger
- classes receive a logger or child logger through constructors
- helper or functional modules accept an explicit logger parameter or use a small wrapper at the call site

This keeps testability and avoids hidden runtime dependencies.

## Logging Policy

The logger is for:

- exceptions
- retries
- fallbacks
- important state transitions
- meaningful branch decisions

The logger is not for:

- high-frequency success noise
- per-step chatter that does not help diagnose behavior
- verbose traces with no operational value

This policy keeps context windows smaller and prevents low-value log growth.

## Exception Policy

Any caught exception that is:

- swallowed
- downgraded
- retried
- converted into fallback behavior
- converted into empty or partial success

must be logged through `exception()` at that catch boundary.

## AGENTS Rules To Add

- business modules should not use direct `console.*`
- prefer the unified logger for all new and modified logging
- avoid large amounts of low-value logs; log exceptions, fallbacks, retries, major state changes, and important branch decisions only

## Testing

Phase 1 should add or update tests for:

- `child()` field inheritance
- `exception()` serialization of `message`, `cause`, and contextual fields
- debug-mode file logging still working
- structured exception logging in the newly migrated core paths
- a repository guard that rejects direct `console.*` in `src/`, excluding the logger module itself if necessary
