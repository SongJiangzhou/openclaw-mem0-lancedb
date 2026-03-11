# 2026-03-12 Hook-First Memory Sidecar Design

## Goal

Reposition `openclaw-mem0-lancedb` from a tool-led memory plugin into a hook-first memory sidecar for OpenClaw 3.7.

The plugin should use OpenClaw lifecycle hooks as the primary control plane for automatic recall and capture, while keeping Mem0, LanceDB, audit storage, and background maintenance as the reliability and retrieval layer.

## Why This Change

The current plugin already contains working hook-based behavior:

- `before_prompt_build` injects recall context
- `agent_end` submits capture payloads
- pollers and workers reconcile asynchronous state

But the mental model is still mixed:

- tools are presented as a primary interface
- hooks behave like an enhancement
- background maintenance is not clearly separated from request-path behavior

That is a poor fit for the actual product goal. This plugin is infrastructure for automatic memory, not a toolbox the model should remember to call.

OpenClaw's official memory model also suggests a cleaner separation:

- memory is a retrieval and storage system
- hooks are an automation and orchestration system

For this plugin, the best alignment is not a full rewrite into a pure hook-only plugin. It is a hook-first sidecar architecture:

- hooks own the dialogue-time control flow
- Mem0 + LanceDB own memory extraction, synchronization, and retrieval
- tools are retained only for debugging, administration, and recovery

## Non-Goals

This design does not propose:

- replacing Mem0 + LanceDB with OpenClaw's native Markdown/QMD backend
- removing pollers or workers in the first migration
- rewriting the plugin into a hook-only black box with no manual inspection path
- changing memory extraction semantics beyond control flow and interface positioning

## Recommended Approach

Three approaches were considered:

### Approach 1: Official-Aligned Native Memory Backend

Move the plugin toward OpenClaw's native memory style and reduce Mem0/LanceDB to a minor role.

Pros:

- aligns closely with official OpenClaw memory concepts
- simpler conceptual fit for users who expect workspace-native memory

Cons:

- discards much of the current plugin's value
- requires major re-architecture
- weakens Mem0 governance and LanceDB retrieval advantages

### Approach 2: Hook-First Sidecar

Use hooks as the primary interaction path while preserving Mem0 + LanceDB as the external memory sidecar and keeping limited admin/debug tools.

Pros:

- matches the plugin's real usage model
- keeps existing architecture strengths
- aligns well with OpenClaw hook semantics
- improves reliability by removing model dependence on explicit tool calls

Cons:

- still carries some hybrid complexity
- requires documentation and test strategy changes

### Approach 3: Hook-Only Plugin

Remove tool access entirely and make the plugin fully event-driven.

Pros:

- cleanest conceptual model
- smallest user-facing surface area

Cons:

- poor debuggability
- worse recoverability during outages or sync drift
- less aligned with OpenClaw's observable memory tooling style

### Recommendation

Choose Approach 2: Hook-First Sidecar.

It gives the clearest operational model without losing the observability and administrative control needed for a memory system.

## Architecture Boundary

The target architecture is:

- hooks as the primary request-path entrypoint
- Mem0 + LanceDB as the memory sidecar backend
- audit + outbox as the durability and traceability layer
- pollers and workers as the eventual-consistency and maintenance layer
- tools as optional admin/debug entrypoints

### Responsibility Split

#### Hooks

Hooks own all dialogue-time behavior:

- `before_prompt_build`
- `agent_end`
- optional future visibility hooks for status/debug surfacing

Hooks should be the only path required for normal operation.

#### Sidecar Backend

Mem0 and LanceDB remain responsible for:

- extraction and memory governance
- hot retrieval
- event confirmation
- synchronization into local searchable state

#### Reliability Layer

Audit storage and outbox remain responsible for:

- replay safety
- traceability
- idempotency support
- operator visibility when async paths fail

#### Background Maintenance

Pollers and workers remain responsible for:

- async capture confirmation
- index freshness
- embedding migration
- consolidation
- lifecycle maintenance

These are not primary user interaction entrypoints.

## Event Flow

The system should be understood as two linked flows: a foreground hook flow and a background convergence flow.

### Foreground Hook Flow

#### 1. `before_prompt_build`

The plugin:

- resolves the latest user query and memory identity
- runs local recall against LanceDB
- optionally uses reranking or Mem0 fallback
- builds a stable recall block
- injects it into `prependSystemContext`

If the previous turn completed a capture that is not yet visible to the user, the plugin may also inject a lightweight capture notification block.

This replaces any expectation that the model must call a recall tool to gain context.

#### 2. Model Reply

The model responds with no dependency on explicit memory tool use.

#### 3. `agent_end`

The plugin:

- extracts the latest user and assistant messages
- builds the capture payload
- submits the payload to Mem0

If Mem0 returns extracted memories directly:

- sync them immediately into audit storage and LanceDB

If Mem0 returns only an `event_id`:

- record the pending state
- leave final reconciliation to the background flow

### Background Convergence Flow

#### 4. Poller Reconciliation

The poller tracks pending async capture events and, when they are confirmed:

- fetches captured memories
- syncs them into audit storage
- syncs them into LanceDB
- makes them available for the next recall cycle

#### 5. Worker Maintenance

Workers do not affect whether a turn can complete. They maintain long-term quality by handling:

- embedding migration
- consolidation
- lifecycle maintenance

## Sync vs Async Boundary

The boundary should be explicit.

### Must Complete Synchronously

- recall query extraction
- recall search and rerank
- recall block injection
- capture payload construction
- capture submission attempt

### May Complete Asynchronously

- capture event confirmation
- extracted memory fetch
- local sync after delayed Mem0 completion
- embedding migration
- consolidation
- lifecycle cleanup and maintenance

This preserves conversational responsiveness while keeping eventual consistency.

## Tool Strategy

Tools should no longer be positioned as the plugin's primary operating mode.

### Keep as Admin/Debug

#### `memory_search`

Retain for:

- operator verification
- recall debugging
- manual inspection of retrieval quality

This is the most valuable retained tool.

#### `memoryStore`

Retain but demote for:

- manual repair
- imports
- testing
- recovery workflows

It should no longer be described as a normal dialogue-time path.

### Hide or Remove

#### `memory_get`

Remove or hide unless direct audit snippet reads are a common operator workflow.

If retained, it should be documented as a low-level diagnostic tool only.

## Error Handling and Degradation

The key rule is that hook-path failures must not break the conversation.

### Recall Failure

If recall fails:

- do not block prompt construction
- inject nothing
- emit debug and audit signals

### Capture Submission Failure

If capture submission fails:

- do not block turn completion
- store failure state in the reliability layer
- allow later operator or replay handling

### Async Confirmation Failure

If Mem0 event confirmation fails:

- let the poller retry
- eventually mark the state as unresolved or failed
- do not fail the dialogue path

### LanceDB Sync Failure

If local sync fails:

- preserve upstream Mem0 submission state
- retry via the existing maintenance path
- keep the failure auditable

### Worker Failure

If a worker fails:

- retrieval quality may degrade
- freshness may degrade
- the main user conversation must still proceed

## Testing Strategy

The test suite should shift from tool-centric coverage to hook-centric coverage.

### Priority 1: Hook Recall

Cover:

- recall injection when a valid query exists
- skip behavior when no query exists
- graceful degradation on search failure

### Priority 2: Hook Capture

Cover:

- capture submission on `agent_end`
- direct extraction response path
- delayed event-confirmation response path

### Priority 3: Reliability Degradation

Cover:

- Mem0 unavailable
- LanceDB write failure
- poller timeout
- worker failure

These tests must prove that the main turn flow remains intact.

### Priority 4: End-to-End Hook Flow

Cover the key acceptance path:

1. one turn triggers capture
2. captured memory becomes locally available
3. the next turn recalls and injects it

This is the most important system-level validation for the new positioning.

### Priority 5: Tool Regression Smoke Coverage

Keep only small regression tests for retained admin/debug tools.

Tools are no longer the center of the plugin design.

## Documentation Changes

README and plugin docs should be updated to reflect the new operating model.

Current framing should change from:

- memory plugin with tools and automatic enhancements

To:

- hook-driven automatic memory sidecar
- admin/debug tools available for inspection and manual recovery

Documentation should explicitly describe:

- which hooks are required
- what happens on each hook
- why pollers and workers still exist
- which tools remain and why they are no longer primary

## Migration Strategy

This change should be delivered incrementally.

### Phase 1

- reframe architecture and documentation
- keep all existing runtime components
- mark tools as non-primary

### Phase 2

- reduce internal dependence on tool-style mental models
- move more tests to hook-first acceptance paths

### Phase 3

- decide whether `memory_get` should remain
- decide whether admin tools should become opt-in or hidden

## Success Criteria

The redesign is successful when:

- a normal OpenClaw session uses memory without requiring explicit tool calls
- recall and capture are understood as lifecycle-hook behavior
- async sync remains reliable through pollers and workers
- operators still have enough tooling to inspect and repair the system
- docs and tests reflect hook-first behavior as the default model

## Final Recommendation

Implement `openclaw-mem0-lancedb` as a hook-first memory sidecar.

That means:

- hooks are the primary interface
- pollers and workers remain for async convergence and maintenance
- Mem0 + LanceDB remain the memory backend
- tools are demoted to admin/debug use

This is the best fit for both the current codebase and OpenClaw's official architecture boundaries.
