# Create PR (Coder)

The reviewer approved your implementation. Create a pull request from `{{WORKTREE_PATH}}`.

After creating the PR, write the URL to `{{PR_FILE}}`, then mark completion:

```sh
printf '%s|%s|pr created\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
