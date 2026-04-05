# Proposal: Unify review/plan filename parsing

**Task**: gh-ludics-171
**Date**: 2026-04-05

## Goal

Consolidate all inline plan-file and merge-vote filename construction/parsing into shared helper modules, completing the unification that `review-files.ts` already achieved for review filenames. This eliminates scattered string interpolation patterns that are fragile and inconsistent.

## Acceptance Criteria

### Plan file helpers (primary scope)

1. A new module `src/orchestration/plan-files.ts` exists, exporting:
   - `planFilename(round, agentName)` -- returns `round-{round}-{agentName}.md`
   - `mergedPlanFilename(round, planMergeRound)` -- returns `round-{round}-merged-{planMergeRound}.md`
   - `planFilePath(peerSyncDir, round, agentName)` -- full path under `plans/`
   - `mergedPlanFilePath(peerSyncDir, round, planMergeRound)` -- full path under `plans/`
   - `parsePlanFilename(filename)` -- parses to `{ type: "plan" | "merged", round, agentName?, planMergeRound? }` or null
   - Agent name validation consistent with `review-files.ts` (`AGENT_NAME_RE = /^[\w-]+$/`)

2. All inline plan filename construction is replaced with helper calls:
   - `phases.ts:78` -- `requiredArtifactPath` plan case
   - `phases.ts:82` -- `requiredArtifactPath` plan-merge case
   - `phases.ts:386-388` -- `collectPlanFiles` scanning and coder-plan check
   - `skills.ts:201` -- `buildSkillContext` individual plan path
   - `skills.ts:205` -- `buildSkillContext` merged plan path
   - `skills.ts:216` -- `buildSkillContext` peer plan path
   - `runner.ts:1123` -- solo-mode merged plan path

3. Test file `plan-files.test.ts` covers filename building and parsing round-trips.

### Merge vote helpers (secondary scope)

4. Helper functions for merge vote filenames exist (either in `plan-files.ts` or a separate `merge-vote-files.ts`):
   - `mergeVoteFilename(round, agentName)` -- returns `round-{round}-{agentName}.txt`
   - `mergeVoteFilePath(peerSyncDir, round, agentName)` -- full path under `merge-votes/`
   - `parseMergeVoteFilename(filename)` -- parses to `{ round, agentName }` or null

5. All inline merge vote filename construction is replaced:
   - `merge.ts:12-13` -- `readMergeVotes` ad-hoc prefix/replace parsing
   - `skills.ts:281` -- `buildSkillContext` merge vote path construction

6. Test coverage for merge vote filename helpers.

### General

7. No behavioral changes -- all existing tests continue to pass.
8. The helper API style is consistent with `review-files.ts` (same naming conventions, validation, return types).

## Context

### Review files (item 1 -- already complete)

`src/orchestration/review-files.ts` provides the template: `reviewFilename()`, `reviewFilePath()`, `parseReviewFilename()` with regex-based parsing and agent name validation. All call sites in `phases.ts`, `skills.ts`, and `retrospective.ts` have been migrated. This work (task-90dae811) is code-complete.

### Plan file inline sites (item 2 -- 7 sites across 3 files)

Current inline patterns:
- **`phases.ts:78`**: `` join(dir, "plans", `round-${state.round}-${agent.name}.md`) ``
- **`phases.ts:82`**: `` join(dir, "plans", `round-${state.round}-merged-${state.planMergeRound ?? 0}.md`) ``
- **`phases.ts:386-388`**: scanning with `f.startsWith(planPrefix)` + `!f.includes("-merged-")` + exact match check
- **`skills.ts:201`**: `` join(state.peerSyncDir, "plans", `round-${state.round}-${agent.name}.md`) ``
- **`skills.ts:205`**: `` join(state.peerSyncDir, "plans", `round-${state.round}-merged-${planMergeRound}.md`) ``
- **`skills.ts:216`**: `` join(state.peerSyncDir, "plans", `round-${state.round}-${peer.name}.md`) ``
- **`runner.ts:1123`**: `` join(plansDir, `round-${state.round}-merged-0.md`) ``

### Merge vote inline sites (item 3 -- 2 sites across 2 files)

- **`merge.ts:12-13`**: ad-hoc `startsWith`/`replace` parsing to extract agent name from vote filename
- **`skills.ts:281`**: `` join(state.peerSyncDir, "merge-votes", `round-${state.mergeRound}-${agent.name}.txt`) ``
