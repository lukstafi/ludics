# PR Comments

Address reviewer feedback on the PR in `{{PR_FILE}}` from `{{WORKTREE_PATH}}`.

Fetch both top-level reviews and inline file comments:
```sh
PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
gh pr view "$PR_URL" {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--json reviews,comments --jq '.reviews,.comments'
gh api --paginate repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {path, line, body}'
```

For each actionable comment, make the change, commit, and push.

If `{{PR_FILE}}` is missing/blank, create the PR first and write the URL there.
If the PR is already merged, create `{{MERGED_MARKER_FILE}}`.

```sh
printf '%s|%s|pr comments handled\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
