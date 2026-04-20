# PR Conflict Resolution

Your PR in `{{PR_FILE}}` has merge conflicts with the base branch. From `{{WORKTREE_PATH}}`:

1. Fetch latest changes:
   ```sh
   git fetch origin
   ```

2. Determine the PR's base branch and rebase onto it:
   ```sh
   BASE=$(gh pr view --json baseRefName -q .baseRefName)
   git rebase "origin/$BASE"
   ```
   Resolve each conflict — keep your changes where they're correct, take upstream where that makes more sense.

3. Force-push with lease:
   ```sh
   git push --force-with-lease
   ```

4. Verify the PR is now conflict-free:
   ```sh
   gh pr view --json mergeable
   ```

If new conflicts appear after rebasing (e.g., from concurrent upstream merges), repeat the rebase cycle until the PR is clean.

While you're here, check for pending reviewer comments:
```sh
gh pr view --json reviews,comments --jq '.reviews,.comments'
gh api --paginate repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {path, line, body}'
```

```sh
printf '%s|%s|conflict resolution done\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
