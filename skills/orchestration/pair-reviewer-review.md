# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{TASK_ID}}`. {{PROPOSAL_INSTRUCTION}}

If the PR touches documented-interface code (config types, CLI commands), check that the paired reference (`templates/config.reference.yaml`, README CLI Reference) was updated alongside — CI catches drift post-merge, but this round is the cheap place to catch it. See [CI drift files](../../docs/orchestration-patterns.md#ci-drift-files) for the known pairs.

Write your review to `{{REVIEW_FILE}}` — don't write it to a different filename, the orchestrator checks this path exactly. The first line is either `APPROVE` or `REQUEST_CHANGES`, followed by action items, then non-blocking observations.

If the implementation changes data shapes, check that helpers consuming the changed data were updated — shape changes break consumers silently (see [data-shape consumer sweep](../../docs/orchestration-patterns.md#data-shape-consumer-sweep)). For format-compat serializers, look for a round-trip fidelity test — see [round-trip serialization fidelity](../../docs/orchestration-patterns.md#round-trip-serialization-fidelity). Missing consumer updates or missing round-trip tests are blocking action items.

Before treating a failing test as blocking, cross-check the merged plan's `## Pre-existing test failures (baseline)` section — the point is to separate pre-existing noise from regressions introduced this round. See [pre-existing failures baseline](../../docs/orchestration-patterns.md#pre-existing-failures-baseline) for how to handle the cases where the baseline is absent, incomplete, or notes planning was skipped.

{{#IF PROPOSAL_PATH}}
**Scope review (discretion)**: Cross-reference the coder's changes against the proposal's `## Scope` section at `{{PROPOSAL_PATH}}`. Scope expansions are not automatic blockers — decide per-expansion whether the change belongs in this PR or should be salvaged to a follow-up:

- **Accept as-is** if the expansion is small, directly supports the goal, and doesn't materially broaden the PR's review surface.
- **Reject and ask for salvage** if the expansion is valuable but belongs in its own task. In the review body, explicitly ask the coder to salvage the rejected diff into a needs-confirmation follow-up (capture patch → revert → new task with `relates_to`) before continuing. Do not just tell them to revert — that throws away useful work.

Flag **undeclared** out-of-scope changes (no `scope-expansion:` trailer in any commit, no mention in the plan) as a discipline issue in the review body even when you accept the content. See [scope declaration and salvage](../../docs/orchestration-patterns.md#scope-declaration-and-salvage).
{{/IF}}

If the coder wrote a `bail-out` status and you agree the task is already resolved or obsolete (verify against the base branch), confirm the bail-out (see [bail-out contract](../../docs/orchestration-patterns.md#bail-out-contract)):

```sh
printf 'bail-out-confirmed|%s|<describe why you agree task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If you disagree with the bail-out, write `REQUEST_CHANGES` in the review file and explain what's still needed.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
