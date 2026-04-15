# Fix PR Targeting for upstream_repo Projects

## Goal

Ensure all `gh pr create` invocations in orchestration target the correct repository (`PROJECT_REPO` / staging repo) rather than being misdirected to the upstream repo by git's `gh-resolved` config marker.

## Acceptance Criteria

- [ ] `gh pr create` in `pr-create.md` and `pair-coder-pr-create.md` templates includes `--repo "{{PROJECT_REPO}}"` so PRs always target the working/staging repo regardless of `gh-resolved` git config state
- [ ] `validateAndFixPrFile()` in `src/orchestration/github.ts` accepts a `repo` parameter and passes `--repo` to the `gh pr create` fallback command
- [ ] `validateAgentPrFiles()` in `src/orchestration/runner.ts` resolves the project repo slug (via `findProjectConfig(state.projectDir)`) and passes it to `validateAndFixPrFile()`
- [ ] After `git remote add upstream` in `forward-pr.md` and `upstream-final-merge.md`, the templates include `git config --unset remote.upstream.gh-resolved 2>/dev/null || true` to prevent the `gh-resolved` marker from poisoning the git config
- [ ] Existing tests in `runner.test.ts` for `validateAgentPrFiles` are updated to pass the new `repo` parameter via the mock
- [ ] New unit test verifies that `validateAndFixPrFile()` passes `--repo` when a repo argument is provided
- [ ] `bun test` passes with no regressions

## Context

### Root Cause

When a git repository has an `upstream` remote, the `gh` CLI may set `remote.upstream.gh-resolved = base` in the git config. This tells `gh` to use the upstream remote as the base repository for all PR operations, overriding the `origin` remote. For projects with `upstream_repo` configured (e.g., OCANNL where `repo: lukstafi/ocannl-staging` and `upstream_repo: ahrefs/ocannl`), this causes `gh pr create` to file PRs against the upstream instead of the staging repo.

Since all worktrees share `.git/config` with the parent repository, a single poisoned config affects every worktree and every orchestration slot working on that project. This is what caused all 5 OCANNL slots to get stuck at `pr-comments` -- the PRs were filed against `ahrefs/ocannl` where the Codex connector is not configured.

### Affected Code Paths

1. **`skills/orchestration/pr-create.md` (line 7)** -- Template for `gh pr create` lacks `--repo` flag
2. **`skills/orchestration/pair-coder-pr-create.md` (line 7)** -- Same template, same issue
3. **`src/orchestration/github.ts` `validateAndFixPrFile()` (line 122-125)** -- Fallback auto-creator lacks `--repo` flag
4. **`skills/orchestration/forward-pr.md` (line 25)** -- Adds `upstream` remote without clearing `gh-resolved`
5. **`skills/orchestration/upstream-final-merge.md` (line 14)** -- Same upstream remote addition without clearing `gh-resolved`

### Code Paths Already Correct

- `forward-pr.md` explicitly uses `--repo "{{UPSTREAM_REPO}}"` and `--repo "{{PROJECT_REPO}}"` for its own `gh pr` commands (but not for the initial `pr-create` phase that precedes it)
- `upstream-final-merge.md` explicitly uses `--repo "{{PROJECT_REPO}}"` for its cleanup commands
- All GitHub API query functions in `github.ts` (`isPrMerged`, `fetchNewPrCommentCount`, `getPrVerification`) extract the repo from the PR URL, so they work correctly

## Approach

Three-layer fix: templates, auto-repair code, and defense-in-depth.

### Layer 1: Template Fix (primary)

In `skills/orchestration/pr-create.md` and `skills/orchestration/pair-coder-pr-create.md`, change:

```
gh pr create --title "<concise title>" --body "<description>" | tee "{{PR_FILE}}"
```

to:

```
gh pr create --repo "{{PROJECT_REPO}}" --title "<concise title>" --body "<description>" | tee "{{PR_FILE}}"
```

`PROJECT_REPO` is already available in templates via the auto-injection of project config fields at `src/orchestration/skills.ts:286-294`. The auto-injection iterates over the project config entry and creates `PROJECT_<FIELD>` variables for all string fields. For OCANNL, this resolves to `PROJECT_REPO = lukstafi/ocannl-staging`.

### Layer 2: Code Fix (auto-repair path)

In `src/orchestration/github.ts`, add an optional `repo?: string` parameter to `validateAndFixPrFile()`. When provided, include `--repo` in the `gh pr create` invocation:

```ts
export function validateAndFixPrFile(
  prFile: string,
  worktreePath: string,
  branch: string,
  repo?: string,
): string | null {
  // ... existing logic ...
  const args = ["gh", "pr", "create", "--title", title, "--body", content, "--head", branch];
  if (repo) args.splice(2, 0, "--repo", repo);
  const result = safeSyncOutput(args, { cwd: worktreePath });
  // ...
}
```

In `src/orchestration/runner.ts` `validateAgentPrFiles()`, resolve the repo from the project config and pass it through:

```ts
import { findProjectConfig } from "../config.ts";

export function validateAgentPrFiles(state: OrchestrationState): void {
  const projectRepo = findProjectConfig(state.projectDir)?.repo;
  // ... pass projectRepo to validateAndFixPrFile() calls ...
}
```

### Layer 3: Defense-in-Depth (prevent poisoning)

In `skills/orchestration/forward-pr.md` and `skills/orchestration/upstream-final-merge.md`, after the `git remote add upstream` line, add:

```sh
git config --unset remote.upstream.gh-resolved 2>/dev/null || true
```

This prevents `gh` from setting or preserving the `gh-resolved = base` marker on the upstream remote, which is the root cause of the misdirection.
