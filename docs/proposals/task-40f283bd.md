# Proposal: Make cleanupWorktrees resilient to missing git repos and spawn errors

**Task**: task-40f283bd
**Date**: 2026-04-04
**Effort**: small

## Goal

Make `maybeGit` in `src/orchestration/worktrees.ts` catch spawn-level exceptions (e.g., `ENOENT` when the `cwd` directory does not exist) in addition to non-zero exit codes. This prevents `cleanupWorktrees` and other callers from throwing when the underlying repo path has been partially deleted or is otherwise inaccessible.

## Acceptance Criteria

1. `maybeGit` returns `""` when `Bun.spawnSync` throws (same behavior as non-zero exit code).
2. `cleanupWorktrees` does not throw when called with a nonexistent `projectDir`.
3. `worktreeExists` returns `false` when called with a nonexistent `projectDir`.
4. `runGit` is not modified -- it intentionally throws on failure and callers depend on that.
5. A new test verifies that `cleanupWorktrees` with a nonexistent directory completes without error.

## Context

- `maybeGit` (line 26-35 in `worktrees.ts`) wraps `Bun.spawnSync` and returns `""` on non-zero exit, but does not catch thrown exceptions from the spawn call itself.
- `Bun.spawnSync` throws `ENOENT` when the `cwd` does not exist on disk.
- Call chain: `cleanupWorktrees` -> `removeIfRegistered` -> `worktreeExists` -> `maybeGit`. Any throw propagates up uncaught.
- `autoCommitWorktree` already has its own try/catch around `runGit`, so it is unaffected.

## Approach

Wrap the body of `maybeGit` in a try/catch block that returns `""` on any exception. This is a single-function, ~3-line change that aligns with the function's existing best-effort semantics (the name "maybe" signals fallibility). Add one test case for `cleanupWorktrees` with a nonexistent path.

### Files to change

| File | Change |
|------|--------|
| `src/orchestration/worktrees.ts` | Wrap `maybeGit` body in try/catch, return `""` on exception |
| `src/orchestration/worktrees.test.ts` | Add test: `cleanupWorktrees` with nonexistent `projectDir` does not throw |
