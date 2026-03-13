# Semantic Rerank Design

## Goal

Improve end-to-end memory precision and recall for preference/time-sensitive questions without adding new storage layers, new maintenance flows, or new model calls.

## Why This Direction

The current architecture is strongest when it remains:

- local-first
- retrieval-centric
- operationally simple

Explicit relation tables, graph-like storage, or new time-versioning systems would increase complexity and risk harming end-to-end recall quality. The better fit is to strengthen the existing rerank stage so it understands candidate memory context more clearly.

## Design

### 1. Semantic Rerank View

Before reranking, convert each candidate memory into a lightweight ranking view derived from existing fields:

- original memory text
- memory type
- domains
- source kind
- lightweight temporal hint

This view is only used for ranking. It is not stored and does not become a new source of truth.

Example shape:

`preference memory; domain=food; source=user_explicit; recency=current; text=User likes McDonalds grilled chicken burger`

### 2. Lightweight Temporal Hint

Do not add new storage schema or a complex temporal state system.

Instead, compute a temporary temporal hint from existing fields such as:

- `ts_event`
- `last_access_ts`
- `lifecycle_state`

Hints stay intentionally coarse:

- `current`
- `recent`
- `older`
- `historical`

### 3. Final Blend After Rerank

After rerank, apply a small final blend that respects:

- rerank order
- existing lifecycle-related quality signals
- source-kind trust
- lightweight temporal hint

This blend should be shallow and conservative. It exists to prevent clearly stale or weaker memories from displacing stronger current memories when semantic similarity alone is insufficient.

### 4. No New Model Calls

This design does not add:

- a separate LLM rewrite request
- a new relation extraction call
- a graph query path

The existing reranker interface remains the extension point.

## Files Likely To Change

- `src/recall/reranker.ts`
- `src/recall/auto.ts`
- `tests/recall/reranker.test.ts`
- `tests/recall/auto.test.ts`

## Success Criteria

- better ordering for “current preference” style queries
- no new storage schema
- no new maintenance task
- no new model dependency
- tests show preference/time-aware ranking improvements without broad regressions
