# Suggest Refactor

Write what you'd do differently next time to `{{SUGGEST_REFACTOR_FILE}}`, then post it on the PR:
```sh
PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
[ -n "$PR_URL" ] && gh pr comment "$PR_URL" --body "$(cat "{{SUGGEST_REFACTOR_FILE}}")"
```

```sh
printf '%s|%s|refactor notes captured\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
