# Proposal: Extract orchBranchName helper and add prefix guard to cleanupWorktrees

**Task**: task-56a5f480
**Date**: 2026-04-10

## Goal

Consolidate the duplicated orchestration branch naming convention (`ludics/<slug>-s<slot>/<suffix>`) into a single `orchBranchName()` helper, and add a path-prefix safety guard to `cleanupWorktrees()` to prevent removal of directories outside the expected worktree location.

## Acceptance Criteria

1. A new exported function `orchBranchName(taskId: string, slot: number | undefined, suffix: string): string` exists in `src/orchestration/worktrees.ts` and produces branch names in the form `ludics/<slugified-taskId>[-s<slot>]/<suffix>`.
2. `createWorktrees()` uses `orchBranchName()` instead of inline template literals for both root and agent branch names.
3. `buildCleanupEntry()` in `src/orchestration/deferred-cleanup.ts` uses `orchBranchName()` in its fallback branch derivation instead of inline slugify + concatenation.
4. `cleanupWorktrees()` validates that each computed worktree path starts with the expected prefix (`<parentDir>/<repoName>-<featureSlug>`) before calling `removeIfRegistered()`. If the path fails validation, a warning is logged and the removal is skipped.
5. All changes are behavior-preserving: the actual branch names and worktree paths produced are identical to the current implementation.
6. Existing tests continue to pass.

## Context

- Follow-up from task-cdc68aa1 retrospective.
- The branch naming formula `ludics/${featureSlug}${slotSuffix}/${suffix}` appears in `createWorktrees()` (worktrees.ts lines 138, 153) and in `buildCleanupEntry()` fallback (deferred-cleanup.ts lines 83-85).
- `cleanupWorktrees()` computes paths and calls `removeIfRegistered()` without validating the paths contain the expected feature slug, risking incorrect removal if slugify or state produces unexpected values.
- `deleteBranches()` already has a `ludics/` prefix guard (added by task-cdc68aa1), so no change is needed there.

## Approach

### 1. Add `orchBranchName()` helper

Export from `src/orchestration/worktrees.ts`:

```typescript
export function orchBranchName(taskId: string, slot: number | undefined, suffix: string): string {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  return `ludics/${featureSlug}${slotSuffix}/${suffix}`;
}
```

### 2. Update callers

- `createWorktrees()`: replace the inline `branches.root` assignment and the per-agent branch derivation with calls to `orchBranchName()`.
- `buildCleanupEntry()`: import `orchBranchName` and replace the fallback `rootBranch` derivation.

### 3. Add path-prefix guard to `cleanupWorktrees()`

Before each `removeIfRegistered()` call, verify the path starts with `join(parentDir, repoName + "-" + featureSlug)`. Log and skip on mismatch.

### Files changed

| File | Change |
|------|--------|
| `src/orchestration/worktrees.ts` | Add `orchBranchName()` export; update `createWorktrees()` to use it; add path guard to `cleanupWorktrees()` |
| `src/orchestration/deferred-cleanup.ts` | Import `orchBranchName`; replace inline fallback branch derivation in `buildCleanupEntry()` |
