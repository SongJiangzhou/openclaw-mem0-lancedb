# 2026-03-11 Memory Lifecycle Design

## Goal

Upgrade the memory plugin from a retrieval-only freshness model to a full memory lifecycle system with:

- explicit memory strength and stability
- review-driven reinforcement
- inhibition, quarantine, supersede, and delete states
- retention-aware forgetting
- audit-friendly state transitions

This design intentionally avoids word-level heuristic rules. It relies on lifecycle state, usage signals, duplication, conflict handling, and retention policy instead.

## Why This Change

The current implementation already has useful pieces:

- hybrid search with time decay
- duplicate consolidation
- append-only audit log
- background workers
- status values such as `active`, `superseded`, `deleted`

But it still lacks a real lifecycle model:

- time decay only exists inside ranking
- no explicit reinforcement state after successful recall
- no reversible suppression layer for noisy or conflicting memories
- no retention deadline or policy-driven forgetting
- no scheduled review state for high-value long-term memories

The deep research report supports promoting these concepts into first-class lifecycle state:

- spacing effect and testing effect support reinforcement and scheduled review
- reconsolidation supports versioned update after retrieval
- retrieval-induced forgetting supports reversible inhibition of competing memories
- PIPL/GDPR-style storage limitation supports retention deadline and eventual deletion

## Design Summary

We will upgrade the memory table schema and add lifecycle-aware maintenance.

### New Fields

Add these fields to each memory row:

- `strength: number`
- `stability: number`
- `last_access_ts: string`
- `next_review_ts: string`
- `access_count: number`
- `inhibition_weight: number`
- `inhibition_until: string`
- `utility_score: number`
- `risk_score: number`
- `retention_deadline: string`
- `lifecycle_state: string`

### Lifecycle States

Allowed values:

- `active`
- `reinforced`
- `inhibited`
- `superseded`
- `quarantined`
- `deleted`

State meaning:

- `active`: normal long-term memory, eligible for recall
- `reinforced`: recently and usefully recalled, eligible for recall
- `inhibited`: temporarily down-ranked, still retained
- `superseded`: replaced by a stronger canonical version
- `quarantined`: excluded from recall, retained for audit and review
- `deleted`: logically removed

## Schema Upgrade Strategy

This is a schema-level upgrade, but it does not require embedding-dimension migration.

### Existing Tables

For every discovered memory table:

1. inspect schema fields
2. if lifecycle fields are missing, open a new table with the expanded schema
3. copy rows into the upgraded table with backfilled lifecycle defaults
4. rename the old table to `_legacy_<timestamp>` if needed
5. let the existing migration machinery complete the handoff

This follows the repo's current schema migration pattern rather than introducing a second migration system.

### Backfill Defaults

For rows that do not yet have lifecycle data:

- `strength = 0.6`
- `stability = 30`
- `last_access_ts = ts_event`
- `next_review_ts = ts_event + 30 days`
- `access_count = 0`
- `inhibition_weight = 0`
- `inhibition_until = ''`
- `utility_score = 0.5`
- `risk_score = riskFromSensitivity(sensitivity)`
- `retention_deadline = retentionDeadlineFromSensitivityAndScope(row)`
- `lifecycle_state = mapStatusToLifecycleState(status)`

Mapping rule:

- `status = active` -> `lifecycle_state = active`
- `status = superseded` -> `lifecycle_state = superseded`
- `status = deleted` -> `lifecycle_state = deleted`

## Search Integration

Search ranking must move from "time decay only" to lifecycle-aware scoring.

### Hard Filters

Never recall:

- `lifecycle_state = deleted`
- `lifecycle_state = quarantined`
- `status = deleted`
- rows with `retention_deadline < now`

### Score Inputs

Start with the existing hybrid retrieval score, then apply lifecycle adjustments:

- `strength`
- `stability`
- `inhibition_weight`
- `inhibition_until`
- `utility_score`
- time decay based on `last_access_ts`

Rules:

- `reinforced` gets a mild positive multiplier
- `inhibited` gets a strong negative multiplier until `inhibition_until`
- expired inhibition returns to normal
- `superseded` does not participate in recall

### Access Update

After a successful recall block is built, selected memories should be updated asynchronously:

- increment `access_count`
- set `last_access_ts = now`
- if the memory contributed to final recall, reinforce it

This update should be scheduled via maintenance infrastructure rather than blocking the request path.

## Reinforcement Model

The first implementation should be simple and deterministic.

### Effective Strength

Compute decayed effective strength at read time:

`effective_strength = strength * exp(-ln(2) * age_days / stability)`

### Reinforcement Rule

When a memory is successfully included in final recall:

- `strength = min(1, effective_strength + 0.15 * (1 - effective_strength))`
- `stability = min(180, stability * 1.15)`
- `access_count += 1`
- `last_access_ts = now`
- `next_review_ts = now + reviewInterval(stability)`
- `lifecycle_state = reinforced`

### Review Interval

Initial heuristic:

- `stability <= 14` -> review after 7 days
- `stability <= 30` -> review after 14 days
- `stability <= 90` -> review after 30 days
- otherwise -> review after 60 days

This is intentionally heuristic-first and can be tuned later from logs.

## Forgetting Model

Forgetting should not start with hard delete. It should progress through reversible stages.

### Inhibition

Use inhibition for:

- noisy competitors
- near-duplicate weaker memories
- assistant-inferred memories that conflict with stronger user-explicit memories

Effects:

- set `lifecycle_state = inhibited`
- increase `inhibition_weight`
- set `inhibition_until`

This is the default action for competitive recall suppression.

### Quarantine

Use quarantine for:

- query-like historical pollution
- assistant-only preference statements with insufficient user evidence
- low-value operational or host-wrapper artifacts that escaped capture filtering

Effects:

- set `lifecycle_state = quarantined`
- exclude from recall
- keep in audit and maintenance review

### Supersede

Use supersede for:

- canonical replacement after consolidation
- conflict resolution when a better or newer memory wins

Effects:

- current winning version remains `active` or `reinforced`
- replaced rows move to `superseded`

### Delete

Use delete only when:

- retention deadline has passed
- explicit erase request exists
- policy class requires removal

Effects:

- append tombstone in audit
- update LanceDB row to `deleted`
- exclude from all recall and maintenance except compliance logs

## Retention Policy

Retention must be explicit.

### Inputs

Use existing row fields:

- `scope`
- `sensitivity`
- `memory_type`
- `source_kind`

### Initial Policy

Default proposal:

- `restricted` -> 30 days
- `confidential` -> 90 days
- `internal` -> 180 days
- `public` -> 365 days
- `session` scope -> 7 days
- explicit user profile preferences may extend to 365 days if still reinforced

This policy should be configurable later, but hardcoded defaults are acceptable for first implementation.

## Workers

Three workers are required.

### 1. Consolidation Worker

Extend the current consolidation worker to:

- group by dedup keys
- choose canonical winner using:
  - `source_kind`
  - `confidence`
  - `strength`
  - `stability`
  - `ts_event`
- mark weaker duplicates as `superseded`
- optionally mark clear query pollution as `quarantined`

### 2. Review Worker

New worker:

- scan active long-term rows where `next_review_ts <= now`
- reinforce high-utility rows modestly
- reschedule `next_review_ts`
- avoid external model calls in v1

This is maintenance-only and should not rewrite text content in the first release.

### 3. Eviction Worker

New worker:

- scan active and inhibited rows
- apply retention and utility rules
- perform:
  - `inhibited`
  - `quarantined`
  - `deleted`

Decision inputs:

- `utility_score`
- `risk_score`
- `retention_deadline`
- `access_count`
- `strength`
- `lifecycle_state`

## Utility and Risk Scoring

The first version should be deterministic and local.

### Utility Score Inputs

Use:

- recall usage frequency
- successful inclusion in final recall
- source quality
- recency

Initial heuristic:

- user explicit + used recently -> high utility
- assistant inferred + never used -> low utility

### Risk Score Inputs

Use:

- `sensitivity`
- credential-like detection
- scope
- source kind

Initial heuristic:

- `restricted` > `confidential` > `internal` > `public`

## Audit Requirements

Every lifecycle transition must append an audit event.

Required transitions to log:

- reinforcement
- inhibition
- quarantine
- supersede
- delete
- retention expiry

Audit entries should preserve:

- previous lifecycle state
- next lifecycle state
- reason code
- timestamp

## API and Type Changes

### Schema

Update `src/db/schema.ts` and table schema helpers for new lifecycle fields.

### Types

Update:

- `MemoryRow`
- `MemoryRecord`
- `MemorySyncPayload`

Add lifecycle-related types:

- `LifecycleState`
- `LifecycleUpdateReason`

### Search

Update `src/hot/search.ts` to:

- filter quarantined/deleted/expired rows
- apply lifecycle-aware scoring
- optionally enqueue reinforcement updates

### Capture

Update capture sync to:

- initialize lifecycle fields on new rows
- compute initial retention deadline
- initialize utility and risk score

## Historical Data Cleanup

As part of backfill:

- identify historical query-like pollution
- move those rows to `quarantined`
- preserve audit trace

Known examples should be cleaned by lifecycle policy, not by text rules in recall.

## Migration and Verification Plan

### Migration Verification

Required tests:

- schema upgrade adds lifecycle fields
- old rows are backfilled correctly
- upgraded table remains writable
- upgraded table remains searchable

### Lifecycle Verification

Required tests:

- reinforced rows gain strength/stability
- inhibited rows are strongly down-ranked
- quarantined rows do not recall
- superseded rows do not recall
- expired retention rows are excluded

### Worker Verification

Required tests:

- consolidation supersedes weaker duplicates
- review worker reschedules next review
- eviction worker inhibits/quarantines/deletes correctly

### Regression Verification

Run:

- `npm run build`
- `npm test`

## Implementation Phases

### Phase 1

- schema and type upgrade
- backfill defaults
- capture initializes lifecycle fields

### Phase 2

- search lifecycle scoring
- recall exclusion for quarantined/deleted/expired rows
- reinforcement updates

### Phase 3

- review worker
- eviction worker
- consolidation worker lifecycle upgrade

### Phase 4

- historical cleanup pass
- retention enforcement
- audit reason codes

## Non-Goals For This Iteration

- no LLM-driven lifecycle decisions
- no word-level rules for preference classification
- no semantic contradiction model beyond deterministic duplicate and winner logic
- no UI for lifecycle inspection yet

## Recommendation

Proceed with a single integrated upgrade, but implement in the phase order above. This keeps the migration atomic at the schema level while preserving engineering verifiability at each layer.
