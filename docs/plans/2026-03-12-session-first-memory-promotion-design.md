# 2026-03-12 Session-First Memory Promotion Design

## Goal

Change automatic memory capture from direct long-term persistence to a session-first pipeline:

- auto-captured memories land in `session` scope first
- only high-value items are promoted into `long-term`
- session memories age out quickly
- long-term recall quality improves by reducing operational and transient noise

This design intentionally stays lightweight. It does not introduce graph memory, emergent concept nodes, subconscious bias layers, or word-level heuristic rules.

## Why This Change

The current plugin can extract useful memories, but long-term memory quality is still too noisy when automatic capture writes directly into shared long-term storage.

Typical low-quality long-term rows include:

- transient task instructions
- tool execution fragments
- filesystem paths
- operational status messages
- one-off session decisions

These are useful during the current conversation, but they should not compete with durable preferences, identity facts, and stable background context during future recall.

The existing lifecycle system already gives the project the right building blocks:

- `session_id` and `agent_id`
- lifecycle fields such as `strength`, `stability`, and `lifecycle_state`
- reinforcement after successful recall
- consolidation and lifecycle maintenance workers

The missing piece is admission control between short-lived session memory and shared long-term memory.

## Design Summary

The memory system should adopt a simple default policy:

- automatic capture writes to `session`
- manual store writes to `long-term`
- a new promotion worker decides which session memories are worth keeping as long-term memory
- session memories decay and are cleaned aggressively

Users do not choose this strategy in config. It becomes the default behavior when automatic capture is enabled.

## Scope Model

### Long-Term

Long-term memory remains shared at the person level:

- `user_id = default`
- `scope = long-term`
- `session_id = ''`

These rows are intended for:

- durable preferences
- identity facts
- stable background context
- long-running project knowledge

### Session

Automatic capture writes session-scoped rows:

- `user_id = default`
- `scope = session`
- `session_id = current session key`
- `agent_id = current agent id if available`

These rows are intended for:

- current-task context
- temporary plans
- short-lived decisions
- fresh observations that are not yet proven durable

## Admission Policy

### Automatic Capture

When `autoCapture.enabled = true`:

- the plugin writes captured memories to `session`
- the installer no longer asks users to choose auto-capture scope
- runtime defaults treat auto-capture as session-first

This keeps automatic extraction conservative and reduces long-term contamination.

### Manual Store

Manual `memoryStore` continues to default to `long-term`.

Reason:

- manual store is an explicit user action
- it is the right path for durable facts the user clearly wants remembered

## Promotion Model

### Promotion Worker

Add a dedicated `PromotionWorker` that periodically scans recent session memories and evaluates whether they should be copied into long-term memory.

This worker should:

1. read current-session rows from the audit store
2. group by dedup key
3. evaluate promotion signals
4. write promoted copies into long-term memory
5. mark original session rows as promoted or superseded where appropriate

### Promotion Signals

Promotion should remain deterministic and conservative.

A session memory is eligible for promotion only if all required gates pass:

Required gates:

- not sensitive
- not query echo
- not assistant-only inferred preference
- not quarantined or deleted

Positive signals:

- explicit user intent to remember
- recalled successfully at least twice in the same session
- `utility_score` exceeds threshold
- `strength` exceeds threshold after reinforcement
- duplicated consistently within the same session

Recommended first-pass thresholds:

- `access_count >= 2`
- `strength >= 0.72`
- `utility_score >= 0.65`

Promotion should create a new long-term row, not mutate the original session row in place.

## Session Aging Model

Session memory should decay much faster than long-term memory.

### Defaults

- session half-life: `12 hours`
- quarantine after: `24 hours` idle
- delete after: `7 days`

### Worker Behavior

The lifecycle worker should treat `scope = session` differently:

- apply stronger decay
- quarantine quickly once idle
- delete after the retention window expires

Session memory should not be preserved by default forever. Its main purpose is short-term continuity.

## Recall Behavior

Recall should merge two sources:

1. shared long-term memory
2. current-session session memory

The ranking order should continue to use the existing lifecycle-aware search pipeline, but with these additions:

- session memories are only eligible when `session_id` matches the current session
- long-term memories remain globally shared for the user
- promoted long-term copies compete normally with existing long-term memories

This gives the user:

- continuity inside the current conversation
- less long-term noise
- durable recall only for memories that proved useful

## Error Handling

Promotion must be best-effort and asynchronous.

Rules:

- failure to promote must never break normal capture or recall
- promotion errors should log clearly with memory id, session id, and reason
- duplicate detection still applies when creating long-term copies
- if a promoted fact already exists in long-term, update lifecycle metadata instead of creating another duplicate

## Data Model Changes

No new table is required for the first version.

Reuse existing schema:

- `scope`
- `session_id`
- `agent_id`
- lifecycle fields already introduced by the memory lifecycle work

Potential small additions:

- `promoted_from_session_id`
- `promotion_reason`

These are optional. The first version can work without them if audit entries already preserve enough traceability.

## Testing

Required automated coverage:

1. auto-capture defaults to `session`
2. manual store still defaults to `long-term`
3. recall merges current-session session rows with long-term rows
4. session rows from a different session do not leak into recall
5. promotion worker copies eligible rows into long-term
6. promotion worker does not promote low-utility or assistant-only rows
7. lifecycle worker quarantines and deletes stale session rows on the shorter schedule

## Rollout

### Phase 1

- change auto-capture default scope to `session`
- remove scope selection from installer for auto-capture
- ensure all automatic write paths persist `session_id`

### Phase 2

- add `PromotionWorker`
- wire promotion into plugin startup
- add tests for promotion and current-session recall

### Phase 3

- tighten session aging behavior inside lifecycle worker
- add audit visibility for promotions and session expiry

## Non-Goals

This design explicitly does not include:

- graph memory edges
- prototype or cluster nodes
- subconscious bias layers
- multi-hop associative retrieval
- LLM-driven promotion decisions
- word-level heuristic rules

## Recommended Outcome

The plugin should move from:

- auto-capture writes everything into long-term

to:

- auto-capture writes into session
- only reinforced, useful, durable memories are promoted into long-term

This is the smallest change that materially improves memory quality without introducing a much heavier cognitive architecture.
