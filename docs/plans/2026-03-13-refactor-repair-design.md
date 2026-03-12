# Refactor Repair Design

## Summary

This design repairs two behavior risks introduced by commit `1809389` without undoing the useful deduplication work:

1. Remove unsafe automatic audit-log compaction from the synchronous append path.
2. Restore per-call-site `lancedb` provenance support in the shared record mapper.

The goal is to keep the code reduction benefits while eliminating data-loss risk and restoring record semantics that were previously preserved.

## Goals

- Eliminate the risk of losing audit rows due to automatic compaction during append.
- Preserve the shared `payloadToRecord()` / `recordToPayload()` abstraction.
- Restore `lancedb` metadata on audit records for call sites that previously emitted it.
- Add focused tests for the repaired behavior.

## Non-Goals

- Do not redesign the audit subsystem.
- Do not reintroduce duplicated `toRecord()` helpers.
- Do not revisit migration-status removal or recall rewrite simplification in this pass.
- Do not add multi-process locking or a new maintenance runner in this pass.

## Current Problems

### 1. Unsafe automatic compaction

`FileAuditStore.append()` now triggers `compact()` after a threshold. `compact()` rewrites the entire JSONL file from a snapshot of latest rows. The plugin creates multiple `FileAuditStore` instances for the same file path, so one instance can compact while another instance appends. That creates a real risk of dropping rows written after the snapshot was read.

### 2. Mapper abstraction lost call-site semantics

The new shared `payloadToRecord()` keeps only common fields. Before the refactor, some call sites also stored `lancedb.table`, `lancedb.row_key`, `lancedb.vector_dim`, and `lancedb.index_version` in audit records. After the refactor, those fields are silently omitted.

### 3. Missing coverage around the risky change

Existing audit-store tests still cover append and reads, but not the new compaction path and not mapper behavior for `lancedb` metadata. The highest-risk additions are therefore not protected by tests.

## Approach Options

### Option A: Minimal safety repair

- Remove automatic compaction from `append()`.
- Keep `compact()` as an explicit method but do not call it automatically.
- Extend `payloadToRecord()` with optional overrides for fields like `lancedb`.

Pros:

- Smallest change set
- Lowest regression risk
- Preserves most of the refactor benefit

Cons:

- Audit log no longer auto-compacts
- Future compaction policy still needs a safer design

### Option B: Keep auto-compaction with in-process locking

- Add a per-path mutex around append and compact.
- Keep the threshold-based compaction behavior.
- Extend the mapper with optional extras.

Pros:

- Retains auto-compaction

Cons:

- More complex than needed for the immediate fix
- Only addresses in-process concurrency
- Keeps expensive file rewrite behavior on the hot path

### Option C: Full audit rewrite

- Replace JSONL compaction with a dedicated maintenance flow and redesigned store contract.

Pros:

- Clean long-term architecture

Cons:

- Far outside the requested minimal repair scope

## Recommended Approach

Use Option A.

This directly removes the dangerous behavior from the write path and restores lost semantics in the mapper while keeping the refactor structure intact.

## Design

### 1. Audit store behavior

`FileAuditStore.append()` should go back to a single responsibility: append one serialized record safely.

`FileAuditStore.compact()` can remain as an explicit utility method for future operator use or later background integration, but it should not be invoked automatically from `append()`.

This intentionally prefers bounded code risk over immediate file-size optimization.

### 2. Shared mapper contract

`payloadToRecord()` should accept an optional second argument for record extensions. The shared helper still builds the common `MemoryRecord`, but callers that need additional provenance can supply:

- `lancedb`
- any future record-level extras that are safe to merge structurally

That keeps the shared mapper useful without flattening away legitimate call-site differences.

### 3. Call-site behavior

Repair only the call sites that previously wrote `lancedb` metadata:

- `MemorySyncEngine`
- capture sync path

Other call sites can keep using the base mapper with no extras if they did not previously emit that metadata.

### 4. Testing

Add tests that prove the repaired contract:

- `payloadToRecord()` preserves base fields and accepts `lancedb` overrides.
- `FileAuditStore.append()` no longer triggers implicit compaction.
- Existing append/read semantics remain unchanged.

## Error Handling

- Removing automatic compaction reduces write-path failure modes.
- Mapper extensions should be merged structurally and remain optional.
- No behavior should depend on omitted optional `lancedb` metadata unless the caller explicitly provides it.

## Validation

Required verification for the repair:

- targeted unit tests for mapper and audit store
- full `npm test`

## Expected Outcome

After this repair:

- the refactor still benefits from shared mapping and shared text utilities
- audit writes no longer risk losing rows due to automatic compaction
- audit records once again include `lancedb` provenance where those call sites previously emitted it
