# Final Merge — Staging Cleanup
{{VERIFICATION_CONTEXT}}
The upstream PR has been merged. Perform staging fork cleanup from `{{WORKTREE_PATH}}`.

1. Read the staging and upstream PR URLs:
```sh
STAGING_PR_URL=$(cat "{{STAGING_PR_FILE}}" 2>/dev/null)
STAGING_PR_NUM=$(echo "$STAGING_PR_URL" | grep -oP '\d+$')
UPSTREAM_PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
```

2. Set up upstream remote and detect default branch:
```sh
git remote add upstream https://github.com/{{PROJECT_REPO}}.git 2>/dev/null || true
git fetch upstream
UPSTREAM_DEFAULT=$(git remote show upstream | sed -n 's/.*HEAD branch: //p')
```

3. Sync staging fork's default branch from upstream:
```sh
git push origin upstream/$UPSTREAM_DEFAULT:$UPSTREAM_DEFAULT
```

4. Comment on the staging PR and close it:
```sh
gh pr comment "$STAGING_PR_NUM" --repo "{{STAGING_REPO}}" \
  --body "Merged upstream: $UPSTREAM_PR_URL — staging fork synced."
gh pr close "$STAGING_PR_NUM" --repo "{{STAGING_REPO}}"
```

5. Clean up feature branches on both remotes. Query the upstream PR's head ref
   to handle the branch-collision fallback case (where upstream branch may differ
   from local branch):
```sh
LOCAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
UPSTREAM_HEAD=$(gh pr view "$UPSTREAM_PR_URL" --json headRefName -q .headRefName 2>/dev/null)
git push origin --delete "$LOCAL_BRANCH" 2>/dev/null || true
if [ -n "$UPSTREAM_HEAD" ]; then
  git push upstream --delete "$UPSTREAM_HEAD" 2>/dev/null || true
else
  git push upstream --delete "$LOCAL_BRANCH" 2>/dev/null || true
fi
```

6. Create merged marker and signal completion:
```sh
touch "{{MERGED_MARKER_FILE}}"
printf '%s|%s|staging cleanup complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```

Do not write the merged marker until all cleanup steps succeed.
