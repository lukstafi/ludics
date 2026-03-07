# Final Merge

Prepare the final integration from `{{WORKTREE_PATH}}`.

- Rebase or merge onto the main branch as appropriate.
- Run the relevant checks.
- If the branch lands successfully, create `{{MERGED_MARKER_FILE}}`.

Then mark completion:

```sh
printf '%s|%s|final merge complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
