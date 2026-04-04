# Extract shared planFilename helper to consolidate plan file path patterns

## Goal

Consolidate the inline plan filename construction scattered across `phases.ts`, `skills.ts`, and `runner.ts` into a single `plan-files.ts` module, mirroring the existing `review-files.ts` pattern. This eliminates 8+ inline string interpolation sites and provides a single source of truth for plan file naming conventions.

## Acceptance Criteria

- A new module `src/orchestration/plan-files.ts` exports `planFilename`, `planFilePath`, and `parsePlanFilename`
- `planFilename("plan", round, agentName)` returns `round-{round}-{agentName}.md`
- `planFilename("merged", round, mergeRound)` returns `round-{round}-merged-{mergeRound}.md`
- `planFilePath(peerSyncDir, ...)` returns the full path under `plans/` subdirectory
- `parsePlanFilename(filename)` returns `{ type: "plan", round, agentName }` or `{ type: "merged", round, mergeRound }` or `null`
- All inline plan filename constructions in `phases.ts`, `skills.ts`, and `runner.ts` are replaced with calls to the new helpers
- `findPlanFiles()` in `phases.ts` uses `parsePlanFilename` instead of prefix matching + `-merged-` exclusion
- Agent name validation matches the `[\w-]+` pattern used in `review-files.ts`
- Existing tests continue to pass without behavioral changes
- New unit tests in `plan-files.test.ts` cover filename generation, path construction, parsing, and invalid input

## Context

Plan filenames are constructed inline across three files with two patterns:

1. **Individual plan**: `round-${round}-${agentName}.md` -- used in `phases.ts:78`, `skills.ts:201`, `skills.ts:216`, `phases.ts:388`
2. **Merged plan**: `round-${round}-merged-${mergeRound}.md` -- used in `phases.ts:82`, `skills.ts:205`, `runner.ts:1094`

The `findPlanFiles()` function at `phases.ts:375-395` uses string prefix matching (`f.startsWith(planPrefix)`) with an exclusion heuristic (`!f.includes("-merged-")`) to enumerate individual plan files. This is fragile -- any future filename pattern containing "-merged-" would be incorrectly excluded.

The existing `review-files.ts` module (40 lines) provides the exact pattern to follow: `reviewFilename()`, `reviewFilePath()`, and `parseReviewFilename()` with regex-based parsing and agent name validation. The plan-files module is a direct structural parallel.

The `planMergeRound ?? 0` default appears in callers (`phases.ts:82`, `phases.ts:86`, `skills.ts:202`) -- the helper should accept the resolved value, leaving callers responsible for the fallback.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Create `src/orchestration/plan-files.ts` with overloaded `planFilename`, `planFilePath`, and `parsePlanFilename` using the same structural pattern as `review-files.ts`
2. Create `src/orchestration/plan-files.test.ts` mirroring `review-files.test.ts` test structure
3. Replace inline constructions in `phases.ts` (lines 78, 82, 381, 386, 388), `skills.ts` (lines 201, 205, 216), and `runner.ts` (line 1094) with helper calls
4. Refactor `findPlanFiles()` to use `parsePlanFilename` for filtering instead of string prefix + exclusion logic
5. Run existing test suite to verify no regressions
