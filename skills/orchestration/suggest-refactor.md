# Suggest Refactor

Reflect on the completed work. Capture what you would do differently next time.

Write the reflection to `{{SUGGEST_REFACTOR_FILE}}`.

Then post it as a comment on the merged PR so the team can see it:
```sh
PR_URL=$(cat "{{PR_FILE}}" 2>/dev/null)
if [ -n "$PR_URL" ]; then
  gh pr comment "$PR_URL" --body "$(cat "{{SUGGEST_REFACTOR_FILE}}")"
fi
```

Then write:

```sh
printf '%s|%s|refactor notes captured\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
