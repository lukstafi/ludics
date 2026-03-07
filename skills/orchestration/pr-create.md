# Create PR

Create or refresh the pull request for your branch from `{{WORKTREE_PATH}}`.

After creating the PR, write the URL to `{{PR_FILE}}`, then mark completion:

```sh
printf '%s|%s|pr created\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
