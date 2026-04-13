# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{TASK_ID}}`. {{PROPOSAL_INSTRUCTION}}

**IMPORTANT**: Write your review to exactly this file path: `{{REVIEW_FILE}}`
First line must be `APPROVE` or `REQUEST_CHANGES`, then action items, then non-blocking observations.
If the implementation changes data shapes, verify that all helpers consuming the changed data have been updated. For format-compat serializers, check that round-trip fidelity tests exist (serialize → deserialize → compare). Flag missing consumer updates or missing round-trip tests as blocking action items.
Do NOT write to a different filename — the orchestrator checks this exact path.

**Pre-existing failures**: Before marking any failing test as a blocking action item, check the merged plan's `## Pre-existing test failures (baseline)` section. Failures listed there are pre-existing and must not block acceptance unless the task's acceptance criteria explicitly require fixing them. Flag any *new* failures (not in the baseline) as blocking. If the merged plan has no baseline section (older plan format), treat all failures as potentially blocking. If the baseline section says planning was skipped, do not block on test failures unless they are clearly caused by the task's changes.

If the coder wrote a `bail-out` status and you agree the task is already resolved or obsolete
(verify by checking the base branch), confirm the bail-out:

```sh
printf 'bail-out-confirmed|%s|<describe why you agree task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If you disagree with the bail-out, write `REQUEST_CHANGES` in your review file explaining what still needs to be done.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
