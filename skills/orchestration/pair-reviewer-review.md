# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{TASK_ID}}`. {{PROPOSAL_INSTRUCTION}}

If the PR touches config types or CLI commands, check that `templates/config.reference.yaml` and the README CLI Reference were updated accordingly.

Write your review to `{{REVIEW_FILE}}` — don't write it to a different filename, the orchestrator checks this path exactly. The first line is either `APPROVE` or `REQUEST_CHANGES`, followed by action items, then non-blocking observations.

If the implementation changes data shapes, check that helpers consuming the changed data were updated. For format-compat serializers, look for round-trip fidelity tests (serialize → deserialize → compare). Missing consumer updates or missing round-trip tests are blocking action items.

Before treating a failing test as blocking, cross-check the merged plan's `## Pre-existing test failures (baseline)` section: failures listed there stay non-blocking unless the acceptance criteria call for fixing them. *New* failures (not in the baseline) are blocking. If the plan has no baseline section (older format), treat failures as potentially blocking. If the baseline notes planning was skipped, only block on failures clearly caused by this task's changes.

If the coder wrote a `bail-out` status and you agree the task is already resolved or obsolete (verify against the base branch), confirm the bail-out:

```sh
printf 'bail-out-confirmed|%s|<describe why you agree task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If you disagree with the bail-out, write `REQUEST_CHANGES` in the review file and explain what's still needed.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
