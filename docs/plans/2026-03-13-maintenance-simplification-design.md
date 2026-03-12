# Maintenance Simplification Design

## Summary

This design simplifies the plugin's maintenance architecture in four coordinated ways:

1. Remove `FileAuditStore` as the state source of truth.
2. Stop running `EmbeddingMigrationWorker` as a background task.
3. Tighten `Mem0Poller` so sync runs only when explicitly requested.
4. Reduce background workers by moving maintenance into an explicit unified entrypoint.

The result is a LanceDB-centered architecture with fewer always-on timers, lower concurrency risk, and clearer operational behavior.

## Goals

- Make LanceDB the only state source of truth.
- Eliminate background maintenance timers from the default runtime path.
- Preserve existing maintenance capabilities without preserving their current always-on execution model.
- Provide one explicit maintenance entrypoint for operators and admin flows.
- Keep startup behavior lightweight and observable.

## Non-Goals

- Do not redesign recall ranking or memory lifecycle semantics in this phase.
- Do not remove lifecycle or consolidation behavior entirely.
- Do not introduce a new external daemon or service.
- Do not keep multiple background workers under a renamed umbrella timer.

## Current Problems

### 1. Shadow state in `FileAuditStore`

Several maintenance flows currently read and write `FileAuditStore` JSONL records, then propagate those results into LanceDB. This creates a second operational data layer and raises consistency risks.

### 2. Expensive background migration

`EmbeddingMigrationWorker` currently starts during plugin registration and runs in the background. Migration is an expensive and high-risk maintenance action, and should not execute silently on a timer.

### 3. Fixed-interval remote polling

`Mem0Poller` currently starts by default and polls at a fixed interval, even when there is no meaningful sync work to do.

### 4. Too many independent maintenance loops

The runtime currently starts multiple background loops for polling, migration, consolidation, and lifecycle maintenance. Even when each loop is small, the overall system becomes harder to reason about, debug, and test.

## Proposed Architecture

### LanceDB as the only source of truth

All durable state decisions should come from LanceDB tables and adapter queries.

That means:

- lifecycle reads come from LanceDB
- consolidation reads come from LanceDB
- reinforcement reads and writes come from LanceDB
- sync writes land directly in LanceDB

`FileAuditStore` should no longer be required for state derivation or worker coordination.

### Explicit maintenance entrypoint

Introduce one unified maintenance entrypoint:

- `memory_maintain`

Supported actions:

- `sync`
- `migrate`
- `consolidate`
- `lifecycle`
- `all`

This entrypoint runs tasks serially in-process and returns a structured summary.

### Startup behavior becomes preflight-only

Plugin startup should only do lightweight checks and emit signals such as:

- legacy embedding tables detected
- pending remote sync work detected
- consolidation candidates detected
- lifecycle maintenance candidates detected

Startup should not automatically execute expensive maintenance actions.

## Approach Options

### Option A: Explicit maintenance runner with no background timers

Keep each maintenance domain as a callable unit, but remove default `start()` usage and centralize invocation behind `memory_maintain`.

Pros:

- largest reduction in runtime complexity
- no concurrent maintenance timers by default
- easiest to reason about operationally

Cons:

- maintenance no longer happens automatically unless explicitly invoked

### Option B: Single background `MaintenanceWorker`

Replace multiple background workers with one scheduler that still runs on a timer.

Pros:

- fewer concurrent timers

Cons:

- still background maintenance
- still hidden runtime work
- does not solve the core operational simplicity problem

### Option C: Minimal runtime with no maintenance path

Remove maintenance execution entirely and rely only on write-time and recall-time logic.

Pros:

- simplest runtime

Cons:

- drops useful lifecycle and consolidation behavior
- too destructive relative to current product direction

## Recommended Approach

Use Option A.

This preserves current maintenance capabilities while removing the operational complexity of always-on background execution. It also aligns with the goal of making expensive or risky actions explicit.

## Component Design

### 1. `FileAuditStore`

Target state:

- no longer required for maintenance state reads
- no longer used as a prerequisite for lifecycle, consolidation, reinforcement, or sync

Possible end states:

- fully deleted
- retained only as optional debug or export output

The implementation should aim for full removal unless a specific non-state use case remains justified.

### 2. `EmbeddingMigrationWorker`

Target state:

- not started during plugin registration
- callable only through `memory_maintain action=migrate`
- startup only reports whether migration work is pending

Migration becomes an explicit maintenance operation, not ambient behavior.

### 3. `Mem0Poller`

Target state:

- not started automatically on plugin registration
- remote sync runs only through `memory_maintain action=sync`
- startup may emit a preflight signal that sync work is pending

If future automation is reintroduced, it should be driven by a real dirty signal, not a blind fixed timer.

### 4. Consolidation and lifecycle

Target state:

- no default background `start()`
- logic kept as single-run maintenance units
- all reads and writes go directly through LanceDB-backed paths
- invoked serially through `memory_maintain`

This preserves the behavior while removing the concurrency model.

## Maintenance Flow

### `memory_maintain(action=all)` order

Recommended order:

1. `sync`
2. `migrate`
3. `consolidate`
4. `lifecycle`

Rationale:

- `sync` brings remote or pending writes into local truth first
- `migrate` normalizes storage shape before downstream processing
- `consolidate` deduplicates on the latest local state
- `lifecycle` applies status transitions on already-normalized records

Each action should:

- read current LanceDB state
- compute a bounded set of changes
- write changes back to LanceDB
- return a summary object

## Error Handling

- A failed maintenance action should return an explicit error summary.
- `memory_maintain(action=all)` should stop on the first hard failure by default.
- Startup preflight must never fail plugin registration unless the failure blocks all core memory access.
- Expensive actions must be visible through structured debug logs.

## Testing Strategy

### Data source transition

- Replace `FileAuditStore`-based maintenance tests with LanceDB-backed tests.
- Verify state transitions directly from LanceDB reads.

### Maintenance orchestration

- Add tests for `memory_maintain` action selection and ordering.
- Verify `all` runs tasks serially in the intended order.

### Startup behavior

- Verify registration no longer starts maintenance timers by default.
- Verify startup emits preflight signals instead of running maintenance.

### Migration and sync

- Verify migration does not run automatically during registration.
- Verify sync runs only through explicit maintenance invocation.

## Risks

- Removing `FileAuditStore` touches many tests and internal flows at once.
- Direct LanceDB state updates may expose adapter gaps that JSONL previously masked.
- Removing default background maintenance can change user expectations if they relied on passive convergence.

## Mitigations

- Migrate one maintenance domain at a time behind the unified entrypoint.
- Keep behavior-preserving tests around lifecycle and consolidation outcomes.
- Add clear debug/preflight messages so users know when maintenance is pending.

## Success Criteria

- Default plugin registration starts no maintenance timers.
- LanceDB is the only required maintenance state source.
- Explicit `memory_maintain` can run sync, migration, consolidation, and lifecycle tasks.
- Existing maintenance outcomes remain available without relying on background polling.
