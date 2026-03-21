# Proposal: Orchestrated workflows run to completion

## Summary

Make pair/duo orchestration run autonomously through PR comments response, rebase onto main, and PR merge — instead of stopping at pr-comments and waiting indefinitely.

## Changes

### 1. PR comments response loop (`phases.ts`, `runner.ts`)

- In `pr-comments` phase, poll GitHub API for new comments since last dispatch
- When new comments found: reset `phaseDispatched`, re-dispatch coder to address them
- When no new comments within timeout: transition to `final-merge`
- Remove the `autoFinish` gate — `pr-comments` → `final-merge` is the default path

### 2. Final merge phase improvements (`final-merge.md`, `runner.ts`)

- Coder rebases feature branch onto main (`git rebase main`)
- If conflicts: resolve, force-push, retry merge
- Merge PR via `gh pr merge --merge --delete-branch`
- Create merged marker file on success
- Retry loop with max attempts (e.g., 3) to prevent infinite loops

### 3. PR file validation safety net (`runner.ts`)

After coder turn completes in `pr-create` or `work` phase, the runner checks the `pr` file:
- If it contains a valid URL (`https://...`): proceed normally
- If it contains markdown/text (agent wrote description instead of creating the PR): runner uses the content as PR body, runs `gh pr create --body <content>` from the worktree, writes the resulting URL back to the `pr` file
- This prevents workflows from stalling when agents fail to create the actual GitHub PR

### 4. Skill template updates

- `pr-comments.md`: Add instructions to check for new GitHub comments via `gh pr view`, address them, push fixes
- `final-merge.md`: Add rebase instructions, conflict resolution, `gh pr merge` command, retry guidance
- New `pair-coder-final-merge.md` for pair-specific instructions

### Files to modify

- `src/orchestration/phases.ts` — `evaluateTransition` for pr-comments → final-merge
- `src/orchestration/runner.ts` — PR comment polling, phaseDispatched reset logic
- `skills/orchestration/pr-comments.md` — GitHub comment checking instructions
- `skills/orchestration/final-merge.md` — rebase + merge instructions
- `skills/orchestration/pair-coder-final-merge.md` — new template
