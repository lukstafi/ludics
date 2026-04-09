# Proposal: Persist root branch in OrchestrationState and add prefix guard to deleteBranches

**Task**: task-cdc68aa1
**Project**: ludics
**Date**: 2026-04-09

## Goal

Eliminate fragile branch-name derivation duplication between `createWorktrees()` and `buildCleanupEntry()` by persisting the concrete `branches` map in `OrchestrationState`. Add a safety prefix guard to `deleteBranches()` preventing deletion of protected branches (e.g. `main`, `master`) if state corruption occurs.

## Acceptance Criteria

- `OrchestrationState` interface includes an optional `branches?: Record<string, string>` field
- Adapter init functions (tmux-adapter, t3code) persist `setup.branches` into `state.branches` after `createWorktrees()` returns
- `buildCleanupEntry()` reads `orchState.branches` for the branch list when present; falls back to current naming-convention derivation when the field is missing (backward compat with old persisted state)
- `deleteBranches()` validates every branch name starts with `ludics/` before executing `git branch -D` and `git push origin --delete`; branches failing the check are logged as warnings and skipped
- No branch named `main`, `master`, or any non-`ludics/` prefixed name can be deleted through the cleanup path
- Existing deferred-cleanup and worktree tests pass without regression

## Context

**Origin**: Auto-generated from retrospective of `gh-ludics-153`. The root branch naming convention `ludics/<slug>-s<slot>/root` is currently duplicated:

1. `src/orchestration/worktrees.ts` line 132 — `createWorktrees()` constructs and returns it in `setup.branches`
2. `src/orchestration/deferred-cleanup.ts` line 73 — `buildCleanupEntry()` re-derives the same name from `taskId` + `slot`

If the convention changes in one place but not the other, cleanup deletes wrong branches. Additionally, `deleteBranches()` has no guard against corrupted branch lists pointing at protected names.

**Key files**:
- `src/orchestration/state.ts` — `OrchestrationState` interface (add field)
- `src/orchestration/worktrees.ts` — `createWorktrees()`, `deleteBranches()` (prefix guard)
- `src/orchestration/deferred-cleanup.ts` — `buildCleanupEntry()` (read from state)
- `src/adapters/tmux-adapter.ts` — persist branches at init
- `src/adapters/t3code.ts` — persist branches at init

## Approach

### 1. Add `branches` field to `OrchestrationState` (state.ts)

Add `branches?: Record<string, string>` to the interface. The field is optional for backward compatibility with already-persisted state files that lack it.

### 2. Persist branches in adapter init (tmux-adapter.ts, t3code.ts)

After `createWorktrees()` returns a `WorktreeSetup`, assign `state.branches = setup.branches` before calling `persistState()`. Both adapters follow this pattern.

### 3. Read persisted branches in `buildCleanupEntry()` (deferred-cleanup.ts)

Replace the naming-convention derivation block with a read from `orchState.branches` when present. Collect all unique branch values from the record. Retain the current derivation as a fallback path when `orchState.branches` is undefined (migration window for old state).

### 4. Add prefix guard to `deleteBranches()` (worktrees.ts)

Before the deletion loop, filter branches to only those matching the `ludics/` prefix. For each skipped branch, emit a `console.error` warning identifying the branch and the reason it was skipped. This is a pure safety net — under normal operation all branches will pass.
