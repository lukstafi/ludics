# Proposal: Extract shared AGENT_NAME_RE and canonical-round validation into filename-utils.ts

**Task**: task-7ef02569
**Date**: 2026-04-09

## Goal

Deduplicate the `AGENT_NAME_RE` regex and canonical-round integer validation pattern that are independently defined in three orchestration modules (`review-files.ts`, `plan-files.ts`, `merge-vote-files.ts`) by extracting them into a new shared `filename-utils.ts` module. No behavior changes.

## Acceptance Criteria

1. A new file `src/orchestration/filename-utils.ts` exports:
   - `AGENT_NAME_RE` (`/^[\w-]+$/`) -- the regex constant, for any caller that needs it directly.
   - `validateAgentName(name: string, context: string): void` -- throws a descriptive error if the name doesn't match `AGENT_NAME_RE`, with `context` identifying the caller (e.g. "plan filename").
   - `parseCanonicalInt(token: string): number | null` -- parses an integer and returns `null` when `String(result) !== token` (rejects zero-padded or non-canonical representations).

2. `review-files.ts`, `plan-files.ts`, and `merge-vote-files.ts` each:
   - Remove their local `AGENT_NAME_RE` definition.
   - Import and use `validateAgentName` / `AGENT_NAME_RE` from `filename-utils.ts`.
   - Replace inline `parseInt` + `String(round) !== m[1]` guards with calls to `parseCanonicalInt`.

3. All existing tests (`review-files.test.ts`, `plan-files.test.ts`, `merge-vote-files.test.ts`) continue to pass unchanged -- public APIs of the three modules are not altered.

4. A new `filename-utils.test.ts` covers:
   - `validateAgentName` accepts valid names (`"coder-1"`, `"agent_a"`), throws on invalid (`""`, `"a b"`, `"a/b"`).
   - `parseCanonicalInt` returns the number for canonical strings (`"0"`, `"1"`, `"42"`), returns `null` for non-canonical (`"01"`, `"abc"`, `""`).

5. `bun run build` succeeds with no new errors or warnings.

## Context

The duplication was identified during the gh-ludics-171 retrospective. The three files are small (27-57 lines each) and the pattern is identical:

- **`AGENT_NAME_RE`** defined on line 3, 11, or 12 of each file as `/^[\w-]+$/`.
- **Canonical-round guard**: `const round = parseInt(m[1]!, 10); if (String(round) !== m[1]) return null;` appears 2x in `review-files.ts`, 2x in `plan-files.ts` (plus a `planMergeRound` variant), and 1x in `merge-vote-files.ts`.

No external callers import `AGENT_NAME_RE` directly -- it is only used internally by the filename builder functions. The public API surface of each module (exported functions and types) remains unchanged.

## Approach

1. Create `src/orchestration/filename-utils.ts` with the three exports.
2. Update each of the three consuming modules to import from the new file and remove duplicated code.
3. Add `src/orchestration/filename-utils.test.ts` with unit tests for the new helpers.
4. Run existing tests to confirm no regressions, then `bun run build`.
