# Proposal: Drop redundant pathspec excludes from autoCommitWorktree

**Task:** task-52fd8f03
**Project:** ludics
**Effort:** small

## Goal

Fix a latent bug where `git add -A -- . :(exclude)pattern` fails with exit code 1 when the same pattern already appears in `.git/info/exclude` and the excluded directory physically exists in the worktree. This affects all entries in `GIT_EXCLUDE_ENTRIES`. The fix removes the redundant `ORCHESTRATION_EXCLUDES` pathspec mechanism from `autoCommitWorktree()`, relying solely on `.git/info/exclude` (already guaranteed by `ensureGitExcludes()` during orchestration setup).

## Acceptance Criteria

1. **`ORCHESTRATION_EXCLUDES` constant removed** from `src/orchestration/worktrees.ts` (currently lines 285-290).
2. **`autoCommitWorktree()` simplified** to use plain `git status --porcelain` and `git add -A` without pathspec exclusions.
3. **All existing tests pass** after the change, with necessary test setup adjustments.
4. **Tests that create excluded directories still verify exclusion works** -- via `.git/info/exclude` instead of pathspec args.
5. **JSDoc on `autoCommitWorktree()`** documents the dependency on `ensureGitExcludes()` having been called.
6. **No regression**: orchestration auto-commits in production continue to exclude `.peer-sync`, `.ludics-orchestration.json`, `.claude`, `.agents`, `.agent-sessions`, `node_modules`, and `_build_review*` directories.

## Context

### Code pointers

| What | File | Lines |
|------|------|-------|
| `GIT_EXCLUDE_ENTRIES` | `src/orchestration/worktrees.ts` | 24-32 |
| `ensureGitExcludes()` | `src/orchestration/worktrees.ts` | 42-63 |
| `ORCHESTRATION_EXCLUDES` (to remove) | `src/orchestration/worktrees.ts` | 285-290 |
| `autoCommitWorktree()` | `src/orchestration/worktrees.ts` | 308-333 |
| Only production call site | `src/orchestration/runner.ts` | 1113 |
| Test: excludes .peer-sync | `src/orchestration/worktrees.test.ts` | 122-132 |
| Test: excludes .ludics-orchestration.json | `src/orchestration/worktrees.test.ts` | 134-143 |
| Test: excludes .claude/ | `src/orchestration/worktrees.test.ts` | 145-155 |
| Test: mixed real + orchestration files | `src/orchestration/worktrees.test.ts` | 157-181 |
| Test: ignores .agents and node_modules | `src/orchestration/worktrees.test.ts` | 205-220 |
| Test: excludes _build_review* dirs | `src/orchestration/worktrees.test.ts` | 222-247 |

### Root cause

`autoCommitWorktree()` uses `ORCHESTRATION_EXCLUDES` to pass `:(exclude)pattern` pathspec arguments alongside `git add -A -- .`. When `.git/info/exclude` already contains the same pattern (written by `ensureGitExcludes()`) and the excluded directory exists, git considers the pathspec exclude redundant/conflicting and exits with code 1. This was discovered during task-537987ee when `_build_review*` was added to `GIT_EXCLUDE_ENTRIES`.

### Safety analysis

Only one production call site exists: `runner.ts` line 1113, which runs within orchestration where `createWorktrees()` has already called `ensureGitExcludes()` on all worktrees. No external callers exist.

## Approach

### Step 1: Remove `ORCHESTRATION_EXCLUDES` constant

Delete lines 285-290 in `src/orchestration/worktrees.ts`:

```typescript
// DELETE:
/** Pathspec exclusions derived from {@link GIT_EXCLUDE_ENTRIES} for autoCommitWorktree. */
const ORCHESTRATION_EXCLUDES = GIT_EXCLUDE_ENTRIES.flatMap((e) =>
  /[*?[]/.test(e)
    ? [`:(exclude)${e}`, `:(exclude)**/${e}`]
    : [`:!${e}`],
);
```

### Step 2: Simplify `autoCommitWorktree()`

Replace the two git commands that spread `ORCHESTRATION_EXCLUDES`:

```typescript
// Before:
runGit(worktreePath, ["status", "--porcelain", "--", ".", ...ORCHESTRATION_EXCLUDES]);
runGit(worktreePath, ["add", "-A", "--", ".", ...ORCHESTRATION_EXCLUDES]);

// After:
runGit(worktreePath, ["status", "--porcelain"]);
runGit(worktreePath, ["add", "-A"]);
```

### Step 3: Update JSDoc

Update the `autoCommitWorktree()` doc comment to note:

```typescript
/**
 * Auto-commit any uncommitted changes in the given directory.
 * Relies on {@link ensureGitExcludes} having been called to set up
 * `.git/info/exclude` with orchestration-internal paths.
 * Returns a structured result. Safe to call on clean worktrees (no-op).
 */
```

### Step 4: Add `ensureGitExcludes(repo)` to tests that need it

The following tests currently rely on `ORCHESTRATION_EXCLUDES` pathspecs for exclusion and need `ensureGitExcludes(repo)` added after `initRepo(repo)`:

- "excludes .peer-sync from staging and dirty check" (line 122)
- "excludes .ludics-orchestration.json from staging" (line 134)
- "excludes .claude/ from staging" (line 145)
- "commits real files while excluding orchestration files" (line 157)
- "excludes _build_review* dirs while committing real changes" (line 222)

The test "ignores .agents and node_modules" (line 205) already calls `ensureGitExcludes(repo)` and needs no change.

### Step 5: Update test description string

The test at line 205 references `ORCHESTRATION_EXCLUDES` in its description. Update the description to reflect the new mechanism (e.g., "ignores .agents and node_modules via .git/info/exclude").

### Verification

Run the test suite: `bun test src/orchestration/worktrees.test.ts`
