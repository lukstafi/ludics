# Final Merge

Merge the feature branch into main from `{{WORKTREE_PATH}}`.

Steps:
1. Ensure the branch is up to date and rebased onto main:
   ```sh
   git fetch origin
   git rebase origin/main
   ```
2. If rebase produces conflicts, resolve them, then:
   ```sh
   git add -A
   git rebase --continue
   ```
3. Force-push the rebased branch so the PR reflects the latest state:
   ```sh
   git push --force-with-lease
   ```
4. Run the project build and relevant tests to confirm the branch is green.
5. Merge the PR:
   ```sh
   gh pr merge --merge --delete-branch
   ```
6. After a successful merge, create the merged marker:
   ```sh
   touch "{{MERGED_MARKER_FILE}}"
   ```
7. If the merge fails (CI checks, conflicts, or rate limits), wait briefly and retry (up to 3 times).

Then mark completion:

```sh
printf '%s|%s|final merge complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
