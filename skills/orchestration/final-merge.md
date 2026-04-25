# Final Merge
{{VERIFICATION_CONTEXT}}
Merge the feature branch into main from `{{WORKTREE_PATH}}`.

Rebase onto `origin/main`, force-push with lease, verify the build is green, then merge:
```sh
PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
if gh pr merge "$PR_URL" {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--merge --delete-branch; then
  :
else
  # gh exits non-zero when local-side cleanup (worktree remove / branch -D)
  # fails even though the server-side merge landed. Re-check via gh pr view.
  state=$(gh pr view "$PR_URL" {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--json state -q .state)
  [ "$state" = "MERGED" ] || exit 1
fi
printf 'merged\n' > "{{MERGED_MARKER_FILE}}"
printf '%s|%s|final merge complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```

Retry up to 3 times on transient failures.
