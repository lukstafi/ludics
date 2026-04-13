# Proposal: Extract orchWorktreeStem, add tests, and guard removeWorktreeByPath

**Task:** task-0b450faa
**Date:** 2026-04-13

## Goal

Deduplicate the worktree stem pattern, add unit tests for branch naming, and add a safety guard to `removeWorktreeByPath`.

## Acceptance Criteria

1. `orchWorktreeStem(repoName, featureSlug, slotSuffix)` extracted and used in both `createWorktrees()` and `cleanupWorktrees()`.
2. Unit tests for `orchBranchName()` covering slug edge cases (special chars, long names, slot/no-slot).
3. `removeWorktreeByPath()` validates the path contains a ludics task slug pattern before removing.
4. `bun run build` succeeds, all tests pass.

## Context

### Duplicated stem pattern

`createWorktrees()` (line 141): `const stem = \`${repoName}-${featureSlug}${slotSuffix}\`;`
`cleanupWorktrees()` (line 226): `const stem = \`${repoName}-${featureSlug}${slotSuffix}\`;`

Identical computation — extract to shared helper.

### orchBranchName already extracted

`orchBranchName(taskId, slot, suffix)` exists at line 122-127, returns `ludics/${featureSlug}${slotSuffix}/${suffix}`. Has no unit tests.

### removeWorktreeByPath unguarded

`removeWorktreeByPath()` (line 77-79) calls `removeIfRegistered()` with no path validation. `deleteBranches()` (line 84-96) has a `ludics/` prefix guard. Analogous guard needed for worktree paths.

## Approach

### 1. Extract orchWorktreeStem (worktrees.ts)

```typescript
export function orchWorktreeStem(repoName: string, taskId: string, slot?: number): string {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  return `${repoName}-${featureSlug}${slotSuffix}`;
}
```

Replace in `createWorktrees()` (line 141) and `cleanupWorktrees()` (line 226).

### 2. Add unit tests (worktrees.test.ts)

Test `orchBranchName()`:
- Standard case: `orchBranchName("task-abc", 2, "root")` → `"ludics/task-abc-s2/root"`
- No slot: `orchBranchName("task-abc", undefined, "coder")` → `"ludics/task-abc/coder"`
- GitHub issue ID: `orchBranchName("gh-ludics-42", 1, "reviewer")` → expected slug

Test `orchWorktreeStem()`:
- Standard case with slot
- Without slot

### 3. Guard removeWorktreeByPath (worktrees.ts:77-79)

```typescript
export function removeWorktreeByPath(projectDir: string, path: string): void {
  const repoName = basename(resolve(projectDir));
  if (!basename(path).startsWith(repoName + "-")) {
    console.error(`ludics: refusing to remove worktree "${path}" — does not match expected naming`);
    return;
  }
  removeIfRegistered(projectDir, path);
}
```

### Files to modify

- `src/orchestration/worktrees.ts` — extract `orchWorktreeStem`, add guard to `removeWorktreeByPath`
- `src/orchestration/worktrees.test.ts` — new file (or add to existing) with unit tests
