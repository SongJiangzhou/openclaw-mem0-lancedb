# Current Architecture

## Overview

`openclaw-mem0-lancedb` is a local-first memory plugin for OpenClaw. The current architecture emphasizes:

- hook-first runtime integration
- local-first recall
- direct-to-long-term auto capture
- explicit maintenance instead of default background maintenance
- structured observability

The current implementation on `main` is simpler than some earlier designs and older research notes. In particular, it no longer relies on always-on maintenance workers or any JSONL audit layer.

## Runtime Flow

The plugin entrypoint is [src/index.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/index.ts).

Primary runtime paths:

- `before_prompt_build`
  - runs auto recall
  - searches local memory
  - injects retrieved memories into hidden system context
- `agent_end`
  - runs auto capture
  - extracts memory candidates from the latest turn
  - syncs confirmed memories into local storage

Operator/admin tools remain available:

- `memory_search`
- `memory_store`
- `memory_get`
- `memory_maintain`

The normal product path is hook-first, not tool-first.

## Storage Model

### LanceDB

LanceDB is the primary local state store for searchable memory records.

- local memory rows live in dimension-specific tables such as `memory_records_d1024`
- recall reads from LanceDB first
- lifecycle state, ranking signals, and stored memory content are all represented in LanceDB rows

### Mem0

Mem0 acts as a control/extraction layer, not the local source of truth.

Current roles:

- capture and extraction
- optional fallback search
- optional synchronization / maintenance action targets

If Mem0 is unavailable or partially failing, local LanceDB recall should still provide the best available result set.

## Recall Pipeline

The main local recall path starts in [src/tools/search.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/tools/search.ts) and [src/hot/search.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/hot/search.ts).

High-level flow:

1. Build scoped identity from user/session/agent context
2. Search local LanceDB first
3. Run hybrid retrieval on the current embedding dimension
4. Fuse FTS and vector candidates
5. Apply ranking adjustments and lifecycle-aware scoring
6. Optionally rerank
7. If local results are insufficient and Mem0 is available, try fallback search
8. If fallback fails, preserve the local result set

### Query Variants

Auto recall may generate multiple query variants before local search. The sizing and candidate expansion policy is centralized so recall quantities are derived consistently instead of spread across multiple ad hoc constants.

### Hybrid Retrieval

Local search combines:

- FTS
- vector retrieval
- RRF fusion
- lifecycle-aware reranking
- optional reranker use after candidate generation

### Fallback Behavior

Fallback exists to supplement local recall, not replace it.

Current rule:

- if local recall succeeds, its results remain authoritative
- a later fallback failure must not clear already-available local results

This behavior is enforced in [src/tools/search.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/tools/search.ts).

## Capture Pipeline

The capture path is centered around [src/capture/auto.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/capture/auto.ts) and [src/capture/sync.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/capture/sync.ts).

Current default behavior:

- automatic capture writes directly to `long-term`
- it does not depend on session-first promotion as the default runtime path
- session-related structures still exist in the codebase, but they are not the default capture model

Additional properties:

- capture strips injected recall/debug artifacts before extraction
- duplicate handling is performed before storage
- confirmed extracted memories are synced into local storage

## Maintenance Model

The project no longer treats multiple always-on workers as the preferred default runtime model.

Current behavior:

- startup performs lightweight maintenance preflight
- heavy maintenance is explicit
- maintenance runs through `memory_maintain`

Supported maintenance actions:

- `sync`
- `migrate`
- `consolidate`
- `lifecycle`
- `all`

This keeps runtime behavior simpler, reduces hidden background activity, and makes maintenance actions easier to reason about and debug.

## Lifecycle And Forgetting

The current lifecycle model is more conservative than earlier session/promotion-heavy designs.

Important properties:

- low-value memories fade first through ranking
- lifecycle can further suppress or quarantine some memory classes
- `assistant_inferred` and `system_generated` are more aggressively eligible for automatic fade-out
- `user_explicit` is treated more conservatively and is not automatically quarantined in the same way

This is intended to make forgetting gradual rather than abrupt:

- ranking decay first
- lifecycle transitions later

## Logging And Observability

The project now uses a unified structured logger centered in [src/debug/logger.ts](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/src/debug/logger.ts).

Key properties:

- structured JSON event logs
- child loggers by component
- structured exception logging
- `debug` mode still writes to:
  - `~/.openclaw/workspace/logs/openclaw-mem0-lancedb/YYYY-MM-DD.log`
- the same logger also emits to the host sink or `console`

Important policy:

- business modules should not use direct `console.*`
- caught exceptions that are swallowed, downgraded, retried, or converted into fallback behavior must be logged at the catch boundary
- logs should focus on exceptions, fallbacks, retries, major state changes, and important branch decisions

## Known Constraints

Current practical constraints include:

- embedding and reranker quality still depend on external services when enabled
- small local memory sets can trigger fallback behavior more often
- the system does not use language-specific special handling
- this is not a graph-memory architecture
- relationship modeling is still relatively lightweight compared with graph-native systems

## Evolution Summary

Recent architectural evolution moved the system toward a simpler and more operationally stable model:

- from session-first promotion to direct-to-long-term capture by default
- from multiple default background workers to explicit maintenance
- from scattered direct `console.*` calls to a unified structured logger
- from fallback behavior that could discard local results to fallback behavior that preserves successful local recall

## Related Documents

- Comparative external research: [docs/deep-research-report.md](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/docs/deep-research-report.md)
- Current design plans: [docs/plans](/home/lv5railgun/.openclaw/workspace/plugins/openclaw-mem0-lancedb/docs/plans)
