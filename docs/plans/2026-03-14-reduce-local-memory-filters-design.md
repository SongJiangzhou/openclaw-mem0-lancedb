# Reduce Local Memory Filters Design

## Goal

Let Mem0 remain the primary decision-maker for capture and recall while keeping only minimal local guardrails that protect obvious low-value cases.

## Problem

Two local rules were overriding Mem0 too aggressively:

- `assistant_only_preference` in capture rejected Mem0-extracted preference memories when the extracted wording was closer to the assistant summary than the user's original wording.
- `looksOperationalNoise()` in local reranking penalized recall candidates based on lexical surface patterns such as `workspace` or `scripts/`.

Both rules reduced end-to-end recall and violated the current design direction of avoiding brittle rule layering.

## Options Considered

### 1. Remove both rules entirely

Recommended.

- Keep `query_echo` as the only capture-time hard rejection.
- Remove lexical operational-noise penalties from local reranking.
- Preserve existing temporal and source-kind light blending.

This is the smallest change that restores Mem0's primary role without adding any new systems.

### 2. Replace both rules with more semantic local heuristics

Rejected.

This would still add another local decision layer and would likely recreate the same precision/recall trade-off in a more complex form.

### 3. Keep the rules but lower their thresholds

Rejected.

This still leaves local hard-coded gates in front of Mem0 and does not align with the first-principles design rules in `AGENTS.md`.

## Final Design

- Capture:
  - Keep rejection for empty extracted text.
  - Keep rejection for pure query echo.
  - Remove assistant-similarity-based rejection.

- Recall reranking:
  - Keep query echo penalty.
  - Keep temporal/source-kind light blending.
  - Remove lexical operational-noise penalty.

## Testing

- Update capture sync tests to assert assistant-summary-adjacent preference memories are still stored.
- Update reranker tests to assert relevant memories mentioning words like `workspace` are not demoted just because of lexical pattern matching.
