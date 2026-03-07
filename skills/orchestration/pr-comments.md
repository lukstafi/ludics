# PR Comments

Monitor the PR tied to `{{PR_FILE}}` and address useful feedback in `{{WORKTREE_PATH}}`.

If the PR URL changes, update `{{PR_FILE}}`.
If the PR gets merged, create `{{MERGED_MARKER_FILE}}`.

When you have processed the current feedback batch:

```sh
printf '%s|%s|pr comments handled\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
