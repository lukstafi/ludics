# Proposal: Detect PR merge conflicts and prompt coder to rebase and resolve

**Task:** task-fecf65ee
**Project:** ludics
**Date:** 2026-04-03

## Goal

During the `pr-comments` phase, detect when a PR enters `dirty` mergeable state (merge conflicts) and automatically dispatch the coder to rebase and resolve conflicts. This prevents PRs from silently stalling until the quiet period expires and then failing at `final-merge`.

## Acceptance Criteria

1. When a PR's `mergeable_state` transitions to `"dirty"` during `pr-comments`, the runner dispatches the coder with a conflict-resolution prompt within the next poll cycle (after existing agents finish their current turn).
2. The conflict dispatch uses a dedicated `pr-conflict-resolve.md` skill template that instructs the agent to rebase onto `origin/main`, resolve conflicts, and force-push with lease.
3. Normal PR comment/review handling continues to work alongside conflict detection -- conflict resolution is an additional dispatch trigger, not a replacement.
4. The dispatch is edge-triggered: it fires only on transition from non-dirty to `dirty`. If the PR remains `dirty` across consecutive polls (e.g., coder is still resolving), no redundant dispatch is sent.
5. The `mergeable_state` value `"unknown"` is treated as indeterminate and never triggers a conflict dispatch.
6. The `"behind"` state does NOT trigger a rebase -- only `"dirty"` (actual conflicts).

## Context

### Current behavior

- `checkAndRedispatchPrComments()` in `src/orchestration/runner.ts` (line 565) polls GitHub for new PR comments and merged status, but never checks `mergeable_state`.
- `getPrVerification()` in `src/orchestration/github.ts` (line 164) already queries the GitHub API for `mergeable_state` alongside `state` and `merged`.
- A conflicting PR sits idle until the quiet period or phase timeout advances it to `final-merge`, where it fails.
- `verifyFinalMergeOutcome()` logs `mergeableState` in failure details but takes no conflict-specific action.

### Related tasks

- **task-d3fd6d80** (done): Added the `final-merge` phase with rebase and merge instructions.
- **task-5eb4ecd7** (done): Added `verifyFinalMergeOutcome()` which checks `mergeableState` post-merge.

### Key code locations

| File | Function/Section | Relevance |
|------|-----------------|-----------|
| `src/orchestration/runner.ts` | `checkAndRedispatchPrComments()` (L565) | Main insertion point for conflict detection |
| `src/orchestration/runner.ts` | `redispatchForPrComments()` (L522) | Re-dispatch mechanism to reuse |
| `src/orchestration/github.ts` | `getPrVerification()` (L164) | Already returns `mergeableState` |
| `src/orchestration/skills.ts` | `resolveTemplatePath()` (L161) | Template resolution -- new template auto-discovered |
| `src/orchestration/skills.ts` | `buildSkillContext()` (L187) | Template variable substitution |
| `src/orchestration/state.ts` | `OrchestrationState` (L106) | State type -- needs new field |
| `skills/orchestration/pr-comments.md` | -- | Existing PR comments template (unchanged) |
| `skills/orchestration/final-merge.md` | -- | Has rebase instructions to reference |

## Approach

### 1. Add conflict state tracking to `OrchestrationState`

Add a new field to `OrchestrationState` in `src/orchestration/state.ts`:

```typescript
/** Per-agent last-observed mergeable_state, for edge-triggered conflict detection. */
prMergeableStates?: Record<string, string>;
```

This tracks the last-known `mergeable_state` per agent (keyed by agent name). The conflict dispatch fires only when this value transitions from anything other than `"dirty"` to `"dirty"`.

### 2. Add conflict detection to `checkAndRedispatchPrComments()`

Insert a conflict-detection block in `checkAndRedispatchPrComments()` after the `allDone` guard (after line 654) and before the comment count poll (line 691). The block:

1. Iterates over `agentsWithPr`.
2. Calls `getPrVerification(prUrl)` for each agent's PR.
3. Compares the returned `mergeableState` against `state.prMergeableStates[agent.name]`.
4. If the state transitions to `"dirty"` (previous was not `"dirty"` or was absent), sets a flag to trigger conflict re-dispatch.
5. Updates `state.prMergeableStates[agent.name]` with the current value (skipping `"unknown"`).
6. If any PR transitioned to `"dirty"`, calls a new `redispatchForConflictResolution()` function.

Note: The `allDone` guard at line 653-654 already ensures agents have finished their current turn before any re-dispatch, preventing mid-turn interruption.

### 3. Create `redispatchForConflictResolution()`

A new function similar to `redispatchForPrComments()` (line 522) that:

- Sets `state.phaseRetryContext` to a conflict-specific message (e.g., "PR has merge conflicts (mergeable_state: dirty)") so the `VERIFICATION_CONTEXT` template variable carries the context.
- Temporarily overrides the phase to use the conflict template, OR uses a separate dispatch path that selects `pr-conflict-resolve.md`.

The simplest approach: introduce an optional `templateOverride` parameter to `redispatchForPrComments()` (or a new wrapper) that passes through to `composeSkillMessage()`. Alternatively, since `resolveTemplatePath()` uses file existence checks with priority ordering, we can set a transient flag on the state that `composeSkillMessage` checks to select the conflict template.

Recommended: Add an optional `conflictRedispatch` boolean to the state. In `composeSkillMessage()`, when `phase === "pr-comments"` and `conflictRedispatch` is true, resolve to `pr-conflict-resolve.md` instead of `pr-comments.md`. Clear the flag after dispatch.

### 4. Create `skills/orchestration/pr-conflict-resolve.md` template

A new template file:

```markdown
# Resolve PR Merge Conflicts

Your PR in `{{PR_FILE}}` from `{{WORKTREE_PATH}}` has merge conflicts.

Rebase onto `origin/main`, resolve all conflicts, and force-push with lease:
```sh
git fetch origin main
git rebase origin/main
# resolve any conflicts
git rebase --continue
git push --force-with-lease
```

After resolving, verify the build is still green. Also address any pending review comments.

```sh
printf '%s|%s|conflict resolution complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
```

The `DONE_STATUS` will be `pr-comments-done` (same as the regular pr-comments phase), so the existing lifecycle and phase transition logic works unchanged.

### 5. Reset conflict state on phase entry

When entering `pr-comments` phase, initialize `state.prMergeableStates = {}` so that the first observation of `"dirty"` triggers a dispatch. This happens in the phase transition logic in the runner's main loop.

### Summary of changes

| File | Change |
|------|--------|
| `src/orchestration/state.ts` | Add `prMergeableStates?` and `conflictRedispatch?` fields |
| `src/orchestration/runner.ts` | Add conflict detection block in `checkAndRedispatchPrComments()` |
| `src/orchestration/runner.ts` | Add `redispatchForConflictResolution()` or extend `redispatchForPrComments()` |
| `src/orchestration/skills.ts` | Handle `conflictRedispatch` flag in `composeSkillMessage()` |
| `skills/orchestration/pr-conflict-resolve.md` | New template |
