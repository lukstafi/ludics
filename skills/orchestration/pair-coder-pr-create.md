# Create PR (Coder)

The reviewer approved your implementation. Create a GitHub pull request from `{{WORKTREE_PATH}}`.

Steps:
1. Push the branch if not already pushed:
   ```sh
   git push -u origin HEAD
   ```
2. Create the pull request:
   ```sh
   gh pr create --title "<concise title>" --body "<description>"
   ```
3. Write **only the PR URL** (e.g. `https://github.com/owner/repo/pull/42`) to `{{PR_FILE}}`.
   Do **not** write a markdown description or any other text to this file — just the bare URL.

After writing the URL, mark completion:

```sh
printf '%s|%s|pr created\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
