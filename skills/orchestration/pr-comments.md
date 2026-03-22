# PR Comments

Monitor the GitHub PR linked in `{{PR_FILE}}` and address any reviewer feedback in `{{WORKTREE_PATH}}`.

Steps:
1. Read the PR URL from `{{PR_FILE}}`.
2. Fetch all review feedback — both top-level reviews AND inline file comments:
   ```sh
   # Top-level reviews and PR comments
   gh pr view --json reviews,comments --jq '.reviews,.comments'
   # Inline file-level review comments (these are on a separate API endpoint)
   gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {path, line, body}'
   ```
   Extract the owner/repo/number from the PR URL.
3. For each actionable comment (top-level or inline), make the requested change, commit, and push.
4. If no PR URL exists in `{{PR_FILE}}` yet (file missing or blank), create the PR first:
   ```sh
   gh pr create --title "<title>" --body "<description>"
   ```
   Then write the resulting URL to `{{PR_FILE}}`.
5. If the PR URL in `{{PR_FILE}}` looks like a markdown description instead of a URL
   (i.e. does not start with `https://github.com`), create the PR using that text as the body,
   then overwrite `{{PR_FILE}}` with the URL only.
6. If the PR has already been merged, create `{{MERGED_MARKER_FILE}}`.

When you have addressed the current batch of comments (or confirmed there are none):

```sh
printf '%s|%s|pr comments handled\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```

The orchestrator will re-dispatch you if new comments appear.
