# Create PR
{{STAGING_REPO_NOTE}}
Push and create a PR from `{{WORKTREE_PATH}}`. Write **only the bare PR URL** to `{{PR_FILE}}`.

```sh
git push -u origin HEAD
gh pr create --title "<concise title>" --body "<description>" | tee "{{PR_FILE}}"
```

```sh
printf '%s|%s|pr created\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
