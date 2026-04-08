# Forward PR to Upstream

Forward the approved working repo PR to the upstream repo from `{{WORKTREE_PATH}}`.

## Steps

1. Read the working repo PR URL. On retry, `{{UPSTREAM_PR_FILE}}` may already exist from
   a previous failed attempt while `{{PR_FILE}}` may have been overwritten with the
   upstream URL. Always prefer `{{UPSTREAM_PR_FILE}}` when it exists:
```sh
if [ -f "{{UPSTREAM_PR_FILE}}" ]; then
  WORKING_PR_URL=$(cat "{{UPSTREAM_PR_FILE}}")
else
  WORKING_PR_URL=$(cat "{{PR_FILE}}")
  echo "$WORKING_PR_URL" > "{{UPSTREAM_PR_FILE}}"
fi
WORKING_PR_NUM=$(echo "$WORKING_PR_URL" | grep -oP '\d+$')
WORKING_PR_TITLE=$(gh pr view "$WORKING_PR_NUM" --repo "{{PROJECT_REPO}}" --json title -q .title)
WORKING_PR_BODY=$(gh pr view "$WORKING_PR_NUM" --repo "{{PROJECT_REPO}}" --json body -q .body)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

2. Set up upstream remote and detect default branch:
```sh
git remote add upstream https://github.com/{{UPSTREAM_REPO}}.git 2>/dev/null || true
git fetch upstream
UPSTREAM_DEFAULT=$(git remote show upstream | sed -n 's/.*HEAD branch: //p')
```

3. Rebase onto upstream:
```sh
git rebase upstream/$UPSTREAM_DEFAULT
```
If conflicts occur, resolve them file by file, then `git rebase --continue`.
If truly unresolvable, write a failure status and stop — do NOT write done status,
do NOT modify `{{PR_FILE}}`, do NOT create `{{FORWARDED_MARKER_FILE}}`.

4. Force-push rebased branch to working repo:
```sh
git push --force-with-lease origin HEAD
```

5. Push branch to upstream:
```sh
UPSTREAM_HEAD=$BRANCH
git push upstream HEAD:$UPSTREAM_HEAD
```
If this fails due to a branch name collision, use a prefixed name:
```sh
UPSTREAM_HEAD=forwarded/$BRANCH
git push upstream HEAD:$UPSTREAM_HEAD
```

6. Create upstream PR (or reuse if one already exists for the branch):
```sh
EXISTING_PR=$(gh pr list --repo "{{UPSTREAM_REPO}}" --head "$UPSTREAM_HEAD" --json url -q '.[0].url' 2>/dev/null)
if [ -n "$EXISTING_PR" ]; then
  UPSTREAM_PR_URL="$EXISTING_PR"
else
  UPSTREAM_PR_URL=$(gh pr create --repo "{{UPSTREAM_REPO}}" \
    --title "$WORKING_PR_TITLE" --body "$WORKING_PR_BODY" \
    --head "$UPSTREAM_HEAD" --base "$UPSTREAM_DEFAULT")
fi
```

7. Swap PR_FILE and write the forwarded marker. On retry, step 1 will
   read from UPSTREAM_PR_FILE regardless of PR_FILE state:
```sh
echo "$UPSTREAM_PR_URL" > "{{PR_FILE}}"
touch "{{FORWARDED_MARKER_FILE}}"
```

8. Comment on working repo PR:
```sh
gh pr comment "$WORKING_PR_NUM" --repo "{{PROJECT_REPO}}" \
  --body "Forwarded to upstream: $UPSTREAM_PR_URL"
```

**Important**: Do NOT create `{{MERGED_MARKER_FILE}}`. The working repo PR stays open
until the upstream PR is merged and the fork is synced.

```sh
printf '%s|%s|forwarded to upstream\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
