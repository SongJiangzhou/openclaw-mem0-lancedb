# 2026-03-12 Long-Term Direct Capture Design

## Goal

Replace the default session-first auto-capture path with a lighter pipeline:

- apply deterministic noise filtering first
- write accepted auto-captured memories directly into `long-term`
- keep the existing session/promotion code in the repo for now
- stop relying on promotion thresholds as the primary long-term admission control

## Why This Change

The current session-first plus promotion model is conservative, but it adds complexity and creates another place where useful memories can be dropped before they ever become durable.

The desired behavior is simpler:

- obvious garbage should be filtered out cheaply
- useful extracted memories should be stored immediately
- long-term memory quality should be managed mostly by retrieval ranking and forgetting, not by a promotion gate

This keeps the write path short while still preventing the worst long-term contamination.

## Product Decision

Automatic capture should no longer depend on `session -> promotion -> long-term` as the default path.

Instead:

- auto-capture uses strong-rule noise rejection
- accepted memories are stored directly as `scope = long-term`
- manual store remains `long-term`

This is not a zero-admission system. It is a light-admission system with deterministic filtering.

## Noise Filtering Policy

The filter should reject only high-confidence noise categories.

### Reject

- obvious filesystem paths
- obvious shell command fragments
- raw stack traces and error logs
- host metadata and injected debug blocks
- one-off tool execution echoes
- operational status lines such as install/start/stop/success/failure output when they are not user facts

### Keep

- user preferences
- durable profile facts
- stable project background
- recurring working context likely to matter across sessions

### Principle

Prefer false negatives over false positives:

- do not aggressively block ambiguous content
- only reject content that is clearly operational garbage

## Runtime Behavior

### Auto-Capture

- default auto-capture scope becomes `long-term`
- auto-capture applies noise filtering before sync
- accepted memories are written directly into long-term storage

### Manual Store

- no change
- explicit manual store still defaults to `long-term`

### Recall

- no architectural change required for this phase
- recall keeps working against long-term memory as it already does

## Existing Session/Promotion Code

For this phase, keep the code but remove it from the default path.

Recommended handling:

- keep `MemoryPromotionWorker` in the repository
- do not start it during normal plugin registration
- keep `session` data structures and related code untouched unless required by tests

This keeps rollback cheap and limits refactor risk.

## Implementation Shape

### Config

- change runtime defaults so `autoCapture.scope` resolves to `long-term`
- change installer defaults so generated config uses `long-term`

### Capture Path

- adjust the auto-capture sync path to pass `scope = long-term`
- insert deterministic noise checks before writing

### Plugin Startup

- stop starting the promotion worker by default
- remove any default-path assertions that depend on promotion startup

## Testing

Required coverage:

1. auto-capture defaults to `long-term`
2. accepted extracted memory lands in long-term storage
3. strong-rule noise is rejected before persistence
4. plugin does not start the promotion worker on the default path
5. recall still works for the newly stored long-term memories

## Non-Goals

- deleting session or promotion code entirely
- redesigning the entire lifecycle system
- changing retrieval scoring in this step
- introducing new model-based classification for promotion or filtering

## Follow-Up

After this shift, the next worthwhile phase is strengthening forgetting and retrieval ranking so long-term storage can be broader without becoming noisy.
