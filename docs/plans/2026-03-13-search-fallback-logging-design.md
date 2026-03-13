# Search Fallback Logging Design

## Goal

Fix the memory search control-flow bug where a Mem0 fallback failure discards already-available local LanceDB results, and formalize a rule that swallowed or downgraded exceptions must be logged at the catch boundary.

## Scope

- Preserve existing fallback behavior: local LanceDB search still runs first, and Mem0 fallback still runs when local results are below `topK`.
- Change failure handling so Mem0 fallback errors do not erase successful local results.
- Add structured logging at the catch boundaries involved in this flow.
- Add a project rule in `AGENTS.md` requiring boundary-level structured exception logging.

## Current Problem

`MemorySearchTool.execute()` currently wraps both local search and Mem0 fallback inside the same `try` block. When local LanceDB search succeeds but the subsequent Mem0 fallback throws, the outer catch treats the entire local search path as failed. The method then retries Mem0 alone and can return an empty result, even though local memories were already found.

This is especially visible when:

- local LanceDB has fewer than `topK` matching results
- `hasMem0Auth()` returns true
- Mem0 `/search` fails

## Desired Behavior

1. Run local LanceDB search first.
2. If local search fails:
   - emit a structured error log at that boundary
   - continue to Mem0-only fallback if configured
3. If local search succeeds and returns enough results:
   - return local results immediately
4. If local search succeeds but returns fewer than `topK`:
   - attempt Mem0 fallback
   - if Mem0 succeeds, merge local and remote
   - if Mem0 fails, emit a structured error log and return the local results

## Logging Rule

Add an explicit project rule:

- Any exception that is caught and then swallowed, downgraded, retried, converted to a fallback path, or transformed into a non-throwing return value must emit a structured log at that catch boundary.

This rule is intentionally narrower than a repo-wide refactor. It guides future changes and is enforced for this search path now.

## Implementation Notes

- Keep the fix local to `src/tools/search.ts`
- Do not introduce a global error-logging abstraction in this change
- Use stable event names for this flow:
  - `memory_search.local_failed`
  - `memory_search.mem0_fallback_failed`
  - `memory_search.returning_local_after_fallback_failure`

## Testing

Add regression coverage for:

- local success + Mem0 fallback failure => return local results
- structured logging is emitted when fallback fails after local success

Do not change the semantics of existing successful fallback tests.
