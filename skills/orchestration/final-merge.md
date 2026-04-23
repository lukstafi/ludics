# Final Merge
{{VERIFICATION_CONTEXT}}
Merge the feature branch into main from `{{WORKTREE_PATH}}`.

Rebase onto `origin/main`, force-push with lease, verify the build is green, then merge:
```sh
PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
gh pr merge "$PR_URL" {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--merge --delete-branch
```

On success, create `{{MERGED_MARKER_FILE}}`. Retry up to 3 times on transient failures.

```sh
printf '%s|%s|final merge complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
