# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{TASK_ID}}`. {{PROPOSAL_INSTRUCTION}}

**IMPORTANT**: Write your review to exactly this file path: `{{REVIEW_FILE}}`
First line must be `APPROVE` or `REQUEST_CHANGES`, then action items, then non-blocking observations.
If the implementation changes data shapes, verify that all helpers consuming the changed data have been updated. For format-compat serializers, check that round-trip fidelity tests exist (serialize → deserialize → compare). Flag missing consumer updates or missing round-trip tests as blocking action items.
Do NOT write to a different filename — the orchestrator checks this exact path.

**Pre-existing failures**: Before marking any failing test as a blocking action item, check the merged plan's `## Pre-existing test failures (baseline)` section. Failures listed there are pre-existing and must not block acceptance unless the task's acceptance criteria explicitly require fixing them. Flag any *new* failures (not in the baseline) as blocking. If the merged plan has no baseline section (older plan format), treat all failures as potentially blocking.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
