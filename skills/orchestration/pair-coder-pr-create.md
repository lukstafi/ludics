# Create PR (Coder)
{{VERIFICATION_CONTEXT}}{{#IF UPSTREAM_REPO}}
> **Upstream forwarding**: This project forwards approved PRs to upstream (`{{UPSTREAM_REPO}}`). Create the PR against the working repo, not upstream.
{{/IF}}
Push and create a PR from `{{WORKTREE_PATH}}`. Write just the bare PR URL to `{{PR_FILE}}`.

```sh
git push -u origin HEAD
gh pr create {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--title "<concise title>" --body "<description>" | tee "{{PR_FILE}}"
```

```sh
printf '%s|%s|pr created\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
