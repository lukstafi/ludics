# Proposal: Automate staging-to-upstream PR forwarding

## Summary

When a project has `staging_repo` configured, the `final-merge` phase should forward the approved feature branch to the upstream repo (`repo` field) as a PR, instead of merging on the staging fork. This avoids divergent histories and extra merge commits. The change is a template-only update to `skills/orchestration/final-merge.md` -- no TypeScript changes needed.

## Motivation

Projects like OCANNL use a staging fork (`lukstafi/ocannl-staging`) for Codex reviewer access while the real upstream is `ahrefs/ocannl`. Currently, after a staging PR is approved, the maintainer must manually push the branch to upstream, create a PR there, merge it, then sync the fork. Merging on the staging fork instead creates divergent commit histories (different merge SHAs) that are painful to reconcile.

## Current state

### `final-merge.md` template (14 lines)

The current template is minimal: rebase onto `origin/main`, force-push with lease, `gh pr merge --merge --delete-branch`, create the merged marker file. It has no awareness of staging repos.

### Template variables already available

- `{{STAGING_REPO}}` -- the staging fork repo (e.g., `lukstafi/ocannl-staging`), empty string when no staging configured (injected at `skills.ts` line 282)
- `{{PROJECT_REPO}}` -- the upstream repo (e.g., `ahrefs/ocannl`), auto-injected from the `repo` config field via the `PROJECT_<FIELD>` loop at `skills.ts` lines 291-296
- `{{MERGED_MARKER_FILE}}`, `{{PR_FILE}}`, `{{STATUS_FILE}}`, `{{WORKTREE_PATH}}` -- all standard orchestration variables

### Phase transition

`final-merge` transitions to `suggest-refactor` on completion (checked via merged marker file existence). This transition is unchanged by this proposal.

## Plan

### Single file change: `skills/orchestration/final-merge.md`

Replace the current unconditional merge flow with a conditional template. The agent reads `{{STAGING_REPO}}` to decide which path to take.

#### When `{{STAGING_REPO}}` is empty (non-staging projects)

Keep the existing behavior exactly: rebase, force-push, `gh pr merge`, create marker.

#### When `{{STAGING_REPO}}` is non-empty (staging projects)

The agent executes the following steps from `{{WORKTREE_PATH}}`:

1. **Add upstream remote** (idempotent):
   ```sh
   git remote add upstream https://github.com/{{PROJECT_REPO}}.git 2>/dev/null || true
   ```

2. **Detect upstream default branch**:
   ```sh
   UPSTREAM_DEFAULT=$(git remote show upstream | sed -n 's/.*HEAD branch: //p')
   ```

3. **Rebase onto upstream**:
   ```sh
   git fetch upstream
   git rebase upstream/$UPSTREAM_DEFAULT
   ```
   If conflicts arise, the agent resolves them (file-by-file inspection and fixes), then `git rebase --continue`. If unresolvable, report failure via status file and stop.

4. **Force-push rebased branch to staging fork** (so the staging PR reflects the rebased state):
   ```sh
   git push --force-with-lease origin HEAD
   ```

5. **Push branch to upstream**:
   ```sh
   git push upstream HEAD
   ```

6. **Create upstream PR**:
   ```sh
   gh pr create --repo {{PROJECT_REPO}} --title "<same title>" --body "<same body>" --head <branch>
   ```
   Write the upstream PR URL to `{{PR_FILE}}` (overwriting the staging PR URL).

7. **Comment on staging PR** linking to the upstream PR:
   ```sh
   gh pr comment <staging-pr-number> --repo {{STAGING_REPO}} --body "Forwarded to upstream: <upstream-pr-url>"
   ```

8. **Create merged marker** (`{{MERGED_MARKER_FILE}}`). The staging PR is NOT merged -- it will be closed manually or by a future sync step after upstream merges.

9. **Signal completion** via status file.

### What about `pr-comments` monitoring?

Since step 6 overwrites `{{PR_FILE}}` with the upstream PR URL, any subsequent `pr-comments` phase invocation will automatically monitor the upstream PR. No template or code change needed.

### What about syncing the staging fork after upstream merge?

This is explicitly out of scope for the MVP. The upstream PR is created and handed to the maintainer. After upstream merge, the staging fork can be synced manually (`git fetch upstream && git push origin upstream/main:main`) or via GitHub's "Sync fork" button. A future enhancement could add a post-merge trigger.

## Edge cases

1. **Rebase conflicts**: The template instructs the agent to resolve conflicts. The orchestration timeout (from runner.ts) handles truly unresolvable cases -- the agent writes a failure status.

2. **Upstream branch protection**: The template does NOT attempt to merge the upstream PR. It only creates the PR and lets the maintainer handle review/merge. This is correct for repos like `ahrefs/ocannl` where the contributor may not have merge permissions.

3. **Authentication**: `gh` CLI and `git push` must be authenticated for the upstream repo. This is a prerequisite (the user already has push access to `ahrefs/ocannl`). Not something the template can fix -- it will fail visibly if credentials are missing.

4. **Race condition**: If someone else pushes to upstream between the rebase and the PR creation, GitHub will show the PR as having conflicts. This is the normal GitHub PR flow and is handled by the maintainer or a subsequent rebase.

5. **Branch name collision on upstream**: If a branch with the same name already exists on upstream, `git push upstream HEAD` will fail. The agent should detect this and use a prefixed branch name (e.g., `staging/<original-name>`). This edge case should be documented in the template.

## Files to modify

| File | Change |
|------|--------|
| `skills/orchestration/final-merge.md` | Replace with staging-aware conditional template |

## Scope boundaries

- **In scope**: Template update for staging-aware final-merge flow
- **Out of scope**: TypeScript phase logic changes, new phases, post-merge fork sync automation, pair-mode specific template (not needed since final-merge is coder-only)
- **Future work**: Automatic staging fork sync after upstream merge (trigger or webhook)
