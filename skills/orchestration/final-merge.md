# Final Merge

Merge the feature branch into main from `{{WORKTREE_PATH}}`.

Rebase onto `origin/main`, force-push with lease, verify the build is green, then merge:
```sh
gh pr merge --merge --delete-branch
```

On success, create `{{MERGED_MARKER_FILE}}`. Retry up to 3 times on transient failures.

```sh
printf '%s|%s|final merge complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
